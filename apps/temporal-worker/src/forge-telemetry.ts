import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { context, trace, type Context } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanProcessor
} from '@opentelemetry/sdk-trace-base';
import { OpenTelemetryPlugin } from '@temporalio/interceptors-opentelemetry-v2';

export interface ForgeTraceIdentity {
  readonly runId?: string;
  readonly taskId?: string;
  readonly attemptId?: string;
}

const allowedAttributes = new Set([
  'run_id',
  'task_id',
  'attempt_id',
  'provider',
  'model',
  'reasoning_effort',
  'role',
  'outcome'
]);

/** Temporal injects WorkflowInfo attributes (including memo and failure data).
 * Strip them before every export, including workflow-isolate spans. */
export class ForgeSafeSpanProcessor implements SpanProcessor {
  constructor(private readonly delegate: SpanProcessor) {}

  onStart(span: Parameters<SpanProcessor['onStart']>[0], parentContext: Context): void {
    this.delegate.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    const attributes = Object.fromEntries(
      Object.entries(span.attributes).filter(([name]) => allowedAttributes.has(name))
    );
    this.delegate.onEnd(
      new Proxy(span, {
        get(target, property) {
          if (property === 'attributes') {
            return attributes;
          }
          if (property === 'events' || property === 'links') {
            return [];
          }
          if (property === 'status') {
            return { code: target.status.code };
          }
          return Reflect.get(target, property, target);
        }
      })
    );
  }

  forceFlush(): Promise<void> {
    return this.delegate.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }
}

const identityAttributes = ({ runId, taskId, attemptId }: ForgeTraceIdentity) => ({
  ...(runId === undefined ? {} : { run_id: runId }),
  ...(taskId === undefined ? {} : { task_id: taskId }),
  ...(attemptId === undefined ? {} : { attempt_id: attemptId })
});

/** Only explicit scalar identities and outcomes enter telemetry. Never record an exception body. */
export const traceForgeOperation = async <Result>(
  name: 'forge.verification' | 'forge.review' | 'forge.repair' | 'forge.integration',
  identity: ForgeTraceIdentity,
  operation: () => Promise<Result>,
  outcome?: (result: Result) => string
): Promise<Result> =>
  trace
    .getTracer('forge-worker')
    .startActiveSpan(name, { attributes: identityAttributes(identity) }, async (span) => {
      try {
        const result = await operation();
        span.setAttribute('outcome', outcome?.(result) ?? 'completed');
        return result;
      } catch (error) {
        span.setAttribute('outcome', 'error');
        throw error;
      } finally {
        span.end();
      }
    });

export interface ForgeModelTraceIdentity extends ForgeTraceIdentity {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly role: 'planner' | 'builder' | 'reviewer' | 'repair';
}

export const traceForgeModelRequest = async <Result>(
  identity: ForgeModelTraceIdentity,
  operation: () => Promise<Result>,
  parent: Context = context.active()
): Promise<Result> =>
  context.with(parent, () =>
    trace.getTracer('forge-worker').startActiveSpan(
      'forge.model.request',
      {
        attributes: {
          ...identityAttributes(identity),
          provider: identity.provider,
          model: identity.model,
          reasoning_effort: identity.reasoningEffort,
          role: identity.role
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
    )
  );

/** Keep telemetry opt-in: ordinary workers and preflight never contact an exporter. */
export const startForgeTelemetry = (environment: NodeJS.ProcessEnv = process.env) => {
  if (
    environment.FORGE_OTEL_INSTRUMENTATION !== '1' ||
    environment.OTEL_TRACES_EXPORTER !== 'otlp' ||
    !environment.OTEL_EXPORTER_OTLP_ENDPOINT
  ) {
    return undefined;
  }
  const resource = resourceFromAttributes({
    'service.name': environment.OTEL_SERVICE_NAME || 'forge-local'
  });
  const spanProcessor = new ForgeSafeSpanProcessor(new BatchSpanProcessor(new OTLPTraceExporter()));
  const sdk = new NodeSDK({ resource, spanProcessors: [spanProcessor] });
  sdk.start();
  return {
    plugin: new OpenTelemetryPlugin({ resource, spanProcessor }),
    shutdown: () => sdk.shutdown()
  };
};
