import { z } from 'zod';

const nonEmptyStringSchema = z.string().trim().min(1);
const fingerprintSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const taskVerificationEvidenceSchema = z.object({
  id: nonEmptyStringSchema,
  runId: nonEmptyStringSchema,
  taskId: nonEmptyStringSchema,
  attemptId: nonEmptyStringSchema,
  workspaceId: nonEmptyStringSchema,
  workspaceRevision: z.int().positive(),
  workspaceChangeFingerprint: fingerprintSchema,
  verificationPolicyFingerprint: fingerprintSchema,
  status: z.literal('passed'),
  verifiedAt: z.string().datetime(),
  fingerprint: fingerprintSchema
});

export type TaskVerificationEvidence = z.infer<typeof taskVerificationEvidenceSchema>;
