import { realpathSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import type {
  FileNode,
  GraphEdge,
  ProjectNode,
  RepositoryDiagnostic,
  RepositoryGraph,
  SymbolKind,
  SymbolNode
} from '@apra-amcos-admin-coding-orchestrator/domain';
import {
  isClassDeclaration,
  isComputedPropertyName,
  isConstructorDeclaration,
  isEnumDeclaration,
  isFunctionDeclaration,
  isGetAccessorDeclaration,
  isIdentifier,
  isInterfaceDeclaration,
  isMethodDeclaration,
  isMethodSignatureDeclaration,
  isModuleBlock,
  isModuleDeclaration,
  isNumericLiteral,
  isParenthesizedExpression,
  isPropertyDeclaration,
  isPropertySignatureDeclaration,
  isSetAccessorDeclaration,
  isStringLiteral,
  isTypeAliasDeclaration,
  isVariableStatement,
  type ModifiersBase,
  type Node,
  type SourceFile,
  type Statement
} from '@typescript/native/unstable/ast';
import {
  API,
  ModifierFlags,
  SymbolFlags,
  type Checker,
  type Project,
  type Symbol as NativeSymbol
} from '@typescript/native/unstable/sync';
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { glob } from 'tinyglobby';

import { ProjectGraphError } from './project-graph-error.js';
import { compareText, isWithin, pathExists, toPortablePath } from './path-utils.js';
import { cleanupAnalysisResources, resolveAnalysisOutcome } from './analysis-lifecycle.js';

const TYPESCRIPT_FILE_PATTERN = /\.(?:cts|mts|tsx?|d\.ts)$/i;
const GENERATED_PATH_PATTERN =
  /(?:^|\/)(?:dist|generated|out-tsc)(?:\/|$)|\.generated\.[cm]?tsx?$/i;
// The native checker accepts arrays. The conservative starting batch of 500 caps temporary
// handle/memory pressure and has been exercised by real repositories with thousands of references;
// it is not a benchmark-derived optimum. Edge semantics are independent of the batch boundary.
const REFERENCE_BATCH_SIZE = 500;
const EMPTY_PROJECT_DIAGNOSTIC_CODES = new Set([18002, 18003]);
const SYMBOL_KIND_PRIORITY: Readonly<Record<SymbolKind, number>> = {
  class: 0,
  interface: 1,
  function: 2,
  enum: 3,
  namespace: 4,
  type: 5,
  variable: 6,
  constructor: 7,
  method: 8,
  property: 9
};

interface ProjectContext {
  readonly project: Project;
}

interface FileCandidate {
  readonly context: ProjectContext;
  readonly fileName: string;
  readonly fileKey: string;
  readonly owner: ProjectNode;
  readonly node: FileNode;
}

interface IndexedSymbol {
  readonly context: ProjectContext;
  readonly sourceFile: SourceFile;
  readonly declaration: Node;
  readonly node: SymbolNode;
  readonly privateOrProtected: boolean;
  readonly parentExportRule: ParentExportRule;
  readonly declaredExport: boolean;
}

type ParentExportRule = 'none' | 'public-member' | 'explicit-export';

interface ReferenceCandidate {
  readonly identifier: Node;
  readonly sourceSymbolId: string;
}

interface MemberNameState {
  readonly propertyOccurrences: Map<string, number>;
}

const realFilePath = (fileName: string): string => {
  const absolutePath = resolve(fileName);
  try {
    return realpathSync.native(absolutePath);
  } catch {
    return absolutePath;
  }
};

const canonicalResolvedPathKey = (absolutePath: string): string => {
  /* v8 ignore next 3 -- the alternate casing policy is exercised on Linux and Windows. */
  return process.platform === 'darwin' || process.platform === 'win32'
    ? absolutePath.toLowerCase()
    : absolutePath;
};

const canonicalFileKey = (fileName: string): string =>
  canonicalResolvedPathKey(realFilePath(fileName));

const nodeKey = (node: Node): string =>
  `${canonicalFileKey(node.getSourceFile().fileName)}:${node.getStart(node.getSourceFile())}`;

const findOwningProject = (
  repositoryPath: string,
  projectsBySpecificity: readonly ProjectNode[],
  fileName: string
): ProjectNode | undefined =>
  projectsBySpecificity.find((project) => {
    const projectPath = project.root === '.' ? repositoryPath : join(repositoryPath, project.root);
    return isWithin(projectPath, fileName);
  });

const isOwningProjectContext = (
  repositoryPath: string,
  projectsBySpecificity: readonly ProjectNode[],
  owner: ProjectNode,
  context: ProjectContext
): boolean =>
  findOwningProject(repositoryPath, projectsBySpecificity, context.project.configFileName)?.id ===
  owner.id;

const readConfigReferences = async (configPath: string): Promise<readonly string[]> => {
  let source: string;
  try {
    source = await readFile(configPath, 'utf8');
  } catch (error) {
    throw new ProjectGraphError(
      'INVALID_TYPESCRIPT_CONFIGURATION',
      `Cannot read TypeScript configuration ${configPath}`,
      configPath,
      { cause: error }
    );
  }

  const parseErrors: ParseError[] = [];
  const parsed = parse(source, parseErrors, {
    allowTrailingComma: true,
    disallowComments: false
  }) as unknown;
  if (parseErrors.length > 0) {
    const details = parseErrors
      .map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`)
      .join(', ');
    throw new ProjectGraphError(
      'INVALID_TYPESCRIPT_CONFIGURATION',
      `Cannot parse TypeScript configuration ${configPath}: ${details}`,
      configPath
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProjectGraphError(
      'INVALID_TYPESCRIPT_CONFIGURATION',
      `${configPath} must contain a JSON object`,
      configPath
    );
  }

  const references = Reflect.get(parsed, 'references');
  if (references === undefined) {
    return [];
  }
  if (!Array.isArray(references)) {
    throw new ProjectGraphError(
      'INVALID_TYPESCRIPT_CONFIGURATION',
      `${configPath} references must be an array`,
      configPath
    );
  }

  return references.map((reference, index) => {
    if (reference === null || typeof reference !== 'object' || Array.isArray(reference)) {
      throw new ProjectGraphError(
        'INVALID_TYPESCRIPT_CONFIGURATION',
        `${configPath} reference ${index} must be an object`,
        configPath
      );
    }
    const path = Reflect.get(reference, 'path');
    if (typeof path !== 'string' || path.trim() === '') {
      throw new ProjectGraphError(
        'INVALID_TYPESCRIPT_CONFIGURATION',
        `${configPath} reference ${index} must declare a non-empty path`,
        configPath
      );
    }
    return path;
  });
};

const resolveReferencedConfigPath = async (
  repositoryPath: string,
  configPath: string,
  reference: string
): Promise<string> => {
  const referencedPath = resolve(dirname(configPath), reference);
  if (!isWithin(repositoryPath, referencedPath)) {
    throw new ProjectGraphError(
      'INVALID_TYPESCRIPT_CONFIGURATION',
      `TypeScript project reference resolves outside the repository: ${reference}`,
      configPath
    );
  }

  const candidates = referencedPath.endsWith('.json')
    ? [referencedPath]
    : [referencedPath, `${referencedPath}.json`, join(referencedPath, 'tsconfig.json')];
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) {
        const canonicalPath = await realpath(candidate);
        if (!isWithin(repositoryPath, canonicalPath)) {
          throw new ProjectGraphError(
            'INVALID_TYPESCRIPT_CONFIGURATION',
            `TypeScript project reference resolves outside the repository: ${reference}`,
            configPath
          );
        }
        return canonicalPath;
      }
    } catch {
      // Try the next TypeScript-supported project-reference shape.
    }
  }
  throw new ProjectGraphError(
    'INVALID_TYPESCRIPT_CONFIGURATION',
    `Cannot resolve TypeScript project reference ${reference} from ${configPath}`,
    configPath
  );
};

const discoverConfigPaths = async (graph: RepositoryGraph): Promise<readonly string[]> => {
  const pending: string[] = [];
  for (const project of graph.projects.values()) {
    const projectPath =
      project.root === '.' ? graph.repositoryPath : join(graph.repositoryPath, project.root);
    const configPath = join(projectPath, 'tsconfig.json');
    if (await pathExists(configPath)) {
      pending.push(configPath);
    }
  }

  const discovered = new Set<string>();
  while (pending.length > 0) {
    const nextConfigPath = pending.shift();
    if (nextConfigPath === undefined) {
      continue;
    }
    let configPath: string;
    try {
      configPath = await realpath(nextConfigPath);
    } catch (error) {
      throw new ProjectGraphError(
        'INVALID_TYPESCRIPT_CONFIGURATION',
        `Cannot resolve TypeScript configuration ${nextConfigPath}`,
        nextConfigPath,
        { cause: error }
      );
    }
    if (!isWithin(graph.repositoryPath, configPath)) {
      throw new ProjectGraphError(
        'INVALID_TYPESCRIPT_CONFIGURATION',
        `TypeScript configuration resolves outside the repository: ${nextConfigPath}`,
        nextConfigPath
      );
    }
    if (discovered.has(configPath)) {
      continue;
    }
    discovered.add(configPath);
    for (const reference of await readConfigReferences(configPath)) {
      pending.push(await resolveReferencedConfigPath(graph.repositoryPath, configPath, reference));
    }
  }
  return [...discovered].toSorted(compareText);
};

const contextPriority = (context: ProjectContext): number =>
  /(?:^|\.)(?:spec|test)(?:\.|$)/i.test(basename(context.project.configFileName)) ? 0 : 1;

const discoverFiles = (
  graph: RepositoryGraph,
  contexts: readonly ProjectContext[]
): ReadonlyMap<string, FileCandidate> => {
  const projectsBySpecificity = [...graph.projects.values()].toSorted(
    (a, b) => b.root.length - a.root.length || compareText(a.root, b.root)
  );
  const candidates = new Map<string, FileCandidate>();

  for (const context of contexts) {
    for (const fileName of context.project.program.getSourceFileNames()) {
      const absoluteFileName = resolve(fileName);
      if (
        !isWithin(graph.repositoryPath, absoluteFileName) ||
        absoluteFileName.includes(`${sep}node_modules${sep}`) ||
        !TYPESCRIPT_FILE_PATTERN.test(absoluteFileName)
      ) {
        continue;
      }
      const realFileName = realFilePath(absoluteFileName);
      if (
        !isWithin(graph.repositoryPath, realFileName) ||
        realFileName.includes(`${sep}node_modules${sep}`)
      ) {
        continue;
      }
      const owner = findOwningProject(graph.repositoryPath, projectsBySpecificity, realFileName);
      if (owner === undefined) {
        continue;
      }
      if (!isOwningProjectContext(graph.repositoryPath, projectsBySpecificity, owner, context)) {
        continue;
      }
      const fileKey = canonicalResolvedPathKey(realFileName);
      const existing = candidates.get(fileKey);
      if (
        existing !== undefined &&
        (contextPriority(existing.context) > contextPriority(context) ||
          (contextPriority(existing.context) === contextPriority(context) &&
            compareText(existing.context.project.configFileName, context.project.configFileName) <=
              0))
      ) {
        continue;
      }

      const path = toPortablePath(relative(graph.repositoryPath, realFileName));
      candidates.set(fileKey, {
        context,
        fileName,
        fileKey,
        owner,
        node: {
          id: `${owner.id}:${path}`,
          projectId: owner.id,
          path,
          isGenerated: GENERATED_PATH_PATTERN.test(path)
        }
      });
    }
  }

  return new Map(
    [...candidates.entries()].toSorted(([, a], [, b]) => compareText(a.node.path, b.node.path))
  );
};

const discoverTypeScriptFilesByProject = async (
  graph: RepositoryGraph
): Promise<ReadonlyMap<string, readonly string[]>> => {
  const projectsBySpecificity = [...graph.projects.values()].toSorted(
    (a, b) => b.root.length - a.root.length || compareText(a.root, b.root)
  );
  const filePathsByProject = new Map<string, string[]>();
  const globOptions = {
    absolute: true,
    cwd: graph.repositoryPath,
    dot: true,
    followSymbolicLinks: false,
    ignore: ['**/.git/**', '**/coverage/**', '**/dist/**', '**/node_modules/**', '**/out-tsc/**'],
    onlyFiles: true
  } as const;
  const [fileNames, workspaceFiles] = await Promise.all([
    glob(['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'], globOptions),
    glob('**/pnpm-workspace.yaml', globOptions)
  ]);
  const nestedWorkspacePaths = workspaceFiles
    .map((workspaceFile) => dirname(workspaceFile))
    .filter(
      (workspacePath) => canonicalFileKey(workspacePath) !== canonicalFileKey(graph.repositoryPath)
    );
  for (const fileName of fileNames) {
    if (nestedWorkspacePaths.some((workspacePath) => isWithin(workspacePath, fileName))) {
      continue;
    }
    const owner = findOwningProject(graph.repositoryPath, projectsBySpecificity, fileName);
    if (owner === undefined) {
      continue;
    }
    const filePaths = filePathsByProject.get(owner.id) ?? [];
    filePaths.push(toPortablePath(relative(graph.repositoryPath, fileName)));
    filePathsByProject.set(owner.id, filePaths);
  }
  return new Map(
    [...filePathsByProject].map(([projectId, filePaths]) => [
      projectId,
      filePaths.toSorted(compareText)
    ])
  );
};

const getSourceFile = (candidate: FileCandidate): SourceFile | undefined =>
  candidate.context.project.program.getSourceFile(candidate.fileName);

const resolveSymbolDeclarationFileIds = (
  symbol: NativeSymbol | undefined,
  checker: Checker,
  files: ReadonlyMap<string, FileCandidate>
): readonly string[] => {
  if (symbol === undefined) {
    return [];
  }
  const target =
    (symbol.flags & SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
  if (checker.isUnknownSymbol(target)) {
    return [];
  }
  const fileIds = new Set<string>();
  for (const declaration of target.declarations) {
    const file = files.get(canonicalFileKey(declaration.path));
    if (file !== undefined) {
      fileIds.add(file.node.id);
    }
  }
  return [...fileIds].toSorted(compareText);
};

const buildFileDependencies = (
  files: ReadonlyMap<string, FileCandidate>
): readonly GraphEdge<string>[] => {
  const edges = new Map<string, GraphEdge<string>>();
  for (const source of files.values()) {
    const sourceFile = getSourceFile(source);
    if (sourceFile === undefined) {
      continue;
    }
    for (const moduleSpecifier of sourceFile.imports) {
      const symbol = source.context.project.checker.getSymbolAtLocation(moduleSpecifier);
      for (const targetFileId of resolveSymbolDeclarationFileIds(
        symbol,
        source.context.project.checker,
        files
      )) {
        if (source.node.id === targetFileId) {
          continue;
        }
        const edge = { from: source.node.id, to: targetFileId };
        edges.set(`${edge.from}\0${edge.to}`, edge);
      }
    }
  }
  return [...edges.values()].toSorted(
    (a, b) => compareText(a.from, b.from) || compareText(a.to, b.to)
  );
};

const hasModifier = (node: ModifiersBase, modifier: ModifierFlags): boolean =>
  (node.modifierFlags & modifier) !== 0;

const isPrivateOrProtected = (node: ModifiersBase): boolean =>
  hasModifier(node, ModifierFlags.Private) || hasModifier(node, ModifierFlags.Protected);

const unwrapParenthesized = (node: Node): Node => {
  let expression = node;
  while (isParenthesizedExpression(expression)) {
    expression = expression.expression;
  }
  return expression;
};

const computedName = (
  node: Node,
  sourceFile: SourceFile,
  occurrence: number | undefined
): string | undefined => {
  if (!isComputedPropertyName(node)) {
    return undefined;
  }
  const expression = unwrapParenthesized(node.expression);
  if (isStringLiteral(expression) || isNumericLiteral(expression)) {
    return expression.text;
  }
  const baseName = `<computed:${expression.getText(sourceFile)}>`;
  return occurrence === undefined ? baseName : `${baseName}#${occurrence}`;
};

const declarationName = (
  node: Node,
  sourceFile: SourceFile,
  computedOccurrence?: number
): string | undefined => {
  if (isConstructorDeclaration(node)) {
    return 'constructor';
  }
  if (
    isClassDeclaration(node) ||
    isFunctionDeclaration(node) ||
    isInterfaceDeclaration(node) ||
    isTypeAliasDeclaration(node) ||
    isEnumDeclaration(node) ||
    isModuleDeclaration(node) ||
    isMethodDeclaration(node) ||
    isMethodSignatureDeclaration(node) ||
    isGetAccessorDeclaration(node) ||
    isSetAccessorDeclaration(node) ||
    isPropertyDeclaration(node) ||
    isPropertySignatureDeclaration(node)
  ) {
    if (node.name === undefined) {
      return undefined;
    }
    return (
      computedName(node.name, sourceFile, computedOccurrence) ??
      (isStringLiteral(node.name) || isNumericLiteral(node.name)
        ? node.name.text
        : node.name.getText(sourceFile))
    );
  }
  return undefined;
};

const symbolPath = (parent: SymbolNode | undefined, name: string): string => {
  const segment = name.replaceAll('%', '%25').replaceAll('.', '%2E').replaceAll(':', '%3A');
  return parent === undefined ? segment : `${parent.path}.${segment}`;
};

const mergeSymbolKinds = (
  existing: SymbolNode | undefined,
  kind: SymbolKind
): readonly SymbolKind[] =>
  [
    ...new Set([
      ...(existing?.mergedKinds ?? (existing === undefined ? [] : [existing.kind])),
      kind
    ])
  ].toSorted((a, b) => SYMBOL_KIND_PRIORITY[a] - SYMBOL_KIND_PRIORITY[b]);

const addIndexedSymbol = (
  candidate: FileCandidate,
  sourceFile: SourceFile,
  declaration: Node,
  name: string,
  kind: SymbolKind,
  path: string,
  parentSymbolId: string | undefined,
  modifiers: ModifiersBase,
  parentExportRule: ParentExportRule,
  parentExported: boolean,
  symbols: Map<string, SymbolNode>,
  indexed: IndexedSymbol[],
  declarations: Map<string, string>
): SymbolNode => {
  const id = `${candidate.node.id}:${path}`;
  const privateOrProtected = isPrivateOrProtected(modifiers);
  const declaredExport = hasModifier(modifiers, ModifierFlags.Export);
  const exported =
    !privateOrProtected &&
    (parentExportRule === 'none'
      ? declaredExport
      : parentExported &&
        (parentExportRule === 'public-member' ||
          (parentExportRule === 'explicit-export' && declaredExport)));
  const existing = symbols.get(id);
  const mergedKinds = mergeSymbolKinds(existing, kind);
  const symbolNode: SymbolNode = {
    ...existing,
    id,
    fileId: candidate.node.id,
    name,
    path,
    kind: mergedKinds[0] ?? kind,
    ...(mergedKinds.length > 1 ? { mergedKinds } : {}),
    ...(parentSymbolId === undefined ? {} : { parentSymbolId }),
    exported: existing?.exported === true || exported
  };
  symbols.set(id, symbolNode);
  indexed.push({
    context: candidate.context,
    sourceFile,
    declaration,
    node: symbolNode,
    privateOrProtected,
    parentExportRule,
    declaredExport
  });
  declarations.set(nodeKey(declaration), id);
  return symbolNode;
};

const indexMember = (
  candidate: FileCandidate,
  sourceFile: SourceFile,
  member: Node,
  nameState: MemberNameState,
  parent: SymbolNode,
  parentExported: boolean,
  symbols: Map<string, SymbolNode>,
  indexed: IndexedSymbol[],
  declarations: Map<string, string>
): void => {
  let kind: SymbolKind | undefined;
  let modifiers: ModifiersBase | undefined;
  if (isConstructorDeclaration(member)) {
    kind = 'constructor';
    modifiers = member;
  } else if (
    isMethodDeclaration(member) ||
    isMethodSignatureDeclaration(member) ||
    isGetAccessorDeclaration(member) ||
    isSetAccessorDeclaration(member)
  ) {
    kind = 'method';
    modifiers = member;
  } else if (isPropertyDeclaration(member) || isPropertySignatureDeclaration(member)) {
    kind = 'property';
    modifiers = member;
  }
  if (kind === undefined || modifiers === undefined) {
    return;
  }
  let computedOccurrence: number | undefined;
  if (
    kind === 'property' &&
    (isPropertyDeclaration(member) || isPropertySignatureDeclaration(member)) &&
    isComputedPropertyName(member.name) &&
    !isStringLiteral(member.name.expression) &&
    !isNumericLiteral(member.name.expression)
  ) {
    const expressionNode = unwrapParenthesized(member.name.expression);
    const expression = expressionNode.getText(sourceFile);
    computedOccurrence = (nameState.propertyOccurrences.get(expression) ?? 0) + 1;
    nameState.propertyOccurrences.set(expression, computedOccurrence);
  }
  const name = declarationName(member, sourceFile, computedOccurrence);
  if (name === undefined) {
    return;
  }
  addIndexedSymbol(
    candidate,
    sourceFile,
    member,
    name,
    kind,
    symbolPath(parent, name),
    parent.id,
    modifiers,
    'public-member',
    parentExported,
    symbols,
    indexed,
    declarations
  );
};

const indexStatements = (
  candidate: FileCandidate,
  sourceFile: SourceFile,
  statements: readonly Statement[],
  container: SymbolNode | undefined,
  symbols: Map<string, SymbolNode>,
  indexed: IndexedSymbol[],
  declarations: Map<string, string>
): void => {
  for (const statement of statements) {
    let kind: SymbolKind | undefined;
    let modifiers: ModifiersBase | undefined;
    if (isClassDeclaration(statement)) {
      kind = 'class';
      modifiers = statement;
    } else if (isFunctionDeclaration(statement)) {
      kind = 'function';
      modifiers = statement;
    } else if (isInterfaceDeclaration(statement)) {
      kind = 'interface';
      modifiers = statement;
    } else if (isTypeAliasDeclaration(statement)) {
      kind = 'type';
      modifiers = statement;
    } else if (isEnumDeclaration(statement)) {
      kind = 'enum';
      modifiers = statement;
    } else if (isModuleDeclaration(statement)) {
      kind = 'namespace';
      modifiers = statement;
    }

    if (kind !== undefined && modifiers !== undefined) {
      const name =
        declarationName(statement, sourceFile) ??
        (hasModifier(modifiers, ModifierFlags.Default) ? 'default' : undefined);
      if (name === undefined) {
        continue;
      }
      const parent = addIndexedSymbol(
        candidate,
        sourceFile,
        statement,
        name,
        kind,
        symbolPath(container, name),
        container?.id,
        modifiers,
        container === undefined ? 'none' : 'explicit-export',
        container?.exported ?? true,
        symbols,
        indexed,
        declarations
      );
      if (isClassDeclaration(statement) || isInterfaceDeclaration(statement)) {
        const nameState: MemberNameState = { propertyOccurrences: new Map() };
        for (const member of statement.members) {
          indexMember(
            candidate,
            sourceFile,
            member,
            nameState,
            parent,
            parent.exported,
            symbols,
            indexed,
            declarations
          );
        }
      } else if (isModuleDeclaration(statement) && statement.body !== undefined) {
        const namespaceStatements = isModuleBlock(statement.body)
          ? statement.body.statements
          : [statement.body];
        indexStatements(
          candidate,
          sourceFile,
          namespaceStatements,
          parent,
          symbols,
          indexed,
          declarations
        );
      }
      continue;
    }

    if (isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!isIdentifier(declaration.name)) {
          continue;
        }
        addIndexedSymbol(
          candidate,
          sourceFile,
          declaration,
          declaration.name.text,
          'variable',
          symbolPath(container, declaration.name.text),
          container?.id,
          statement,
          container === undefined ? 'none' : 'explicit-export',
          container?.exported ?? true,
          symbols,
          indexed,
          declarations
        );
      }
    }
  }
};

const indexSourceFileSymbols = (
  candidate: FileCandidate,
  sourceFile: SourceFile,
  symbols: Map<string, SymbolNode>,
  indexed: IndexedSymbol[],
  declarations: Map<string, string>
): void => {
  indexStatements(
    candidate,
    sourceFile,
    sourceFile.statements,
    undefined,
    symbols,
    indexed,
    declarations
  );
};

const markModuleExports = (
  files: ReadonlyMap<string, FileCandidate>,
  symbols: Map<string, SymbolNode>,
  declarations: ReadonlyMap<string, string>,
  indexed: readonly IndexedSymbol[]
): void => {
  for (const candidate of files.values()) {
    const sourceFile = getSourceFile(candidate);
    if (sourceFile === undefined) {
      continue;
    }
    const checker = candidate.context.project.checker;
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    if (moduleSymbol === undefined) {
      continue;
    }
    for (const exportedSymbol of checker.getExportsOfModule(moduleSymbol)) {
      const target =
        (exportedSymbol.flags & SymbolFlags.Alias) !== 0
          ? checker.getAliasedSymbol(exportedSymbol)
          : exportedSymbol;
      if (checker.isUnknownSymbol(target)) {
        continue;
      }
      for (const declaration of target.declarations) {
        const resolved = declaration.resolve();
        if (resolved === undefined) {
          continue;
        }
        const symbolId = declarations.get(nodeKey(resolved));
        const symbol = symbolId === undefined ? undefined : symbols.get(symbolId);
        if (symbol !== undefined && !symbol.exported) {
          symbols.set(symbol.id, { ...symbol, exported: true });
        }
      }
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of indexed) {
      const symbol = symbols.get(entry.node.id);
      const parent =
        symbol?.parentSymbolId === undefined ? undefined : symbols.get(symbol.parentSymbolId);
      if (
        symbol !== undefined &&
        !symbol.exported &&
        !entry.privateOrProtected &&
        parent?.exported &&
        (entry.parentExportRule === 'public-member' ||
          (entry.parentExportRule === 'explicit-export' && entry.declaredExport))
      ) {
        symbols.set(symbol.id, { ...symbol, exported: true });
        changed = true;
      }
    }
  }
};

const findTargetSymbolId = (
  symbol: NativeSymbol | undefined,
  checker: Checker,
  declarations: ReadonlyMap<string, string>
): string | undefined => {
  if (symbol === undefined) {
    return undefined;
  }
  const target =
    (symbol.flags & SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
  if (checker.isUnknownSymbol(target)) {
    return undefined;
  }
  for (const declaration of target.declarations) {
    const resolved = declaration.resolve();
    if (resolved === undefined) {
      continue;
    }
    const symbolId = declarations.get(nodeKey(resolved));
    if (symbolId !== undefined) {
      return symbolId;
    }
  }
  return undefined;
};

const collectReferenceCandidates = (
  indexed: readonly IndexedSymbol[],
  declarations: ReadonlyMap<string, string>
): ReadonlyMap<ProjectContext, readonly ReferenceCandidate[]> => {
  const candidates = new Map<ProjectContext, ReferenceCandidate[]>();
  for (const entry of indexed) {
    const references = candidates.get(entry.context) ?? [];
    const visit = (node: Node): void => {
      if (node !== entry.declaration && declarations.has(nodeKey(node))) {
        return;
      }
      if (isIdentifier(node)) {
        references.push({ identifier: node, sourceSymbolId: entry.node.id });
      }
      node.forEachChild((child) => {
        visit(child);
        return undefined;
      });
    };
    visit(entry.declaration);
    candidates.set(entry.context, references);
  }
  return candidates;
};

const buildSymbolReferences = (
  indexed: readonly IndexedSymbol[],
  declarations: ReadonlyMap<string, string>
): readonly GraphEdge<string>[] => {
  const edges = new Map<string, GraphEdge<string>>();
  const candidatesByContext = collectReferenceCandidates(indexed, declarations);

  for (const [context, candidates] of candidatesByContext) {
    const checker = context.project.checker;
    const targetCache = new Map<number, string | undefined>();
    for (let offset = 0; offset < candidates.length; offset += REFERENCE_BATCH_SIZE) {
      const batch = candidates.slice(offset, offset + REFERENCE_BATCH_SIZE);
      const nativeSymbols = checker.getSymbolAtLocation(
        batch.map((candidate) => candidate.identifier)
      );
      for (const [index, nativeSymbol] of nativeSymbols.entries()) {
        const candidate = batch[index];
        if (candidate === undefined || nativeSymbol === undefined) {
          continue;
        }
        let targetId = targetCache.get(nativeSymbol.id);
        if (!targetCache.has(nativeSymbol.id)) {
          targetId = findTargetSymbolId(nativeSymbol, checker, declarations);
          targetCache.set(nativeSymbol.id, targetId);
        }
        if (targetId === undefined || targetId === candidate.sourceSymbolId) {
          continue;
        }
        const edge = { from: candidate.sourceSymbolId, to: targetId };
        edges.set(`${edge.from}\0${edge.to}`, edge);
      }
    }
  }

  return [...edges.values()].toSorted(
    (a, b) => compareText(a.from, b.from) || compareText(a.to, b.to)
  );
};

const mergeProjectDependencies = (
  graph: RepositoryGraph,
  files: ReadonlyMap<string, FileCandidate>,
  fileDependencies: readonly GraphEdge<string>[]
): readonly GraphEdge<string>[] => {
  const projectIdByFileId = new Map(
    [...files.values()].map((candidate) => [candidate.node.id, candidate.node.projectId])
  );
  const edges = new Map<string, GraphEdge<string>>();
  for (const edge of graph.projectDependencies) {
    edges.set(`${edge.from}\0${edge.to}`, edge);
  }
  for (const edge of fileDependencies) {
    const from = projectIdByFileId.get(edge.from);
    const to = projectIdByFileId.get(edge.to);
    if (from === undefined || to === undefined || from === to) {
      continue;
    }
    edges.set(`${from}\0${to}`, { from, to });
  }
  return [...edges.values()].toSorted(
    (a, b) => compareText(a.from, b.from) || compareText(a.to, b.to)
  );
};

const buildRepositoryDiagnostics = (
  graph: RepositoryGraph,
  configPaths: readonly string[],
  files: ReadonlyMap<string, FileCandidate>,
  discoveredTypeScriptFiles: ReadonlyMap<string, readonly string[]>
): readonly RepositoryDiagnostic[] => {
  const diagnostics: RepositoryDiagnostic[] = [];
  const projectsBySpecificity = [...graph.projects.values()].toSorted(
    (a, b) => b.root.length - a.root.length || compareText(a.root, b.root)
  );
  const indexedPaths = new Set([...files.values()].map((file) => file.node.path));
  for (const project of graph.projects.values()) {
    const projectConfigPaths = configPaths
      .filter(
        (configPath) =>
          findOwningProject(graph.repositoryPath, projectsBySpecificity, configPath)?.id ===
          project.id
      )
      .map((configPath) => toPortablePath(relative(graph.repositoryPath, configPath)))
      .toSorted(compareText);
    if (projectConfigPaths.length === 0) {
      diagnostics.push({
        code: 'MISSING_TYPESCRIPT_CONFIGURATION',
        severity: 'warning',
        projectId: project.id,
        message: `Project ${project.id} has no root TypeScript configuration and was not indexed`,
        configPaths: []
      });
      continue;
    }
    if (![...files.values()].some((file) => file.owner.id === project.id)) {
      diagnostics.push({
        code: 'EMPTY_TYPESCRIPT_PROJECT',
        severity: 'warning',
        projectId: project.id,
        message: `Project ${project.id} produced no owned TypeScript source files`,
        configPaths: projectConfigPaths
      });
    }
    const uncoveredFilePaths = (discoveredTypeScriptFiles.get(project.id) ?? []).filter(
      (filePath) => !indexedPaths.has(filePath)
    );
    if (uncoveredFilePaths.length > 0) {
      diagnostics.push({
        code: 'UNCOVERED_TYPESCRIPT_FILES',
        severity: 'warning',
        projectId: project.id,
        message: `Project ${project.id} has ${uncoveredFilePaths.length} TypeScript file(s) not covered by a discovered configuration`,
        configPaths: projectConfigPaths,
        filePaths: uncoveredFilePaths
      });
    }
  }
  return diagnostics;
};

export const analyzeTypeScriptRepository = async (
  graph: RepositoryGraph
): Promise<RepositoryGraph> => {
  const configPaths = await discoverConfigPaths(graph);
  const discoveredTypeScriptFiles = await discoverTypeScriptFilesByProject(graph);
  if (configPaths.length === 0) {
    return {
      ...graph,
      diagnostics: [
        ...graph.diagnostics,
        ...buildRepositoryDiagnostics(graph, [], new Map(), discoveredTypeScriptFiles)
      ]
    };
  }

  const api = new API();
  let snapshot: ReturnType<API['updateSnapshot']> | undefined;
  let result: RepositoryGraph | undefined;
  let analysisFailure: unknown;
  try {
    snapshot = api.updateSnapshot({ openProjects: [...configPaths] });
    const contexts = snapshot.getProjects().map((project) => ({ project }));
    for (const context of contexts) {
      const diagnostics = context.project.program
        .getConfigFileParsingDiagnostics()
        .filter((diagnostic) => !EMPTY_PROJECT_DIAGNOSTIC_CODES.has(diagnostic.code));
      if (diagnostics.length > 0) {
        throw new ProjectGraphError(
          'INVALID_TYPESCRIPT_CONFIGURATION',
          `${context.project.configFileName}: ${diagnostics.map((diagnostic) => diagnostic.text).join('; ')}`,
          context.project.configFileName
        );
      }
    }
    const fileCandidates = discoverFiles(graph, contexts);
    const files = new Map(
      [...fileCandidates.values()].map((candidate) => [candidate.node.id, candidate.node])
    );
    const fileDependencies = buildFileDependencies(fileCandidates);

    const symbols = new Map<string, SymbolNode>();
    const indexed: IndexedSymbol[] = [];
    const declarations = new Map<string, string>();
    for (const candidate of fileCandidates.values()) {
      const sourceFile = getSourceFile(candidate);
      if (sourceFile !== undefined) {
        indexSourceFileSymbols(candidate, sourceFile, symbols, indexed, declarations);
      }
    }
    markModuleExports(fileCandidates, symbols, declarations, indexed);
    const orderedSymbols = new Map(
      [...symbols.entries()].toSorted(([, a], [, b]) => compareText(a.id, b.id))
    );
    const symbolReferences = buildSymbolReferences(indexed, declarations);

    result = {
      ...graph,
      files,
      symbols: orderedSymbols,
      projectDependencies: mergeProjectDependencies(graph, fileCandidates, fileDependencies),
      fileDependencies,
      symbolReferences,
      diagnostics: [
        ...graph.diagnostics,
        ...buildRepositoryDiagnostics(graph, configPaths, fileCandidates, discoveredTypeScriptFiles)
      ]
    };
  } catch (error) {
    analysisFailure = error;
  }

  const cleanupFailure = cleanupAnalysisResources(
    () => snapshot?.dispose(),
    () => api.close()
  );
  return resolveAnalysisOutcome(graph, result, analysisFailure, cleanupFailure);
};
