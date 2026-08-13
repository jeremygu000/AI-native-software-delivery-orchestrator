import { z } from 'zod';

const nonEmptyStringSchema = z.string().trim().min(1);
const fingerprintSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/** Immutable execution inputs required to resume one admitted repair attempt. */
export const taskRepairWorkItemSchema = z.object({
  runId: nonEmptyStringSchema,
  taskId: nonEmptyStringSchema,
  repairAttemptId: nonEmptyStringSchema,
  builderAttemptId: nonEmptyStringSchema,
  workspaceId: nonEmptyStringSchema,
  leasePlanFingerprint: nonEmptyStringSchema,
  impactFingerprint: fingerprintSchema,
  parentReviewIteration: z.int().positive(),
  reviewIteration: z.int().positive(),
  verificationPolicyFingerprint: fingerprintSchema,
  codeReviewPolicyFingerprint: fingerprintSchema
});

export type TaskRepairWorkItem = z.infer<typeof taskRepairWorkItemSchema>;
