import type {
  AgentRunner,
  CreatePersistedRunRequest,
  RecoveredRun,
  SchedulerSnapshot,
  TaskImpact,
  TaskLeasePlan,
  WorkspaceManager
} from '@ai-native-software-delivery-orchestrator/domain';

export interface RuntimeTaskBinding {
  readonly taskId: string;
  readonly agentId: string;
  readonly leasePlan: TaskLeasePlan;
  readonly impact?: TaskImpact;
  readonly commandPolicy?: Parameters<AgentRunner['run']>[0]['commandPolicy'];
  readonly trustedCommandPath?: string;
  readonly workspace: Parameters<WorkspaceManager['create']>[0];
}

export interface StartRuntimeRunRequest extends Omit<CreatePersistedRunRequest, 'taskBindings'> {
  readonly taskBindings: readonly RuntimeTaskBinding[];
}

export interface RecoveredRuntimeRun {
  readonly run: RecoveredRun['run'];
  readonly snapshot: SchedulerSnapshot;
  readonly workspaces: RecoveredRun['workspaces'];
  readonly leases: RecoveredRun['leases'];
  readonly attempts: RecoveredRun['attempts'];
  readonly repairAttempts: readonly import('@ai-native-software-delivery-orchestrator/domain').PersistedTaskRepairAttempt[];
  readonly repairWorkItems: readonly import('@ai-native-software-delivery-orchestrator/domain').TaskRepairWorkItem[];
}
