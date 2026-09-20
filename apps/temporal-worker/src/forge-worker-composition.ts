import { Context } from '@temporalio/activity';

import { createForgeRuntimeComposition } from '@ai-native-software-delivery-orchestrator/forge-runtime-composition';
import type {
  ForgeRuntimeComposition,
  ForgeRuntimeCompositionOverrides
} from '@ai-native-software-delivery-orchestrator/forge-runtime-composition';

export {
  reviewPolicyFingerprint,
  verificationPolicyFingerprint
} from '@ai-native-software-delivery-orchestrator/forge-runtime-composition';
export type {
  ForgeRuntimeComposition as ForgeWorkerComposition,
  ForgeRuntimeCompositionOverrides as ForgeWorkerCompositionOverrides
} from '@ai-native-software-delivery-orchestrator/forge-runtime-composition';

/**
 * Temporal adapter around the provider-neutral Forge runtime composition.
 * Direct activity tests run without a Temporal context and receive no signal.
 */
export async function createForgeWorkerComposition(
  overrides: ForgeRuntimeCompositionOverrides = {}
): Promise<ForgeRuntimeComposition> {
  return createForgeRuntimeComposition(overrides, {
    getActivityExecutionContext: () => {
      try {
        return { cancellationSignal: Context.current().cancellationSignal };
      } catch {
        return undefined;
      }
    }
  });
}
