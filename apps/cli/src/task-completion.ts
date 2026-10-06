import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { appendFile, mkdir, readFile, lstat } from 'node:fs/promises';
import {
  PiPlanningGatewayAdapter,
  type PiPlanningGateway
} from '@ai-native-software-delivery-orchestrator/agent-runtime';
import {
  TaskVerificationStatus,
  type RepositoryGraph,
  type TaskCompletionGate,
  type TaskContract,
  type TaskVerifier,
  type TaskVerificationRequest,
  type TaskVerificationResult,
  type PredictedTaskImpact
} from '@ai-native-software-delivery-orchestrator/domain';
import { z } from 'zod';
import { CompletionStage, CompletionScope, CompletionOutcome } from './completion-values.js';

const execute = promisify(execFile);
const outputReviewRecommendationSchema = z.enum(['accept', 'reject']);
export const OutputReviewRecommendation = outputReviewRecommendationSchema.enum;
const reviewSchema = z
  .object({
    recommendation: outputReviewRecommendationSchema,
    summary: z.string().trim().min(1),
    findings: z.array(z.object({ path: z.string().min(1), detail: z.string().trim().min(1) }))
  })
  .strict()
  .superRefine((review, context) => {
    if (
      review.recommendation === OutputReviewRecommendation.accept &&
      review.findings.length !== 0
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Accepted output cannot have unresolved findings.'
      });
    }
    if (
      review.recommendation !== OutputReviewRecommendation.accept &&
      review.findings.length === 0
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Rejected output needs actionable findings.'
      });
    }
  });
export type OutputReview = z.infer<typeof reviewSchema>;
export interface CompletionDiff {
  readonly paths: readonly string[];
  readonly patch: string;
}
export class PiOutputReviewer implements OutputReviewer {
  constructor(readonly gateway: PiPlanningGateway = new PiPlanningGatewayAdapter()) {}
  async review(request: Parameters<OutputReviewer['review']>[0]): Promise<OutputReview> {
    const response = await this.gateway.generate({
      cwd: request.workspace.workspacePath,
      prompt: `Review the coding output against this task, actual diff and repository verification. Return ONLY JSON {recommendation: "accept"|"reject", summary: string, findings: [{path, detail}]}. For accept, findings MUST be an empty array: findings represent unresolved defects, not praise or a list of completed changes. For reject, include at least one actionable unresolved defect. Every finding must name one of these exact changed paths: ${JSON.stringify(request.diff.paths)}. Explain accepted changes in summary only. Do not execute commands or edit files.\n${JSON.stringify({ task: request.task, diff: request.diff, verification: request.verification })}\nResponse contract: output exactly one JSON object, beginning with { and ending with }. No Markdown fences, introduction, analysis, or text outside that object. All three fields are REQUIRED: recommendation, summary, findings. Acceptance shape: {"recommendation":"accept","summary":"Explain the accepted changes here.","findings":[]}. Rejection shape: {"recommendation":"reject","summary":"Explain the rejection here.","findings":[{"path":"an exact changed path","detail":"an actionable unresolved defect"}]}. Never omit findings, including for accept.`,
      executeTool: async () => ({
        content: 'Output review uses the supplied diff only.',
        isError: true
      })
    });
    return reviewSchema.parse(JSON.parse(response.output));
  }
}
export interface OutputReviewer {
  review(
    request: TaskVerificationRequest & {
      readonly diff: CompletionDiff;
      readonly verification: TaskVerificationResult;
      readonly round: number;
    }
  ): Promise<OutputReview>;
}
function inside(root: string, path: string): boolean {
  const result = relative(root, path);
  return (
    result === '' || (!isAbsolute(result) && result !== '..' && !result.startsWith(`..${sep}`))
  );
}

/** Executes only the verification rules saved in the approved local plan, without a shell for package scripts. */
export class RepositoryTaskVerifier implements TaskVerifier {
  constructor(
    readonly graph: RepositoryGraph,
    readonly timeoutMs = 120_000
  ) {}

  async verify(request: TaskVerificationRequest): Promise<TaskVerificationResult> {
    if (request.task.verification.length === 0) {
      return {
        status: TaskVerificationStatus.Failed,
        detail: 'No repository verification rules were planned.'
      };
    }
    for (const rule of request.task.verification) {
      let cwd = request.workspace.workspacePath;
      let command: string;
      let args: string[];
      if (rule.type === 'package-script') {
        const project = [...this.graph.projects.values()].find(
          (p) => p.id === rule.packageName || p.name === rule.packageName
        );
        if (project === undefined || project.scripts[rule.script] === undefined) {
          return {
            status: TaskVerificationStatus.Failed,
            detail: `Unknown planned package script: ${rule.packageName}.${rule.script}`
          };
        }
        cwd = resolve(cwd, project.root);
        command = 'npm';
        args = ['run', rule.script];
      } else {
        cwd = resolve(cwd, rule.cwd ?? '.');
        // A command rule is explicitly approved repository code, not an agent-provided command.
        command = '/bin/sh';
        args = ['-c', rule.command];
      }
      if (!inside(request.workspace.workspacePath, cwd)) {
        return {
          status: TaskVerificationStatus.Failed,
          detail: 'Verification cwd must stay inside the task worktree.'
        };
      }
      try {
        await execute(command, args, {
          cwd,
          timeout: this.timeoutMs,
          maxBuffer: 1024 * 1024,
          env: { ...process.env, CI: 'true' }
        });
      } catch (error) {
        const result = z
          .object({ stdout: z.string().optional(), stderr: z.string().optional() })
          .passthrough()
          .safeParse(error);
        const output = result.success
          ? `${result.data.stdout ?? ''}\n${result.data.stderr ?? ''}`.slice(-8192)
          : '';
        return {
          status: TaskVerificationStatus.Failed,
          detail: `Repository verification failed: ${rule.type === 'command' ? rule.command : `${rule.packageName}.${rule.script}`}\n${output}`
        };
      }
    }
    return { status: TaskVerificationStatus.Passed };
  }
}

export class LocalTaskCompletionPipeline implements TaskCompletionGate {
  constructor(
    readonly options: {
      readonly graph: RepositoryGraph;
      readonly impacts: readonly PredictedTaskImpact[];
      readonly verifier: TaskVerifier;
      readonly reviewer: OutputReviewer;
      readonly evidenceDirectory: string;
    }
  ) {}

  async #diff(request: TaskVerificationRequest): Promise<CompletionDiff> {
    const cwd = request.workspace.workspacePath;
    const head = await execute('git', ['rev-parse', 'HEAD'], { cwd });
    if (head.stdout.trim() !== request.workspace.baseRef) {
      // baseRef is the saved plan commit. Agent commits would otherwise hide changes from a working-tree-only check.
      throw new Error(
        'Writer changed the task worktree HEAD; completion requires uncommitted task changes.'
      );
    }
    const tracked = await execute(
      'git',
      ['diff', '--name-only', '--no-renames', '-z', request.workspace.baseRef],
      {
        cwd
      }
    );
    const untracked = await execute('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
      cwd
    });
    const paths = [
      ...new Set(`${tracked.stdout}${untracked.stdout}`.split('\0').filter(Boolean))
    ].toSorted();
    const patch = await execute(
      'git',
      ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', request.workspace.baseRef, '--'],
      { cwd, maxBuffer: 1024 * 1024 }
    );
    const newFiles = await Promise.all(
      untracked.stdout
        .split('\0')
        .filter(Boolean)
        .map(async (path) => {
          const file = resolve(cwd, path);
          const stat = await lstat(file);
          if (!stat.isFile() || stat.size > 1024 * 1024) {
            throw new Error(`New file cannot be reviewed as bounded text: ${path}`);
          }
          const content = await readFile(file, 'utf8');
          if (content.includes('\0')) {
            throw new Error(`New binary file requires a different review path: ${path}`);
          }
          return { path, content };
        })
    );
    const fullPatch = `${patch.stdout}${newFiles.map((file) => `\n--- new file: ${file.path}\n${file.content}`).join('')}`;
    if (Buffer.byteLength(fullPatch) > 1024 * 1024) {
      throw new Error('Actual diff is too large for local output review (1 MiB).');
    }
    return { paths, patch: fullPatch };
  }

  #outsideScope(task: TaskContract, paths: readonly string[]): readonly string[] {
    const impact = this.options.impacts.find((candidate) => candidate.taskId === task.id);
    if (impact === undefined) {
      throw new Error(`Missing predicted impact: ${task.id}`);
    }
    const files = new Set(
      [...impact.filesWritten]
        .map((id) => this.options.graph.files.get(id)?.path)
        .filter((path) => path !== undefined)
    );
    const roots = [...impact.explicitProjectsWritten]
      .map((id) => this.options.graph.projects.get(id)?.root)
      .filter((root) => root !== undefined);
    // Symbol and glob selectors already resolve to files during planning; they do not authorize unrelated files.
    return paths.filter(
      (path) =>
        !files.has(path) && !roots.some((root) => inside(resolve('/', root), resolve('/', path)))
    );
  }

  async complete(
    request: Parameters<TaskCompletionGate['complete']>[0]
  ): Promise<TaskVerificationResult> {
    try {
      return await this.#complete(request);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Completion checks failed.';
      await mkdir(this.options.evidenceDirectory, { recursive: true });
      await appendFile(
        resolve(this.options.evidenceDirectory, `${request.workspace.id}.jsonl`),
        `${JSON.stringify({ completion: CompletionOutcome.Failed, detail })}\n`
      );
      return {
        status: TaskVerificationStatus.Failed,
        detail
      };
    }
  }

  async #complete(
    request: Parameters<TaskCompletionGate['complete']>[0]
  ): Promise<TaskVerificationResult> {
    await mkdir(this.options.evidenceDirectory, { recursive: true });
    const record = async (value: unknown) =>
      appendFile(
        resolve(this.options.evidenceDirectory, `${request.workspace.id}.jsonl`),
        `${JSON.stringify(value)}\n`
      );
    const round = 0;
    const diff = await this.#diff(request);
    if (diff.paths.length === 0) {
      await record({
        round,
        diff,
        completion: CompletionOutcome.Failed,
        detail: 'Writer produced no changes.'
      });
      return {
        status: TaskVerificationStatus.Failed,
        detail: 'Writer produced no changes; nothing to verify or integrate.'
      };
    }
    const outside = this.#outsideScope(request.task, diff.paths);
    if (outside.length > 0) {
      await record({ round, diff, scope: CompletionScope.Rejected, outside });
      return {
        status: TaskVerificationStatus.Failed,
        detail: `Actual diff exceeds planned scope: ${outside.join(', ')}`
      };
    }
    await record({
      stage: CompletionStage.Verifying,
      taskId: request.task.id,
      diff,
      scope: CompletionScope.Matched
    });
    const verification = await this.options.verifier.verify(request);
    if (verification.status === TaskVerificationStatus.Failed) {
      await record({
        taskId: request.task.id,
        diff,
        scope: CompletionScope.Matched,
        plannedVerification: request.task.verification,
        verification
      });
      return verification;
    }
    await record({ stage: CompletionStage.Reviewing, taskId: request.task.id, verification });
    const review = reviewSchema.parse(
      await this.options.reviewer.review({ ...request, diff, verification, round })
    );
    if (review.findings.some((finding) => !diff.paths.includes(finding.path))) {
      throw new Error('Output review finding must name an actual changed path.');
    }
    await record({
      taskId: request.task.id,
      diff,
      scope: CompletionScope.Matched,
      plannedVerification: request.task.verification,
      verification,
      review
    });
    if (review.recommendation === OutputReviewRecommendation.accept) {
      // Review and verification may read the worktree, but must not silently alter what was approved.
      const after = await this.#diff(request);
      if (JSON.stringify(after) !== JSON.stringify(diff)) {
        return {
          status: TaskVerificationStatus.Failed,
          detail: 'Worktree changed during verification/review; not integrating unchecked changes.'
        };
      }
      return { status: TaskVerificationStatus.Passed };
    }
    return { status: TaskVerificationStatus.Failed, detail: review.summary };
  }
}
