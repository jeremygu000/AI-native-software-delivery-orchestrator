import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  PlanningSource,
  PlanArtifact
} from '@ai-native-software-delivery-orchestrator/planning';
import { PlanExecutionBindingError } from '@ai-native-software-delivery-orchestrator/planning';
import type { ForgeProgramDependencies, planRepositoryFromSource } from './app.js';
import {
  ModelSelectionCancelled,
  ModelSelectionError,
  selectForgeModel
} from './model-selection.js';
import type { InteractiveTerminal } from './interactive-terminal.js';
import type { CodingPresentation, CodingStage } from './interactive-presentation.js';
import {
  integrationTaskIds,
  renderPlanDetails,
  renderPlanSummary,
  renderRunProgress,
  renderRunCompletion
} from './interactive-render.js';

type RunRequest = Parameters<NonNullable<ForgeProgramDependencies['runPlan']>>[0];
export interface InteractiveCodingDependencies {
  readonly terminal: InteractiveTerminal;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly validateRepository: (path: string) => Promise<string>;
  readonly planSource: typeof planRepositoryFromSource;
  readonly approvePlan: NonNullable<ForgeProgramDependencies['approvePlan']>;
  readonly bindPlan: NonNullable<ForgeProgramDependencies['bindPlan']>;
  readonly runPlan: NonNullable<ForgeProgramDependencies['runPlan']>;
  readonly statusRun: NonNullable<ForgeProgramDependencies['statusRun']>;
  readonly cancelRun: NonNullable<ForgeProgramDependencies['cancelRun']>;
  readonly checkWorker: (request: {
    repositoryPath: string;
    policyFingerprint: string;
  }) => Promise<void>;
  readonly setup: (
    request: RunRequest & {
      artifact: PlanArtifact;
      approvedBy: string;
      onProgress?: (
        stage: 'metadata' | 'workspace' | 'authority',
        state: 'active' | 'complete'
      ) => void;
    }
  ) => Promise<void>;
  readonly wait?: (signal: AbortSignal) => Promise<void>;
  readonly createId?: () => string;
  readonly present?: CodingPresentation;
}

const taskInput = async (
  terminal: InteractiveTerminal,
  cwd: string,
  signal: AbortSignal
): Promise<PlanningSource> => {
  const mode = await terminal.choose('How would you like to provide the task?', [
    'Describe task',
    'Use Markdown specification'
  ]);
  if (mode === 0) {
    const content = await terminal.multiline('Task', signal);
    if (content.trim() === '') {
      throw new ModelSelectionError('Task description must not be empty.');
    }
    return { type: 'user-request', content };
  }
  if (mode !== 1) {
    throw new ModelSelectionError('Invalid task-input selection.');
  }
  const path = resolve(cwd, await terminal.prompt('Task specification', undefined, signal));
  return { type: 'markdown-spec', path, content: await readFile(path, 'utf8') };
};

/** Human frontend over the same immutable application operations as explicit commands. */
export async function startInteractiveCoding(
  dependencies: InteractiveCodingDependencies
): Promise<void> {
  const { terminal, environment } = dependencies;
  if (!terminal.isInteractive) {
    throw new ModelSelectionError(
      'Interactive Forge requires a terminal. Use forge --help for non-interactive commands.'
    );
  }
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt);
  const requireActive = () => {
    if (controller.signal.aborted) {
      throw new ModelSelectionCancelled('Interactive coding cancelled.');
    }
  };
  let currentRun: RunRequest | undefined;
  let runPrepared = false;
  let cancellationAttempted = false;
  let phase = 'input';
  let activeStage: CodingStage | undefined;
  const stage = (value: CodingStage, state: 'active' | 'complete') => {
    activeStage = state === 'active' ? value : undefined;
    dependencies.present?.({ type: 'stage', stage: value, state });
  };
  const createId = dependencies.createId ?? randomUUID;
  const requestCancellation = async () => {
    if (currentRun === undefined || cancellationAttempted) {
      return;
    }
    cancellationAttempted = true;
    try {
      await dependencies.cancelRun({
        runId: currentRun.runId,
        runDirectory: currentRun.runDirectory ?? ''
      });
    } catch {
      terminal.write(
        'Cancellation could not be fully confirmed; inspect durable status and use existing operator recovery if required.\n'
      );
      return;
    }
    terminal.write(
      `Cancellation requested for ${currentRun.runId}. UNKNOWN attempts require existing operator settlement; no automatic settlement was performed.\n`
    );
  };
  try {
    for (;;) {
      const choice = await terminal.choose('What do you want to do?', [
        'Start a coding task',
        'Resume a run',
        'View runs',
        'Configure model',
        'Check environment'
      ]);
      if (choice === 3) {
        await selectForgeModel(terminal, environment);
        continue;
      }
      if (choice !== 0) {
        terminal.write('Not available in this CLI version.\n');
        continue;
      }
      break;
    }
    const entered = await terminal.prompt('Repository', dependencies.cwd, controller.signal);
    stage('repository', 'active');
    if (/\$(?:[A-Za-z_]|\{)/.test(entered)) {
      throw new ModelSelectionError(
        `Repository not found: ${entered}\nShell variables such as $PWD are not expanded in this field.`
      );
    }
    const repositoryPath = await dependencies
      .validateRepository(
        resolve(
          dependencies.cwd,
          entered.startsWith('~/') ? resolve(homedir(), entered.slice(2)) : entered
        )
      )
      .catch((error: unknown) => {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          (error.code === 'ENOENT' || error.code === 'ENOTDIR')
        ) {
          throw new ModelSelectionError(
            `Repository not found: ${entered}\nEnter an existing Git repository path.`
          );
        }
        throw error;
      });
    stage('repository', 'complete');
    dependencies.present?.({ type: 'repository', path: repositoryPath });
    let source = await taskInput(terminal, dependencies.cwd, controller.signal);
    const selection = await selectForgeModel(terminal, environment);
    dependencies.present?.({
      type: 'model',
      provider: selection.provider,
      model: selection.model,
      reasoning: selection.reasoningEffort
    });
    const profile = {
      reviewProvider: selection.provider,
      reviewModel: selection.model,
      reasoningEffort: selection.reasoningEffort
    };
    const authorized = await terminal.choose(
      'Forge will use the selected model to create the plan and perform independent semantic plan review. Continue?',
      ['Continue', 'Cancel']
    );
    if (authorized !== 0) {
      return;
    }
    for (;;) {
      requireActive();
      phase = 'planning';
      terminal.write('Creating and reviewing plan...\n');
      stage('analysis', 'active');
      const artifact = await dependencies.planSource({
        source,
        repositoryPath,
        maxAttempts: 3,
        maxConcurrency: 1,
        semanticReviewAuthorized: true,
        ...profile,
        signal: controller.signal,
        onProgress: (value) => {
          if (activeStage !== undefined && activeStage !== 'semantic-review') {
            stage(activeStage, 'complete');
          }
          stage(value, 'active');
        }
      });
      requireActive();
      if (activeStage !== undefined) {
        stage(activeStage, 'complete');
      }
      stage('analysis', 'complete');
      stage('planning', 'complete');
      stage('semantic-review', 'complete');
      dependencies.present?.({ type: 'plan', artifact });
      terminal.write(renderPlanSummary(artifact));
      let revise = false;
      let approved = false;
      while (!approved && !revise) {
        const action = await terminal.choose('What next?', [
          'Review plan',
          'Approve and run',
          'Revise task',
          'Cancel'
        ]);
        if (action === 0) {
          terminal.write(renderPlanDetails(artifact));
          continue;
        }
        if (action === 2) {
          source = await taskInput(terminal, dependencies.cwd, controller.signal);
          revise = true;
          continue;
        }
        if (action !== 1) {
          return;
        }
        terminal.write(
          `Approve exact artifact ${artifact.artifactId} / revision ${artifact.revision}\nExecution: ${selection.provider} / ${selection.model} / ${selection.reasoningEffort}\nRepository integration tasks: ${integrationTaskIds(artifact).join(', ') || 'none'}\nWorkspace creation: ${artifact.decision.specification.tasks.length} tasks\n`
        );
        const confirmation = await terminal.choose(
          'Allow Forge to prepare isolated workspaces and modify/integrate these approved tasks?',
          ['Approve and run', 'Review details', 'Cancel']
        );
        if (confirmation === 1) {
          terminal.write(renderPlanDetails(artifact));
          continue;
        }
        if (confirmation !== 0) {
          return;
        }
        approved = true;
      }
      if (revise) {
        continue;
      }
      requireActive();
      phase = 'readiness';
      stage('readiness', 'active');
      terminal.write('Checking worker deployment and task queue...\n');
      await dependencies
        .checkWorker({
          repositoryPath,
          policyFingerprint: artifact.authority.codeReviewPolicyFingerprint
        })
        .catch(() => {
          throw new ModelSelectionError(
            'Forge authority or worker is not ready for this repository/profile/task queue. Check deployment and start the matching worker, then retry. No run was started.'
          );
        });
      requireActive();
      terminal.write('✓ Worker deployment and task queue available\n');
      stage('readiness', 'complete');
      const approvalId = createId();
      const runId = createId();
      const approvedBy = userInfo().username;
      const request = {
        artifactId: artifact.artifactId,
        artifactRevision: artifact.revision,
        approvalId,
        runId,
        repositoryPath,
        ...profile
      };
      phase = 'approval';
      stage('approval', 'active');
      terminal.write('Recording exact plan approval...\n');
      await dependencies.approvePlan({
        artifactId: artifact.artifactId,
        artifactRevision: artifact.revision,
        approvalId,
        approvedBy,
        repositoryIntegrationTasks: integrationTaskIds(artifact),
        repositoryPath
      });
      requireActive();
      terminal.write(`✓ Exact plan approved\nApproval ID: ${approvalId}\n`);
      stage('approval', 'complete');
      dependencies.present?.({
        type: 'identity',
        runId,
        approvalId,
        artifactId: artifact.artifactId,
        repositoryPath
      });
      phase = 'binding';
      stage('binding', 'active');
      terminal.write('Binding repository authority...\n');
      try {
        await dependencies.bindPlan(request);
      } catch (error) {
        if (!(error instanceof PlanExecutionBindingError)) {
          throw error;
        }
        terminal.write(
          'Repository or approved execution policy changed. Forge refused execution.\n'
        );
        if (
          (await terminal.choose('Re-plan against the current repository?', [
            'Re-plan',
            'Cancel'
          ])) === 0
        ) {
          continue;
        }
        return;
      }
      requireActive();
      terminal.write('✓ Repository authority bound\n');
      stage('binding', 'complete');
      const runDirectory = resolve(
        resolve(homedir(), '.forge', 'runs', artifact.repository.repositoryId.replace(':', '-'))
      );
      currentRun = { ...request, runDirectory, prepareOnly: false };
      phase = 'setup';
      stage('workspace', 'active');
      runPrepared = true; // setup includes accepted initial dispatch; failures can leave durable authority.
      terminal.write('Preparing coding run...\n');
      await dependencies.setup({ ...currentRun, artifact, approvedBy, onProgress: stage });
      requireActive();
      terminal.write('✓ Setup preparation checked; runtime validation remains authoritative\n');
      stage('workspace', 'complete');
      phase = 'launch';
      stage('launch', 'active');
      terminal.write('Starting coding run...\n');
      await dependencies.runPlan(currentRun);
      stage('launch', 'complete');
      terminal.write(
        `Running...\nRun ID: ${runId}\nApproval ID: ${approvalId}\nArtifact: ${artifact.artifactId}\nRepository: ${repositoryPath}\nRun directory: ${runDirectory}\n`
      );
      phase = 'status';
      let previous = '';
      for (;;) {
        if (controller.signal.aborted) {
          await requestCancellation();
          throw new ModelSelectionCancelled('Interactive coding cancelled.');
        }
        const status = await dependencies.statusRun({ runId, runDirectory });
        dependencies.present?.({ type: 'run', status });
        const rendered = renderRunProgress(status);
        if (rendered !== previous) {
          terminal.write(rendered);
        }
        previous = rendered;
        if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(status.state)) {
          terminal.write(renderRunCompletion(status));
          terminal.write(
            `Approval ID: ${approvalId}\nArtifact: ${artifact.artifactId} / revision ${artifact.revision}\nRepository: ${repositoryPath}\nRun directory: ${runDirectory}\n`
          );
          if (status.state !== 'COMPLETED') {
            throw new ModelSelectionError(`Run ${runId} ended ${status.state}.`);
          }
          return;
        }
        try {
          await (dependencies.wait ?? ((signal) => delay(1000, undefined, { signal })))(
            controller.signal
          );
        } catch (error) {
          if (!controller.signal.aborted) {
            throw error;
          }
        }
      }
    }
  } catch (error) {
    if (activeStage !== undefined) {
      dependencies.present?.({
        type: 'stage',
        stage: activeStage,
        state: 'failed'
      });
    }
    if (error instanceof ModelSelectionCancelled || controller.signal.aborted) {
      if (runPrepared) {
        await requestCancellation();
      }
      throw new ModelSelectionCancelled('Interactive coding cancelled.');
    }
    terminal.write(
      `Interactive execution stopped during ${phase}.${currentRun === undefined ? ' No run was launched.' : ` Run ID: ${currentRun.runId}. Approval ID: ${currentRun.approvalId}. Run directory: ${currentRun.runDirectory ?? 'unspecified'}. Inspect durable status before recovery; no automatic retry.`}\n`
    );
    if (phase === 'launch') {
      terminal.write(
        'Temporal launch may have succeeded before the response failed; use forge status/cancel for this exact run.\n'
      );
    }
    if (error instanceof ModelSelectionError) {
      throw error;
    }
    throw new ModelSelectionError(
      'Forge refused to continue. Check deployment configuration or existing operator evidence; provider/driver diagnostics are not printed.'
    );
  } finally {
    process.removeListener('SIGINT', interrupt);
  }
}
