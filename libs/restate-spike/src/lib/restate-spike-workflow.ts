import * as restate from '@restatedev/restate-sdk';

export interface RepairWakeSignal {
  readonly repairAttemptId: string;
  readonly leaseState: 'RELEASED' | 'STALE';
}

export interface RestateSpikeScenarioService {
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

export const restateSpikeActivities = restate.service({
  name: 'restate-spike-activities',
  handlers: {
    executeBuilder: async (
      _ctx: restate.Context,
      request: {
        readonly runId: string;
        readonly taskId: string;
        readonly attemptId: string;
        readonly agentId: string;
      }
    ) => {
      return {
        builderAttemptId: `builder-${request.runId}-${request.attemptId}`,
        workspaceId: `workspace-${request.runId}`,
        impactPrediction: [] as readonly string[]
      };
    },

    evaluateBuilderOutput: async (
      _ctx: restate.Context,
      request: {
        readonly runId: string;
        readonly builderAttemptId: string;
        readonly workspaceId: string;
        readonly verificationPolicyFingerprint: string;
      }
    ) => {
      return {
        verificationEvidenceId: `verification-${request.builderAttemptId}`,
        reviewSubjectRef: {
          builderAttemptId: request.builderAttemptId,
          outputAttemptId: `output-${request.builderAttemptId}`,
          workspaceId: request.workspaceId
        },
        recommendation: 'accept' as const
      };
    },

    executeRepair: async (
      _ctx: restate.Context,
      request: {
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
      }
    ) => {
      return {
        repairAttemptId: request.repairAttemptId,
        verificationEvidenceId: `verification-repair-${request.repairAttemptId}`,
        reviewSubjectRef: request.reviewSubjectRef,
        recommendation: 'accept' as const
      };
    },

    integrateAcceptedOutput: async (
      _ctx: restate.Context,
      _request: {
        readonly runId: string;
        readonly taskId: string;
        readonly workspaceId: string;
        readonly reviewSubjectRef: {
          readonly builderAttemptId: string;
          readonly outputAttemptId: string;
          readonly workspaceId: string;
        };
      }
    ) => {
      return {
        integrationStatus: 'integrated' as const
      };
    },

    executeBlockedRepairResume: async (
      _ctx: restate.Context,
      request: {
        readonly runId: string;
        readonly repairAttemptId: string;
        readonly leaseState: 'RELEASED' | 'STALE';
      }
    ) => {
      return {
        repairAttemptId: request.repairAttemptId,
        verificationEvidenceId: `verification-resume-${request.repairAttemptId}`,
        state: 'completed' as const
      };
    }
  }
});

export const restateSpikeWorkflow = restate.workflow({
  name: 'restate-spike-workflow',
  handlers: {
    run: async (
      ctx: restate.WorkflowContext,
      request: {
        readonly scenario: 'build-review-repair-integrate' | 'blocked-repair-restart-resume';
        readonly runId: string;
        readonly taskId: string;
        readonly attemptId: string;
        readonly agentId: string;
        readonly blockedRepairAttemptId?: string;
      }
    ) => {
      if (request.scenario === 'build-review-repair-integrate') {
        const builderResult = await ctx.run('executeBuilder', async () => {
          return ctx.serviceClient(restateSpikeActivities).executeBuilder({
            runId: request.runId,
            taskId: request.taskId,
            attemptId: request.attemptId,
            agentId: request.agentId
          });
        });

        const evaluationResult = await ctx.run('evaluateBuilderOutput', async () => {
          return ctx.serviceClient(restateSpikeActivities).evaluateBuilderOutput({
            runId: request.runId,
            builderAttemptId: builderResult.builderAttemptId,
            workspaceId: builderResult.workspaceId,
            verificationPolicyFingerprint: 'default'
          });
        });

        if (evaluationResult.recommendation === 'repair') {
          if (evaluationResult.repairAttemptId === undefined) {
            throw new Error('Forge must provide repairAttemptId for repair recommendation');
          }

          const repairResult = await ctx.run('executeRepair', async () => {
            return ctx.serviceClient(restateSpikeActivities).executeRepair({
              runId: request.runId,
              repairAttemptId: evaluationResult.repairAttemptId,
              builderAttemptId: builderResult.builderAttemptId,
              workspaceId: builderResult.workspaceId,
              reviewSubjectRef: evaluationResult.reviewSubjectRef,
              maxRepairs: 3
            });
          });

          if (repairResult.recommendation === 'accept') {
            await ctx.run('integrateAcceptedOutput', async () => {
              return ctx.serviceClient(restateSpikeActivities).integrateAcceptedOutput({
                runId: request.runId,
                taskId: request.taskId,
                workspaceId: builderResult.workspaceId,
                reviewSubjectRef: repairResult.reviewSubjectRef
              });
            });

            return {
              runId: request.runId,
              scenario: 'build-review-repair-integrate' as const,
              builderAttemptId: builderResult.builderAttemptId,
              repairAttemptId: repairResult.repairAttemptId
            };
          }

          throw new Error('Multi-repair not yet supported');
        }

        await ctx.run('integrateDirectAccept', async () => {
          return ctx.serviceClient(restateSpikeActivities).integrateAcceptedOutput({
            runId: request.runId,
            taskId: request.taskId,
            workspaceId: builderResult.workspaceId,
            reviewSubjectRef: evaluationResult.reviewSubjectRef
          });
        });

        return {
          runId: request.runId,
          scenario: 'build-review-repair-integrate' as const,
          builderAttemptId: builderResult.builderAttemptId
        };
      } else {
        if (request.blockedRepairAttemptId === undefined) {
          throw new Error('blockedRepairAttemptId is required for Scenario B');
        }

        const signalName = `repair-wake-${request.blockedRepairAttemptId}`;
        const wakePayload = await ctx.signal<RepairWakeSignal>(signalName);

        const result = await ctx.run('executeBlockedRepairResume', async () => {
          return ctx.serviceClient(restateSpikeActivities).executeBlockedRepairResume({
            runId: request.runId,
            repairAttemptId: wakePayload.repairAttemptId,
            leaseState: wakePayload.leaseState
          });
        });

        return {
          runId: request.runId,
          scenario: 'blocked-repair-restart-resume' as const,
          repairAttemptId: result.repairAttemptId
        };
      }
    }
  }
});

export type RestateSpikeActivities = typeof restateSpikeActivities;
export type RestateSpikeWorkflow = typeof restateSpikeWorkflow;
