import { createHash } from 'node:crypto';
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

export const taskVerificationEvidenceFingerprint = (
  evidence: Omit<TaskVerificationEvidence, 'fingerprint'>
): string => `sha256:${createHash('sha256').update(JSON.stringify(evidence)).digest('hex')}`;

export class TaskVerificationEvidenceIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskVerificationEvidenceIntegrityError';
  }
}

export const assertTaskVerificationEvidenceIntegrity = (
  evidence: TaskVerificationEvidence
): void => {
  taskVerificationEvidenceSchema.parse(evidence);
  const { fingerprint, ...payload } = evidence;
  if (fingerprint !== taskVerificationEvidenceFingerprint(payload)) {
    throw new TaskVerificationEvidenceIntegrityError(
      'Verification evidence fingerprint does not match its content'
    );
  }
};
