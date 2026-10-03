import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { trace } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { NodeSDK } from '@opentelemetry/sdk-node';

const root = resolve(import.meta.dirname, '../../..');
let local = {};
try {
  local = parseEnv(await readFile(resolve(root, '.env.local'), 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') {
    throw error;
  }
}

for (const name of [
  'OTEL_SERVICE_NAME',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_TRACES_EXPORTER'
]) {
  if (process.env[name] === undefined && local[name] !== undefined) {
    process.env[name] = local[name];
  }
}

process.env.OTEL_SERVICE_NAME ||= 'forge-local';
process.env.OTEL_TRACES_EXPORTER ||= 'otlp';
process.env.OTEL_METRICS_EXPORTER ||= 'none';
process.env.OTEL_LOGS_EXPORTER ||= 'none';

if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  throw new Error('Set OTEL_EXPORTER_OTLP_ENDPOINT in .env.local or the shell');
}
if (process.env.OTEL_TRACES_EXPORTER !== 'otlp') {
  throw new Error('OTEL_TRACES_EXPORTER must be otlp for this check');
}

const exporter = new OTLPTraceExporter();
const sdk = new NodeSDK({ traceExporter: exporter });
sdk.start();
const span = trace.getTracer('forge-local-otel-check').startSpan('forge.startup');
if (!span.isRecording()) {
  await sdk.shutdown();
  throw new Error('OpenTelemetry did not record forge.startup; check SDK and sampler settings');
}
const traceId = span.spanContext().traceId;
span.end();

try {
  await sdk.shutdown();
  console.log(
    `Exported forge.startup trace ${traceId} (service: ${process.env.OTEL_SERVICE_NAME})`
  );
} catch {
  // Exporter errors may contain endpoint or authentication details.
  throw new Error('OTLP trace export failed; check endpoint and authentication');
}
