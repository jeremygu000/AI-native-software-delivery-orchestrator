/** Side-effect adapter surface for the M2 spike. It intentionally contains identifiers only. */
export interface TemporalSpikeActivity {
  recordExecutionBoundary(request: {
    readonly runId: string;
    readonly scenario: 'build-review-repair-integrate' | 'blocked-repair-restart-resume';
  }): Promise<void>;
}

export const createTemporalSpikeActivities = (): TemporalSpikeActivity => ({
  recordExecutionBoundary: async () => undefined
});
