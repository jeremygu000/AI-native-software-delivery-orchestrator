export type ProjectGraphErrorCode =
  | 'INVALID_REPOSITORY'
  | 'INVALID_WORKSPACE_CONFIGURATION'
  | 'INVALID_PACKAGE_MANIFEST'
  | 'DUPLICATE_PROJECT_ID'
  | 'INVALID_PROJECT_DEPENDENCY'
  | 'INVALID_TYPESCRIPT_CONFIGURATION'
  | 'TYPESCRIPT_ANALYSIS_FAILED'
  | 'UNSUPPORTED_REPOSITORY';

export class ProjectGraphError extends Error {
  readonly code: ProjectGraphErrorCode;
  readonly path?: string;

  constructor(code: ProjectGraphErrorCode, message: string, path?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProjectGraphError';
    this.code = code;
    this.path = path;
  }
}
