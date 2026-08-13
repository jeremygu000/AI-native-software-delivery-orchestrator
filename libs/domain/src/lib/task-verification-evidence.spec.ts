import { describe, expect, it } from 'vitest';

import {
  assertTaskVerificationEvidenceIntegrity,
  taskVerificationEvidenceFingerprint,
  TaskVerificationEvidenceIntegrityError
} from './task-verification-evidence.js';

const payload = {
  id: 'verification-1',
  runId: 'run-1',
  taskId: 'task-1',
  attemptId: 'attempt-1',
  workspaceId: 'workspace-1',
  workspaceRevision: 1,
  workspaceChangeFingerprint: `sha256:${'1'.repeat(64)}`,
  verificationPolicyFingerprint: `sha256:${'2'.repeat(64)}`,
  status: 'passed' as const,
  verifiedAt: '2026-08-13T00:02:00.000Z'
};

describe('TaskVerificationEvidence', () => {
  it('accepts its canonical self fingerprint and rejects a valid-looking forged one', () => {
    const evidence = { ...payload, fingerprint: taskVerificationEvidenceFingerprint(payload) };
    expect(() => assertTaskVerificationEvidenceIntegrity(evidence)).not.toThrow();
    expect(() =>
      assertTaskVerificationEvidenceIntegrity({
        ...evidence,
        fingerprint: `sha256:${'f'.repeat(64)}`
      })
    ).toThrow(TaskVerificationEvidenceIntegrityError);
  });
});
