import type { PlanArtifact } from '@ai-native-software-delivery-orchestrator/planning';
import type { ForgeRunReadModel } from '@ai-native-software-delivery-orchestrator/orchestration-runtime';

export type CodingStage =
  | 'repository'
  | 'analysis'
  | 'planning'
  | 'semantic-review'
  | 'readiness'
  | 'approval'
  | 'binding'
  | 'metadata'
  | 'workspace'
  | 'authority'
  | 'launch';
export type CodingPresentationEvent =
  | { type: 'stage'; stage: CodingStage; state: 'active' | 'complete' | 'failed' }
  | { type: 'repository'; path: string }
  | { type: 'model'; provider: string; model: string; reasoning: string }
  | { type: 'plan'; artifact: PlanArtifact }
  | { type: 'run'; status: ForgeRunReadModel }
  | {
      type: 'identity';
      runId: string;
      approvalId: string;
      artifactId: string;
      repositoryPath: string;
    };

/** Presentation notifications carry observations only, never authority or commands. */
export type CodingPresentation = (event: CodingPresentationEvent) => void;
