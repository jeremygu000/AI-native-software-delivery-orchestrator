/**
 * M2 configuration boundary. The Temporal client and worker are introduced only inside this spike package.
 */
export interface TemporalSpikeConfiguration {
  readonly address: string;
  readonly namespace: string;
  readonly taskQueue: string;
}
