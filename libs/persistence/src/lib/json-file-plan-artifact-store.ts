import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { RepositorySnapshot } from '@ai-native-software-delivery-orchestrator/domain';

import type {
  PlanArtifact,
  PlanArtifactStore
} from '@ai-native-software-delivery-orchestrator/planning';
import {
  canonicalPlanJson,
  parsePlanArtifact
} from '@ai-native-software-delivery-orchestrator/planning';

export class PlanArtifactStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanArtifactStoreError';
  }
}

const artifactFileName = (artifactId: string, revision: number): string =>
  `${artifactId}.r${revision}.json`;

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
    const temporary = join(this.#directory, `.${artifact.artifactId}.${randomUUID()}.tmp`);
    const content = `${JSON.stringify(artifact, null, 2)}\n`;
    await this.#assertOutsideForbiddenRepository();
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
    let primaryError: unknown;
    try {
      try {
        await link(temporary, target);
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') {
          throw error;
        }
        const existing = await this.load(artifact.artifactId, artifact.revision);
        if (existing === undefined || canonicalPlanJson(existing) !== canonicalPlanJson(artifact)) {
          throw new PlanArtifactStoreError(
            `Plan artifact revision is immutable: ${artifact.artifactId} revision ${artifact.revision}`
          );
        }
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
    if (this.#forbiddenRepositoryRoot === undefined) {
      return;
    }
    const [repositoryRoot, actualDirectory] = await Promise.all([
      realpath(this.#forbiddenRepositoryRoot),
      canonicalFuturePath(this.#directory)
    ]);
    if (isWithin(repositoryRoot, actualDirectory)) {
      throw new PlanArtifactStoreError(
        'Plan artifact directory resolved inside the analyzed repository during save'
      );
    }
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
