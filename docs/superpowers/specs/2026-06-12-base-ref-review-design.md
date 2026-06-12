# 设计：--base <ref> 范围审查

日期：2026-06-12

## 背景

duet-review 目前只能审查未提交的变更：`collectDiff`（src/git.ts）staged 优先、为空才取 unstaged，不含 untracked。变更一旦 commit 就无法审查，导致工具无法用于「feature 分支 vs main」的 PR 审查场景——而这恰是双评审最有价值的场景。

## 目标

新增 `--base <ref>` 参数，支持审查从基准 ref 到 HEAD 的提交范围（如 `--base origin/main`、`--base HEAD~3`），解锁 PR 审查工作流。

## 非目标

- 不支持透传任意 `git diff` 参数（错误处理与文案无法收敛）。
- 不支持 `--range <a>..<b>` 双端点（PR 场景几乎总是「基准到 HEAD」，YAGNI）。
- 不要求 `--base` 模式下工作区干净；apply 阶段行为不变（claude 把共识修改写入工作区，用户自行 commit）。

## 设计

### 1. CLI（src/cli.ts）

新增 `--base <ref>` option（无默认值）。给了 `--base` 就只审该范围，完全跳过 staged/unstaged 探测；不给则行为与现状完全一致。ref 字符串不在 CLI 层校验，交给 git 层。

### 2. diff 收集（src/git.ts）

`collectDiff(cwd, opts?: { base?: string })`：

- `opts.base` 存在时：
  1. `git rev-parse --verify <base>` 校验 ref，失败抛 `基准 ref 不存在: <base>`。
  2. `git diff <base>...HEAD` 取 patch（三点语法 = merge-base 到 HEAD，符合 PR 语义，不把基准分支上的新提交算进来）。无共同祖先等 git 报错原样包进中文错误信息抛出。
  3. patch 为空 → 抛 `NoDiffError`，文案为 `<base>...HEAD 范围内没有可审查的变更`（`NoDiffError` 构造函数接受可选 message，默认保持现有文案）。
  4. 文件列表用 `git -c core.quotepath=false diff --name-only <base>...HEAD`。
- 不存在时：现有 staged/unstaged 逻辑不变。

### 3. 类型联动（DiffResult / prompts / report）

- `DiffResult.source` 扩为 `'staged' | 'unstaged' | 'range'`，新增 `label: string`：
  - staged → `'staged'`；unstaged → `'unstaged'`；range → `'<base>...HEAD'`（如 `origin/main...HEAD`）。
- `buildInitialReviewPrompt(patch, label)`（src/prompts.ts）：第二参数由联合类型改为 `string`，文案为「请审查下面这份 ${label} 的 git diff」。评审者能从 prompt 看到实际审查范围。
- `renderReport`（src/report.ts）：`ReportInput.source` 改为 `label: string`，报告中「审查对象: ${label} diff」。
- `main.ts`：`collectDiff(cwd, { base: options.base })`，开头日志「审查对象: ${label} diff（N 行，M 个文件）」。

## 错误处理

- ref 不存在、无共同祖先、git 命令失败：中文错误信息抛出，main.ts 现有 catch 路径处理。
- 范围为空：`NoDiffError` 早退，exit 0，与现有「无变更」路径一致。

## 测试

- `tests/git.test.ts`：用 `tmpRepo` 建分支并提交，覆盖三条路径——
  1. 正常范围：patch 含分支上的提交、不含基准分支后续提交（验证三点语义），files 正确；
  2. ref 不存在：抛中文错误；
  3. 范围为空（分支与基准无差异）：抛 `NoDiffError` 且文案含范围。
- `tests/e2e.test.ts`：新增一个 `--base` 用例（fake CLI，不耗 token），断言日志中的审查对象 label 与报告内容。
- prompts / report 现有断言随签名变更同步更新。

## 用户可见文案（中文，与现有风格一致）

- `审查对象: origin/main...HEAD diff（N 行，M 个文件）`
- `基准 ref 不存在: <base>`
- `<base>...HEAD 范围内没有可审查的变更`
