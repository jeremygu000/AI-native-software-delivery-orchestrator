import { createTemporalWorker } from '@ai-native-software-delivery-orchestrator/temporal-runtime';
import { createForgeWorkerComposition } from './forge-worker-composition.js';
import { resolveWorkerDeployment } from './worker-deployment-config.js';
import { inspectWorkerDeployment } from './worker-preflight.js';
import { startForgeTelemetry } from './forge-telemetry.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 1 || args[0] !== '--preflight')) {
    throw new Error('Usage: forge-worker [--preflight]');
  }
  if (args[0] !== '--preflight') {
    console.log('Initializing Forge worker...');
  }
  const { deployment, temporal, mode } = resolveWorkerDeployment();
  if (args[0] === '--preflight') {
    const report = await inspectWorkerDeployment({
      deployment,
      temporal,
      mode
    });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === 'ready' ? 0 : 1;
    return;
  }
  const telemetry = startForgeTelemetry();
  try {
    const composition = await createForgeWorkerComposition(deployment);
    let closed = false;
    const closeComposition = async (): Promise<void> => {
      if (!closed) {
        closed = true;
        await composition.close();
      }
    };
    try {
      const handle = await createTemporalWorker(temporal, {
        forgeActivities: composition.forgeActivities,
        onStartup: (stage) => {
          if (stage === 'connecting') {
            console.log('Connecting to Temporal...');
          }
          if (stage === 'bundling') {
            console.log('Building Temporal workflow bundle...');
          }
        },
        ...(telemetry === undefined ? {} : { plugins: [telemetry.plugin] })
      });
      const shutdown = async (): Promise<void> => {
        await handle.shutdown();
        await closeComposition();
      };
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
      try {
        console.log(`Starting worker on task queue: ${temporal.taskQueue}`);
        const running = handle.run();
        if (handle.worker.getState() === 'RUNNING') {
          console.log(`Forge worker is ready and polling for tasks on ${temporal.taskQueue}.`);
        }
        await running;
      } finally {
        process.off('SIGTERM', shutdown);
        process.off('SIGINT', shutdown);
      }
    } finally {
      await closeComposition();
    }
  } finally {
    await telemetry?.shutdown();
  }
}

main().catch((error: unknown) => {
  if (process.argv.includes('--preflight')) {
    console.error('Worker preflight configuration or invocation is invalid');
    process.exitCode = 1;
  } else {
    console.error('Worker failed to start:', error);
    process.exit(1);
  }
});
