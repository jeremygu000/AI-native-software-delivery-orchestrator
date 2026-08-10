import { z } from 'zod';

const nonEmptyStringSchema = z.string().trim().min(1);

export const workspaceIntegrationPhaseSchema = z.enum([
  'READY_TO_INTEGRATE',
  'INTEGRATION_BLOCKED',
  'INTEGRATED'
]);

export type WorkspaceIntegrationPhase = z.infer<typeof workspaceIntegrationPhaseSchema>;

export const integrationBlockerSchema = z.object({
  type: z.enum(['rebase-conflict', 'fast-forward-failed', 'repository-dirty']),
  detail: nonEmptyStringSchema,
  conflictPaths: z.array(nonEmptyStringSchema)
});

export type IntegrationBlocker = z.infer<typeof integrationBlockerSchema>;

const taskWorkspaceBaseSchema = z.object({
  id: nonEmptyStringSchema,
  runId: nonEmptyStringSchema,
  taskId: nonEmptyStringSchema,
  repositoryPath: nonEmptyStringSchema,
  workspacePath: nonEmptyStringSchema,
  branchName: nonEmptyStringSchema,
  baseRef: nonEmptyStringSchema,
  integrationRef: nonEmptyStringSchema,
  revision: z.int().positive()
});

export const taskWorkspaceSchema = z.discriminatedUnion('phase', [
  taskWorkspaceBaseSchema.extend({ phase: z.literal('READY_TO_INTEGRATE') }),
  taskWorkspaceBaseSchema.extend({
    phase: z.literal('INTEGRATION_BLOCKED'),
    blocker: integrationBlockerSchema
  }),
  taskWorkspaceBaseSchema.extend({
    phase: z.literal('INTEGRATED'),
    integrationCommit: nonEmptyStringSchema
  })
]);

export type TaskWorkspace = z.infer<typeof taskWorkspaceSchema>;

export const createTaskWorkspaceRequestSchema = z.object({
  id: nonEmptyStringSchema,
  runId: nonEmptyStringSchema,
  taskId: nonEmptyStringSchema,
  repositoryPath: nonEmptyStringSchema,
  workspacePath: nonEmptyStringSchema,
  branchName: nonEmptyStringSchema,
  baseRef: nonEmptyStringSchema,
  integrationRef: nonEmptyStringSchema
});

export type CreateTaskWorkspaceRequest = z.infer<typeof createTaskWorkspaceRequestSchema>;

export const disposeTaskWorkspaceRequestSchema = z
  .object({
    workspace: taskWorkspaceSchema,
    force: z.boolean().default(false),
    reason: nonEmptyStringSchema.optional()
  })
  .superRefine((request, context) => {
    if (request.force && request.reason === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'A force disposal requires a reason',
        path: ['reason']
      });
    }
  });

export type DisposeTaskWorkspaceRequest = z.infer<typeof disposeTaskWorkspaceRequestSchema>;

export type IntegrateTaskWorkspaceResult =
  | { readonly status: 'integrated'; readonly workspace: TaskWorkspace }
  | { readonly status: 'blocked'; readonly workspace: TaskWorkspace };

export type DisposeTaskWorkspaceResult =
  | { readonly status: 'disposed' }
  | { readonly status: 'dirty'; readonly paths: readonly string[] };

export interface WorkspaceManager {
  create(request: CreateTaskWorkspaceRequest): Promise<TaskWorkspace>;
  integrate(workspace: TaskWorkspace): Promise<IntegrateTaskWorkspaceResult>;
  resumeIntegration(workspace: TaskWorkspace): Promise<IntegrateTaskWorkspaceResult>;
  abortIntegration(workspace: TaskWorkspace): Promise<TaskWorkspace>;
  dispose(request: DisposeTaskWorkspaceRequest): Promise<DisposeTaskWorkspaceResult>;
}
