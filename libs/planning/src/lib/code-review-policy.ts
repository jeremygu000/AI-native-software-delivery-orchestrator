import { z } from 'zod';
import { createHash } from 'node:crypto';

const nonEmptyStringSchema = z.string().trim().min(1);

/** Semantic inputs that can change an automated code-review decision. */
export const codeReviewPolicySchema = z.object({
  version: z.int().positive(),
  reviewer: z.object({
    implementation: nonEmptyStringSchema,
    agentBackend: z.literal('pi'),
    model: z.object({
      provider: nonEmptyStringSchema,
      id: nonEmptyStringSchema
    }),
    toolProfile: z.literal('workspace-read-only-v1'),
    outputSchemaVersion: z.int().positive(),
    promptVersion: nonEmptyStringSchema
  })
});

export type CodeReviewPolicy = z.infer<typeof codeReviewPolicySchema>;

export const createCodeReviewPolicy = (input: {
  readonly provider: string;
  readonly model: string;
}): CodeReviewPolicy =>
  codeReviewPolicySchema.parse({
    version: 1,
    reviewer: {
      implementation: 'pi-task-code-reviewer',
      agentBackend: 'pi',
      model: { provider: input.provider, id: input.model },
      toolProfile: 'workspace-read-only-v1',
      outputSchemaVersion: 1,
      promptVersion: 'v1'
    }
  });

export const codeReviewPolicyFingerprint = (policy: CodeReviewPolicy): string =>
  `sha256:${createHash('sha256')
    .update(JSON.stringify(codeReviewPolicySchema.parse(policy)))
    .digest('hex')}`;
