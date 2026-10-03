import { createTemporalWorker } from '@ai-native-software-delivery-orchestrator/temporal-runtime';
import { createForgeWorkerComposition } from './forge-worker-composition.js';
import { resolveWorkerDeployment } from './worker-deployment-config.js';
import { inspectWorkerDeployment } from './worker-preflight.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 1 || args[0] !== '--preflight')) {
    throw new Error('Usage: forge-worker [--preflight]');
  }
  const { deployment, temporal, mode } = resolveWorkerDeployment();
  if (args[0] === '--preflight') {
    const report = await inspectWorkerDeployment({ deployment, temporal, mode });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === 'ready' ? 0 : 1;
    return;
  }
  const composition = await createForgeWorkerComposition(deployment);
  const handle = await createTemporalWorker(temporal, {
    forgeActivities: composition.forgeActivities
  });
  const shutdown = async (): Promise<void> => {
    await handle.shutdown();
    await composition.close();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  await handle.run();
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
