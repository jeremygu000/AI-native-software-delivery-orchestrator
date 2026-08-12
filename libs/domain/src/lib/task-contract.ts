import { z } from 'zod';

export const resourceSelectorTypeSchema = z.enum([
  'project',
  'file',
  'glob',
  'symbol',
  'shared-resource'
]);

export const resourceSelectorSchema = z.object({
  type: resourceSelectorTypeSchema,
  value: z.string().trim().min(1)
});

const stableUniqueStringsSchema = z
  .array(z.string().trim().min(1))
  .transform((values) => [...new Set(values)].toSorted());

export const verificationRuleSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('command'),
    command: z.string().trim().min(1),
    cwd: z.string().trim().min(1).optional()
  }),
  z.object({
    type: z.literal('package-script'),
    packageName: z
      .string()
      .trim()
      .regex(/^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/),
    script: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9:._-]*$/)
  })
]);

export const taskContractSchema = z
  .object({
    id: z.string().trim().min(1),
    title: z.string().trim().min(1),
    goal: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
    dependencies: z.array(z.string().trim().min(1)),
    expectedReads: z.array(resourceSelectorSchema),
    expectedWrites: z.array(resourceSelectorSchema),
    sharedResources: stableUniqueStringsSchema,
    verification: z.array(verificationRuleSchema),
    priority: z.int().optional()
  })
  .superRefine((task, context) => {
    if (task.dependencies.includes(task.id)) {
      context.addIssue({
        code: 'custom',
        message: 'A task cannot depend on itself',
        path: ['dependencies']
      });
    }

    if (new Set(task.dependencies).size !== task.dependencies.length) {
      context.addIssue({
        code: 'custom',
        message: 'Task dependencies must be unique',
        path: ['dependencies']
      });
    }
  });

export const taskSpecificationSchema = z
  .object({
    tasks: z.array(taskContractSchema).min(1)
  })
  .superRefine((specification, context) => {
    const taskIds = new Set<string>();
    for (const [index, task] of specification.tasks.entries()) {
      if (taskIds.has(task.id)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate task ID: ${task.id}`,
          path: ['tasks', index, 'id']
        });
      }
      taskIds.add(task.id);
    }
  });

export const collectSharedResourceIds = (task: TaskContract): readonly string[] => {
  const resourceIds = new Set(task.sharedResources);
  for (const selector of [...task.expectedReads, ...task.expectedWrites]) {
    if (selector.type === 'shared-resource') {
      resourceIds.add(selector.value);
    }
  }
  return [...resourceIds].toSorted();
};

export type ResourceSelectorType = z.infer<typeof resourceSelectorTypeSchema>;
export type ResourceSelector = z.infer<typeof resourceSelectorSchema>;
export type VerificationRule = z.infer<typeof verificationRuleSchema>;
export type TaskContract = z.infer<typeof taskContractSchema>;
export type TaskSpecification = z.infer<typeof taskSpecificationSchema>;
