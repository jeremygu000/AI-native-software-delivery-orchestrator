import { spawn } from 'node:child_process';
import type {
  AgentCommandSandbox,
  AgentCommandSandboxRequest,
  AgentCommandSandboxResult
} from '@ai-native-software-delivery-orchestrator/domain';

const appendOutput = (current: string, chunk: Buffer, maxOutputBytes: number): string =>
  Buffer.concat([Buffer.from(current), chunk])
    .subarray(0, maxOutputBytes)
    .toString('utf8');

export class DockerReadOnlyCommandSandbox implements AgentCommandSandbox {
  readonly #dockerExecutable: string;
  readonly #terminationGraceMs: number;

  constructor(
    options: { readonly dockerExecutable?: string; readonly terminationGraceMs?: number } = {}
  ) {
    this.#dockerExecutable = options.dockerExecutable ?? 'docker';
    this.#terminationGraceMs = options.terminationGraceMs ?? 5_000;
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
    const args = [
      'run',
      '--rm',
      '--network',
      'none',
      '--read-only',
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
        env: {},
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      let result: AgentCommandSandboxResult | undefined;
      let settled = false;
      let escalation: ReturnType<typeof setTimeout> | undefined;
      const finish = (fallback: AgentCommandSandboxResult) => {
        if (settled) {
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
        escalation = setTimeout(() => child.kill('SIGKILL'), this.#terminationGraceMs);
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
        finish(result);
      });
      child.once('close', (exitCode) =>
        finish({ status: 'completed', exitCode: exitCode ?? -1, stdout, stderr })
      );
    });
  }
}
