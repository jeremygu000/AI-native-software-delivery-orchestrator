import type {
  EvidenceStore,
  BuilderAttemptEvidence,
  RepairAttemptEvidence,
  VerificationEvidence,
  ReviewEvidence,
  LeaseEvidence,
  IntegrationEvidence,
  BlockedResumeEvidence
} from './outcome-collector.js';

export class InMemoryEvidenceStore implements EvidenceStore {
  private builderAttempts = new Map<string, BuilderAttemptEvidence>();
  private repairAttempts = new Map<string, RepairAttemptEvidence[]>();
  private verifications = new Map<string, VerificationEvidence[]>();
  private reviews = new Map<string, ReviewEvidence[]>();
  private leases = new Map<string, LeaseEvidence[]>();
  private integrations = new Map<string, IntegrationEvidence>();
  private blockedResumes = new Map<string, BlockedResumeEvidence>();

  constructor(private runId: string) {}

  setBuilderAttempt(attempt: BuilderAttemptEvidence): void {
    this.builderAttempts.set(this.runId, attempt);
  }

  addRepairAttempt(attempt: RepairAttemptEvidence): void {
    const existing = this.repairAttempts.get(this.runId) ?? [];
    existing.push(attempt);
    this.repairAttempts.set(this.runId, existing);
  }

  addVerification(verification: VerificationEvidence): void {
    const existing = this.verifications.get(this.runId) ?? [];
    existing.push(verification);
    this.verifications.set(this.runId, existing);
  }

  addReview(review: ReviewEvidence): void {
    const existing = this.reviews.get(this.runId) ?? [];
    existing.push(review);
    this.reviews.set(this.runId, existing);
  }

  addLease(lease: LeaseEvidence): void {
    const existing = this.leases.get(this.runId) ?? [];
    existing.push(lease);
    this.leases.set(this.runId, existing);
  }

  setIntegration(integration: IntegrationEvidence): void {
    this.integrations.set(this.runId, integration);
  }

  setBlockedResume(blockedResume: BlockedResumeEvidence): void {
    this.blockedResumes.set(this.runId, blockedResume);
  }

  getBuilderAttempt(runId: string): BuilderAttemptEvidence | undefined {
    return this.builderAttempts.get(runId);
  }

  getRepairAttempts(runId: string): readonly RepairAttemptEvidence[] {
    return this.repairAttempts.get(runId) ?? [];
  }

  getVerifications(runId: string): readonly VerificationEvidence[] {
    return this.verifications.get(runId) ?? [];
  }

  getReviews(runId: string): readonly ReviewEvidence[] {
    return this.reviews.get(runId) ?? [];
  }

  getLeases(runId: string): readonly LeaseEvidence[] {
    return this.leases.get(runId) ?? [];
  }

  getIntegration(runId: string): IntegrationEvidence | undefined {
    return this.integrations.get(runId);
  }

  getBlockedResume(runId: string): BlockedResumeEvidence | undefined {
    return this.blockedResumes.get(runId);
  }
}

export const createInMemoryEvidenceStore = (runId: string): InMemoryEvidenceStore => {
  return new InMemoryEvidenceStore(runId);
};
