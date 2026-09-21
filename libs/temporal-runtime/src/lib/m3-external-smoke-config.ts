export interface M312ExternalSmokeConfig {
  readonly provider: 'openai';
  readonly model: 'gpt-4.1';
}

const required = (environment: NodeJS.ProcessEnv, name: string): string => {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`M3.12 external smoke requires ${name}`);
  }
  return value;
};

/**
 * External model execution is deliberately opt-in. One identity is bound to every Pi role,
 * including planning, semantic review, coding, and task code review.
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
  const provider = required(environment, 'FORGE_M312_REVIEW_PROVIDER');
  const model = required(environment, 'FORGE_M312_REVIEW_MODEL');
  if (provider !== 'openai' || model !== 'gpt-4.1') {
    throw new Error(
      'M3.12 external smoke only supports FORGE_M312_REVIEW_PROVIDER=openai and FORGE_M312_REVIEW_MODEL=gpt-4.1'
    );
  }
  return { provider, model };
};
