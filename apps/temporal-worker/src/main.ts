import {
  resolveTemporalConfig,
  createTemporalWorker
} from '@ai-native-software-delivery-orchestrator/temporal-runtime';

import { createForgeWorkerComposition } from './forge-worker-composition.js';

async function main(): Promise<void> {
  const config = resolveTemporalConfig({
    serverUrl: process.env.TEMPORAL_SERVER_URL ?? 'http://localhost:7233',
    namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'forge-run'
  });

  const composition = await createForgeWorkerComposition();
  const handle = await createTemporalWorker(config, {
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
  console.error('Worker failed to start:', error);
  process.exit(1);
});
