import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type {
  AgentCommandSandbox,
  AgentCommandSandboxRequest,
  AgentCommandSandboxResult
} from '@ai-native-software-delivery-orchestrator/domain';

const appendOutput = (current: string, chunk: Buffer, maxOutputBytes: number): string =>
  Buffer.concat([Buffer.from(current), chunk])
    .subarray(0, maxOutputBytes)
    .toString('utf8');

const dockerExecutableFromPath = (): string => {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(directory, 'docker');
    if (directory.length > 0 && existsSync(candidate)) {
      return candidate;
    }
  }
  return 'docker';
};

export class DockerReadOnlyCommandSandbox implements AgentCommandSandbox {
  readonly #dockerExecutable: string;
  readonly #terminationGraceMs: number;
  readonly #createContainerName: () => string;

  constructor(
    options: {
      readonly dockerExecutable?: string;
      readonly terminationGraceMs?: number;
      readonly createContainerName?: () => string;
    } = {}
  ) {
    this.#dockerExecutable = options.dockerExecutable ?? dockerExecutableFromPath();
    this.#terminationGraceMs = options.terminationGraceMs ?? 5_000;
    this.#createContainerName =
      options.createContainerName ?? (() => `forge-sandbox-${randomUUID()}`);
  }

  async execute(request: AgentCommandSandboxRequest): Promise<AgentCommandSandboxResult> {
    if (request.profile.kind !== 'docker-read-only') {
      return {
        status: 'failed',
        detail: 'Unsupported command sandbox profile',
        stdout: '',
        stderr: ''
      };
    }
    const containerName = request.containerName ?? this.#createContainerName();
    const args = [
      'run',
      '--name',
      containerName,
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--user',
      '65532:65532',
      '--memory',
      String(request.profile.memoryBytes),
      '--cpus',
      String(request.profile.cpuCount),
      '--pids-limit',
      String(request.profile.pidLimit),
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=64m',
      '--workdir',
      '/workspace',
      '--volume',
      `${request.cwd}:/workspace:ro`,
      '--env',
      `PATH=${request.trustedPath}`,
      ...Object.entries(request.environment).flatMap(([key, value]) => [
        '--env',
        `${key}=${value}`
      ]),
      request.profile.image,
      request.executable,
      ...request.args
    ];
    return new Promise((resolve) => {
      const child = spawn(this.#dockerExecutable, args, {
        cwd: request.cwd,
        env: { HOME: homedir() },
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      let result: AgentCommandSandboxResult | undefined;
      let settled = false;
      let escalation: ReturnType<typeof setTimeout> | undefined;
      let cliSettled = false;
      let containerSettled = false;
      let waitStarted = false;
      const finish = (fallback: AgentCommandSandboxResult) => {
        if (settled || !cliSettled || !containerSettled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (escalation !== undefined) {
          clearTimeout(escalation);
        }
        request.signal?.removeEventListener('abort', cancel);
        resolve(result ?? fallback);
      };
      const terminate = (next: NonNullable<typeof result>) => {
        if (result !== undefined) {
          return;
        }
        result = next;
        child.kill('SIGTERM');
        const killer = spawn(this.#dockerExecutable, ['kill', containerName], {
          cwd: request.cwd,
          env: { HOME: homedir() },
          shell: false,
          stdio: 'ignore'
        });
        const removeContainer = (fallback: AgentCommandSandboxResult) => {
          const remover = spawn(this.#dockerExecutable, ['rm', '-f', containerName], {
            cwd: request.cwd,
            env: { HOME: homedir() },
            shell: false,
            stdio: 'ignore'
          });
          const complete = () => {
            containerSettled = true;
            finish(fallback);
          };
          remover.once('error', complete);
          remover.once('close', complete);
        };
        const waitForContainer = () => {
          if (waitStarted) {
            return;
          }
          waitStarted = true;
          const waiter = spawn(this.#dockerExecutable, ['wait', containerName], {
            cwd: request.cwd,
            env: { HOME: homedir() },
            shell: false,
            stdio: 'ignore'
          });
          waiter.once('error', () => {
            removeContainer(next);
          });
          waiter.once('close', () => {
            removeContainer(next);
          });
        };
        killer.once('error', () => {
          waitForContainer();
        });
        killer.once('close', () => {
          waitForContainer();
        });
        escalation = setTimeout(() => {
          child.kill('SIGKILL');
          waitForContainer();
        }, this.#terminationGraceMs);
      };
      const timeout = setTimeout(
        () => terminate({ status: 'timed-out', stdout, stderr }),
        request.timeoutMs
      );
      const cancel = () => terminate({ status: 'cancelled', stdout, stderr });
      request.signal?.addEventListener('abort', cancel, { once: true });
      if (request.signal?.aborted) {
        cancel();
      }
      const limit = () => terminate({ status: 'output-limited', stdout, stderr });
      child.stdout.on('data', (chunk: Buffer) => {
        stdout = appendOutput(stdout, chunk, request.maxOutputBytes);
        if (Buffer.byteLength(stdout) >= request.maxOutputBytes) {
          limit();
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = appendOutput(stderr, chunk, request.maxOutputBytes);
        if (Buffer.byteLength(stderr) >= request.maxOutputBytes) {
          limit();
        }
      });
      child.once('error', () => {
        result = { status: 'failed', detail: 'Command sandbox could not start', stdout, stderr };
        cliSettled = true;
        containerSettled = true;
        finish(result);
      });
      child.once('close', (exitCode) => {
        cliSettled = true;
        if (result === undefined) {
          const waiter = spawn(this.#dockerExecutable, ['wait', containerName], {
            cwd: request.cwd,
            env: { HOME: homedir() },
            shell: false,
            stdio: 'ignore'
          });
          const removeContainer = () => {
            const remover = spawn(this.#dockerExecutable, ['rm', '-f', containerName], {
              cwd: request.cwd,
              env: { HOME: homedir() },
              shell: false,
              stdio: 'ignore'
            });
            const complete = () => {
              containerSettled = true;
              finish({ status: 'completed', exitCode: exitCode ?? -1, stdout, stderr });
            };
            remover.once('error', complete);
            remover.once('close', complete);
          };
          waiter.once('error', removeContainer);
          waiter.once('close', removeContainer);
        }
        finish({ status: 'completed', exitCode: exitCode ?? -1, stdout, stderr });
      });
    });
  }
}
