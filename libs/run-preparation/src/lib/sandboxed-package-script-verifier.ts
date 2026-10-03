import { randomUUID } from 'node:crypto';

import {
  defaultAgentCommandTrustedPath,
  type AgentCommandSandbox,
  type AgentCommandSandboxProfile,
  type RepositoryGraph,
  type TaskVerifier
} from '@ai-native-software-delivery-orchestrator/domain';
import { DockerReadOnlyCommandSandbox } from '@ai-native-software-delivery-orchestrator/agent-runtime';

type DockerVerificationProfile = Extract<
  AgentCommandSandboxProfile,
  { readonly kind: 'docker-read-only' }
>;

export interface SandboxedVerificationPolicy {
  readonly version: 2;
  readonly autonomousRules: readonly ['package-script-required', 'free-form-command-forbidden'];
  readonly packageScriptRunner: 'npm-from-pinned-node-image';
  readonly executionProfile: DockerVerificationProfile;
}

const dockerDigestImage = /^(?:[^\s]+@)?sha256:[a-f0-9]{64}$/;

/** These settings form part of the approval fingerprint, never a runtime-only override. */
export function resolveVerificationPolicy(
  base: SandboxedVerificationPolicy,
  environment: Readonly<Record<string, string | undefined>>
): SandboxedVerificationPolicy {
  const image = environment.FORGE_VERIFICATION_IMAGE;
  if (image === undefined) {
    if (
      environment.FORGE_VERIFICATION_TEMPORARY_BYTES !== undefined ||
      environment.FORGE_VERIFICATION_TEMPORARY_EXECUTABLE !== undefined
    ) {
      throw new Error('Verification temporary settings require an explicitly pinned image');
    }
    return base;
  }
  if (!dockerDigestImage.test(image)) {
    throw new Error('Verification image must be digest pinned');
  }
  const temporaryBytes = Number(environment.FORGE_VERIFICATION_TEMPORARY_BYTES ?? 67_108_864);
  const executable = environment.FORGE_VERIFICATION_TEMPORARY_EXECUTABLE ?? 'false';
  if (
    !Number.isSafeInteger(temporaryBytes) ||
    temporaryBytes < 67_108_864 ||
    temporaryBytes > 4_294_967_296 ||
    !['true', 'false'].includes(executable)
  ) {
    throw new Error('Invalid approved verification temporary settings');
  }
  return {
    ...base,
    executionProfile: {
      ...base.executionProfile,
      image,
      temporaryBytes,
      temporaryExecutable: executable === 'true'
    }
  };
}

export class SandboxedPackageScriptVerifier implements TaskVerifier {
  readonly #policy: SandboxedVerificationPolicy;
  readonly #sandbox: AgentCommandSandbox;
  readonly #projectRoots: ReadonlyMap<string, string>;

  constructor(options: {
    readonly policy: SandboxedVerificationPolicy;
    readonly graph: RepositoryGraph;
    readonly sandbox?: AgentCommandSandbox;
  }) {
    if (!dockerDigestImage.test(options.policy.executionProfile.image)) {
      throw new Error('Verification Docker image must use a sha256 digest');
    }
    this.#policy = options.policy;
    this.#sandbox = options.sandbox ?? new DockerReadOnlyCommandSandbox();
    this.#projectRoots = new Map(
      [...options.graph.projects.values()].flatMap((project) => [
        [project.id, project.root],
        [project.name, project.root]
      ])
    );
  }

  async verify(request: Parameters<TaskVerifier['verify']>[0]) {
    for (const rule of request.task.verification) {
      if (rule.type !== 'package-script') {
        return {
          status: 'failed' as const,
          detail: 'Autonomous runtime accepts only package-script verification rules'
        };
      }
      const projectRoot = this.#projectRoots.get(rule.packageName);
      if (projectRoot === undefined) {
        return {
          status: 'failed' as const,
          detail: `Verification package is not present in approved Repository Facts: ${rule.packageName}`
        };
      }
      const result = await this.#sandbox.execute({
        profile: this.#policy.executionProfile,
        executable: 'npm',
        args: ['--prefix', projectRoot, 'run', rule.script],
        cwd: request.workspace.workspacePath,
        environment: { CI: '1', HOME: '/tmp', npm_config_cache: '/tmp/npm-cache' },
        trustedPath: defaultAgentCommandTrustedPath,
        timeoutMs: 600_000,
        maxOutputBytes: 1024 * 1024,
        containerName: `forge-verify-${randomUUID()}`
      });
      if (result.status !== 'completed' || result.exitCode !== 0) {
        const detail =
          result.status === 'completed'
            ? `${result.stderr}\n${result.stdout}`.trim().slice(0, 8192)
            : result.status === 'failed'
              ? result.detail
              : result.status;
        return {
          status: 'failed' as const,
          detail: `Verification failed for ${rule.packageName}:${rule.script}: ${detail}`
        };
      }
    }
    return { status: 'passed' as const };
  }
}
