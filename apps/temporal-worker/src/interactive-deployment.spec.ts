import { realpath } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCodeReviewPolicy,
  codeReviewPolicyFingerprint
} from '@ai-native-software-delivery-orchestrator/planning';
import { checkInteractiveDeployment } from './interactive-deployment.js';
const probes = vi.hoisted(() => ({
  resolve: vi.fn(),
  inspect: vi.fn(),
  client: vi.fn(),
  describe: vi.fn(),
  close: vi.fn()
}));
vi.mock('./worker-deployment-config.js', () => ({ resolveWorkerDeployment: probes.resolve }));
vi.mock('./worker-preflight.js', () => ({ inspectWorkerDeployment: probes.inspect }));
vi.mock('@ai-native-software-delivery-orchestrator/temporal-runtime', () => ({
  createTemporalClient: probes.client
}));
const policy = createCodeReviewPolicy({ provider: 'deepseek', model: 'deepseek-flash' });
const request = async () => ({
  repositoryPath: await realpath(process.cwd()),
  policyFingerprint: codeReviewPolicyFingerprint(policy)
});
beforeEach(() => {
  vi.resetAllMocks();
  probes.resolve.mockReturnValue({
    deployment: { repositoryPath: process.cwd(), codeReviewPolicy: policy },
    temporal: { namespace: 'default', taskQueue: 'approved-queue', connectTimeoutMs: 1000 }
  });
  probes.inspect.mockResolvedValue({ status: 'ready' });
  probes.describe.mockResolvedValue({ pollers: [{ identity: 'worker' }] });
  probes.client.mockResolvedValue({
    connection: {
      withDeadline: async (_: number, call: () => Promise<unknown>) => call(),
      workflowService: { describeTaskQueue: probes.describe }
    },
    close: probes.close
  });
});
describe('Interactive worker readiness', () => {
  it('checks the unchanged deployment and both existing queue kinds without starting a worker', async () => {
    const env = { FORGE_WORKER_REVIEW_PROVIDER: 'deepseek' };
    await checkInteractiveDeployment(await request(), env);
    expect(probes.resolve).toHaveBeenCalledWith(env);
    expect(probes.describe.mock.calls.map(([call]) => call.taskQueueType)).toEqual([1, 2]);
    expect(probes.close).toHaveBeenCalledOnce();
  });
  it('refuses a mismatched policy before authority or queue access', async () => {
    await expect(
      checkInteractiveDeployment({ ...(await request()), policyFingerprint: 'wrong' })
    ).rejects.toThrow('differs');
    expect(probes.inspect).not.toHaveBeenCalled();
    expect(probes.client).not.toHaveBeenCalled();
  });
  it('refuses a different repository before authority access', async () => {
    await expect(
      checkInteractiveDeployment({ ...(await request()), repositoryPath: '/other' })
    ).rejects.toThrow('differs');
    expect(probes.inspect).not.toHaveBeenCalled();
  });
  it('refuses failed authority preflight before queue access', async () => {
    probes.inspect.mockResolvedValueOnce({ status: 'not-ready' });
    await expect(checkInteractiveDeployment(await request())).rejects.toThrow('not ready');
    expect(probes.client).not.toHaveBeenCalled();
  });
  it('refuses absent activity pollers and closes the Temporal client', async () => {
    probes.describe.mockResolvedValueOnce({ pollers: [{}] }).mockResolvedValueOnce({ pollers: [] });
    await expect(checkInteractiveDeployment(await request())).rejects.toThrow('Start the worker');
    expect(probes.close).toHaveBeenCalledOnce();
  });
  it('closes the client after a queue service error', async () => {
    probes.describe.mockRejectedValueOnce(new Error('unavailable'));
    await expect(checkInteractiveDeployment(await request())).rejects.toThrow('unavailable');
    expect(probes.close).toHaveBeenCalledOnce();
  });
});
