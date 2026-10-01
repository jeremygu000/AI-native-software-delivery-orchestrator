import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  GitWorkspaceStateInspector,
  type GitWorkspaceInspection,
  type GitWorkspaceInspectionRequest
} from './git-workspace-state-inspector.js';

const digestImage = /@sha256:[0-9a-f]{64}$/;
const containerIdPattern = /^[0-9a-f]{64}$/;

export interface SupervisedWorkspaceGeneration {
  readonly scopeId: string;
  readonly parentClaimId: string;
  readonly generationId: string;
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly workspaceDevice: string;
  readonly workspaceInode: string;
  readonly supervisorId: string;
  readonly containerId: string;
}

/** A container observation, not a signed quiescence or handoff attestation. */
export interface StoppedWorkspaceGeneration {
  readonly generation: SupervisedWorkspaceGeneration;
  readonly exitCode: number;
}

export class DockerGenerationSupervisorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DockerGenerationSupervisorError';
  }
}

type JsonObject = Record<string, unknown>;

const object = (value: unknown): JsonObject => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DockerGenerationSupervisorError('Invalid Docker inspection result');
  }
  return Object.fromEntries(Object.entries(value));
};

const array = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) {
    throw new DockerGenerationSupervisorError('Invalid Docker inspection result');
  }
  return value;
};

const required = (value: string): string => {
  if (!value.trim()) {
    throw new DockerGenerationSupervisorError('Generation identity must not be empty');
  }
  return value;
};

const labels = (generation: Omit<SupervisedWorkspaceGeneration, 'containerId'>) => ({
  'forge.supervisor': generation.supervisorId,
  'forge.scope': generation.scopeId,
  'forge.parent': generation.parentClaimId,
  'forge.generation': generation.generationId,
  'forge.workspace': generation.workspaceId
});

const containerName = (generation: Omit<SupervisedWorkspaceGeneration, 'containerId'>): string =>
  `forge-generation-${createHash('sha256')
    .update(JSON.stringify([generation.scopeId, generation.generationId]))
    .digest('hex')}`;

/**
 * Only an independent supervisor may hold Docker daemon credentials. The
 * writer container cannot access the daemon; its deterministic name remains
 * reserved after stopping so this supervisor cannot accidentally launch the
 * same generation again. An actor with Docker daemon access is outside this
 * boundary and must never share credentials with the worker.
 */
export class DockerWorkspaceGenerationSupervisor {
  readonly #docker: string;
  readonly #supervisorId: string;
  readonly #image: string;

  constructor(configuration: {
    readonly supervisorId: string;
    readonly image: string;
    readonly dockerExecutable?: string;
  }) {
    this.#supervisorId = required(configuration.supervisorId);
    if (!digestImage.test(configuration.image)) {
      throw new DockerGenerationSupervisorError('Supervisor image must be pinned by SHA256 digest');
    }
    this.#image = configuration.image;
    this.#docker = configuration.dockerExecutable ?? 'docker';
  }

  async #command(args: readonly string[]): Promise<string> {
    return new Promise((complete, reject) => {
      execFile(
        this.#docker,
        [...args],
        { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          if (error !== null) {
            reject(new DockerGenerationSupervisorError(`Docker supervisor ${args[0]} failed`));
            return;
          }
          complete(stdout.trim());
        }
      );
    });
  }

  async launch(request: {
    readonly scopeId: string;
    readonly parentClaimId: string;
    readonly generationId: string;
    readonly workspaceId: string;
    readonly workspacePath: string;
    readonly command: readonly string[];
  }): Promise<SupervisedWorkspaceGeneration> {
    if (request.command.length === 0 || request.command.some((arg) => !arg.trim())) {
      throw new DockerGenerationSupervisorError('An explicit worker command is required');
    }
    const workspacePath = await realpath(resolve(request.workspacePath));
    const workspaceIdentity = await stat(workspacePath, { bigint: true });
    if (!workspaceIdentity.isDirectory()) {
      throw new DockerGenerationSupervisorError('Supervised workspace must be a directory');
    }
    const generation = {
      scopeId: required(request.scopeId),
      parentClaimId: required(request.parentClaimId),
      generationId: required(request.generationId),
      workspaceId: required(request.workspaceId),
      workspacePath,
      workspaceDevice: workspaceIdentity.dev.toString(),
      workspaceInode: workspaceIdentity.ino.toString(),
      supervisorId: this.#supervisorId
    };
    const id = await this.#command([
      'create',
      '--name',
      containerName(generation),
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      '128',
      '--user',
      '65532:65532',
      '--restart',
      'no',
      '--tmpfs',
      '/tmp:rw,nosuid,noexec,size=64m',
      '--workdir',
      '/workspace',
      '--mount',
      `type=bind,source=${generation.workspacePath},target=/workspace`,
      ...Object.entries(labels(generation)).flatMap(([key, value]) => [
        '--label',
        `${key}=${value}`
      ]),
      this.#image,
      ...request.command
    ]);
    if (!containerIdPattern.test(id)) {
      throw new DockerGenerationSupervisorError('Docker did not return an immutable container ID');
    }
    const binding = { ...generation, containerId: id };
    // Verify the container before permitting a process to reach the workspace.
    await this.#inspect(binding);
    try {
      await this.#command(['start', id]);
    } catch (error) {
      // A lost start response can leave a running writer. Keep its identity
      // reserved and try to contain it; never mint a replacement generation.
      try {
        await this.stopAndVerify(binding);
      } catch {
        throw new DockerGenerationSupervisorError(
          'Worker start outcome is unknown and containment was not confirmed'
        );
      }
      throw error;
    }
    return binding;
  }

  async #inspect(generation: SupervisedWorkspaceGeneration): Promise<JsonObject> {
    if (!containerIdPattern.test(generation.containerId)) {
      throw new DockerGenerationSupervisorError('Invalid container identity');
    }
    const output = await this.#command(['inspect', generation.containerId]);
    let inspect: JsonObject;
    try {
      const parsed: unknown = JSON.parse(output);
      const items = array(parsed);
      if (items.length !== 1) {
        throw new DockerGenerationSupervisorError('Invalid Docker inspection result');
      }
      inspect = object(items[0]);
    } catch {
      throw new DockerGenerationSupervisorError('Invalid Docker inspection result');
    }
    const config = object(inspect['Config']);
    const host = object(inspect['HostConfig']);
    const mount = array(inspect['Mounts']);
    const registeredLabels = object(config['Labels']);
    const restart = object(host['RestartPolicy']);
    const capDrop = array(host['CapDrop']);
    const security = array(host['SecurityOpt']);
    if (
      inspect['Id'] !== generation.containerId ||
      inspect['Name'] !== `/${containerName(generation)}` ||
      config['Image'] !== this.#image ||
      config['User'] !== '65532:65532' ||
      config['WorkingDir'] !== '/workspace' ||
      (config['Volumes'] !== null && config['Volumes'] !== undefined) ||
      Object.entries(labels(generation)).some(([key, value]) => registeredLabels[key] !== value) ||
      host['Privileged'] !== false ||
      host['PidMode'] !== '' ||
      host['NetworkMode'] !== 'none' ||
      restart['Name'] !== 'no' ||
      host['ReadonlyRootfs'] !== true ||
      !capDrop.includes('ALL') ||
      !security.includes('no-new-privileges') ||
      mount.length !== 1 ||
      object(mount[0])['Type'] !== 'bind' ||
      object(mount[0])['Source'] !== generation.workspacePath ||
      object(mount[0])['Destination'] !== '/workspace' ||
      object(mount[0])['RW'] !== true
    ) {
      throw new DockerGenerationSupervisorError(
        'Container containment or generation identity differs'
      );
    }
    return inspect;
  }

  /** Call only after separately committing durable generation revocation. */
  async stopAndVerify(
    generation: SupervisedWorkspaceGeneration
  ): Promise<StoppedWorkspaceGeneration> {
    await this.#assertWorkspaceIdentity(generation);
    const previous = object((await this.#inspect(generation))['State']);
    if (previous['Running'] === true) {
      await this.#command(['kill', generation.containerId]);
    }
    await this.#command(['wait', generation.containerId]);
    await this.assertStopped(generation);
    const state = object((await this.#inspect(generation))['State']);
    if (!Number.isInteger(state['ExitCode'])) {
      throw new DockerGenerationSupervisorError('Missing container exit status');
    }
    return { generation, exitCode: Number(state['ExitCode']) };
  }

  async assertStopped(generation: SupervisedWorkspaceGeneration): Promise<void> {
    await this.#assertWorkspaceIdentity(generation);
    const state = object((await this.#inspect(generation))['State']);
    if (
      state['Running'] !== false ||
      state['Restarting'] !== false ||
      state['Status'] !== 'exited'
    ) {
      throw new DockerGenerationSupervisorError(
        'The worker container and its descendants are not stopped'
      );
    }
  }

  /**
   * Recheck Docker on both sides of read-only Git inspection. This is still an
   * observation: no signed proof, atomic cross-system lock, or PG handoff is
   * produced here.
   */
  async inspectStoppedWorkspace(
    generation: SupervisedWorkspaceGeneration,
    request: GitWorkspaceInspectionRequest
  ): Promise<GitWorkspaceInspection> {
    if (
      generation.workspaceId !== request.workspace.id ||
      generation.workspacePath !== (await realpath(resolve(request.workspace.workspacePath)))
    ) {
      throw new DockerGenerationSupervisorError('Git workspace differs from stopped generation');
    }
    await this.assertStopped(generation);
    const inspection = await new GitWorkspaceStateInspector().inspect(request);
    await this.assertStopped(generation);
    return inspection;
  }

  async #assertWorkspaceIdentity(generation: SupervisedWorkspaceGeneration): Promise<void> {
    if (
      generation.supervisorId !== this.#supervisorId ||
      generation.workspacePath !== (await realpath(resolve(generation.workspacePath)))
    ) {
      throw new DockerGenerationSupervisorError('Generation does not belong to this supervisor');
    }
    const current = await stat(generation.workspacePath, { bigint: true });
    if (
      !current.isDirectory() ||
      current.dev.toString() !== generation.workspaceDevice ||
      current.ino.toString() !== generation.workspaceInode
    ) {
      throw new DockerGenerationSupervisorError('Supervised workspace directory was replaced');
    }
  }
}
