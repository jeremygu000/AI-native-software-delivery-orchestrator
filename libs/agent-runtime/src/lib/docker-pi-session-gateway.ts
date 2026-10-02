import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { StringDecoder } from 'node:string_decoder';
import { PiSessionCancellationConfirmedError, type PiSessionGateway } from './pi-gateway.js';
import type { PiHostModelProxy } from './pi-model-proxy.js';
import {
  parsePiToolCall,
  piSessionFrameLimit,
  protocolObject,
  protocolText
} from './pi-session-protocol.js';

const execute = promisify(execFile);

/** Immutable daemon identity saved by the host before an isolated process starts. */
export interface PersistedPiContainer {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly executable: string;
  readonly args: readonly string[];
}

/** A deployment-owned image speaks the Forge stdio protocol. The container has
 * no repository mount, Docker socket or database credential. Only the host tool
 * callback may touch the workspace; its caller must supply durable fenced tools.
 */
export class DockerPiSessionGateway implements PiSessionGateway {
  constructor(
    private readonly configuration: {
      readonly image: string;
      readonly executable: string;
      readonly args?: readonly string[];
      readonly dockerExecutable?: string;
      readonly timeoutMs?: number;
      readonly modelProxy?: PiHostModelProxy;
      /** Deployment-owned launch reservation, never a task/model-selected name. */
      readonly launchReservation?: string;
      readonly persistCreated?: (container: PersistedPiContainer) => Promise<void>;
    }
  ) {
    if (
      !/^(?:.+@)?sha256:[a-f0-9]{64}$/.test(configuration.image) ||
      !configuration.executable.startsWith('/')
    ) {
      throw new Error('Isolated Pi requires a pinned image and absolute image entrypoint');
    }
    if (
      configuration.launchReservation !== undefined &&
      !/^[a-f0-9-]{36}$/.test(configuration.launchReservation)
    ) {
      throw new Error('Isolated Pi launch reservation must be a UUID');
    }
  }

  async start(
    options: Parameters<PiSessionGateway['start']>[0]
  ): Promise<{ readonly sessionId: string }> {
    if (options.cancellationSignal?.aborted) {
      throw new PiSessionCancellationConfirmedError();
    }
    const docker = this.configuration.dockerExecutable ?? 'docker';
    const name = `forge-pi-${this.configuration.launchReservation ?? randomUUID()}`;
    const command = async (...args: string[]) =>
      execute(docker, args, { timeout: 30_000, maxBuffer: piSessionFrameLimit });
    const inspect = async () => {
      const { stdout } = await command('inspect', name);
      const value: unknown = JSON.parse(stdout);
      if (!Array.isArray(value) || value.length !== 1) {
        throw new Error('Isolated Pi container inspection failed');
      }
      return protocolObject(value[0]);
    };
    await command(
      'create',
      '--name',
      name,
      '--interactive',
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--user',
      '65532:65532',
      '--pids-limit',
      '64',
      '--memory',
      '512m',
      '--cpus',
      '1',
      '--restart',
      'no',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=64m',
      '--workdir',
      '/tmp',
      '--entrypoint',
      this.configuration.executable,
      this.configuration.image,
      ...(this.configuration.args ?? [])
    );
    let confirmedStopped = false;
    try {
      const container = await inspect();
      const config = protocolObject(container.Config);
      const host = protocolObject(container.HostConfig);
      if (
        config.Image !== this.configuration.image ||
        config.User !== '65532:65532' ||
        config.WorkingDir !== '/tmp' ||
        host.ReadonlyRootfs !== true ||
        host.Privileged !== false ||
        host.NetworkMode !== 'none' ||
        host.PidMode !== '' ||
        protocolObject(host.RestartPolicy).Name !== 'no' ||
        !Array.isArray(host.CapDrop) ||
        !host.CapDrop.includes('ALL') ||
        !Array.isArray(host.SecurityOpt) ||
        !host.SecurityOpt.includes('no-new-privileges') ||
        !Array.isArray(container.Mounts) ||
        container.Mounts.length !== 0
      ) {
        throw new Error('Isolated Pi container configuration differs from its confinement');
      }
      // Docker does not inherit the host environment. Image ENV belongs to the
      // trusted pinned deployment image, never to the task repository.
      if (this.configuration.persistCreated !== undefined) {
        const id = protocolText(container.Id);
        if (!/^[a-f0-9]{64}$/.test(id) || container.Name !== `/${name}`) {
          throw new Error('Isolated Pi immutable container identity differs');
        }
        await this.configuration.persistCreated({
          id,
          name,
          image: this.configuration.image,
          executable: this.configuration.executable,
          args: [...(this.configuration.args ?? [])]
        });
      }
      const child = spawn(docker, ['start', '--attach', '--interactive', name], {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      let failure: unknown;
      let sessionId: string | undefined;
      let completed = false;
      let cancellationRequested = false;
      let buffer = '';
      const decoder = new StringDecoder('utf8');
      let queuedBytes = 0;
      let queue = Promise.resolve();
      const seen = new Set<string>();
      let termination: Promise<void> | undefined;
      const modelCancellation = new AbortController();
      const terminate = () => {
        termination ??= (async () => {
          const state = protocolObject((await inspect()).State);
          if (state.Running === true) {
            await command('kill', name);
          }
          await command('wait', name);
          const stopped = protocolObject((await inspect()).State);
          if (
            stopped.Running !== false ||
            stopped.Restarting !== false ||
            stopped.Status !== 'exited'
          ) {
            throw new Error('Isolated Pi shutdown is not confirmed');
          }
          confirmedStopped = true;
        })();
        return termination;
      };
      const fail = (error: unknown) => {
        failure ??= error;
        modelCancellation.abort();
        void terminate().catch((stopError: unknown) => {
          failure = stopError;
          child.kill('SIGKILL');
        });
      };
      const send = (value: unknown) => {
        const frame = `${JSON.stringify(value)}\n`;
        if (Buffer.byteLength(frame) > piSessionFrameLimit || child.stdin.destroyed) {
          throw new Error('Isolated Pi response exceeds the protocol boundary');
        }
        child.stdin.write(frame);
      };
      const handle = async (line: string) => {
        if (failure !== undefined || cancellationRequested) {
          return;
        }
        const message = protocolObject(JSON.parse(line));
        switch (message.type) {
          case 'started':
            if (sessionId !== undefined || completed) {
              throw new Error('Duplicate isolated Pi session start');
            }
            sessionId = protocolText(message.sessionId);
            await options.onStarted(sessionId);
            if (!cancellationRequested) {
              send({ type: 'started-ack' });
            }
            return;
          case 'tool': {
            if (sessionId === undefined || completed) {
              throw new Error('Isolated Pi tool outside an established session');
            }
            const id = protocolText(message.id);
            if (seen.has(id) || seen.size >= 10_000) {
              throw new Error('Duplicate or excessive isolated Pi tool requests');
            }
            seen.add(id);
            const call = parsePiToolCall(message.call);
            if (!options.tools.includes(call.name)) {
              throw new Error('Isolated Pi tool is not enabled');
            }
            const result = await options.executeTool(call);
            if (!cancellationRequested && failure === undefined) {
              send({ type: 'tool-result', id, result });
            }
            return;
          }
          case 'model': {
            if (
              sessionId === undefined ||
              completed ||
              this.configuration.modelProxy === undefined
            ) {
              throw new Error('Isolated model request has no approved host proxy');
            }
            const id = protocolText(message.id);
            if (seen.has(id) || seen.size >= 10_000) {
              throw new Error('Duplicate or excessive isolated model requests');
            }
            seen.add(id);
            try {
              const response = await this.configuration.modelProxy.complete(
                message.context,
                options.tools,
                modelCancellation.signal
              );
              if (!cancellationRequested && failure === undefined) {
                send({ type: 'model-result', id, message: response });
              }
            } catch {
              if (cancellationRequested) {
                return;
              }
              // Provider exceptions may include URLs, headers or credentials.
              throw new Error('Approved host model request failed');
            }
            return;
          }
          case 'completed':
            if (sessionId === undefined || completed || message.sessionId !== sessionId) {
              throw new Error('Invalid isolated Pi completion');
            }
            completed = true;
            child.stdin.end();
            return;
          default:
            throw new Error('Invalid isolated Pi protocol message');
        }
      };
      const cancel = () => {
        cancellationRequested = true;
        modelCancellation.abort();
        void terminate().catch(fail);
      };
      options.cancellationSignal?.addEventListener('abort', cancel, { once: true });
      const timeout = setTimeout(
        () => fail(new Error('Isolated Pi session deadline exceeded')),
        this.configuration.timeoutMs ?? 300_000
      );
      child.stdout.on('data', (data: Buffer) => {
        buffer += decoder.write(data);
        if (Buffer.byteLength(buffer) + queuedBytes > piSessionFrameLimit) {
          fail(new Error('Isolated Pi protocol output limit exceeded'));
          return;
        }
        let end: number;
        while ((end = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          const bytes = Buffer.byteLength(line);
          queuedBytes += bytes;
          queue = queue
            .then(async () => {
              await handle(line);
            })
            .catch(fail)
            .finally(() => {
              queuedBytes -= bytes;
            });
        }
      });
      let stderrBytes = 0;
      child.stderr.on('data', (data: Buffer) => {
        stderrBytes += data.length;
        if (stderrBytes > piSessionFrameLimit) {
          fail(new Error('Isolated Pi stderr limit exceeded'));
        }
      });
      child.stdin.on('error', fail);
      try {
        const exitCode = await new Promise<number | null>((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
          send({ type: 'start', prompt: options.prompt, tools: options.tools });
          if (options.cancellationSignal?.aborted) {
            cancel();
          }
        });
        // A killed container never cancels a host mutation callback halfway
        // through. Drain the callback first; its durable permit remains owned.
        await queue;
        buffer += decoder.end();
        await terminate();
        if (failure !== undefined) {
          throw failure;
        }
        if (cancellationRequested) {
          throw new PiSessionCancellationConfirmedError();
        }
        if (exitCode !== 0 || !completed || sessionId === undefined || buffer.length !== 0) {
          throw new Error('Isolated Pi exited without confirmed protocol completion');
        }
        return { sessionId };
      } finally {
        clearTimeout(timeout);
        options.cancellationSignal?.removeEventListener('abort', cancel);
        await queue;
        await terminate();
      }
    } finally {
      if (confirmedStopped) {
        await command('rm', name);
      }
      // An unconfirmed container is retained for operator recovery, never
      // converted into a falsely confirmed stop or force-removed here.
    }
  }

  /** Recovery only observes/stops the exact registered container. It does not
   * prove that callbacks in a lost host have drained or authorize claim release.
   */
  async stopPersistedContainer(container: PersistedPiContainer): Promise<void> {
    if (
      !/^[a-f0-9]{64}$/.test(container.id) ||
      !/^forge-pi-[a-f0-9-]{36}$/.test(container.name) ||
      container.image !== this.configuration.image ||
      container.executable !== this.configuration.executable ||
      JSON.stringify(container.args) !== JSON.stringify(this.configuration.args ?? [])
    ) {
      throw new Error('Persisted Pi container does not match deployment configuration');
    }
    const command = async (...args: string[]) =>
      execute(this.configuration.dockerExecutable ?? 'docker', args, {
        timeout: 30_000,
        maxBuffer: piSessionFrameLimit
      });
    const inspect = async () => {
      const value: unknown = JSON.parse((await command('inspect', container.id)).stdout);
      if (!Array.isArray(value) || value.length !== 1) {
        throw new Error('Persisted Pi container cannot be inspected');
      }
      const record = protocolObject(value[0]);
      const config = protocolObject(record.Config);
      if (
        record.Id !== container.id ||
        record.Name !== `/${container.name}` ||
        config.Image !== container.image ||
        JSON.stringify(config.Entrypoint) !== JSON.stringify([container.executable]) ||
        JSON.stringify(config.Cmd ?? []) !== JSON.stringify(container.args)
      ) {
        throw new Error('Persisted Pi daemon identity differs');
      }
      return protocolObject(record.State);
    };
    const state = await inspect();
    if (state.Running === true) {
      await command('kill', container.id);
    }
    if (state.Status === 'created' && state.Running === false && state.Restarting === false) {
      // No process ever started. Remove it to prevent a delayed Docker start.
      await command('rm', container.id);
      return;
    }
    await command('wait', container.id);
    const stopped = await inspect();
    if (stopped.Running !== false || stopped.Restarting !== false || stopped.Status !== 'exited') {
      throw new Error('Persisted Pi container stop is unconfirmed');
    }
    // Retain the stopped identity for independent recovery; never replace it.
  }
}
