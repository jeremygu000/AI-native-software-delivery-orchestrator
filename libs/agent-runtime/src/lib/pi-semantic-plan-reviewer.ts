import type {
  SemanticPlanReviewer,
  SemanticPlanReviewRequest
} from '@ai-native-software-delivery-orchestrator/planning';

import {
  createPlanningFactToolExecutor,
  PiPlanningGatewayAdapter,
  type PiPlanningGateway
} from './pi-planning-agent.js';

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const buildReviewPrompt = (request: SemanticPlanReviewRequest): string => {
  const sourceLabel =
    request.source.type === 'markdown-spec'
      ? `Markdown specification${request.source.path === undefined ? '' : ` (${request.source.path})`}`
      : 'User request';
  const tasks = [...request.specification.tasks]
    .toSorted((left, right) => compareStrings(left.id, right.id))
    .map((task) => ({
      id: task.id,
      title: task.title,
      goal: task.goal,
      description: task.description,
      dependencies: task.dependencies,
      expectedReads: task.expectedReads,
      expectedWrites: task.expectedWrites,
      sharedResources: task.sharedResources,
      verification: task.verification
    }));

  return [
    'You are the independent semantic plan reviewer for a repository-aware coding orchestrator.',
    'Evaluate whether the proposed tasks completely and faithfully cover the supplied request.',
    'Do not authorize execution. Your output is an advisory recommendation that deterministic code will validate.',
    'Return exactly one JSON object and no prose or Markdown fence.',
    'Use this shape:',
    '{"recommendation":"accept|revise","summary":"...","requirements":[{"requirement":"one concrete requirement from the source","status":"covered|missing|ambiguous","taskIds":["task-id"],"detail":"evidence or gap"}]}',
    'Every concrete source requirement must have one entry. Use covered only when one or more listed task IDs actually cover it.',
    'Use missing when no task covers a requirement. Use ambiguous when the task intent or acceptance criteria are insufficient.',
    'Use accept only when every entry is covered; otherwise use revise.',
    'Use only task IDs from the supplied task specification.',
    'Use forge_projects, forge_files, forge_symbols, and forge_relationships when repository facts are needed. Do not use any other tools.',
    `Repository: ${request.repository.repositoryPath}`,
    `Review attempt: ${request.attempt}`,
    `Proposed tasks: ${JSON.stringify(tasks)}`,
    `${sourceLabel}:`,
    request.source.content
  ].join('\n\n');
};

export class PiSemanticPlanReviewer implements SemanticPlanReviewer {
  readonly #gateway: PiPlanningGateway;

  constructor(gateway: PiPlanningGateway = new PiPlanningGatewayAdapter()) {
    this.#gateway = gateway;
  }

  async review(request: SemanticPlanReviewRequest): Promise<unknown> {
    const result = await this.#gateway.generate({
      cwd: request.repository.repositoryPath,
      prompt: buildReviewPrompt(request),
      executeTool: createPlanningFactToolExecutor(request.repository)
    });
    return result.output;
  }
}
