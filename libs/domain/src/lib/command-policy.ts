import { z } from 'zod';

const commandIdSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^[a-z][a-z0-9-]*$/);
const executableSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const environmentKeySchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const environmentValueSchema = z
  .string()
  .refine((value) => !value.includes('\0') && !value.includes('\r') && !value.includes('\n'), {
    message: 'Agent command environment values cannot contain NUL or line breaks'
  });

export const agentCommandDefinitionSchema = z.object({
  id: commandIdSchema,
  executable: executableSchema,
  args: z.array(z.string()),
  timeoutMs: z.int().min(1).max(600_000),
  maxOutputBytes: z.int().min(1).max(1_048_576)
});

export const agentCommandPolicySchema = z
  .object({
    commands: z.array(agentCommandDefinitionSchema).min(1),
    environment: z.record(environmentKeySchema, environmentValueSchema)
  })
  .superRefine((policy, context) => {
    const ids = new Set<string>();
    for (const [index, command] of policy.commands.entries()) {
      if (ids.has(command.id)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate agent command ID: ${command.id}`,
          path: ['commands', index, 'id']
        });
      }
      ids.add(command.id);
    }
    if (Object.hasOwn(policy.environment, 'PATH')) {
      context.addIssue({
        code: 'custom',
        message: 'Agent command policy cannot override PATH',
        path: ['environment', 'PATH']
      });
    }
  });

export type AgentCommandDefinition = z.infer<typeof agentCommandDefinitionSchema>;
export type AgentCommandPolicy = z.infer<typeof agentCommandPolicySchema>;

export interface AgentCommandExecutionRequest {
  readonly command: AgentCommandDefinition;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export type AgentCommandExecutionResult =
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

export interface AgentCommandExecutor {
  execute(request: AgentCommandExecutionRequest): Promise<AgentCommandExecutionResult>;
}
