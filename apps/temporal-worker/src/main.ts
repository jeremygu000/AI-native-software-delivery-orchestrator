import { resolveTemporalConfig, createTemporalWorker } from '@ai-native-software-delivery-orchestrator/temporal-runtime';

async function main(): Promise<void> {
  const config = resolveTemporalConfig({
    serverUrl: process.env.TEMPORAL_SERVER_URL ?? 'http://localhost:7233',
    namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'forge-run',
  });

  const handle = await createTemporalWorker(config);

  const shutdown = async () => {
    await handle.shutdown();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await handle.run();
}

main().catch((err: unknown) => {
  console.error('Worker failed to start:', err);
  process.exit(1);
});
