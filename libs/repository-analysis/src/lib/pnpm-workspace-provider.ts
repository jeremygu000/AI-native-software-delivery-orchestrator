import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

import type {
  GraphEdge,
  ProjectGraphProvider,
  ProjectNode,
  RepositoryAnalysisRequest,
  RepositoryGraph
} from '@apra-amcos-admin-coding-orchestrator/domain';
import { glob } from 'tinyglobby';
import { parse } from 'yaml';

import { ProjectGraphError } from './project-graph-error.js';
import { compareText, isWithin, pathExists, toPortablePath } from './path-utils.js';

const WORKSPACE_FILE = 'pnpm-workspace.yaml';
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies'
] as const;

interface PackageManifest {
  readonly name: string;
  readonly dependencies: ReadonlyMap<string, string>;
}

interface DiscoveredProject {
  readonly manifestPath: string;
  readonly node: ProjectNode;
  readonly dependencies: ReadonlyMap<string, string>;
}

const readWorkspacePatterns = async (workspacePath: string): Promise<readonly string[]> => {
  let parsed: unknown;
  try {
    parsed = parse(await readFile(workspacePath, 'utf8')) as unknown;
  } catch (error) {
    throw new ProjectGraphError(
      'INVALID_WORKSPACE_CONFIGURATION',
      `Cannot parse ${workspacePath}`,
      workspacePath,
      { cause: error }
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProjectGraphError(
      'INVALID_WORKSPACE_CONFIGURATION',
      `${workspacePath} must contain a YAML object`,
      workspacePath
    );
  }

  const packages = Reflect.get(parsed, 'packages');
  if (packages === undefined) {
    return [];
  }
  if (!Array.isArray(packages) || packages.some((pattern) => typeof pattern !== 'string')) {
    throw new ProjectGraphError(
      'INVALID_WORKSPACE_CONFIGURATION',
      `${workspacePath} packages must be an array of strings`,
      workspacePath
    );
  }

  return packages;
};

const toManifestPattern = (workspacePattern: string): string => {
  const negated = workspacePattern.startsWith('!');
  const rawPattern = negated ? workspacePattern.slice(1) : workspacePattern;
  const pattern = rawPattern.replace(/\/+$/, '');
  const manifestPattern =
    pattern === '' || pattern === '.' ? 'package.json' : `${pattern}/package.json`;
  return negated ? `!${manifestPattern}` : manifestPattern;
};

const readManifest = async (manifestPath: string): Promise<PackageManifest> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
  } catch (error) {
    throw new ProjectGraphError(
      'INVALID_PACKAGE_MANIFEST',
      `Cannot parse ${manifestPath}`,
      manifestPath,
      { cause: error }
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProjectGraphError(
      'INVALID_PACKAGE_MANIFEST',
      `${manifestPath} must contain a JSON object`,
      manifestPath
    );
  }

  const name = Reflect.get(parsed, 'name');
  if (typeof name !== 'string' || name.trim() === '') {
    throw new ProjectGraphError(
      'INVALID_PACKAGE_MANIFEST',
      `${manifestPath} must declare a non-empty package name`,
      manifestPath
    );
  }

  const dependencies = new Map<string, string>();
  for (const field of DEPENDENCY_FIELDS) {
    const values = Reflect.get(parsed, field);
    if (values === undefined) {
      continue;
    }
    if (values === null || typeof values !== 'object' || Array.isArray(values)) {
      throw new ProjectGraphError(
        'INVALID_PACKAGE_MANIFEST',
        `${manifestPath} ${field} must be an object`,
        manifestPath
      );
    }
    for (const [dependencyName, version] of Object.entries(values)) {
      if (typeof version !== 'string') {
        throw new ProjectGraphError(
          'INVALID_PACKAGE_MANIFEST',
          `${manifestPath} dependency ${dependencyName} must have a string version`,
          manifestPath
        );
      }
      dependencies.set(dependencyName, version);
    }
  }

  return { name: name.trim(), dependencies };
};

const discoverManifestPaths = async (
  repositoryPath: string,
  patterns: readonly string[]
): Promise<readonly string[]> => {
  const manifestPatterns = patterns.map(toManifestPattern);
  const matches = await glob(manifestPatterns, {
    cwd: repositoryPath,
    absolute: true,
    dot: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    ignore: ['**/node_modules/**']
  });
  const rootManifestPath = join(repositoryPath, 'package.json');
  const candidates = new Set(matches.map((path) => resolve(path)));
  if (await pathExists(rootManifestPath)) {
    candidates.add(rootManifestPath);
  }

  const safePaths: string[] = [];
  for (const candidate of candidates) {
    const canonicalPath = await realpath(candidate);
    if (!isWithin(repositoryPath, canonicalPath)) {
      throw new ProjectGraphError(
        'INVALID_WORKSPACE_CONFIGURATION',
        `Workspace package resolves outside the repository: ${candidate}`,
        candidate
      );
    }
    safePaths.push(canonicalPath);
  }
  return safePaths.toSorted(compareText);
};

const discoverProject = async (
  repositoryPath: string,
  manifestPath: string
): Promise<DiscoveredProject> => {
  const manifest = await readManifest(manifestPath);
  const packagePath = dirname(manifestPath);
  const root = toPortablePath(relative(repositoryPath, packagePath)) || '.';
  const sourcePath = join(packagePath, 'src');
  const sourceRoot = (await pathExists(sourcePath))
    ? toPortablePath(relative(repositoryPath, sourcePath))
    : undefined;

  return {
    manifestPath,
    node: {
      id: manifest.name,
      name: manifest.name,
      root,
      ...(sourceRoot === undefined ? {} : { sourceRoot })
    },
    dependencies: manifest.dependencies
  };
};

const buildProjectDependencies = (
  projects: readonly DiscoveredProject[]
): readonly GraphEdge<string>[] => {
  const projectIds = new Set(projects.map((project) => project.node.id));
  const edges = new Map<string, GraphEdge<string>>();

  for (const project of projects) {
    for (const [dependencyId, version] of project.dependencies) {
      if (version.startsWith('workspace:') && !projectIds.has(dependencyId)) {
        throw new ProjectGraphError(
          'INVALID_PROJECT_DEPENDENCY',
          `${project.node.id} declares missing workspace dependency ${dependencyId}`,
          project.manifestPath
        );
      }
      if (!projectIds.has(dependencyId)) {
        continue;
      }
      if (dependencyId === project.node.id) {
        throw new ProjectGraphError(
          'INVALID_PROJECT_DEPENDENCY',
          `${project.node.id} cannot depend on itself`,
          project.manifestPath
        );
      }
      const edge = { from: project.node.id, to: dependencyId };
      edges.set(`${edge.from}\0${edge.to}`, edge);
    }
  }

  return [...edges.values()].toSorted(
    (a, b) => compareText(a.from, b.from) || compareText(a.to, b.to)
  );
};

export class PnpmWorkspaceProvider implements ProjectGraphProvider {
  readonly id = 'pnpm-workspace';

  async supports(repositoryPath: string): Promise<boolean> {
    return pathExists(join(resolve(repositoryPath), WORKSPACE_FILE));
  }

  async analyze(request: RepositoryAnalysisRequest): Promise<RepositoryGraph> {
    const requestedPath = resolve(request.repositoryPath);
    let repositoryPath: string;
    try {
      const repositoryStats = await stat(requestedPath);
      if (!repositoryStats.isDirectory()) {
        throw new Error('Not a directory');
      }
      repositoryPath = await realpath(requestedPath);
    } catch (error) {
      throw new ProjectGraphError(
        'INVALID_REPOSITORY',
        `Repository path is not a readable directory: ${requestedPath}`,
        requestedPath,
        { cause: error }
      );
    }

    const workspacePath = join(repositoryPath, WORKSPACE_FILE);
    if (!(await pathExists(workspacePath))) {
      throw new ProjectGraphError(
        'INVALID_WORKSPACE_CONFIGURATION',
        `${workspacePath} does not exist`,
        workspacePath
      );
    }

    const patterns = await readWorkspacePatterns(workspacePath);
    const manifestPaths = await discoverManifestPaths(repositoryPath, patterns);
    const discoveredProjects = (
      await Promise.all(
        manifestPaths.map((manifestPath) => discoverProject(repositoryPath, manifestPath))
      )
    ).toSorted((a, b) => {
      if (a.node.root === '.') {
        return -1;
      }
      if (b.node.root === '.') {
        return 1;
      }
      return compareText(a.node.root, b.node.root);
    });
    const projects = new Map<string, ProjectNode>();
    for (const project of discoveredProjects) {
      const duplicate = projects.get(project.node.id);
      if (duplicate !== undefined) {
        throw new ProjectGraphError(
          'DUPLICATE_PROJECT_ID',
          `Duplicate workspace package name ${project.node.id} at ${duplicate.root} and ${project.node.root}`,
          project.manifestPath
        );
      }
      projects.set(project.node.id, project.node);
    }

    return {
      repositoryPath,
      projects,
      files: new Map(),
      symbols: new Map(),
      projectDependencies: buildProjectDependencies(discoveredProjects),
      fileDependencies: [],
      symbolReferences: [],
      diagnostics: []
    };
  }
}
