import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { platform } from 'node:process';
import type {
  AgentCommandSandbox,
  AgentCommandSandboxRequest,
  AgentCommandSandboxResult
} from '@ai-native-software-delivery-orchestrator/domain';

const sandboxExecutable = '/usr/bin/sandbox-exec';

const appendOutput = (current: string, chunk: Buffer, maxOutputBytes: number): string =>
  Buffer.concat([Buffer.from(current), chunk])
    .subarray(0, maxOutputBytes)
    .toString('utf8');

const profile = (cwd: string, executable: string, trustedPath: string): string =>
  [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow sysctl-read)',
    '(allow file-read*)',
    `(allow file-read* (subpath "${cwd.replaceAll('"', '\\"')}"))`,
    `(allow file-read* (subpath "${dirname(executable).replaceAll('"', '\\"')}"))`,
    ...trustedPath
      .split(':')
      .filter((path) => path.length > 0)
      .map((path) => `(allow file-read* (subpath "${path.replaceAll('"', '\\"')}"))`)
  ].join(' ');

export class MacosReadOnlyCommandSandbox implements AgentCommandSandbox {
  readonly #sandboxExecutable: string;
  readonly #terminationGraceMs: number;
  readonly #platform: () => string;

  constructor(
    options: {
      readonly executable?: string;
      readonly terminationGraceMs?: number;
      readonly platform?: () => string;
    } = {}
  ) {
    this.#sandboxExecutable = options.executable ?? sandboxExecutable;
    this.#terminationGraceMs = options.terminationGraceMs ?? 5_000;
    this.#platform = options.platform ?? (() => platform);
  }

  async execute({
    profile: sandbox,
    executable,
    args,
    cwd,
    environment,
    trustedPath,
    timeoutMs,
    maxOutputBytes,
    signal
  }: AgentCommandSandboxRequest): Promise<AgentCommandSandboxResult> {
    if (sandbox.kind !== 'macos-read-only') {
      return {
        status: 'failed',
        detail: 'Unsupported command sandbox profile',
        stdout: '',
        stderr: ''
      };
    }
    if (this.#platform() !== 'darwin') {
      return {
        status: 'failed',
        detail: 'macOS command sandbox requires Darwin',
        stdout: '',
        stderr: ''
      };
    }
    return new Promise((resolve) => {
      const child = spawn(
        this.#sandboxExecutable,
        ['-p', profile(cwd, executable, trustedPath), executable, ...args],
        {
          cwd,
          env: { ...environment, PATH: trustedPath },
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe']
        }
      );
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
        signal?.removeEventListener('abort', cancel);
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
        timeoutMs
      );
      const cancel = () => terminate({ status: 'cancelled', stdout, stderr });
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) {
        cancel();
      }
      const limit = () => terminate({ status: 'output-limited', stdout, stderr });
      child.stdout.on('data', (chunk: Buffer) => {
        stdout = appendOutput(stdout, chunk, maxOutputBytes);
        if (Buffer.byteLength(stdout) >= maxOutputBytes) {
          limit();
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = appendOutput(stderr, chunk, maxOutputBytes);
        if (Buffer.byteLength(stderr) >= maxOutputBytes) {
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
