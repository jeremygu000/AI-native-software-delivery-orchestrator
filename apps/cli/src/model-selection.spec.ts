import { mkdtemp, realpath, rm, readdir, lstat, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FileSubscriptionCredentialStore,
  forgeModelProfiles,
  resolveForgeModelSelection
} from '@ai-native-software-delivery-orchestrator/agent-runtime';
import {
  createCodeReviewPolicy,
  createPlanArtifact,
  createPlanApproval,
  codeReviewPolicyFingerprint,
  type CodeReviewPolicy
} from '@ai-native-software-delivery-orchestrator/planning';
import { createForgeProgram, type ForgeProgramDependencies } from './app.js';
import {
  createModelSelectionTerminal,
  ModelSelectionCancelled,
  selectForgeModel,
  loginForgeModel,
  type ModelSelectionTerminal
} from './model-selection.js';
import { resolveCliReviewPolicy } from './review-policy.js';

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});
const configuredEnvironment = async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'forge-picker-')));
  directories.push(directory);
  const store = new FileSubscriptionCredentialStore(directory);
  for (const provider of ['github-copilot', 'openai-codex']) {
    // Expired credentials count as configured; inspection must not refresh them.
    await store.save(provider, { access: 'secret-access', refresh: 'secret-refresh', expires: 1 });
  }
  return { FORGE_SUBSCRIPTION_AUTH_DIRECTORY: directory, FORGE_MODEL_API_KEY: 'secret-key' };
};
const terminal = (choices: number[] = [], isInteractive = true): ModelSelectionTerminal => ({
  isInteractive,
  write: vi.fn(),
  choose: vi.fn(async () => {
    const choice = choices.shift();
    if (choice === undefined) {
      throw new ModelSelectionCancelled();
    }
    return choice;
  })
});
const parse = (program: ReturnType<typeof createForgeProgram>, args: string[]) =>
  program.parseAsync(['node', 'forge', ...args]);

const artifactForPolicy = (policy: CodeReviewPolicy) =>
  createPlanArtifact({
    artifactId: 'selection-plan',
    revision: 1,
    createdAt: '2026-10-04T00:00:00Z',
    source: { type: 'user-request', content: 'Change one file.' },
    repository: {
      repositoryPath: '/repo',
      projects: new Map(),
      files: new Map(),
      symbols: new Map(),
      projectDependencies: [],
      fileDependencies: [],
      symbolReferences: [],
      diagnostics: []
    },
    repositorySnapshot: {
      repositoryId: `sha256:${'1'.repeat(64)}`,
      repositoryRoot: '/repo',
      baseCommit: '2'.repeat(40),
      workingTreeFingerprint: `sha256:${'3'.repeat(64)}`,
      dirty: false
    },
    sharedResourcePolicy: [],
    verificationPolicy: { version: 1 },
    codeReviewPolicy: policy,
    preparedPlan: {
      attempts: 1,
      specification: {
        tasks: [
          {
            id: 'task',
            title: 'Change',
            goal: 'Change safely',
            dependencies: [],
            expectedReads: [],
            expectedWrites: [],
            sharedResources: [],
            verification: []
          }
        ]
      },
      impacts: [
        {
          taskId: 'task',
          projectsRead: new Set(),
          projectsWritten: new Set(),
          explicitProjectsWritten: new Set(),
          filesRead: new Set(),
          filesWritten: new Set(),
          explicitFilesWritten: new Set(),
          globFilesWritten: new Set(),
          symbolDerivedFilesWritten: new Set(),
          symbolsRead: new Set(),
          symbolsWritten: new Set(),
          sharedResources: new Set(),
          sharedResourceAccesses: [],
          downstreamProjects: new Set(),
          riskSignals: []
        }
      ],
      hardConflicts: [],
      riskConflicts: [],
      executionPlan: { waves: [{ index: 0, taskIds: ['task'] }] },
      schedule: { maxConcurrency: 1 },
      semanticReview: {
        recommendation: 'accept',
        summary: 'Covered',
        requirements: [
          { requirement: 'Change', status: 'covered', taskIds: ['task'], detail: 'Covered' }
        ]
      }
    }
  });

describe('Canonical execution-profile CLI', () => {
  it('lists only validated profiles, reads only the private Forge store, and creates nothing', async () => {
    const environment = await configuredEnvironment();
    const inference = vi.fn(() => {
      throw new Error('Listing must not use the network');
    });
    vi.stubGlobal('fetch', inference);
    const output = vi.fn();
    const before = await readdir(environment.FORGE_SUBSCRIPTION_AUTH_DIRECTORY);
    const program = createForgeProgram({ modelEnvironment: environment, writeOutput: output });
    await parse(program, ['model', 'list']);
    const printed = output.mock.calls.flat().join('');
    for (const profile of forgeModelProfiles) {
      expect(printed).toContain(profile.displayName);
      expect(resolveForgeModelSelection(profile, environment)).toMatchObject({
        providerId: profile.provider,
        modelId: profile.model,
        reasoningConfig: { effort: profile.reasoningEffort }
      });
    }
    expect(printed.match(/ready/g)).toHaveLength(3);
    expect(inference).not.toHaveBeenCalled();
    expect(printed).not.toMatch(/secret-|Local|Custom|accountId/);
    expect(await readdir(environment.FORGE_SUBSCRIPTION_AUTH_DIRECTORY)).toEqual(before);
    await chmod(join(environment.FORGE_SUBSCRIPTION_AUTH_DIRECTORY, 'github-copilot.json'), 0o644);
    await writeFile(join(environment.FORGE_SUBSCRIPTION_AUTH_DIRECTORY, 'openai-codex.json'), '{}');
    output.mockClear();
    await parse(createForgeProgram({ modelEnvironment: environment, writeOutput: output }), [
      'model',
      'list'
    ]);
    expect(
      output.mock.calls
        .flat()
        .join('')
        .match(/invalid/g)
    ).toHaveLength(2);
    const absent = join(environment.FORGE_SUBSCRIPTION_AUTH_DIRECTORY, 'not-created');
    output.mockClear();
    await parse(
      createForgeProgram({
        modelEnvironment: { FORGE_SUBSCRIPTION_AUTH_DIRECTORY: absent },
        writeOutput: output
      }),
      ['model', 'list']
    );
    expect(
      output.mock.calls
        .flat()
        .join('')
        .match(/not-configured/g)
    ).toHaveLength(3);
    await expect(lstat(absent)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([0, 1, 2])(
    'produces identical interactive/explicit targets and policy fingerprints for profile %s',
    async (index) => {
      const environment = await configuredEnvironment();
      const request = vi.fn(
        async (input: Parameters<NonNullable<ForgeProgramDependencies['planRepository']>>[0]) =>
          artifactForPolicy(
            resolveCliReviewPolicy(
              input.reviewProvider,
              input.reviewModel,
              input.reasoningEffort,
              environment
            ).policy
          )
      );
      const modelTerminal = terminal([index, 0]);
      await parse(
        createForgeProgram({
          modelEnvironment: environment,
          modelTerminal,
          planRepository: request,
          writeOutput: vi.fn()
        }),
        ['plan', 'spec.md', '--semantic-review']
      );
      const interactive = request.mock.calls[0][0];
      const interactiveArtifact = await request.mock.results[0].value;
      const profile = forgeModelProfiles[index];
      expect(interactive).toMatchObject({
        reviewProvider: profile.provider,
        reviewModel: profile.model,
        reasoningEffort: profile.reasoningEffort
      });
      const explicitTerminal = terminal([], false);
      request.mockClear();
      await parse(
        createForgeProgram({
          modelEnvironment: environment,
          modelTerminal: explicitTerminal,
          planRepository: request,
          writeOutput: vi.fn()
        }),
        [
          'plan',
          'spec.md',
          '--semantic-review',
          '--review-provider',
          profile.provider,
          '--review-model',
          profile.model,
          '--reasoning-effort',
          profile.reasoningEffort
        ]
      );
      expect(request.mock.calls[0][0]).toEqual(interactive);
      const explicitArtifact = await request.mock.results[0].value;
      expect(explicitArtifact).toEqual(interactiveArtifact);
      const approve = (artifact: typeof explicitArtifact) =>
        createPlanApproval({
          artifact,
          approvalId: 'selection-approval',
          approvedBy: 'operator',
          approvedAt: '2026-10-04T00:01:00Z'
        });
      expect(approve(explicitArtifact).approvalFingerprint).toBe(
        approve(interactiveArtifact).approvalFingerprint
      );
      expect(explicitTerminal.choose).not.toHaveBeenCalled();
      const fromPicker = resolveCliReviewPolicy(
        interactive.reviewProvider,
        interactive.reviewModel,
        interactive.reasoningEffort,
        environment
      );
      const fromFlags = resolveCliReviewPolicy(
        profile.provider,
        profile.model,
        profile.reasoningEffort,
        environment
      );
      expect(fromPicker.policy).toEqual(fromFlags.policy);
      expect(codeReviewPolicyFingerprint(fromPicker.policy)).toBe(
        codeReviewPolicyFingerprint(fromFlags.policy)
      );
      if (fromPicker.execution !== undefined) {
        expect(fromPicker.execution.target).toEqual(
          resolveForgeModelSelection(profile, environment)
        );
        expect(fromPicker.execution.target.executionProfileFingerprint).toBe(
          fromFlags.execution?.target.executionProfileFingerprint
        );
      }
      // DeepSeek retains its accepted direct-API policy shape; no worker contract change.
      if (profile.provider === 'deepseek') {
        expect(fromPicker.policy.reviewer.model.executionTarget).toBeUndefined();
      }
      const previous = resolveCliReviewPolicy(profile.provider, profile.model, undefined, {
        ...environment,
        FORGE_MODEL_REASONING_EFFORT: profile.reasoningEffort
      });
      expect(previous.policy).toEqual(fromPicker.policy);
    }
  );

  it('confirms, allows change, emits the full canonical target, and never persists a selection', async () => {
    const environment = await configuredEnvironment();
    const output = vi.fn();
    const modelTerminal = terminal([0, 1, 1, 0]);
    const files = await readdir(environment.FORGE_SUBSCRIPTION_AUTH_DIRECTORY);
    await parse(
      createForgeProgram({ modelEnvironment: environment, modelTerminal, writeOutput: output }),
      ['model', 'select']
    );
    expect(JSON.parse(output.mock.calls[0][0])).toEqual(
      resolveForgeModelSelection(forgeModelProfiles[1], environment)
    );
    expect(modelTerminal.choose).toHaveBeenCalledTimes(4);
    expect(modelTerminal.write).toHaveBeenCalledWith(
      expect.stringContaining('Reasoning effort: medium')
    );
    expect(await readdir(environment.FORGE_SUBSCRIPTION_AUTH_DIRECTORY)).toEqual(files);
  });

  it('fails closed without complete non-TTY flags and preserves explicit legacy automation', async () => {
    const plan = vi.fn(async () =>
      artifactForPolicy(createCodeReviewPolicy({ provider: 'deepseek', model: 'deepseek-flash' }))
    );
    const modelTerminal = terminal([], false);
    for (const flags of [
      [],
      ['--review-provider', 'deepseek'],
      ['--review-model', 'deepseek-flash']
    ]) {
      await expect(
        parse(createForgeProgram({ planRepository: plan, modelTerminal }), [
          'plan',
          'spec.md',
          '--semantic-review',
          ...flags
        ])
      ).rejects.toThrow('required in non-interactive mode');
    }
    expect(plan).not.toHaveBeenCalled();
    await parse(createForgeProgram({ planRepository: plan, modelTerminal, writeOutput: vi.fn() }), [
      'plan',
      'spec.md',
      '--semantic-review',
      '--review-provider',
      'deepseek',
      '--review-model',
      'deepseek-flash'
    ]);
    expect(plan).toHaveBeenCalledWith(
      expect.not.objectContaining({ reasoningEffort: expect.anything() })
    );
    expect(modelTerminal.choose).not.toHaveBeenCalled();
    await expect(selectForgeModel(modelTerminal, {})).rejects.toThrow('interactive terminal');
  });

  it('does not override partial flags, or fall back when the selected credentials are absent', async () => {
    const environment = await configuredEnvironment();
    const picker = terminal([0, 0]);
    expect(await selectForgeModel(picker, environment, { provider: 'openai-codex' })).toEqual({
      provider: 'openai-codex',
      model: 'gpt-6.1-sol',
      reasoningEffort: 'medium'
    });
    expect(picker.choose).toHaveBeenCalledWith(expect.any(String), [
      expect.stringContaining('OpenAI Codex')
    ]);
    await expect(
      selectForgeModel(terminal(), environment, { provider: 'deepseek', model: 'gpt-6.1-sol' })
    ).rejects.toThrow('No validated');
    const missing = terminal([0]);
    await expect(selectForgeModel(missing, {})).rejects.toThrow('forge model login github-copilot');
    expect(missing.choose).toHaveBeenCalledTimes(1);
    await expect(selectForgeModel(terminal([2]), {})).rejects.toThrow('FORGE_MODEL_API_KEY');
    await expect(selectForgeModel(terminal([99]), environment)).rejects.toThrow(
      'Invalid execution profile selection'
    );
    await expect(selectForgeModel(terminal([0, 99]), environment)).rejects.toThrow(
      'Invalid execution profile confirmation'
    );
  });

  it('cancels before planning, approval or run at selection and confirmation', async () => {
    const environment = await configuredEnvironment();
    const plan = vi.fn();
    const approve = vi.fn();
    const run = vi.fn();
    const output = vi.fn();
    for (const choices of [[], [0]]) {
      await expect(
        parse(
          createForgeProgram({
            modelEnvironment: environment,
            modelTerminal: terminal(choices),
            planRepository: plan,
            approvePlan: approve,
            runPlan: run,
            writeOutput: output
          }),
          ['plan', 'spec.md', '--semantic-review']
        )
      ).rejects.toBeInstanceOf(ModelSelectionCancelled);
    }
    expect(plan).not.toHaveBeenCalled();
    expect(approve).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(output).not.toHaveBeenCalled();
  });

  it('uses the authoritative resolver for invalid model/effort combinations and does not mutate env', async () => {
    const environment = await configuredEnvironment();
    const before = { ...environment };
    for (const [provider, model, effort] of [
      ['deepseek', 'gpt-6.1-sol', 'high'],
      ['openai-codex', 'nonexistent', 'medium'],
      ['deepseek', 'deepseek-flash', 'low'],
      ['github-copilot', 'gpt-6.1-sol', 'invalid']
    ]) {
      expect(() => resolveCliReviewPolicy(provider, model, effort, environment)).toThrow();
    }
    expect(environment).toEqual(before);
  });

  it('wraps existing login, keeps DeepSeek key setup explicit and sanitizes auth failures', async () => {
    const environment = await configuredEnvironment();
    const login = vi.fn(async () => undefined);
    const modelTerminal = terminal();
    for (const provider of ['github-copilot', 'openai-codex']) {
      await parse(
        createForgeProgram({ modelEnvironment: environment, modelTerminal, loginModel: login }),
        ['model', 'login', provider]
      );
      expect(login).toHaveBeenLastCalledWith(
        provider,
        environment.FORGE_SUBSCRIPTION_AUTH_DIRECTORY,
        expect.objectContaining({ signal: expect.any(AbortSignal), onAuth: expect.any(Function) })
      );
    }
    await loginForgeModel('deepseek', modelTerminal, {}, login);
    expect(login).toHaveBeenCalledTimes(2);
    expect(modelTerminal.write).toHaveBeenCalledWith(
      expect.stringContaining('FORGE_MODEL_API_KEY')
    );
    await expect(loginForgeModel('unknown', modelTerminal, environment, login)).rejects.toThrow(
      'Unsupported'
    );
    await expect(
      loginForgeModel('openai-codex', terminal([], false), environment, login)
    ).rejects.toThrow('interactive');
    await expect(loginForgeModel('openai-codex', modelTerminal, {}, login)).rejects.toThrow(
      'FORGE_SUBSCRIPTION_AUTH_DIRECTORY'
    );
    await expect(
      loginForgeModel('openai-codex', modelTerminal, environment, async () => {
        throw new Error('secret-provider-body');
      })
    ).rejects.toThrow('no provider diagnostic');
    await expect(
      loginForgeModel('openai-codex', modelTerminal, environment, async () => {
        process.emit('SIGINT');
        throw new Error('secret-provider-body');
      })
    ).rejects.toBeInstanceOf(ModelSelectionCancelled);
  });
});

const streams = () => {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode: vi.fn(function (this: { isRaw: boolean }, raw: boolean) {
      this.isRaw = raw;
    })
  });
  const output = Object.assign(new PassThrough(), { isTTY: true });
  input.pause();
  return { input, output, picker: createModelSelectionTerminal(input, output) };
};

describe('Terminal picker lifecycle', () => {
  it('handles arrow keys and Enter and restores terminal mode/listeners', async () => {
    const { input, output, picker } = streams();
    let written = '';
    output.on('data', (data) => {
      written += String(data);
    });
    const pending = picker.choose('Select', ['one', 'two']);
    input.emit('keypress', '', { name: 'up' });
    input.emit('keypress', '', { name: 'down' });
    input.emit('keypress', '', { name: 'down' });
    input.emit('keypress', '', { name: 'return' });
    expect(await pending).toBe(1);
    expect(input.isRaw).toBe(false);
    expect(input.isPaused()).toBe(true);
    expect(input.listenerCount('keypress')).toBe(0);
    expect(written).toContain('❯ two');
    expect(written).toContain('\u001b[?25h');
  });
  it('does not leave an initially idle input running after confirmation', async () => {
    const { input, picker } = streams();
    const idle = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
    expect(idle.readableFlowing).toBeNull();
    const pending = createModelSelectionTerminal(
      idle,
      Object.assign(new PassThrough(), { isTTY: true })
    ).choose('Select', ['one']);
    idle.emit('keypress', '', { name: 'return' });
    expect(await pending).toBe(0);
    expect(idle.isPaused()).toBe(true);
    input.resume();
    const flowing = picker.choose('Select', ['one']);
    input.emit('keypress', '', { name: 'return' });
    await flowing;
    expect(input.readableFlowing).toBe(true);
    input.pause();
  });
  it.each(['ctrl-c', 'escape', 'end', 'close', 'signal'])(
    'cancels on %s without returning the highlighted item',
    async (kind) => {
      const { input, picker } = streams();
      const pending = picker.choose('Select', ['one']);
      const rejection = expect(pending).rejects.toBeInstanceOf(ModelSelectionCancelled);
      if (kind === 'signal') {
        process.emit('SIGINT');
      } else if (kind === 'end' || kind === 'close') {
        input.emit(kind);
      } else {
        input.emit('keypress', '', {
          name: kind === 'escape' ? 'escape' : 'c',
          ctrl: kind === 'ctrl-c'
        });
      }
      await rejection;
      expect(input.isRaw).toBe(false);
      expect(input.listenerCount('keypress')).toBe(0);
    }
  );
  it('rejects non-terminal input before changing raw mode', async () => {
    await expect(
      createModelSelectionTerminal(new PassThrough(), new PassThrough()).choose('Select', ['one'])
    ).rejects.toThrow('interactive');
  });
});
