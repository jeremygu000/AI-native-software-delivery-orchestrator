import { z } from 'zod';

export const defaultAgentCommandSandboxProfile = {
  kind: 'docker-read-only',
  image: 'node:24-alpine',
  network: 'deny',
  workspaceAccess: 'read-only',
  processTree: 'container'
} as const;

// This PATH applies inside the Linux validation container, not to the host process.
export const defaultAgentCommandTrustedPath = '/usr/local/bin:/usr/bin:/bin';

export const agentCommandSandboxProfileSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('macos-read-only'),
    network: z.literal('deny'),
    workspaceAccess: z.literal('read-only'),
    processTree: z.literal('direct-child')
  }),
  z.object({
    kind: z.literal('docker-read-only'),
    image: z.string().trim().min(1),
    network: z.literal('deny'),
    workspaceAccess: z.literal('read-only'),
    processTree: z.literal('container')
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
