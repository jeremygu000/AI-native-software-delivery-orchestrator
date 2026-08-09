export type ProjectId = string;
export type FileId = string;
export type SymbolId = string;

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
  readonly sourceRoot?: string;
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

export interface RepositoryGraph {
  readonly repositoryPath: string;
  readonly projects: ReadonlyMap<ProjectId, ProjectNode>;
  readonly files: ReadonlyMap<FileId, FileNode>;
  readonly symbols: ReadonlyMap<SymbolId, SymbolNode>;
  readonly projectDependencies: readonly GraphEdge<ProjectId>[];
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

export interface RepositoryAnalysisRequest {
  readonly repositoryPath: string;
  readonly changedFiles?: readonly string[];
}

export interface RepositoryAnalyzer {
  analyze(request: RepositoryAnalysisRequest): Promise<RepositoryGraph>;
}

export interface ProjectGraphProvider {
  readonly id: string;
  supports(repositoryPath: string): Promise<boolean>;
  analyze(request: RepositoryAnalysisRequest): Promise<RepositoryGraph>;
}
