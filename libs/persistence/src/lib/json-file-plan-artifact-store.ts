import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { RepositorySnapshot } from '@ai-native-software-delivery-orchestrator/domain';

import type {
  PlanApproval,
  PlanApprovalClaim,
  PlanApprovalStore,
  PlanArtifact,
  PlanArtifactStore
} from '@ai-native-software-delivery-orchestrator/planning';
import {
  areEquivalentApprovalClaims,
  canonicalPlanJson,
  parsePlanApproval,
  parsePlanApprovalClaim,
  parsePlanArtifact
} from '@ai-native-software-delivery-orchestrator/planning';

export class PlanArtifactStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanArtifactStoreError';
  }
}

export class PlanApprovalStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanApprovalStoreError';
  }
}

const artifactFileName = (artifactId: string, revision: number): string =>
  `${artifactId}.r${revision}.json`;
const approvalFileName = (approvalId: string): string => `approval.${approvalId}.json`;
const approvalClaimFileName = (approvalId: string): string => `approval.${approvalId}.claim.json`;

const errorCode = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;

const canonicalFuturePath = async (path: string): Promise<string> => {
  let current = resolve(path);
  const missingSegments: string[] = [];
  for (;;) {
    try {
      return join(await realpath(current), ...missingSegments.toReversed());
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        throw error;
      }
      const parent = dirname(current);
      if (parent === current) {
        throw error;
      }
      missingSegments.push(basename(current));
      current = parent;
    }
  }
};

const isWithin = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};

const assertOutsideRepository = async (
  directory: string,
  forbiddenRepositoryRoot: string | undefined,
  recordName: string,
  createError: (message: string) => Error
): Promise<void> => {
  if (forbiddenRepositoryRoot === undefined) {
    return;
  }
  const [repositoryRoot, actualDirectory] = await Promise.all([
    realpath(forbiddenRepositoryRoot),
    canonicalFuturePath(directory)
  ]);
  if (isWithin(repositoryRoot, actualDirectory)) {
    throw createError(
      `${recordName} directory resolved inside the analyzed repository during save`
    );
  }
};

const publishImmutableRecord = async <T>(request: {
  readonly directory: string;
  readonly recordId: string;
  readonly target: string;
  readonly candidate: T;
  readonly loadExisting: () => Promise<T | undefined>;
  readonly equivalent: (existing: T, candidate: T) => boolean;
  readonly conflictError: () => Error;
}): Promise<T> => {
  const temporary = join(request.directory, `.${request.recordId}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(request.candidate, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx'
  });
  let primaryError: unknown;
  try {
    try {
      await link(temporary, request.target);
      return request.candidate;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') {
        throw error;
      }
      const existing = await request.loadExisting();
      if (existing === undefined || !request.equivalent(existing, request.candidate)) {
        throw request.conflictError();
      }
      return existing;
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (errorCode(error) !== 'ENOENT' && primaryError === undefined) {
        throw error;
      }
    });
  }
};

export const resolvePlanArtifactDirectory = async (
  snapshot: RepositorySnapshot,
  requestedDirectory?: string,
  forgeHome = join(homedir(), '.forge')
): Promise<string> => {
  const destination = await canonicalFuturePath(
    requestedDirectory ?? join(forgeHome, 'plans', snapshot.repositoryId.slice('sha256:'.length))
  );
  const repositoryRoot = await realpath(snapshot.repositoryRoot);
  if (isWithin(repositoryRoot, destination)) {
    throw new PlanArtifactStoreError(
      'Plan artifact directory must be outside the analyzed repository so persistence cannot invalidate its snapshot'
    );
  }
  return destination;
};

export class JsonFilePlanArtifactStore implements PlanArtifactStore {
  readonly #directory: string;
  readonly #forbiddenRepositoryRoot?: string;

  constructor(directory: string, forbiddenRepositoryRoot?: string) {
    this.#directory = resolve(directory);
    this.#forbiddenRepositoryRoot = forbiddenRepositoryRoot;
  }

  pathFor(artifactId: string, revision: number): string {
    const validated = parsePlanArtifactIdentity(artifactId, revision);
    return join(this.#directory, artifactFileName(validated.artifactId, validated.revision));
  }

  async save(candidate: PlanArtifact): Promise<void> {
    const artifact = parsePlanArtifact(candidate);
    await this.#assertOutsideForbiddenRepository();
    await mkdir(this.#directory, { recursive: true });
    await this.#assertOutsideForbiddenRepository();
    const target = this.pathFor(artifact.artifactId, artifact.revision);
    await this.#assertOutsideForbiddenRepository();
    await publishImmutableRecord({
      directory: this.#directory,
      recordId: artifact.artifactId,
      target,
      candidate: artifact,
      loadExisting: () => this.load(artifact.artifactId, artifact.revision),
      equivalent: (existing, requested) =>
        canonicalPlanJson(existing) === canonicalPlanJson(requested),
      conflictError: () =>
        new PlanArtifactStoreError(
          `Plan artifact revision is immutable: ${artifact.artifactId} revision ${artifact.revision}`
        )
    });
  }

  async load(artifactId: string, revision: number): Promise<PlanArtifact | undefined> {
    const path = this.pathFor(artifactId, revision);
    let content: string;
    try {
      content = await readFile(path, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
    const candidate: unknown = JSON.parse(content);
    const artifact = parsePlanArtifact(candidate);
    if (artifact.artifactId !== artifactId || artifact.revision !== revision) {
      throw new PlanArtifactStoreError(`Plan artifact key does not match its file name: ${path}`);
    }
    return artifact;
  }

  async #assertOutsideForbiddenRepository(): Promise<void> {
    await assertOutsideRepository(
      this.#directory,
      this.#forbiddenRepositoryRoot,
      'Plan artifact',
      (message) => new PlanArtifactStoreError(message)
    );
  }
}

export class JsonFilePlanApprovalStore implements PlanApprovalStore {
  readonly #directory: string;
  readonly #forbiddenRepositoryRoot?: string;

  constructor(directory: string, forbiddenRepositoryRoot?: string) {
    this.#directory = resolve(directory);
    this.#forbiddenRepositoryRoot = forbiddenRepositoryRoot;
  }

  pathFor(approvalId: string): string {
    return join(this.#directory, approvalFileName(parseRecordId(approvalId, 'approval')));
  }

  claimPathFor(approvalId: string): string {
    return join(this.#directory, approvalClaimFileName(parseRecordId(approvalId, 'approval')));
  }

  async save(candidate: PlanApproval): Promise<void> {
    const approval = parsePlanApproval(candidate);
    await this.#prepareDirectory();
    await publishImmutableRecord({
      directory: this.#directory,
      recordId: approval.approvalId,
      target: this.pathFor(approval.approvalId),
      candidate: approval,
      loadExisting: () => this.load(approval.approvalId),
      equivalent: (existing, requested) =>
        canonicalPlanJson(existing) === canonicalPlanJson(requested),
      conflictError: () =>
        new PlanApprovalStoreError(`Plan approval is immutable: ${approval.approvalId}`)
    });
  }

  async load(approvalId: string): Promise<PlanApproval | undefined> {
    const path = this.pathFor(approvalId);
    const candidate = await readOptionalJson(path);
    if (candidate === undefined) {
      return undefined;
    }
    const approval = parsePlanApproval(candidate);
    if (approval.approvalId !== approvalId) {
      throw new PlanApprovalStoreError(`Plan approval key does not match its file name: ${path}`);
    }
    return approval;
  }

  async claim(candidate: PlanApprovalClaim): Promise<PlanApprovalClaim> {
    const claim = parsePlanApprovalClaim(candidate);
    await this.#prepareDirectory();
    return publishImmutableRecord({
      directory: this.#directory,
      recordId: `${claim.approvalId}.claim`,
      target: this.claimPathFor(claim.approvalId),
      candidate: claim,
      loadExisting: () => this.loadClaim(claim.approvalId),
      equivalent: areEquivalentApprovalClaims,
      conflictError: () =>
        new PlanApprovalStoreError(
          `Plan approval is already claimed by another run: ${claim.approvalId}`
        )
    });
  }

  async loadClaim(approvalId: string): Promise<PlanApprovalClaim | undefined> {
    const path = this.claimPathFor(approvalId);
    const candidate = await readOptionalJson(path);
    if (candidate === undefined) {
      return undefined;
    }
    const claim = parsePlanApprovalClaim(candidate);
    if (claim.approvalId !== approvalId) {
      throw new PlanApprovalStoreError(
        `Plan approval claim key does not match its file name: ${path}`
      );
    }
    return claim;
  }

  async #prepareDirectory(): Promise<void> {
    const assertOutside = async (): Promise<void> =>
      assertOutsideRepository(
        this.#directory,
        this.#forbiddenRepositoryRoot,
        'Plan approval',
        (message) => new PlanApprovalStoreError(message)
      );
    await assertOutside();
    await mkdir(this.#directory, { recursive: true });
    await assertOutside();
  }
}

const parsePlanArtifactIdentity = (
  artifactId: string,
  revision: number
): { readonly artifactId: string; readonly revision: number } => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(artifactId)) {
    throw new PlanArtifactStoreError(`Invalid plan artifact ID: ${artifactId}`);
  }
  if (!Number.isInteger(revision) || revision <= 0) {
    throw new PlanArtifactStoreError(`Invalid plan artifact revision: ${revision}`);
  }
  return { artifactId, revision };
};

const parseRecordId = (recordId: string, recordName: string): string => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(recordId)) {
    throw new PlanApprovalStoreError(`Invalid plan ${recordName} ID: ${recordId}`);
  }
  return recordId;
};

const readOptionalJson = async (path: string): Promise<unknown> => {
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  return JSON.parse(content) as unknown;
};
