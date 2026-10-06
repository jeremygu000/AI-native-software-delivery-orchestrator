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
    image: z.string().trim().min(1),
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
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
}

export const AgentCommandStatus = {
  Completed: 'completed',
  TimedOut: 'timed-out',
  Cancelled: 'cancelled',
  OutputLimited: 'output-limited',
  Failed: 'failed'
} as const;
export type AgentCommandSandboxResult =
  | {
      readonly status: typeof AgentCommandStatus.Completed;
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    }
  | {
      readonly status: typeof AgentCommandStatus.TimedOut;
      readonly stdout: string;
      readonly stderr: string;
    }
  | {
      readonly status: typeof AgentCommandStatus.Cancelled;
      readonly stdout: string;
      readonly stderr: string;
    }
  | {
      readonly status: typeof AgentCommandStatus.OutputLimited;
      readonly stdout: string;
      readonly stderr: string;
    }
  | {
      readonly status: typeof AgentCommandStatus.Failed;
      readonly detail: string;
      readonly stdout: string;
      readonly stderr: string;
    };

export interface AgentCommandSandbox {
  execute(request: AgentCommandSandboxRequest): Promise<AgentCommandSandboxResult>;
}
