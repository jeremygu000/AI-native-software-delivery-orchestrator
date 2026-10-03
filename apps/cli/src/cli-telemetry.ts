import { trace } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { NodeSDK } from '@opentelemetry/sdk-node';

export const startForgeCliTelemetry = (environment: NodeJS.ProcessEnv = process.env) => {
  if (environment.OTEL_TRACES_EXPORTER !== 'otlp' || !environment.OTEL_EXPORTER_OTLP_ENDPOINT) {
    return undefined;
  }
  const sdk = new NodeSDK({ traceExporter: new OTLPTraceExporter() });
  sdk.start();
  return sdk;
};

/** Planning predates run and task allocation, so only approved model identity is available. */
export const tracePlanningModelRequest = async <Result>(
  identity: {
    provider: string;
    model: string;
    reasoningEffort: string;
    role: 'planner' | 'reviewer';
    attemptId: string;
  },
  operation: () => Promise<Result>
): Promise<Result> =>
  trace.getTracer('forge-cli').startActiveSpan(
    'forge.model.request',
    {
      attributes: {
        provider: identity.provider,
        model: identity.model,
        reasoning_effort: identity.reasoningEffort,
        role: identity.role,
        attempt_id: identity.attemptId
      }
    },
    async (span) => {
      try {
        const result = await operation();
        span.setAttribute('outcome', 'completed');
        return result;
      } catch (error) {
        span.setAttribute('outcome', 'error');
        throw error;
      } finally {
        span.end();
      }
    }
  );
