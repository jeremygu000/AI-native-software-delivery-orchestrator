import { createHash } from 'node:crypto';
import { z } from 'zod';

export type ProviderAuth =
  | { readonly kind: 'api-key' }
  | { readonly kind: 'oauth' }
  | { readonly kind: 'subscription-session' }
  | { readonly kind: 'external-helper' }
  | { readonly kind: 'local' };

const profileSchema = z
  .object({
    version: z.literal(1),
    providerId: z.string().trim().min(1),
    providerKind: z.enum(['direct-api', 'subscription', 'local']),
    modelId: z.string().trim().min(1),
    reasoningConfig: z.object({
      effort: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh'])
    }),
    toolCapabilities: z.object({ functionCalling: z.boolean(), textOnly: z.literal(true) }),
    contextLimits: z.object({ inputTokens: z.int().positive(), outputTokens: z.int().positive() }),
    adapterVersion: z.string().trim().min(1),
    transport: z.string().trim().min(1)
  })
  .strict();

export const resolvedModelExecutionTargetSchema = profileSchema
  .extend({
    executionProfileFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/)
  })
  .strict()
  .superRefine((target, context) => {
    const { executionProfileFingerprint, ...profile } = target;
    if (executionProfileFingerprint !== profileFingerprint(profile)) {
      context.addIssue({ code: 'custom', message: 'Model execution profile fingerprint differs' });
    }
  });

export type ResolvedModelExecutionTarget = z.infer<typeof resolvedModelExecutionTargetSchema>;
const profileFingerprint = (profile: z.infer<typeof profileSchema>): string =>
  `sha256:${createHash('sha256')
    .update(JSON.stringify(profileSchema.parse(profile)))
    .digest('hex')}`;

/** Authentication, refresh tokens and account identifiers are deliberately absent. */
export const createModelExecutionTarget = (
  profile: z.infer<typeof profileSchema>
): ResolvedModelExecutionTarget => {
  const parsed = profileSchema.parse(profile);
  return { ...parsed, executionProfileFingerprint: profileFingerprint(parsed) };
};
