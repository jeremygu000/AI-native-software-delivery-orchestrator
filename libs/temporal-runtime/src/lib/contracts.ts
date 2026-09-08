import { z } from 'zod';

// ─── Run identity ────────────────────────────────────────────────────────────

export const RunIdSchema = z.string().min(1);
export type RunId = z.infer<typeof RunIdSchema>;

// ─── Activity input: compact IDs only ────────────────────────────────────────

export const BootstrapInputSchema = z.object({
  runId: RunIdSchema,
});
export type BootstrapInput = z.infer<typeof BootstrapInputSchema>;

export const BootstrapResultSchema = z.object({
  runId: RunIdSchema,
  status: z.literal('bootstrapped'),
});
export type BootstrapResult = z.infer<typeof BootstrapResultSchema>;

// ─── Workflow return ─────────────────────────────────────────────────────────

export const ForgeRunResultSchema = z.object({
  runId: RunIdSchema,
  status: z.enum(['completed', 'failed']),
});
export type ForgeRunResult = z.infer<typeof ForgeRunResultSchema>;
