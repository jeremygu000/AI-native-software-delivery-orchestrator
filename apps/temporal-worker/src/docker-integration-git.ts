import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { TaskWorkspace } from '@ai-native-software-delivery-orchestrator/domain';
import type { GitCommandRunner } from '@ai-native-software-delivery-orchestrator/workspace-git';

const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid Git container inspection object');
  }
  return Object.fromEntries(Object.entries(value));
};
const list = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) {
    throw new Error('Invalid Git container inspection list');
  }
  return value;
};

const command = (
  executable: string,
  args: readonly string[]
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((complete, reject) => {
    execFile(
      executable,
      [...args],
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`Confined Git command failed: ${stderr}`));
        } else {
          complete({ stdout, stderr });
        }
      }
    );
  });

/** Each Git command runs in a generation-private, networkless container. A lost
 * daemon response retains the container and cannot produce a stop receipt. */
export class DockerIntegrationGit implements GitCommandRunner {
  #evidence: string[] = [];
  #failed = false;
  constructor(
    private readonly options: {
      image: string;
      workspace: TaskWorkspace;
      commitIdentity?: { name: string; email: string };
      dockerExecutable?: string;
    }
  ) {
    if (!/^(?:[^\s]+@)?sha256:[a-f0-9]{64}$/.test(options.image)) {
      throw new Error('Integration Git image must be digest pinned');
    }
    if (
      options.commitIdentity !== undefined &&
      [options.commitIdentity.name, options.commitIdentity.email].some(
        (value) => value.trim().length === 0 || /[\r\n\0]/.test(value)
      )
    ) {
      throw new Error('Git commit identity must be nonempty single-line values');
    }
  }
  async run(cwd: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
    const root = await realpath(resolve(this.options.workspace.integrationRepositoryPath));
    const worktree = await realpath(resolve(this.options.workspace.workspacePath));
    const directory = await realpath(resolve(cwd));
    if (directory !== root && directory !== worktree) {
      throw new Error('Git cwd is outside approved workspaces');
    }
    const common = (
      await command('git', ['-C', root, 'rev-parse', '--git-common-dir'])
    ).stdout.trim();
    const commonPath = await realpath(resolve(root, common));
    const name = `forge-git-${randomUUID()}`;
    const docker = this.options.dockerExecutable ?? 'docker';
    const identityArgs =
      this.options.commitIdentity === undefined
        ? []
        : [
            '-c',
            `user.name=${this.options.commitIdentity.name}`,
            '-c',
            `user.email=${this.options.commitIdentity.email}`
          ];
    try {
      await command(docker, [
        'create',
        '--name',
        name,
        '--network',
        'none',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--pids-limit',
        '64',
        '--memory',
        '512m',
        '--cpus',
        '1',
        '--restart',
        'no',
        '--tmpfs',
        '/tmp:rw,nosuid,nodev,size=64m',
        '--tmpfs',
        '/git:rw,nosuid,nodev,size=1m',
        ...[...new Set([root, worktree, commonPath])].flatMap((path) => [
          '--mount',
          `type=bind,src=${path},dst=${path}`
        ]),
        '--workdir',
        directory,
        '--env',
        'HOME=/tmp',
        '--env',
        'GIT_CONFIG_NOSYSTEM=1',
        '--env',
        'GIT_CONFIG_GLOBAL=/dev/null',
        '--env',
        'GIT_TERMINAL_PROMPT=0',
        '--env',
        'GIT_EDITOR=true',
        '--env',
        'GIT_SEQUENCE_EDITOR=true',
        '--entrypoint',
        'git',
        this.options.image,
        '-c',
        'safe.directory=*',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'tag.gpgsign=false',
        '-c',
        'protocol.allow=never',
        ...identityArgs,
        ...args
      ]);
      const inspected: unknown = JSON.parse((await command(docker, ['inspect', name])).stdout);
      if (!Array.isArray(inspected) || inspected.length !== 1) {
        throw new Error('Invalid Git container inspection');
      }
      const container = object(inspected[0]);
      const config = object(container.Config);
      const host = object(container.HostConfig);
      const mounts = list(container.Mounts).map(object);
      const expectedMounts = [...new Set([root, worktree, commonPath])];
      if (
        config.Image !== this.options.image ||
        config.WorkingDir !== directory ||
        JSON.stringify(config.Entrypoint) !== JSON.stringify(['git']) ||
        JSON.stringify(config.Cmd) !==
          JSON.stringify([
            '-c',
            'safe.directory=*',
            '-c',
            'core.hooksPath=/dev/null',
            '-c',
            'commit.gpgsign=false',
            '-c',
            'tag.gpgsign=false',
            '-c',
            'protocol.allow=never',
            ...identityArgs,
            ...args
          ]) ||
        (config.Volumes !== undefined &&
          config.Volumes !== null &&
          JSON.stringify(Object.keys(object(config.Volumes))) !== JSON.stringify(['/git'])) ||
        Object.keys(object(host.Tmpfs)).length !== 2 ||
        object(host.Tmpfs)['/tmp'] !== 'rw,nosuid,nodev,size=64m' ||
        object(host.Tmpfs)['/git'] !== 'rw,nosuid,nodev,size=1m' ||
        host.NetworkMode !== 'none' ||
        host.ReadonlyRootfs !== true ||
        host.Privileged !== false ||
        host.PidsLimit !== 64 ||
        host.Memory !== 512 * 1024 * 1024 ||
        host.NanoCpus !== 1_000_000_000 ||
        object(host.RestartPolicy).Name !== 'no' ||
        !list(host.CapDrop).includes('ALL') ||
        !list(host.SecurityOpt).includes('no-new-privileges') ||
        mounts.length !== expectedMounts.length ||
        expectedMounts.some(
          (path) =>
            !mounts.some(
              (mount) =>
                mount.Type === 'bind' &&
                mount.Source === path &&
                mount.Destination === path &&
                mount.RW === true
            )
        )
      ) {
        throw new Error('Git container confinement differs from the approved mounts');
      }
      const result = await command(docker, ['start', '--attach', name]);
      const state = (
        await command(docker, [
          'inspect',
          '--format',
          '{{.State.Status}} {{.State.Running}} {{.State.Restarting}}',
          name
        ])
      ).stdout.trim();
      if (state !== 'exited false false') {
        throw new Error('Git container is not confirmed stopped');
      }
      await command(docker, ['rm', name]);
      this.#evidence.push(name);
      return result;
    } catch (error) {
      this.#failed = true;
      // Preserve identity on ambiguity; repository authority remains uncertain.
      throw error;
    }
  }
  confirmedStopEvidence(): string {
    if (this.#failed || this.#evidence.length === 0) {
      throw new Error('Git process tree has no confirmed stop receipt');
    }
    return `Docker Git process trees exited: ${this.#evidence.join(',')}`;
  }
}
