import { z } from 'zod';

// ─── Run identity ─────────────────────────────────────────────────────────────

export const RunIdSchema = z.string().min(1);
export type RunId = z.infer<typeof RunIdSchema>;

// ─── Legacy bootstrap (kept for backward compatibility) ───────────────────────

export const BootstrapInputSchema = z.object({
  runId: RunIdSchema
});
export type BootstrapInput = z.infer<typeof BootstrapInputSchema>;

export const BootstrapResultSchema = z.object({
  runId: RunIdSchema,
  status: z.literal('bootstrapped')
});
export type BootstrapResult = z.infer<typeof BootstrapResultSchema>;

// ─── Workflow input / return ──────────────────────────────────────────────────

export const ForgeRunInputSchema = z.object({
  runId: RunIdSchema
});
export type ForgeRunInput = z.infer<typeof ForgeRunInputSchema>;

export const ForgeRunResultSchema = z.object({
  runId: RunIdSchema,
  status: z.enum(['completed', 'failed'])
});
export type ForgeRunResult = z.infer<typeof ForgeRunResultSchema>;

// ─── Scenario A: reevaluateRun ────────────────────────────────────────────────

export const AuthorizedTaskSchema = z.object({
  taskId: z.string().min(1),
  attemptId: z.string().min(1)
});
export type AuthorizedTask = z.infer<typeof AuthorizedTaskSchema>;

export const ReevaluateRunInputSchema = z.object({
  runId: RunIdSchema
});
export type ReevaluateRunInput = z.infer<typeof ReevaluateRunInputSchema>;

export const ReevaluateRunResultSchema = z.object({
  runId: RunIdSchema,
  authorizedTasks: z.array(AuthorizedTaskSchema)
});
export type ReevaluateRunResult = z.infer<typeof ReevaluateRunResultSchema>;

// ─── Scenario A: executeBuilder ───────────────────────────────────────────────

export const ExecuteBuilderInputSchema = z.object({
  runId: RunIdSchema,
  taskId: z.string().min(1),
  attemptId: z.string().min(1)
});
export type ExecuteBuilderInput = z.infer<typeof ExecuteBuilderInputSchema>;

export const ExecuteBuilderResultSchema = z.object({
  runId: RunIdSchema,
  taskId: z.string().min(1),
  workspaceId: z.string().min(1),
  attemptId: z.string().min(1),
  impactId: z.string().min(1)
});
export type ExecuteBuilderResult = z.infer<typeof ExecuteBuilderResultSchema>;

// ─── Scenario A: SubjectRef ───────────────────────────────────────────────────

export const SubjectRefSchema = z.object({
  builderAttemptId: z.string().min(1),
  outputAttemptId: z.string().min(1),
  workspaceId: z.string().min(1)
});
export type SubjectRef = z.infer<typeof SubjectRefSchema>;

// ─── Scenario A: evaluateBuilderOutput ───────────────────────────────────────

export const EvaluateBuilderOutputInputSchema = z.object({
  runId: RunIdSchema,
  taskId: z.string().min(1),
  workspaceId: z.string().min(1),
  builderAttemptId: z.string().min(1),
  impactId: z.string().min(1)
});
export type EvaluateBuilderOutputInput = z.infer<typeof EvaluateBuilderOutputInputSchema>;

export const EvaluateBuilderOutputResultSchema = z.object({
  runId: RunIdSchema,
  taskId: z.string().min(1),
  recommendation: z.enum(['accept', 'repair', 'reject']),
  verificationId: z.string().min(1),
  subjectRef: SubjectRefSchema,
  reviewId: z.string().min(1)
});
export type EvaluateBuilderOutputResult = z.infer<typeof EvaluateBuilderOutputResultSchema>;

// ─── Scenario A: admitRepair ──────────────────────────────────────────────────

export const AdmitRepairInputSchema = z.object({
  runId: RunIdSchema,
  taskId: z.string().min(1),
  reviewId: z.string().min(1),
  subjectRef: SubjectRefSchema
});
export type AdmitRepairInput = z.infer<typeof AdmitRepairInputSchema>;

export const AdmitRepairResultSchema = z.object({
  runId: RunIdSchema,
  taskId: z.string().min(1),
  repairAttemptId: z.string().min(1)
});
export type AdmitRepairResult = z.infer<typeof AdmitRepairResultSchema>;

// ─── Scenario A: executeRepair ────────────────────────────────────────────────

export const ExecuteRepairInputSchema = z.object({
  runId: RunIdSchema,
  taskId: z.string().min(1),
  workspaceId: z.string().min(1),
  builderAttemptId: z.string().min(1),
  impactId: z.string().min(1),
  reviewId: z.string().min(1),
  repairAttemptId: z.string().min(1)
});
export type ExecuteRepairInput = z.infer<typeof ExecuteRepairInputSchema>;

export const ExecuteRepairResultSchema = z.object({
  runId: RunIdSchema,
  taskId: z.string().min(1),
  state: z.enum(['completed', 'blocked', 'unknown']),
  repairAttemptId: z.string().min(1),
  recommendation: z.enum(['accept', 'repair', 'reject']).optional(),
  verificationId: z.string().min(1).optional(),
  subjectRef: SubjectRefSchema.optional(),
  reviewId: z.string().min(1).optional(),
  blockerLeaseId: z.string().min(1).optional(),
  detail: z.string().optional()
});
export type ExecuteRepairResult = z.infer<typeof ExecuteRepairResultSchema>;

// ─── Scenario A: integrateAcceptedOutput ──────────────────────────────────────

export const IntegrateAcceptedOutputInputSchema = z.object({
  runId: RunIdSchema,
  taskId: z.string().min(1),
  workspaceId: z.string().min(1),
  subjectRef: SubjectRefSchema
});
export type IntegrateAcceptedOutputInput = z.infer<typeof IntegrateAcceptedOutputInputSchema>;

export const IntegrateAcceptedOutputResultSchema = z.object({
  runId: RunIdSchema,
  taskId: z.string().min(1),
  status: z.enum(['integrated', 'blocked'])
});
export type IntegrateAcceptedOutputResult = z.infer<typeof IntegrateAcceptedOutputResultSchema>;

// ─── Scenario A: finalizeRunState ─────────────────────────────────────────────

export const FinalizeRunStateInputSchema = z.object({
  runId: RunIdSchema
});
export type FinalizeRunStateInput = z.infer<typeof FinalizeRunStateInputSchema>;

export const FinalizeRunStateResultSchema = z.object({
  runId: RunIdSchema,
  status: z.enum(['completed', 'failed'])
});
export type FinalizeRunStateResult = z.infer<typeof FinalizeRunStateResultSchema>;
