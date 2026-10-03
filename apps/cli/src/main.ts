#!/usr/bin/env node

import { createForgeProgram } from './app.js';
import { startForgeCliTelemetry } from './cli-telemetry.js';

const telemetry = startForgeCliTelemetry();
try {
  await createForgeProgram().parseAsync();
} finally {
  await telemetry?.shutdown();
}
