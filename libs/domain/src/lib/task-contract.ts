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

export const verificationRuleSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('command'),
    command: z.string().trim().min(1)
  }),
  z.object({
    type: z.literal('nx-target'),
    project: z.string().trim().min(1),
    target: z.string().trim().min(1)
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
    sharedResources: z.array(z.string().trim().min(1)),
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

export const taskSpecificationSchema = z.object({
  tasks: z.array(taskContractSchema).min(1)
});

export type ResourceSelectorType = z.infer<typeof resourceSelectorTypeSchema>;
export type ResourceSelector = z.infer<typeof resourceSelectorSchema>;
export type VerificationRule = z.infer<typeof verificationRuleSchema>;
export type TaskContract = z.infer<typeof taskContractSchema>;
export type TaskSpecification = z.infer<typeof taskSpecificationSchema>;
