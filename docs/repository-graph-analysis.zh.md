---
title: RepositoryGraph 分析器——实现与工作机制
tags:
  - coding-orchestrator
  - repository-graph
  - architecture
status: implemented
---

# RepositoryGraph 分析器——实现与工作机制

本文是项目进度说明的独立技术补充,详细解释 `forge analyze <repository>` 如何把一个 pnpm
TypeScript 仓库转换成确定性的 `RepositoryGraph`:每条事实来自哪里、身份怎样保持稳定,以及
分析器明确不会推断什么。

## 一句话说明

分析器组合两类证据:

```text
pnpm workspace 与 package manifest
                  +
TypeScript Program 与 Type Checker
                  |
                  v
            规范化的图事实
```

pnpm 提供 package 归属和显式 workspace 依赖;TypeScript 提供源码文件、解析后的 module、代码
声明、export 和符号引用。确定性的转换规则把这些工具专有事实转换成领域层自己拥有的节点与边。

这不是 LLM 分析。它不调用模型、不通过网络发送源码,也不会修改被分析仓库。

## 图里表示什么

```text
RepositoryGraph
├── repositoryPath
├── projects: Map<ProjectId, ProjectNode>
├── files: Map<FileId, FileNode>
├── symbols: Map<SymbolId, SymbolNode>
├── projectDependencies: ProjectId -> ProjectId
├── fileDependencies: FileId -> FileId
├── symbolReferences: SymbolId -> SymbolId
└── diagnostics: RepositoryDiagnostic[]
```

### 节点

- `ProjectNode` 表示一个 pnpm workspace package,记录稳定 package ID、package root 和零个或
  多个 source roots。
- `FileNode` 表示一个只属于一个项目的真实 TypeScript 文件。
- `SymbolNode` 表示文件里当前支持的有名声明,包括父符号、kind、merged kinds 和 export 状态。

### 边

- 项目边表示 manifest 或跨项目源码解析确认存在依赖。
- 文件边表示 TypeScript 把一个文件的 import/export 解析到了另一个仓库文件。
- 符号边表示 TypeScript Checker 把一个符号里的使用解析到了另一个符号的声明。

边是结构事实,还不表示某个编码任务一定会修改目标、两个任务一定冲突,或者 Agent 已取得写权限。

## 从命令到结果的完整流程

```text
forge analyze <repository>
        |
        v
apps/cli/src/app.ts
  解析用户输入路径
  调用 analyzeRepository()
        |
        v
project-graph-analysis.ts
  选择第一个 supports() 为 true 的 provider
        |
        +------------------------------+
        |                              |
        v                              |
PnpmWorkspaceGraphProvider             |
  读取 workspace 结构                  |
  建立项目和 manifest 依赖边            |
        |                              |
        +--------------+---------------+
                       |
                       v
TypeScriptRepositoryAnalyzer
  查找配置与 Program
  建立文件、符号和语义边
  增加 diagnostics
                       |
                       v
RepositoryGraph 返回 CLI
  默认输出摘要
  --full 输出完整图
```

组合入口位于 `libs/repository-analysis/src/lib/project-graph-analysis.ts`。Package-manager 发现
和 TypeScript enrichment 刻意分成两层,所以未来增加另一个 provider 时不需要修改领域图或
TypeScript 转换规则。

## 阶段一:选择 Repository Provider

`analyzeWorkspaceGraph()` 先把请求路径解析成绝对路径,再按顺序检查已配置的 provider。目前默认
列表只有 `PnpmWorkspaceGraphProvider`。

仓库根目录存在 `pnpm-workspace.yaml` 时,pnpm provider 才认为自己支持这个仓库。如果没有任何
provider 支持,分析返回 `UNSUPPORTED_REPOSITORY`,不会静默猜测仓库结构。

## 阶段二:建立 pnpm 项目图

`PnpmWorkspaceGraphProvider` 执行:

```text
读取 pnpm-workspace.yaml
        |
        v
展开 workspace package pattern
        |
        v
查找根目录与 workspace package.json
        |
        v
解析 package name 和依赖字段
        |
        v
建立 ProjectNode
        |
        v
建立 workspace 项目依赖边
```

Provider 会读取 `dependencies`、`devDependencies`、`peerDependencies` 和
`optionalDependencies`。依赖名匹配另一个已发现 workspace 项目时,就会建立边。缺失的
`workspace:*` 目标会报错,因为 manifest 明确声称目标应该属于当前 workspace。

Provider 校验:

- 仓库和 workspace 是否可读;
- workspace YAML 与 package JSON 结构;
- package name 是否非空且唯一;
- dependency map 和 version 是否合法;
- workspace 目标是否缺失;
- 项目是否自依赖;
- manifest 真实路径是否跑出仓库。

这一阶段结束时,`WorkspaceGraph.projects` 已包含 package manifest 路径、依赖类型和版本、
`workspace:` 使用情况、scripts、source roots 与 TypeScript 配置路径。Manifest 依赖边会记录
`package-dependency`,使用 workspace protocol 时还会记录 `workspace-protocol` 来源;文件、符号和
语义边在下一阶段加入。

## 阶段三:发现 TypeScript 配置

TypeScript 分析器从每个项目根 `tsconfig.json` 开始。它直接解析 JSONC,所以支持注释和尾逗号,
然后递归跟随 project references:

```text
project/tsconfig.json
├── tsconfig.app.json
├── tsconfig.spec.json
└── config/tsconfig.build.json
```

这对 solution-style 仓库非常重要:根配置可能只有 `files: []` 和 references,真正的编译配置在
其他文件。只打开根配置会错误地产生“成功但为空”的图。

Reference 遍历会:

- 解析 TypeScript 支持的文件和目录形式;
- 去重配置,所以 reference cycle 不会无限循环;
- 拒绝缺失目标;
- 解析 symlink 并拒绝仓库外目标;
- 把损坏 JSONC 和错误 `references` 变成结构化错误。

## 阶段四:打开真实 TypeScript Program

所有已发现配置会通过固定版本的 TypeScript 7 原生同步 API 打开。每个 native Project 提供一个
Program 与 Checker,并遵守目标仓库真实的:

- compiler options;
- module 与 module-resolution mode;
- path alias 和 base URL;
- package exports 与 Node ESM 规则;
- project references 与 workspace link。

分析器不会通过扫描 import 字符串重新实现 module resolution,而是直接询问 TypeScript 自己已经
解析出的关系。

Native API 只在 `libs/repository-analysis` 中 import。原生 AST node、Project、Program、Checker
与 Symbol 会立即转换,不会进入 `libs/domain`。TypeScript 7 固定精确版本;没有安装 TypeScript 6。

## 阶段五:选择所属 Compiler Context

同一个物理文件可能出现在多个 Program 里,例如 app config 与 test config 会重叠。分析器必须
确定地选择一个 Checker。

规则是:

1. 把源码解析到真实文件系统路径。
2. 拒绝仓库外或 `node_modules` 中的真实目标。
3. 把文件归属给包含该真实路径的最具体 pnpm 项目。
4. 只接受同一项目拥有的编译配置。
5. Production config 优先于 spec/test config。
6. 同优先级配置重叠时,选择路径字母序最靠前的配置。

最后一条只是确定性 tie-break,不代表某组 compiler options 在语义上更优。

这既能阻止根项目或兄弟项目把任意 Checker 借给其他项目源码,也允许项目把真实配置放在根目录
下的子目录,例如 `config/tsconfig.build.json`。

## 阶段六:稳定文件身份与 Symlink

文件身份使用真实文件系统目标:

```text
FileId = ProjectId + ":" + 真实仓库相对路径
```

示例:

```text
api:workspace/api/src/modules/work/router.ts
```

这意味着:

- 两个 symlink 路径指向同一文件时只有一个 `FileNode`;
- 这些路径里的声明只生成一套符号;
- 通过 symlink import 仍指向真实目标节点;
- 指向 `node_modules` 或仓库外的 symlink 不能绕过边界;
- `FileNode.path` 可能不同于 import 语句里写下的路径;
- 用用户输入路径查图的调用方必须先执行同样的 real-path normalization。

macOS 和 Windows 的 key 会统一大小写。生成路径使用 `isGenerated` 标记。ID 不包含行号或内容
hash。

## 阶段七:建立文件依赖

分析器读取 TypeScript 已解析的 module 信息,再把仓库内目标映射回 `FileNode` ID。

支持的关系包括:

- 普通 import;
- type import;
- named re-export;
- `export *` 链;
- path alias;
- bare workspace package specifier;
- 共享源码 import。

边会去重,并使用与 locale 无关的比较器排序。文件边跨越项目归属时,还会建立项目边。语义项目边
与 manifest 边合并,不会互相覆盖。

## 阶段八:建立符号索引

当前声明索引包括:

- class、interface、function、enum、type alias、namespace 和 variable;
- constructor、method、getter/setter 和 property;
- 递归 namespace 内容和点式 namespace 声明。

每个符号记录所属文件、稳定 path、kind、可选 parent、export 状态和可选 merged kinds。
Private/protected 成员保持非导出。

符号 ID 在文件 ID 后面继续增加路径:

```text
api:workspace/api/src/modules/work/router.ts:createWorkRouter
api:workspace/api/src/service.ts:UserService.findUser
```

### Declaration merging

TypeScript 允许同名 class 和 namespace 等声明合并。分析器用固定 kind 优先级选择主 `kind`,并把
所有类型保存在 `mergedKinds`,所以源码声明顺序不会改变结果。

### Computed name

字面 computed name 会恢复成字面文本。动态名称使用经过转义的表达式身份。Getter/setter 共用
一个符号;多余括号会删除;重复 property 只按相同规范化表达式的出现次数编号,而不是按它在
class 里的绝对位置编号。

## 阶段九:建立符号引用

分析器访问属于已索引声明的 identifier,再让 Checker 查出真实 native Symbol。Alias 会继续
跟到目标声明。如果目标声明属于另一个已索引符号,就建立 `SymbolId -> SymbolId` 边。

这支持跨文件、path alias、re-export 链和跨项目引用。它不会因为两个 identifier 文本相同就
猜测它们相关。请求会分成有上限的 batch,控制临时 native handle 和内存压力。

## 阶段十:诊断不完整输入

分析器会区分非法输入和合法但不完整的输入。

非法配置或仓库结构抛出 `ProjectGraphError`;成功的图可以带 warning:

| Diagnostic                         | 含义                                            |
| ---------------------------------- | ----------------------------------------------- |
| `MISSING_TYPESCRIPT_CONFIGURATION` | 项目没有根 TypeScript 配置                      |
| `EMPTY_TYPESCRIPT_PROJECT`         | 合法配置没有产生所属源码                        |
| `UNCOVERED_TYPESCRIPT_FILES`       | 磁盘存在 TypeScript 文件,但没有已发现配置覆盖它 |

为了发现未覆盖文件,分析器会 glob 仓库,再比较“项目拥有的 TypeScript 文件”和“已索引文件”。
依赖目录、构建/覆盖率输出和嵌套 pnpm workspace 会排除。系统会报告准确相对路径,不会静默分配
任意 Checker。

有意排除的生成文件仍可能产生噪声;是否拆分严重级别属于未来策略决定。

## 阶段十一:Native 资源清理

Native API 和 snapshot 无论成功或失败都会明确关闭:

```text
尝试 snapshot.dispose()
        |
        v
即使 dispose 失败,仍尝试 api.close()
        |
        v
返回图或正确的结构化错误
```

原始分析错误优先于 cleanup error,并保留 stack。如果分析成功但 cleanup 失败,仍返回结构化分析
错误。单元测试与集成测试同时覆盖结果规则和“native snapshot 打开后才失败”的真实路径。

## CLI 序列化

```sh
pnpm exec forge analyze /仓库路径
pnpm exec forge analyze /仓库路径 --full
```

默认输出包括:

- provider 与 repository path;
- 数量;
- projects 与 project dependencies;
- diagnostics。

`--full` 还会输出所有文件、符号、文件边和符号边。完整结果可能很大,主要提供给机器或针对性
调查,不适合作为日常终端输出。

## 核心不变量

实现围绕以下不变量设计:

1. 每个已索引文件只属于一个项目。
2. 文件只能由同一项目拥有的配置分析。
3. 同一个真实文件只有一个图身份,不受 symlink 写法影响。
4. 文件和配置都不能通过 symlink 跑出仓库。
5. ID 不依赖机器绝对路径或行号。
6. 节点和边会去重并确定排序。
7. 非法输入明确失败;合法但不完整的输入产生 diagnostics。
8. Compiler native 对象不会泄漏到领域图。
9. 分析过程只读。

## RepositoryGraph 不做什么

RepositoryGraph 回答:

> 仓库里有哪些项目、文件和符号,仓库工具能证明它们之间存在哪些结构关系?

它不回答:

- 自然语言任务打算修改什么;
- 一项改动会传播多远;
- 两个任务是否冲突;
- 哪些任务可以并发;
- Agent 当前是否拥有写权限;
- Git 应怎样合并改动。

这些职责分别属于 Task Impact Engine、Conflict Engine、Scheduler、Runtime Guard 和
Workspace/Git 层。

## 当前限制

- 语义索引当前覆盖 TypeScript 系列文件,不是所有语言或基础设施格式。
- 不是每种匿名或深层 AST 结构都会变成独立符号。
- 还没有提取规范化 callable 和 type signature。
- 当前是全量扫描,还没有暴露增量 refresh 合同。
- 项目边已经保存 manifest、workspace protocol、TypeScript reference 和 TypeScript import
  provenance,但 import 还没有细分 production/test/generated/runtime/type-only。
- 未覆盖文件扫描已在约一千文件规模验证,还没有为数万文件仓库做 benchmark。
- 摘要包含仓库绝对路径,可能暴露本机目录信息。

## 下一阶段怎样使用它

Task Impact Engine 会把 RepositoryGraph 当作只读事实索引:

```text
task selectors
      |
      v
解析 project/file/symbol 节点
      |
      v
沿 file dependencies 与 symbol references 扩展
      |
      v
生成可解释 TaskImpact
```

关键架构边界是:RepositoryGraph 记录“仓库里存在什么”;Task Impact 记录“某个具体任务可能影响
什么”。
