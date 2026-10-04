import {
  createForgeModelResolver,
  resolveForgeModelSelection,
  resolveSubscriptionExecution
} from '@ai-native-software-delivery-orchestrator/agent-runtime';
import { createCodeReviewPolicy } from '@ai-native-software-delivery-orchestrator/planning';

/** Both CLI input methods use the existing policy and subscription fingerprint path. */
export const resolveCliReviewPolicy = (
  provider: string,
  model: string,
  reasoningEffort?: string,
  environment: NodeJS.ProcessEnv = process.env
) => {
  provider = provider.trim();
  model = model.trim();
  const resolved = createForgeModelResolver().resolve({ provider, id: model });
  const configured =
    reasoningEffort === undefined
      ? environment
      : {
          ...environment,
          FORGE_MODEL_REASONING_EFFORT: reasoningEffort
        };
  const execution =
    resolved === undefined ? undefined : resolveSubscriptionExecution(resolved, configured);
  if (reasoningEffort !== undefined) {
    if (
      reasoningEffort !== 'off' &&
      reasoningEffort !== 'minimal' &&
      reasoningEffort !== 'low' &&
      reasoningEffort !== 'medium' &&
      reasoningEffort !== 'high' &&
      reasoningEffort !== 'xhigh'
    ) {
      throw new Error('Unsupported model reasoning effort');
    }
    // Reuse the same adapter validation as the picker; no UI-only model validation.
    resolveForgeModelSelection(
      {
        provider,
        model,
        reasoningEffort
      },
      configured
    );
  }
  const policy = createCodeReviewPolicy({
    provider,
    model,
    // Preserve the established direct-API policy shape and worker comparison boundary.
    ...(execution === undefined ? {} : { executionTarget: execution.target })
  });
  return { policy, model: resolved, execution };
};
