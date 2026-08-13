import { z } from 'zod';

import { fingerprintPlanValue } from './plan-artifact.js';

const nonEmptyStringSchema = z.string().trim().min(1);

/** Semantic inputs that can change an automated code-review decision. */
export const codeReviewPolicySchema = z.object({
  version: z.int().positive(),
  reviewer: z.object({
    implementation: nonEmptyStringSchema,
    provider: nonEmptyStringSchema,
    model: nonEmptyStringSchema,
    toolProfile: z.literal('workspace-read-only-v1'),
    outputSchemaVersion: z.int().positive(),
    promptVersion: nonEmptyStringSchema
  })
});

export type CodeReviewPolicy = z.infer<typeof codeReviewPolicySchema>;

export const codeReviewPolicyFingerprint = (policy: CodeReviewPolicy): string =>
  fingerprintPlanValue(codeReviewPolicySchema.parse(policy));
