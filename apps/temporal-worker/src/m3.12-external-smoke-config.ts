export interface M312ExternalSmokeConfig {
  readonly reviewProvider: string;
  readonly reviewModel: string;
}

const required = (environment: NodeJS.ProcessEnv, name: string): string => {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`M3.12 external smoke requires ${name}`);
  }
  return value;
};

/**
 * External model execution is deliberately opt-in. Credential configuration stays provider-owned,
 * but an operator must explicitly attest that it is present before the runner creates any process.
 */
export const resolveM312ExternalSmokeConfig = (
  environment: NodeJS.ProcessEnv = process.env
): M312ExternalSmokeConfig => {
  if (environment.FORGE_M312_EXTERNAL_SMOKE !== '1') {
    throw new Error('M3.12 external smoke requires FORGE_M312_EXTERNAL_SMOKE=1');
  }
  if (environment.FORGE_M312_CREDENTIALS_CONFIRMED !== '1') {
    throw new Error('M3.12 external smoke requires FORGE_M312_CREDENTIALS_CONFIRMED=1');
  }
  if (environment.FORGE_M312_CODING_AGENT_CONFIRMED !== '1') {
    throw new Error('M3.12 external smoke requires FORGE_M312_CODING_AGENT_CONFIRMED=1');
  }
  return {
    reviewProvider: required(environment, 'FORGE_M312_REVIEW_PROVIDER'),
    reviewModel: required(environment, 'FORGE_M312_REVIEW_MODEL')
  };
};
