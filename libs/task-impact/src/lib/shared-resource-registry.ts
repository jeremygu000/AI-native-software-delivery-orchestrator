import { z } from 'zod';

import { matchesPathPattern, normalizeRepositoryPath } from './path-pattern.js';

export const sharedResourceConcurrencySchema = z.enum([
  'exclusive',
  'ordered',
  'producer-controlled'
]);

export const sharedResourceDefinitionSchema = z.object({
  id: z.string().trim().min(1),
  files: z.array(z.string().trim().min(1)).default([]),
  paths: z.array(z.string().trim().min(1)).default([]),
  concurrency: sharedResourceConcurrencySchema
});

export const sharedResourceRegistryConfigSchema = z
  .object({
    resources: z.array(sharedResourceDefinitionSchema)
  })
  .superRefine((configuration, context) => {
    const resourceIds = new Set<string>();
    for (const [index, resource] of configuration.resources.entries()) {
      if (resourceIds.has(resource.id)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate shared resource ID: ${resource.id}`,
          path: ['resources', index, 'id']
        });
      }
      resourceIds.add(resource.id);
    }
  });

export type SharedResourceConcurrency = z.infer<typeof sharedResourceConcurrencySchema>;
export type SharedResourceDefinition = z.infer<typeof sharedResourceDefinitionSchema>;
export type SharedResourceRegistryConfig = z.input<typeof sharedResourceRegistryConfigSchema>;

export interface SharedResourcePolicyRegistry {
  get(resourceId: string): SharedResourceDefinition | undefined;
}

const normalizeDefinition = (definition: SharedResourceDefinition): SharedResourceDefinition => ({
  ...definition,
  files: definition.files.map(normalizeRepositoryPath).toSorted(),
  paths: definition.paths.map(normalizeRepositoryPath).toSorted()
});

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export class SharedResourceRegistry implements SharedResourcePolicyRegistry {
  readonly #definitions: ReadonlyMap<string, SharedResourceDefinition>;

  constructor(configuration: SharedResourceRegistryConfig) {
    const parsed = sharedResourceRegistryConfigSchema.parse(configuration);
    this.#definitions = new Map(
      parsed.resources
        .map(normalizeDefinition)
        .toSorted((left, right) => compareStrings(left.id, right.id))
        .map((definition) => [definition.id, definition])
    );
  }

  get(resourceId: string): SharedResourceDefinition | undefined {
    return this.#definitions.get(resourceId);
  }

  matchingFile(path: string): readonly SharedResourceDefinition[] {
    const normalizedPath = normalizeRepositoryPath(path);
    return [...this.#definitions.values()].filter(
      (definition) =>
        definition.files.includes(normalizedPath) ||
        definition.paths.some((pattern) => matchesPathPattern(normalizedPath, pattern))
    );
  }

  matchingGlob(pattern: string): readonly SharedResourceDefinition[] {
    const normalizedPattern = normalizeRepositoryPath(pattern);
    return [...this.#definitions.values()].filter(
      (definition) =>
        definition.files.some((file) => matchesPathPattern(file, normalizedPattern)) ||
        definition.paths.includes(normalizedPattern)
    );
  }

  list(): readonly SharedResourceDefinition[] {
    return [...this.#definitions.values()];
  }
}
