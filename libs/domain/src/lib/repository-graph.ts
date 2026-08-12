export type ProjectId = string;
export type FileId = string;
export type SymbolId = string;

export interface RepositoryContext {
  readonly repositoryPath: string;
}

/**
 * Content-addressed evidence for the exact Git working tree used to derive repository facts.
 *
 * `baseCommit` alone is insufficient because planning may inspect tracked modifications or
 * untracked files. The working-tree fingerprint binds those bytes without exposing them here.
 */
export interface RepositorySnapshot {
  readonly repositoryId: string;
  readonly repositoryRoot: string;
  readonly baseCommit: string;
  readonly workingTreeFingerprint: string;
  readonly dirty: boolean;
}

export interface RepositorySnapshotProvider {
  capture(repository: RepositoryContext): Promise<RepositorySnapshot>;
}

export type PackageDependencyKind =
  | 'dependency'
  | 'dev-dependency'
  | 'peer-dependency'
  | 'optional-dependency';

export interface PackageDependency {
  readonly name: string;
  readonly version: string;
  readonly kind: PackageDependencyKind;
  readonly workspaceProtocol: boolean;
}

export type SymbolKind =
  | 'class'
  | 'constructor'
  | 'enum'
  | 'function'
  | 'interface'
  | 'method'
  | 'namespace'
  | 'property'
  | 'type'
  | 'variable';

export interface ProjectNode {
  readonly id: ProjectId;
  readonly name: string;
  readonly root: string;
  readonly packageJsonPath: string;
  readonly dependencies: readonly PackageDependency[];
  readonly scripts: Readonly<Record<string, string>>;
  readonly sourceRoots: readonly string[];
  readonly tsconfigPaths: readonly string[];
}

export interface FileNode {
  readonly id: FileId;
  readonly projectId: ProjectId;
  readonly path: string;
  readonly isGenerated: boolean;
}

export interface SymbolNode {
  readonly id: SymbolId;
  readonly fileId: FileId;
  readonly name: string;
  readonly path: string;
  readonly kind: SymbolKind;
  readonly mergedKinds?: readonly SymbolKind[];
  readonly parentSymbolId?: SymbolId;
  readonly exported: boolean;
  readonly signature?: string;
}

export interface GraphEdge<TNodeId extends string> {
  readonly from: TNodeId;
  readonly to: TNodeId;
}

export type ProjectDependencySource =
  | 'package-dependency'
  | 'workspace-protocol'
  | 'tsconfig-reference'
  | 'typescript-import'
  | 'generated-artifact'
  | 'manual';

export interface ProjectDependencyEdge extends GraphEdge<ProjectId> {
  readonly sources: readonly ProjectDependencySource[];
}

export type RepositoryDiagnosticCode =
  | 'EMPTY_TYPESCRIPT_PROJECT'
  | 'MISSING_TYPESCRIPT_CONFIGURATION'
  | 'UNCOVERED_TYPESCRIPT_FILES';

export interface RepositoryDiagnostic {
  readonly code: RepositoryDiagnosticCode;
  readonly severity: 'warning';
  readonly projectId: ProjectId;
  readonly message: string;
  readonly configPaths: readonly string[];
  readonly filePaths?: readonly string[];
}

export interface WorkspaceGraph {
  readonly repositoryPath: string;
  readonly projects: ReadonlyMap<ProjectId, ProjectNode>;
  readonly projectDependencies: readonly ProjectDependencyEdge[];
}

export interface RepositoryGraph extends WorkspaceGraph {
  readonly files: ReadonlyMap<FileId, FileNode>;
  readonly symbols: ReadonlyMap<SymbolId, SymbolNode>;
  readonly fileDependencies: readonly GraphEdge<FileId>[];
  readonly symbolReferences: readonly GraphEdge<SymbolId>[];
  readonly diagnostics: readonly RepositoryDiagnostic[];
}

export interface ApiSurfaceChange {
  readonly symbolId: SymbolId;
  readonly beforeSignature?: string;
  readonly afterSignature?: string;
  readonly consumers: readonly SymbolId[];
}

export interface WorkspaceGraphProvider {
  readonly id: string;
  supports(repository: RepositoryContext): Promise<boolean>;
  analyze(repository: RepositoryContext): Promise<WorkspaceGraph>;
}
