import { z } from 'zod';

export const defaultAgentCommandSandboxProfile = {
  kind: 'trusted-local',
  assurance: 'developer-trusted',
  network: 'host',
  workspaceAccess: 'worktree',
  processTree: 'direct-child'
} as const;

// This PATH applies inside the Linux validation container, not to the host process.
export const defaultAgentCommandTrustedPath = '/usr/local/bin:/usr/bin:/bin';
const dockerDigestImage = /^.+@sha256:[a-f0-9]{64}$/;

export const agentCommandSandboxProfileSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('trusted-local'),
    assurance: z.literal('developer-trusted'),
    network: z.literal('host'),
    workspaceAccess: z.literal('worktree'),
    processTree: z.literal('direct-child')
  }),
  z.object({
    kind: z.literal('macos-read-only'),
    assurance: z.literal('developer-only'),
    network: z.literal('deny'),
    workspaceAccess: z.literal('read-only'),
    processTree: z.literal('direct-child')
  }),
  z.object({
    kind: z.literal('docker-read-only'),
    image: z.string().trim().regex(dockerDigestImage, 'Docker image must use a sha256 digest'),
    assurance: z.literal('production-validation'),
    network: z.literal('deny'),
    workspaceAccess: z.literal('read-only'),
    processTree: z.literal('container'),
    memoryBytes: z.int().min(1).max(17_179_869_184),
    cpuCount: z.number().positive().max(16),
    pidLimit: z.int().min(1).max(4_096)
  })
]);

export type AgentCommandSandboxProfile = z.infer<typeof agentCommandSandboxProfileSchema>;

export interface AgentCommandSandboxRequest {
  readonly profile: AgentCommandSandboxProfile;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly trustedPath: string;
  readonly containerName?: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
}

export type AgentCommandSandboxResult =
  | {
      readonly status: 'completed';
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    }
  | { readonly status: 'timed-out'; readonly stdout: string; readonly stderr: string }
  | { readonly status: 'cancelled'; readonly stdout: string; readonly stderr: string }
  | { readonly status: 'output-limited'; readonly stdout: string; readonly stderr: string }
  | {
      readonly status: 'failed';
      readonly detail: string;
      readonly stdout: string;
      readonly stderr: string;
    };

export interface AgentCommandSandbox {
  execute(request: AgentCommandSandboxRequest): Promise<AgentCommandSandboxResult>;
}
