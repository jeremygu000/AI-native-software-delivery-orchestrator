import { z } from 'zod';

export const TemporalConfigSchema = z.object({
  namespace: z.string().min(1).default('default'),
  taskQueue: z.string().min(1).default('forge-run'),
  serverUrl: z.string().url().default('http://localhost:7233'),
  connectTimeoutMs: z.number().positive().default(10_000),
  workerShutdownTimeoutMs: z.number().positive().default(30_000)
});

export type TemporalConfig = z.infer<typeof TemporalConfigSchema>;

export function resolveTemporalConfig(overrides?: Partial<TemporalConfig>): TemporalConfig {
  return TemporalConfigSchema.parse(overrides ?? {});
}
