export {
  createRestateSpikeWorkflow,
  restateSpikeWorkflow,
  setSpikeHarness
} from './lib/restate-spike-workflow.js';
export { createRestateSpikeHarness } from './lib/shared-harness.js';

export type { RestateSpikeHarnessOptions } from './lib/shared-harness.js';

export type {
  DurableExecutionSpikeDriver,
  DurableExecutionSpikeOutcome
} from '@ai-native-software-delivery-orchestrator/orchestration-runtime';

export { assertDurableExecutionSpikeOutcome } from '@ai-native-software-delivery-orchestrator/orchestration-runtime';

export type { RepairWakeSignal } from './lib/restate-spike-workflow.js';
