/** Keep the validated PostgreSQL majors explicit; future releases fail closed. */
export const POSTGRES_AUTHORITY_SERVER_MAJORS = [14, 15, 16, 17, 18] as const;

export const resolvePostgresAuthorityServerMajor = (versionNumber: number): number => {
  const major = Math.floor(versionNumber / 10_000);
  if (
    !Number.isInteger(versionNumber) ||
    !POSTGRES_AUTHORITY_SERVER_MAJORS.some((supported) => supported === major)
  ) {
    throw new Error('PostgreSQL authority requires a validated server major version 14 through 18');
  }
  return major;
};
