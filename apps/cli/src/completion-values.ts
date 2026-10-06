/** Presentation/evidence values; these do not add scheduler states. */
export const CompletionStage = {
  Verifying: 'VERIFYING',
  Reviewing: 'REVIEWING'
} as const;

export const CompletionScope = {
  Matched: 'matched',
  Rejected: 'rejected'
} as const;

export const CompletionOutcome = {
  Failed: 'failed'
} as const;
