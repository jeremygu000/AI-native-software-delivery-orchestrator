import { emitKeypressEvents } from 'node:readline';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createForgeProgram, type ForgeProgramDependencies } from './app.js';
import { LocalPlanStore } from './local-plan.js';
import { listLocalPlans, readRunView } from './run-view.js';
import type { RunView } from './run-view-schema.js';

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
      scroll: 0
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
            '--semantic-review'
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
      if (name === 'n') {
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
      `Run: ${view.runId ?? 'not started'} · ${view.state}`,
      `State source: ${view.stateSource ?? 'not recorded'}; run row: ${view.recordedRunState ?? 'not recorded'}`,
      `Mode: ${view.execution ?? 'not recorded'} / verification ${view.verificationMode ?? 'not recorded'} / review ${view.reviewMode ?? 'not recorded'}`,
      '',
      ...view.tasks.flatMap((task) => [
        `${task.id} · ${task.state}${task.stage ? ` · last completion phase ${task.stage}` : ''}`,
        `  ${task.goal}`,
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

export function renderObservableTui(state: ObservableTuiState, width = 100, height = 30): string {
  const expanded = observableDiagnosticText(state).split('\n');
  const header = expanded.slice(0, 3);
  const body = expanded.slice(3);
  const start = Math.min(state.scroll, Math.max(0, body.length - Math.max(2, height - 5)));
  return [
    ...header,
    ...body.slice(start, start + Math.max(2, height - 5)),
    'Y/Ctrl+Y: copy complete text · PgUp/PgDn: scroll · Q: exit when idle'
  ]
    .map((line) => safe(line).slice(0, Math.max(20, width - 2)))
    .join('\n');
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
