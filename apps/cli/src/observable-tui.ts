import { emitKeypressEvents } from 'node:readline';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createForgeProgram, type ForgeProgramDependencies } from './app.js';
import { LocalPlanStore } from './local-plan.js';
import { listLocalPlans, readRunView } from './run-view.js';
import type { RunView } from './run-view-schema.js';
import { runMetadataText, taskDetailsText, taskSymbol, TuiPanel } from './presentation.js';

export const TuiScreen = {
  Home: 'home',
  Request: 'request',
  Plan: 'plan',
  Running: 'running',
  Result: 'result'
} as const;
type Screen = (typeof TuiScreen)[keyof typeof TuiScreen];
export interface ObservableTuiState {
  screen: Screen;
  plans: string[];
  selected: number;
  planId?: string;
  view?: RunView;
  input: string;
  repository: string;
  busy: boolean;
  error?: string;
  message?: string;
  scroll: number;
  maxConcurrency: number;
  help?: boolean;
  panel?: TuiPanel;
  selectedTask?: number;
}

/** Adapts keys to existing CLI commands. Approval and execution remain explicit actions. */
export class ObservableTuiController {
  state: ObservableTuiState;
  readonly store: LocalPlanStore;
  constructor(
    readonly options: {
      directory: string;
      repository: string;
      dependencies?: ForgeProgramDependencies;
      changed?: () => void;
      copy?: (text: string) => Promise<string>;
    }
  ) {
    this.store = new LocalPlanStore(options.directory);
    this.state = {
      screen: TuiScreen.Home,
      plans: [],
      selected: 0,
      input: '',
      repository: options.repository,
      busy: false,
      scroll: 0,
      maxConcurrency: 1
    };
  }
  async refresh() {
    try {
      this.state.plans = (await listLocalPlans(this.store)).map((plan) => plan.id);
      if (this.state.planId) {
        this.state.view = await readRunView(this.store, this.state.planId);
      }
    } catch {
      this.state.error = 'Local plan/run evidence is unavailable.';
    }
    this.options.changed?.();
  }
  async #command(args: string[]) {
    if (this.state.busy) {
      return;
    }
    this.state.busy = true;
    this.state.error = undefined;
    this.options.changed?.();
    try {
      const program = createForgeProgram({
        ...this.options.dependencies,
        writeOutput: (output) => {
          const result: unknown = JSON.parse(output);
          if (
            typeof result === 'object' &&
            result !== null &&
            'planId' in result &&
            typeof result.planId === 'string'
          ) {
            this.state.planId = result.planId;
          }
        }
      });
      program.exitOverride();
      program.configureOutput({ writeErr: () => undefined });
      for (const command of program.commands) {
        command.exitOverride();
        command.configureOutput({ writeErr: () => undefined });
      }
      await program.parseAsync([
        'node',
        'forge',
        ...args,
        '--state-directory',
        this.store.directory
      ]);
      await this.refresh();
      this.state.screen = this.state.view?.runId ? TuiScreen.Result : TuiScreen.Plan;
    } catch (error) {
      // Do not expose raw SDK responses, environment variables or command dumps in the terminal.
      this.state.error =
        error instanceof Error &&
        /Plan is not approved|already been run|Repository changed|uncommitted changes|Keep Forge state|Use the repository root/.test(
          error.message
        )
          ? error.message
          : 'Operation failed. The plan/worktree and recorded evidence are preserved; no automatic retry.';
      if (this.state.planId) {
        await this.refresh();
      }
    } finally {
      this.state.busy = false;
      this.options.changed?.();
    }
  }
  async key(name: string, text = '', control = false) {
    if (name === 'f1' || (name === '?' && this.state.screen !== TuiScreen.Request)) {
      this.state.help = !this.state.help;
      this.state.scroll = 0;
      this.options.changed?.();
      return;
    }
    if (this.state.help && ['escape', 'return'].includes(name)) {
      this.state.help = false;
      this.state.scroll = 0;
      this.options.changed?.();
      return;
    }
    if (this.state.help && !['y', 'pageup', 'pagedown'].includes(name)) {
      return;
    }
    if (name === 'y' && (control || this.state.screen !== TuiScreen.Request)) {
      try {
        const textToCopy = observableDiagnosticText(this.state);
        this.state.message = await (
          this.options.copy ?? ((value) => copyDiagnostic(value, this.store.directory))
        )(textToCopy);
      } catch {
        this.state.message =
          'Could not copy or save diagnostics. Terminal mouse selection is still available.';
      }
      this.options.changed?.();
      return;
    }
    if (!this.state.help && this.state.screen !== TuiScreen.Request && this.state.view) {
      if (name === 'tab') {
        const panels = [TuiPanel.Overview, TuiPanel.Tasks, TuiPanel.Detail] as const;
        this.state.panel =
          panels[(panels.indexOf(this.state.panel ?? TuiPanel.Overview) + 1) % panels.length];
        this.state.scroll = 0;
        this.options.changed?.();
        return;
      }
      if (
        (name === 'up' || name === 'down') &&
        this.state.panel !== undefined &&
        this.state.panel !== TuiPanel.Overview
      ) {
        this.state.selectedTask = Math.max(
          0,
          Math.min(
            this.state.view.tasks.length - 1,
            (this.state.selectedTask ?? 0) + (name === 'up' ? -1 : 1)
          )
        );
        this.state.scroll = 0;
        this.options.changed?.();
        return;
      }
      if (name === 'return' && this.state.panel === TuiPanel.Tasks) {
        this.state.panel = TuiPanel.Detail;
        this.state.scroll = 0;
        this.options.changed?.();
        return;
      }
    }
    if (this.state.screen === TuiScreen.Request) {
      if (this.state.busy) {
        return;
      }
      if (name === 'escape') {
        this.state.screen = TuiScreen.Home;
      } else if ((name === 'return' && control) || (name === 's' && control)) {
        if (!this.state.input.trim()) {
          this.state.error = 'Enter a request before planning.';
        } else {
          // The existing planner takes a Markdown file. The TUI stores only the user's request in local state.
          const { randomUUID } = await import('node:crypto');
          await mkdir(resolve(this.store.directory, 'requests'), { recursive: true });
          const path = resolve(this.store.directory, 'requests', `${randomUUID()}.md`);
          await writeFile(path, this.state.input, { flag: 'wx' });
          await this.#command([
            'plan',
            path,
            '--repository',
            this.state.repository,
            '--save',
            '--semantic-review',
            '--max-concurrency',
            String(this.state.maxConcurrency)
          ]);
        }
      } else if (name === 'return') {
        this.state.input += '\n';
      } else if (name === 'backspace') {
        this.state.input = this.state.input.slice(0, -1);
      } else if (text && !control) {
        this.state.input += text;
      }
    } else if (!this.state.busy) {
      if (name === 'p') {
        this.state.maxConcurrency =
          this.state.maxConcurrency === 4 ? 1 : this.state.maxConcurrency + 1;
      } else if (name === 'n') {
        this.state.screen = TuiScreen.Request;
        this.state.input = '';
        this.state.error = undefined;
      } else if (name === 'up') {
        this.state.selected = Math.max(0, this.state.selected - 1);
      } else if (name === 'down') {
        this.state.selected = Math.min(
          Math.max(0, this.state.plans.length - 1),
          this.state.selected + 1
        );
      } else if (name === 'return' && this.state.screen === TuiScreen.Home) {
        this.state.planId = this.state.plans[this.state.selected];
        await this.refresh();
        this.state.screen = TuiScreen.Plan;
      } else if (name === 'a' && this.state.planId && !this.state.view?.approved) {
        await this.#command(['approve', this.state.planId, '--yes']);
      } else if (
        (name === 'l' || name === 'c') &&
        this.state.planId &&
        this.state.view?.approved &&
        !this.state.view.runId
      ) {
        this.state.screen = TuiScreen.Running;
        await this.#command(['run', this.state.planId, name === 'l' ? '--live' : '--controlled']);
      } else if (name === 'escape') {
        this.state.screen = TuiScreen.Home;
        this.state.panel = TuiPanel.Overview;
      }
    }
    if (this.state.screen !== TuiScreen.Request) {
      if (name === 'pagedown') {
        this.state.scroll += 8;
      }
      if (name === 'pageup') {
        this.state.scroll = Math.max(0, this.state.scroll - 8);
      }
    }
    this.options.changed?.();
  }
}

const safe = (text: string) =>
  text
    .split('')
    .filter(
      (char) =>
        char === '\t' || char === '\n' || (char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
    )
    .join('');
export function observableDiagnosticText(state: ObservableTuiState): string {
  const lines = [
    'FORGE · Observable local coding',
    `Repository: ${state.repository}`,
    state.busy ? 'Working… · observing recorded facts every second' : `Screen: ${state.screen}`
  ];
  lines.push(`Planning concurrency: ${state.maxConcurrency} · P cycles 1–4 when idle`);
  if (state.error) {
    lines.push(`ERROR: ${state.error}`);
  }
  if (state.message) {
    lines.push(state.message);
  }
  if (state.screen === TuiScreen.Request) {
    lines.push(
      '',
      'Request (Enter = newline, Ctrl+Enter / Ctrl+S = plan; Esc = back)',
      ...state.input.split('\n')
    );
  } else if (state.screen === TuiScreen.Home) {
    lines.push(
      '',
      'Saved plans · ↑/↓ select · Enter inspect · N new request · Q exit',
      ...state.plans.map((id, index) => `${index === state.selected ? '▶' : ' '} ${id}`)
    );
  } else if (state.view) {
    const view = state.view;
    lines.push(
      `Plan: ${view.planId} · ${view.approved ? 'APPROVED' : 'not approved'}`,
      `Planned repository commit: ${view.repositoryCommit}`,
      `Run: ${view.runId ?? 'not started'} · ${view.state}`,
      `Status source: ${view.stateSource ?? 'not recorded'}; separately recorded run status: ${view.recordedRunState ?? 'not recorded'}`,
      `Mode: ${view.execution ?? 'not recorded'} / verification ${view.verificationMode ?? 'not recorded'} / review ${view.reviewMode ?? 'not recorded'}`,
      ...(view.finalRepository
        ? [
            `Final repository checks: ${view.finalRepository.status} · clean: ${view.finalRepository.clean}`,
            `Final HEAD: ${view.finalRepository.head}`,
            ...(view.finalRepository.detail ? [view.finalRepository.detail] : [])
          ]
        : []),
      'Task summary:',
      ...view.tasks.map(
        (task) =>
          `  ${task.id}: ${task.state} · checks ${task.verification?.status ?? 'not recorded'} · review ${task.review?.recommendation ?? 'not recorded'} · commit ${task.integratedCommit ?? 'not integrated'}`
      ),
      '',
      ...view.tasks.flatMap((task) => [
        `${task.id} · ${task.title} · ${task.state}${task.stage ? ` · last completion phase ${task.stage}` : ''}`,
        `  ${task.goal}`,
        ...(task.description ? [`  ${task.description}`] : []),
        `  planned: ${task.plannedFiles.join(', ') || 'none'}; actual: ${task.actualFiles.join(', ') || 'not recorded'}`,
        `  verification: ${task.verification?.status ?? 'not recorded'}; review: ${task.review?.recommendation ?? 'not recorded'}`,
        ...(task.verification?.detail ? [`  check output: ${task.verification.detail}`] : []),
        ...(task.review
          ? [
              `  review: ${task.review.summary}`,
              ...task.review.findings.map((finding) => `  ${finding.path}: ${finding.detail}`)
            ]
          : []),
        ...(task.worktree ? [`  worktree: ${task.worktree}`] : []),
        ...(task.diff ? [`  diff:\n${task.diff}`] : []),
        ...(task.failure ? [`  failure: ${task.failure}`] : []),
        ...(task.integratedCommit ? [`  integrated: ${task.integratedCommit}`] : [])
      ]),
      ...view.edges.map((edge) => `${edge.source} → ${edge.target} · ${edge.label}`),
      ...view.warnings,
      '',
      'A approve · L live (paid) · C controlled fake · Y/Ctrl+Y copy · PgUp/PgDn scroll · Esc plans · Q exit'
    );
  }
  return lines.map(safe).join('\n');
}

/** Explicit clipboard action; a local text file is the fallback when no OS clipboard is available. */
async function copyDiagnostic(text: string, directory: string): Promise<string> {
  const command =
    process.platform === 'darwin'
      ? ['pbcopy']
      : process.platform === 'win32'
        ? ['clip.exe']
        : ['wl-copy'];
  try {
    await new Promise<void>((done, reject) => {
      const child = spawn(command[0], [], { stdio: ['pipe', 'ignore', 'ignore'], timeout: 2000 });
      child.on('error', reject);
      child.stdin.on('error', reject);
      child.on('close', (code) =>
        code === 0 ? done() : reject(new Error('Clipboard unavailable'))
      );
      child.stdin.end(text);
    });
    return 'Copied complete plain-text diagnostics to the clipboard.';
  } catch {
    await mkdir(resolve(directory, 'diagnostics'), { recursive: true });
    const path = resolve(directory, 'diagnostics', `view-${Date.now()}.txt`);
    await writeFile(path, text, { flag: 'wx', mode: 0o600 });
    return `Clipboard unavailable. Complete diagnostics saved to ${path}`;
  }
}

const cellWidth = (text: string) =>
  /[\p{Extended_Pictographic}\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff01-\uff60]/u.test(
    text
  )
    ? 2
    : 1;

export function renderObservableTui(state: ObservableTuiState, width = 100, height = 30): string {
  const columns = Math.max(12, Math.floor(width) - 4);
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const characters = (text: string) =>
    Array.from(segmenter.segment(safe(text)), (item) => item.segment);
  const cells = (text: string) =>
    characters(text).reduce((total, item) => total + cellWidth(item), 0);
  const clip = (line: string) => {
    let result = '';
    let used = 0;
    for (const character of characters(line)) {
      used += cellWidth(character);
      if (used > columns) {
        break;
      }
      result += character;
    }
    return result;
  };
  const wrap = (value: string) =>
    safe(value)
      .split('\n')
      .flatMap((line) => {
        const lines: string[] = [];
        let current = '';
        let used = 0;
        for (const character of characters(line)) {
          const size = cellWidth(character);
          if (used + size > columns) {
            lines.push(current);
            current = '';
            used = 0;
          }
          current += character;
          used += size;
        }
        lines.push(current);
        return lines;
      });
  const border = (title: string) =>
    `┌ ${clip(title)}${'─'.repeat(Math.max(0, columns - cells(clip(title))))} ┐`;
  const row = (line: string) =>
    `│ ${clip(line)}${' '.repeat(Math.max(0, columns - cells(clip(line))))} │`;
  if (width < 40 || height < 24) {
    return ['FORGE', 'Needs at least 40×24.', 'Resize to view; Q exits when idle.']
      .map(clip)
      .join('\n');
  }
  const header = [
    border('FORGE · LOCAL CODING'),
    row(
      `${state.screen.toUpperCase()} · ${state.busy ? '◐ Working' : 'Ready'} · parallel ${state.maxConcurrency}`
    ),
    row(`Repository: ${state.repository}`)
  ];
  if (width >= 90 && height >= 36 && state.screen === TuiScreen.Home) {
    header.push(
      row('███████╗ ██████╗ ██████╗  ██████╗ ███████╗'),
      row('██╔════╝██╔═══██╗██╔══██╗██╔════╝ ██╔════╝'),
      row('█████╗  ██║   ██║██████╔╝██║  ███╗█████╗'),
      row('██╔══╝  ██║   ██║██╔══██╗██║   ██║██╔══╝'),
      row('██║     ╚██████╔╝██║  ██║╚██████╔╝███████╗')
    );
  }
  let content: string;
  let title: string;
  if (state.help) {
    title = 'HELP';
    content =
      'N New request · P Planning concurrency\n↑/↓ Select plan or task · Enter Inspect\nTab Overview / Tasks / Detail\nA Explicit approve · L Live (paid)\nC Controlled (fake)\nEnter Newline in request\nCtrl+Enter / Ctrl+S Submit request\nPgUp/PgDn Scroll · Y/Ctrl+Y Copy full details\n? / F1 Help · Esc/Enter Close help\nEsc Plans · Q/Ctrl+C Exit only when idle\n\nSingle-owner local execution. No cancellation or recovery action.\nDisplayed task-event state is separate from the recorded run row. Final repository checks are a separate observation. Missing evidence stays not recorded.';
  } else if (state.screen === TuiScreen.Request) {
    title = 'REQUEST · Ctrl+Enter / Ctrl+S submit';
    content = `${state.input}\n▌`;
  } else if (state.screen === TuiScreen.Home) {
    title = 'Saved plans · Enter inspect';
    content = state.plans.length
      ? state.plans.map((id, index) => `${index === state.selected ? '❯' : ' '} ${id}`).join('\n')
      : 'No saved plans. Press N to describe a coding task.\nPlans require explicit approval before execution.';
  } else if (state.view) {
    const view = state.view;
    const task = view.tasks[state.selectedTask ?? 0];
    title = `OVERVIEW / TASKS / DETAIL · ${state.panel ?? TuiPanel.Overview}`;
    content =
      state.panel === TuiPanel.Detail && task
        ? [
            taskDetailsText(task),
            ...view.edges
              .filter((edge) => edge.source === task.id || edge.target === task.id)
              .map((edge) => `${edge.source} → ${edge.target} · ${edge.label}`),
            ...view.warnings
          ].join('\n\n')
        : state.panel === TuiPanel.Tasks
          ? view.tasks
              .map(
                (item, index) =>
                  `${index === (state.selectedTask ?? 0) ? '❯' : ' '} ${taskSymbol(item.state)} ${item.title}\n  ${item.id}: ${item.state}`
              )
              .join('\n') +
            '\n\nDependencies / conflicts:\n' +
            view.edges.map((edge) => `${edge.source} → ${edge.target} · ${edge.label}`).join('\n')
          : runMetadataText(view) +
            '\n\nTasks:\n' +
            view.tasks
              .map((item) => `${taskSymbol(item.state)} ${item.title}: ${item.state}`)
              .join('\n');
  } else {
    title = 'OBSERVATIONS';
    content = 'No plan evidence available.';
  }
  const lines = wrap(
    [state.error ? `ERROR: ${state.error}` : '', state.message ?? '', content]
      .filter(Boolean)
      .join('\n\n')
  );
  const available = Math.max(1, height - header.length - 5);
  const start = Math.min(state.scroll, Math.max(0, lines.length - available));
  const body = lines.slice(start, start + available);
  while (body.length < available) {
    body.push('');
  }
  return [
    ...header,
    border(`${title} · ${Math.min(start + 1, lines.length)}/${lines.length}`),
    ...body.map(row),
    `└${'─'.repeat(width - 2)}┘`,
    clip(state.help ? 'Esc Close · Y Copy' : 'Tab Views · Pg↑/↓ Scroll · ?/F1 Help'),
    clip(
      state.busy
        ? 'Y Copy · active operation continues'
        : 'N New · A Approve · L Live · Y Copy · Q Exit'
    )
  ].join('\n');
}

/** Full-screen terminal with a single owner; quitting an active run is intentionally not supported. */
export async function startObservableTui(
  directory = resolve(homedir(), '.forge'),
  repository = process.cwd()
) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      'forge tui requires an interactive terminal. Use the ordinary CLI commands otherwise.'
    );
  }
  let closed = false;
  const draw = () =>
    process.stdout.write(
      `\x1b[H\x1b[2J\x1b[34m${renderObservableTui(controller.state, process.stdout.columns, process.stdout.rows)}\x1b[0m`
    );
  const controller = new ObservableTuiController({ directory, repository, changed: draw });
  const previousRaw = process.stdin.isRaw;
  process.stdout.write('\x1b[?1049h\x1b[?25l');
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  const timer = setInterval(() => void controller.refresh(), 1000);
  const { promise: done, resolve: finish } = Promise.withResolvers<void>();
  const key = (text: string, info: { name?: string; ctrl?: boolean }) => {
    if (
      (info.name === 'q' || (info.name === 'c' && info.ctrl)) &&
      controller.state.screen !== TuiScreen.Request
    ) {
      if (!controller.state.busy) {
        closed = true;
        finish();
      }
      return;
    }
    void controller.key(info.name ?? '', text, info.ctrl).catch(() => {
      controller.state.error = 'Presentation operation failed.';
      draw();
    });
  };
  process.stdin.on('keypress', key);
  process.stdout.on('resize', draw);
  try {
    await controller.refresh();
    draw();
    await done;
  } finally {
    closed = true;
    clearInterval(timer);
    process.stdin.off('keypress', key);
    process.stdout.off('resize', draw);
    process.stdin.setRawMode(previousRaw);
    process.stdin.pause();
    process.stdout.write('\x1b[?25h\x1b[?1049l');
  }
  return closed;
}
