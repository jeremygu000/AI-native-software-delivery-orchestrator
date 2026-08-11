import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import type {
  AgentCommandExecutionResult,
  AgentCommandExecutor,
  AgentCommandPolicy
} from '@ai-native-software-delivery-orchestrator/domain';

import { AgentToolDeniedError } from './agent-tool-runtime.js';

const appendOutput = (current: string, chunk: Buffer, maxOutputBytes: number): string =>
  Buffer.concat([Buffer.from(current), chunk])
    .subarray(0, maxOutputBytes)
    .toString('utf8');

export class AgentCommandRuntime {
  readonly #executor: AgentCommandExecutor;
  #policy: AgentCommandPolicy | undefined;
  #workspacePath: string | undefined;

  constructor(executor: AgentCommandExecutor) {
    this.#executor = executor;
  }

  bindRuntimePolicy(policy: AgentCommandPolicy | undefined, workspacePath: string): void {
    this.#policy = policy;
    this.#workspacePath = workspacePath;
  }

  async run(commandId: string): Promise<AgentCommandExecutionResult> {
    const policy = this.#policy;
    const workspacePath = this.#workspacePath;
    const command = policy?.commands.find((candidate) => candidate.id === commandId);
    if (command === undefined || workspacePath === undefined || policy === undefined) {
      throw new AgentToolDeniedError(`Agent command is not allowed: ${commandId}`);
    }
    return this.#executor.execute({
      command,
      cwd: workspacePath,
      environment: policy.environment
    });
  }
}

export class NodeAgentCommandExecutor implements AgentCommandExecutor {
  readonly #terminationGraceMs: number;
  readonly #trustedPath: string;

  constructor(
    options: { readonly terminationGraceMs?: number; readonly trustedPath?: string } = {}
  ) {
    this.#terminationGraceMs = options.terminationGraceMs ?? 5_000;
    this.#trustedPath =
      options.trustedPath ?? `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`;
  }

  async execute({
    command,
    cwd,
    environment,
    signal
  }: Parameters<AgentCommandExecutor['execute']>[0]) {
    return new Promise<AgentCommandExecutionResult>((resolve) => {
      const child = spawn(command.executable, command.args, {
        cwd,
        env: { ...environment, PATH: this.#trustedPath },
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      let result: AgentCommandExecutionResult | undefined;
      let termination: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const finish = (fallback: AgentCommandExecutionResult) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (termination !== undefined) {
          clearTimeout(termination);
        }
        signal?.removeEventListener('abort', cancel);
        resolve(result ?? fallback);
      };
      const terminate = (nextResult: AgentCommandExecutionResult) => {
        if (result !== undefined) {
          return;
        }
        result = nextResult;
        child.kill('SIGTERM');
        termination = setTimeout(() => child.kill('SIGKILL'), this.#terminationGraceMs);
      };
      const timeout = setTimeout(() => {
        terminate({ status: 'timed-out', stdout, stderr });
      }, command.timeoutMs);
      const cancel = () => {
        terminate({ status: 'cancelled', stdout, stderr });
      };
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted === true) {
        cancel();
      }
      const limitOutput = () => {
        terminate({ status: 'output-limited', stdout, stderr });
      };
      child.stdout.on('data', (chunk: Buffer) => {
        stdout = appendOutput(stdout, chunk, command.maxOutputBytes);
        if (Buffer.byteLength(stdout) >= command.maxOutputBytes) {
          limitOutput();
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = appendOutput(stderr, chunk, command.maxOutputBytes);
        if (Buffer.byteLength(stderr) >= command.maxOutputBytes) {
          limitOutput();
        }
      });
      child.once('error', () => {
        result = {
          status: 'failed',
          detail: `Command could not start: ${command.id}`,
          stdout,
          stderr
        };
        finish(result);
      });
      child.once('close', (exitCode) => {
        finish({ status: 'completed', exitCode: exitCode ?? -1, stdout, stderr });
      });
    });
  }
}
