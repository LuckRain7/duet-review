# --base <ref> 范围审查 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `--base <ref>` 参数，支持审查从基准 ref（merge-base）到 HEAD 的提交范围，解锁 PR 审查场景。

**Architecture:** `git.ts` 的 `collectDiff` 增加可选 `{ base }` 参数走 `git diff <base>...HEAD` 三点语法分支；`DiffResult` 增加展示用 `label` 字段；`prompts.ts`/`report.ts` 的来源参数从联合类型放宽为 label 字符串；`cli.ts`/`main.ts` 透传。设计依据：`docs/superpowers/specs/2026-06-12-base-ref-review-design.md`。

**Tech Stack:** TypeScript ESM（import 必须带 `.js` 后缀）、vitest（30s 超时）、`tests/helpers/tmpRepo.ts` 临时仓库、`tests/helpers/fakeCli.ts` 假 CLI。用户可见文案一律中文。

---

### Task 1: git.ts 支持 base 范围收集

**Files:**
- Modify: `src/git.ts`
- Test: `tests/git.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/git.test.ts` 的 `describe('collectDiff', ...)` 末尾（第 77 行 `it('无任何变更时抛 NoDiffError'...)` 之后、`});` 之前）追加：

```ts
  it('--base 模式取 merge-base 到 HEAD 的范围，忽略工作区与基准分支后续提交', async () => {
    const repo = makeTmpRepo();
    repo.git('checkout', '-b', 'feature');
    repo.write('a.txt', 'line1\nfeature-change\n');
    repo.git('add', '.');
    repo.git('commit', '-m', 'feature change');
    repo.git('checkout', 'main');
    repo.write('b.txt', 'main-only\n');
    repo.git('add', '.');
    repo.git('commit', '-m', 'main advance');
    repo.git('checkout', 'feature');
    repo.write('a.txt', 'line1\nfeature-change\nuncommitted\n'); // 未提交变更不应入范围

    const res = await collectDiff(repo.dir, { base: 'main' });
    expect(res.source).toBe('range');
    expect(res.label).toBe('main...HEAD');
    expect(res.patch).toContain('+feature-change');
    expect(res.patch).not.toContain('main-only');
    expect(res.patch).not.toContain('uncommitted');
    expect(res.files).toEqual(['a.txt']);
  });

  it('--base 的 ref 不存在时抛中文错误', async () => {
    const repo = makeTmpRepo();
    await expect(collectDiff(repo.dir, { base: 'no-such-ref' })).rejects.toThrow('基准 ref 不存在: no-such-ref');
  });

  it('--base 范围为空时抛 NoDiffError 且文案含范围', async () => {
    const repo = makeTmpRepo();
    await expect(collectDiff(repo.dir, { base: 'main' })).rejects.toThrow(NoDiffError);
    await expect(collectDiff(repo.dir, { base: 'main' })).rejects.toThrow('main...HEAD 范围内没有可审查的变更');
  });

  it('staged/unstaged 模式的结果带 label 字段', async () => {
    const repo = makeTmpRepo();
    repo.write('a.txt', 'line1\nline2\n');
    const res = await collectDiff(repo.dir);
    expect(res.label).toBe('unstaged');
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/git.test.ts`
Expected: FAIL —— 新用例编译错误/断言失败（`collectDiff` 还不接受第二参数、无 `label` 字段）。

- [ ] **Step 3: 实现**

把 `src/git.ts` 改为：

```ts
import { runCli } from './utils/proc.js';

export class NoDiffError extends Error {
  constructor(message = '没有可审查的变更（staged 与 unstaged 均为空）') {
    super(message);
    this.name = 'NoDiffError';
  }
}

export interface DiffResult {
  source: 'staged' | 'unstaged' | 'range';
  /** 展示用标签：'staged' / 'unstaged' / '<base>...HEAD' */
  label: string;
  patch: string;
  files: string[];
}

export interface CollectDiffOptions {
  /** 基准 ref：给定时审查 <base>...HEAD 范围，跳过 staged/unstaged 探测 */
  base?: string;
}

export async function ensureGitRepo(cwd: string): Promise<void> {
  const res = await runCli('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
  if (res.code !== 0) throw new Error(`当前目录不是 git 仓库: ${cwd}`);
}

/** 设计约定：base 优先；否则 staged（git diff --cached），为空才取 unstaged（git diff），不含 untracked */
export async function collectDiff(cwd: string, opts: CollectDiffOptions = {}): Promise<DiffResult> {
  if (opts.base) return collectRangeDiff(cwd, opts.base);

  const staged = await runCli('git', ['diff', '--cached'], { cwd });
  if (staged.code !== 0) throw new Error(`git diff --cached 失败: ${staged.stderr}`);
  if (staged.stdout.trim() !== '') {
    return { source: 'staged', label: 'staged', patch: staged.stdout, files: await listFiles(cwd, ['--cached']) };
  }

  const unstaged = await runCli('git', ['diff'], { cwd });
  if (unstaged.code !== 0) throw new Error(`git diff 失败: ${unstaged.stderr}`);
  if (unstaged.stdout.trim() !== '') {
    return { source: 'unstaged', label: 'unstaged', patch: unstaged.stdout, files: await listFiles(cwd, []) };
  }

  throw new NoDiffError();
}

/** 三点语法 = merge-base 到 HEAD，不把基准分支上的新提交算进来，符合 PR 审查语义 */
async function collectRangeDiff(cwd: string, base: string): Promise<DiffResult> {
  const verify = await runCli('git', ['rev-parse', '--verify', '--quiet', `${base}^{commit}`], { cwd });
  if (verify.code !== 0) throw new Error(`基准 ref 不存在: ${base}`);

  const range = `${base}...HEAD`;
  const res = await runCli('git', ['diff', range], { cwd });
  if (res.code !== 0) throw new Error(`git diff ${range} 失败: ${res.stderr}`);
  if (res.stdout.trim() === '') throw new NoDiffError(`${range} 范围内没有可审查的变更`);
  return { source: 'range', label: range, patch: res.stdout, files: await listFiles(cwd, [range]) };
}

async function listFiles(cwd: string, extraArgs: string[]): Promise<string[]> {
  // core.quotepath 默认会把非 ASCII 文件名转义成带引号的八进制串，显式关闭
  const res = await runCli('git', ['-c', 'core.quotepath=false', 'diff', '--name-only', ...extraArgs], { cwd });
  if (res.code !== 0) throw new Error(`git diff --name-only 失败: ${res.stderr}`);
  return res.stdout.split('\n').filter((f) => f.trim() !== '');
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/git.test.ts`
Expected: PASS（全部用例，含原有 6 条 collectDiff 用例）。

- [ ] **Step 5: Commit**

```bash
git add src/git.ts tests/git.test.ts
git commit -m "feat: collectDiff 支持 --base 范围收集与 label 字段"
```

---

### Task 2: prompts/report/main 改用 label

**Files:**
- Modify: `src/prompts.ts:32`（`buildInitialReviewPrompt` 签名）
- Modify: `src/report.ts:20-22, 46`（`ReportInput.source` → `label`）
- Modify: `src/main.ts:52, 80, 93, 127`（改用 `diff.label`）
- Test: `tests/prompts.test.ts`、`tests/report.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/prompts.test.ts` 的 `describe('buildInitialReviewPrompt', ...)` 内追加：

```ts
  it('range 模式下来源说明为具体范围', () => {
    const p = buildInitialReviewPrompt('diff --git a/a.txt b/a.txt', 'origin/main...HEAD');
    expect(p).toContain('origin/main...HEAD 的 git diff');
  });
```

`tests/report.test.ts` 的 `renderReport` 用例：把 `source: 'staged',` 改为 `label: 'main...HEAD',`，并追加断言：

```ts
    expect(md).toContain('审查对象: main...HEAD diff');
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/prompts.test.ts tests/report.test.ts`
Expected: report 用例 FAIL（`label` 不是 `ReportInput` 的字段，类型报错/断言失败）。prompts 新用例此时可能已通过（`'staged' | 'unstaged'` 收窄导致类型错误也算失败信号）。

- [ ] **Step 3: 实现**

`src/prompts.ts` 第 32-33 行，签名与文案改为 label：

```ts
export function buildInitialReviewPrompt(patch: string, label: string): string {
  return `你是一名严格的代码评审者。请审查下面这份 ${label} 的 git diff。
```

（函数其余部分不变。）

`src/report.ts`：`ReportInput` 与渲染行改为：

```ts
export interface ReportInput {
  label: string;
  rounds: number;
  tracked: TrackedFinding[];
  applySummary: string | null;
}
```

`renderReport` 中 `- 审查对象: ${input.source} diff` 改为：

```ts
    `- 审查对象: ${input.label} diff`,
```

`src/main.ts` 三处：

```ts
  log(`审查对象: ${diff.label} diff（${diff.patch.split('\n').length} 行，${diff.files.length} 个文件）`);
```

```ts
      archive.write('report.md', renderReport({ label: diff.label, rounds: 0, tracked, applySummary: null }));
```

```ts
    archive.write('report.md', renderReport({ label: diff.label, rounds, tracked, applySummary }));
```

（`buildInitialReviewPrompt(diff.patch, diff.source)` 改为 `buildInitialReviewPrompt(diff.patch, diff.label)`，在 `src/main.ts:80`。）

- [ ] **Step 4: 跑全量测试确认通过**

Run: `pnpm test`
Expected: PASS（e2e 现有断言不受影响：unstaged 场景下 label 与原 source 同为 `unstaged`）。

- [ ] **Step 5: Commit**

```bash
git add src/prompts.ts src/report.ts src/main.ts tests/prompts.test.ts tests/report.test.ts
git commit -m "refactor: prompt 与报告的审查对象改用 DiffResult.label"
```

---

### Task 3: cli/main 接入 --base 与 e2e

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/main.ts:14-20, 42-44`（`MainOptions.base` + 透传）
- Test: `tests/e2e.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/e2e.test.ts` 的 `describe` 内追加：

```ts
  it('--base 模式审查提交范围而非工作区', async () => {
    const repo = makeTmpRepo();
    repo.git('checkout', '-b', 'feature');
    repo.write('a.txt', 'line1\nfeature-change\n');
    repo.git('add', '.');
    repo.git('commit', '-m', 'feature change');

    const scenario = makeFakeScenario();
    scenario.setReply('codex', 1, JSON.stringify({ findings: [] }));
    scenario.setReply('claude', 1, JSON.stringify({ findings: [] }));

    const logs: string[] = [];
    const code = await main({
      cwd: repo.dir, maxRounds: 3, timeoutMs: 30_000, base: 'main',
      env: scenario.env, log: (m) => logs.push(m),
    });

    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('审查对象: main...HEAD diff');
    // 评审 prompt 携带提交范围的 diff 与范围标签
    expect(scenario.calls('codex')[0].stdin).toContain('+feature-change');
    expect(scenario.calls('claude')[0].stdin).toContain('main...HEAD');
    // 报告记录审查对象
    const dir = join(repo.dir, '.duet-review', readdirSync(join(repo.dir, '.duet-review'))[0]);
    expect(readFileSync(join(dir, 'report.md'), 'utf8')).toContain('审查对象: main...HEAD diff');
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/e2e.test.ts`
Expected: FAIL —— `MainOptions` 没有 `base` 字段（类型错误）。

- [ ] **Step 3: 实现**

`src/main.ts`：`MainOptions` 增加字段（`timeoutMs` 之后）：

```ts
  /** 基准 ref：给定时审查 <base>...HEAD 范围 */
  base?: string;
```

`collectDiff` 调用处改为：

```ts
    diff = await collectDiff(cwd, { base: options.base });
```

`src/cli.ts`：option 区追加一行（`--timeout` 之后）：

```ts
  .option('--base <ref>', '审查 <ref>...HEAD 提交范围（如 origin/main），给定时忽略 staged/unstaged')
```

opts 类型与透传：

```ts
const opts = program.opts<{ maxRounds: string; timeout: string; base?: string }>();
```

```ts
main({ cwd: process.cwd(), maxRounds, timeoutMs: timeoutMinutes * 60_000, base: opts.base }).then(
```

- [ ] **Step 4: 跑全量测试确认通过**

Run: `pnpm test`
Expected: PASS（全部测试文件）。

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/main.ts tests/e2e.test.ts
git commit -m "feat: 新增 --base <ref> 参数审查提交范围"
```

---

### Task 4: 文档与构建验证

**Files:**
- Modify: `README.md:33-41`（Usage 代码块与选项表）
- Modify: `README.zh-CN.md:38-41`（选项表，以及其上方的用法代码块）

- [ ] **Step 1: 更新 README.md**

Usage 代码块追加一行示例：

```bash
duet-review --base origin/main         # review the commit range origin/main...HEAD (PR-style)
```

选项表追加：

```markdown
| `--base <ref>` | Review the commit range `<ref>...HEAD` (merge-base to HEAD) instead of staged/unstaged changes | — |
```

- [ ] **Step 2: 更新 README.zh-CN.md**

选项表上方的用法代码块追加：

```bash
duet-review --base origin/main         # 审查 origin/main...HEAD 提交范围（PR 场景）
```

选项表追加：

```markdown
| `--base <ref>` | 审查 `<ref>...HEAD` 提交范围（merge-base 到 HEAD），给定时忽略 staged/unstaged | — |
```

- [ ] **Step 3: 构建 + 全量测试**

Run: `pnpm build && pnpm test`
Expected: tsc 无错误，vitest 全部 PASS。

- [ ] **Step 4: Commit**

```bash
git add README.md README.zh-CN.md
git commit -m "docs: README 补充 --base 用法"
```
