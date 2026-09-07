import type { DurableExecutionScenarioService } from '@ai-native-software-delivery-orchestrator/orchestration-runtime';

/**
 * Side-effect adapter surface for the M2 spike.
 *
 * This interface defines the Temporal activity boundary between the workflow and Forge services.
 * It intentionally contains identifiers only - actual Forge authority evidence remains in the
 * authority store (SQLite) and is never stored in workflow history.
 *
 * Architecture:
 * - Workflow: Pure control flow, calls activities, stores only IDs in history
 * - Activities: Delegate to a DurableExecutionScenarioService which composes Forge services
 * - Forge services: Execute actual builder/repair logic, persist evidence to SQLite
 */
export interface TemporalSpikeActivity {
  executeBuilder(request: {
    readonly runId: string;
    readonly taskId: string;
    readonly attemptId: string;
    readonly agentId: string;
  }): Promise<{
    readonly builderAttemptId: string;
    readonly workspaceId: string;
    readonly impactPrediction: readonly string[];
  }>;

  evaluateBuilderOutput(request: {
    readonly runId: string;
    readonly builderAttemptId: string;
    readonly workspaceId: string;
    readonly verificationPolicyFingerprint: string;
  }): Promise<{
    readonly verificationEvidenceId: string;
    readonly reviewSubjectRef: {
      readonly builderAttemptId: string;
      readonly outputAttemptId: string;
      readonly workspaceId: string;
    };
    readonly recommendation: 'accept' | 'repair' | 'reject';
    readonly repairAttemptId?: string;
  }>;

  executeRepair(request: {
    readonly runId: string;
    readonly repairAttemptId: string;
    readonly builderAttemptId: string;
    readonly workspaceId: string;
    readonly reviewSubjectRef: {
      readonly builderAttemptId: string;
      readonly outputAttemptId: string;
      readonly workspaceId: string;
    };
    readonly maxRepairs: number;
  }): Promise<{
    readonly repairAttemptId: string;
    readonly verificationEvidenceId: string;
    readonly reviewSubjectRef: {
      readonly builderAttemptId: string;
      readonly outputAttemptId: string;
      readonly workspaceId: string;
    };
    readonly recommendation: 'accept' | 'repair' | 'reject';
  }>;

  integrateAcceptedOutput(request: {
    readonly runId: string;
    readonly taskId: string;
    readonly workspaceId: string;
    readonly reviewSubjectRef: {
      readonly builderAttemptId: string;
      readonly outputAttemptId: string;
      readonly workspaceId: string;
    };
  }): Promise<{
    readonly integrationStatus: 'integrated' | 'blocked';
  }>;

  executeBlockedRepairResume(request: {
    readonly runId: string;
    readonly repairAttemptId: string;
    readonly leaseState: 'RELEASED' | 'STALE';
  }): Promise<{
    readonly repairAttemptId: string;
    readonly verificationEvidenceId: string;
    readonly state: 'completed' | 'blocked' | 'unknown';
  }>;
}

export const createTemporalSpikeActivities = (
  service: DurableExecutionScenarioService
): TemporalSpikeActivity => ({
  executeBuilder: (request) => service.executeBuilder(request),
  evaluateBuilderOutput: (request) => service.evaluateBuilderOutput(request),
  executeRepair: (request) => service.executeRepair(request),
  integrateAcceptedOutput: (request) => service.integrateAcceptedOutput(request),
  executeBlockedRepairResume: (request) => service.executeBlockedRepairResume(request)
});
