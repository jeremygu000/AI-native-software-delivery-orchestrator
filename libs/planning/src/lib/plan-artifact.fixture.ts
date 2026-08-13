import type { PreparedOrchestrationPlan, PlanningSource } from './autonomous-plan-phase.js';
import type {
  RepositoryGraph,
  RepositorySnapshot,
  TaskContract
} from '@ai-native-software-delivery-orchestrator/domain';

import { createPlanArtifact } from './plan-artifact.js';

const task: TaskContract = {
  id: 'task-a',
  title: 'Change A',
  goal: 'Change A safely',
  dependencies: [],
  expectedReads: [],
  expectedWrites: [{ type: 'project', value: 'core' }],
  sharedResources: [],
  verification: [{ type: 'package-script', packageName: 'core', script: 'test' }]
};

export const approvalTestGraph = (): RepositoryGraph => ({
  repositoryPath: '/repo',
  projects: new Map(),
  projectDependencies: [],
  files: new Map(),
  symbols: new Map(),
  fileDependencies: [],
  symbolReferences: [],
  diagnostics: []
});

const snapshot: RepositorySnapshot = {
  repositoryId: `sha256:${'1'.repeat(64)}`,
  repositoryRoot: '/repo',
  baseCommit: '2'.repeat(40),
  workingTreeFingerprint: `sha256:${'3'.repeat(64)}`,
  dirty: false
};

const source: PlanningSource = { type: 'user-request', content: 'Change A.' };

const preparedPlan: PreparedOrchestrationPlan = {
  attempts: 1,
  specification: { tasks: [task] },
  impacts: [
    {
      taskId: 'task-a',
      projectsRead: new Set(),
      projectsWritten: new Set(['core']),
      explicitProjectsWritten: new Set(['core']),
      filesRead: new Set(),
      filesWritten: new Set(),
      explicitFilesWritten: new Set(),
      globFilesWritten: new Set(),
      symbolDerivedFilesWritten: new Set(),
      symbolsRead: new Set(),
      symbolsWritten: new Set(),
      sharedResources: new Set(),
      sharedResourceAccesses: [],
      downstreamProjects: new Set(),
      riskSignals: []
    }
  ],
  hardConflicts: [],
  riskConflicts: [],
  executionPlan: { waves: [{ index: 0, taskIds: ['task-a'] }] },
  schedule: { maxConcurrency: 1 },
  semanticReview: {
    recommendation: 'accept',
    summary: 'Covered.',
    requirements: [
      { requirement: 'Change A.', status: 'covered', taskIds: ['task-a'], detail: 'Covered.' }
    ]
  }
};

export const approvalTestArtifact = (artifactId = 'plan-1') =>
  createPlanArtifact({
    artifactId,
    revision: 1,
    createdAt: '2026-08-13T00:00:00.000Z',
    source,
    repository: approvalTestGraph(),
    repositorySnapshot: snapshot,
    sharedResourcePolicy: [],
    verificationPolicy: { version: 1 },
    codeReviewPolicy: {
      version: 1,
      reviewer: {
        implementation: 'pi-task-code-reviewer',
        provider: 'pi',
        model: 'test-model',
        toolProfile: 'workspace-read-only-v1',
        outputSchemaVersion: 1,
        promptVersion: 'v1'
      }
    },
    preparedPlan
  });
