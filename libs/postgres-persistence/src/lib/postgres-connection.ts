import postgres from 'postgres';

/** Transport settings belong to PostgreSQL deployment, not durable authority identity. */
export interface PostgresConnectionConfiguration {
  readonly connectionString: string;
  readonly ssl?: false | 'verify-full';
}

export const resolvePostgresConnectionSsl = (
  value: string | undefined
): PostgresConnectionConfiguration['ssl'] => {
  if (value === undefined) {
    return undefined;
  }
  if (value === 'verify-full') {
    return value;
  }
  if (value === 'false') {
    return false;
  }
  throw new Error('FORGE_POSTGRES_SSL must be verify-full or false');
};

/** Only loopback development connections may omit verified TLS. */
export const openPostgresConnection = (
  configuration: PostgresConnectionConfiguration,
  options: Pick<
    postgres.Options<Record<string, never>>,
    'max' | 'onnotice' | 'connection' | 'connect_timeout'
  > = {}
): ReturnType<typeof postgres> => {
  let url: URL;
  try {
    url = new URL(configuration.connectionString);
  } catch {
    throw new Error('Invalid private PostgreSQL connection');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.searchParams.size !== 0) {
    throw new Error('PostgreSQL deployment requires a query-free PostgreSQL URL');
  }
  if (
    configuration.ssl !== undefined &&
    configuration.ssl !== false &&
    configuration.ssl !== 'verify-full'
  ) {
    throw new Error('PostgreSQL deployment requires ssl=false or ssl=verify-full');
  }
  if (
    configuration.ssl !== 'verify-full' &&
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  ) {
    throw new Error('Non-loopback PostgreSQL connections require explicit ssl=verify-full');
  }
  // The explicit option overrides URL/environment fallbacks and cannot be weakened by caller options.
  return postgres(configuration.connectionString, { ...options, ssl: configuration.ssl ?? false });
};
