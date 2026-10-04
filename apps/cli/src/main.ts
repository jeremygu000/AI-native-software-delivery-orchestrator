#!/usr/bin/env node

import { createForgeProgram } from './app.js';
import { ModelSelectionCancelled, ModelSelectionError } from './model-selection.js';
import { startForgeCliTelemetry } from './cli-telemetry.js';

const telemetry = startForgeCliTelemetry();
try {
  await createForgeProgram().parseAsync();
} catch (error) {
  if (!(error instanceof ModelSelectionError)) {
    throw error;
  }
  process.stderr.write(`${error.message}\n`);
  process.exitCode = error instanceof ModelSelectionCancelled ? 130 : 1;
} finally {
  await telemetry?.shutdown();
}
