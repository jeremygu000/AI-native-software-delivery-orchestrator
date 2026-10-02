import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ execFile: vi.fn(), spawn: vi.fn() }));
vi.mock('node:child_process', () => mocks);
import { DockerPiSessionGateway } from './docker-pi-session-gateway.js';
import { PiSessionCancellationConfirmedError } from './pi-gateway.js';

const image = 'test@sha256:' + 'a'.repeat(64);
const gateway = () =>
  new DockerPiSessionGateway({ image, executable: '/entrypoint', timeoutMs: 2_000 });
let running: boolean;
let inspectOverride: Record<string, unknown>;
let child: EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};
let shutdownFailure: boolean;
const close = (code = 0) => {
  running = false;
  setImmediate(() => {
    child.stdout.end();
    child.stderr.end();
    child.emit('close', code);
  });
};
const frame = (value: unknown) => child.stdout.write(JSON.stringify(value) + '\n');
const request = () => ({
  cwd: '/never-mounted',
  prompt: 'approved',
  tools: ['forge_read' as const],
  onStarted: vi.fn(async () => {}),
  executeTool: vi.fn(async () => ({ content: 'value' }))
});

beforeEach(() => {
  vi.clearAllMocks();
  running = false;
  inspectOverride = {};
  shutdownFailure = false;
  child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn()
  });
  mocks.spawn.mockImplementation(() => {
    running = true;
    return child;
  });
  mocks.execFile.mockImplementation((_exe, args, _options, callback) => {
    if (args[0] === 'inspect') {
      callback(null, {
        stdout: JSON.stringify([
          {
            Config: { Image: image, User: '65532:65532', WorkingDir: '/tmp' },
            HostConfig: {
              ReadonlyRootfs: true,
              Privileged: false,
              NetworkMode: 'none',
              PidMode: '',
              RestartPolicy: { Name: 'no' },
              CapDrop: ['ALL'],
              SecurityOpt: ['no-new-privileges']
            },
            Mounts: [],
            State: { Running: running, Restarting: false, Status: running ? 'running' : 'exited' },
            ...inspectOverride
          }
        ]),
        stderr: ''
      });
    } else if (args[0] === 'kill') {
      if (shutdownFailure) {
        callback(new Error('daemon stop unavailable'));
      } else {
        close(137);
        callback(null, { stdout: '', stderr: '' });
      }
    } else {
      callback(null, { stdout: '', stderr: '' });
    }
  });
});

it('rejects unsafe inspected configuration without starting any process', async () => {
  inspectOverride = { Mounts: [{ Source: '/repository' }] };
  await expect(gateway().start(request())).rejects.toThrow('confinement');
  expect(mocks.spawn).not.toHaveBeenCalled();
  expect(mocks.execFile.mock.calls.some((call) => call[1][0] === 'rm')).toBe(false);
});

it('acknowledges durable start, validates tool replies and requires matching completion', async () => {
  const options = request();
  child.stdin.on('data', (data) => {
    const message = JSON.parse(data.toString());
    if (message.type === 'start') {
      frame({ type: 'started', sessionId: 's' });
    }
    if (message.type === 'started-ack') {
      frame({ type: 'tool', id: '1', call: { name: 'forge_read', path: 'a' } });
    }
    if (message.type === 'tool-result') {
      expect(message.result.content).toBe('value');
      frame({ type: 'completed', sessionId: 's' });
      close();
    }
  });
  await expect(gateway().start(options)).resolves.toEqual({ sessionId: 's' });
  expect(options.onStarted).toHaveBeenCalledExactlyOnceWith('s');
  expect(options.executeTool).toHaveBeenCalledExactlyOnceWith({ name: 'forge_read', path: 'a' });
  expect(mocks.execFile.mock.calls.some((call) => call[1][0] === 'rm')).toBe(true);
});

it.each([
  { type: 'tool', id: 'x', call: { name: 'forge_read', path: 'a' } },
  { type: 'completed', sessionId: 's' },
  { type: 'unknown' }
])('rejects invalid session ordering without invoking a host callback', async (message) => {
  const options = request();
  child.stdin.once('data', () => frame(message));
  await expect(gateway().start(options)).rejects.toThrow();
  expect(options.executeTool).not.toHaveBeenCalled();
});

it('does not acknowledge a rejected durable session or execute queued tool calls', async () => {
  const options = request();
  options.onStarted.mockRejectedValue(new Error('persist failed'));
  child.stdin.once('data', () => {
    frame({ type: 'started', sessionId: 's' });
    frame({ type: 'tool', id: 'x', call: { name: 'forge_read', path: 'a' } });
  });
  await expect(gateway().start(options)).rejects.toThrow('persist failed');
  expect(options.executeTool).not.toHaveBeenCalled();
});

it('never reports confirmed cancellation when the daemon cannot stop the container', async () => {
  shutdownFailure = true;
  const controller = new AbortController();
  child.stdin.once('data', () => {
    frame({ type: 'started', sessionId: 's' });
    controller.abort();
  });
  // Docker CLI loss is not the same as container termination.
  child.kill.mockImplementation(() => {
    close(137);
    return true;
  });
  await expect(
    gateway().start({ ...request(), cancellationSignal: controller.signal })
  ).rejects.toThrow('daemon stop unavailable');
  expect(mocks.execFile.mock.calls.some((call) => call[1][0] === 'rm')).toBe(false);
});

it('rejects cancellation before any Docker create operation', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    gateway().start({ ...request(), cancellationSignal: controller.signal })
  ).rejects.toBeInstanceOf(PiSessionCancellationConfirmedError);
  expect(mocks.execFile).not.toHaveBeenCalled();
});

it.each(['truncated', 'stdout', 'stderr', 'mismatch', 'disabled', 'duplicate'])(
  'rejects %s protocol evidence',
  async (scenario) => {
    const options = request();
    child.stdin.once('data', () => {
      if (scenario === 'stdout') {
        child.stdout.write('x'.repeat(1_048_577));
        return;
      }
      if (scenario === 'stderr') {
        child.stderr.write('x'.repeat(1_048_577));
        return;
      }
      if (scenario === 'truncated') {
        child.stdout.write('{');
        close();
        return;
      }
      frame({ type: 'started', sessionId: 's' });
      if (scenario === 'mismatch') {
        frame({ type: 'completed', sessionId: 'wrong' });
      } else if (scenario === 'disabled') {
        frame({ type: 'tool', id: '1', call: { name: 'forge_command', commandId: 'x' } });
      } else {
        frame({ type: 'started', sessionId: 's' });
      }
    });
    await expect(gateway().start(options)).rejects.toThrow();
    expect(options.executeTool).not.toHaveBeenCalled();
  }
);
