# duet-review 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 `duet-review` 全局 CLI：并行调用 codex 与 claude 审查 git diff，多轮互评讨论收敛，最终由 claude 把共识修改直接应用到工作区。

**Architecture:** 纯 TypeScript orchestrator，通过 `node:child_process` 驱动 `codex exec`（JSONL 输出 + `exec resume` 续接会话）与 `claude -p`（JSON 输出 + `--resume` 续接会话）。findings/responses 用 zod 校验的固定 JSON schema 传递，共识由程序化状态机判定，不再请模型当裁判。审查/讨论阶段只读，仅应用阶段 claude 获写权限。

**Tech Stack:** Node.js ≥ 20、TypeScript（ESM, NodeNext）、commander（参数）、zod（schema 校验）、vitest（测试）、tsx（开发运行）。

**设计文档:** `2026-06-11-duet-review-design.md`（仓库根目录）

---

## 文件结构

```
package.json / tsconfig.json / vitest.config.ts / .gitignore
src/
  cli.ts              # 入口：参数解析、预检、流程接线
  git.ts              # 仓库检测、staged/unstaged diff 收集
  prompts.ts          # 全部 prompt 构建 + codex output-schema JSON 生成
  orchestrator.ts     # 轮次控制、TrackedFinding 状态机、共识判定
  apply.ts            # 应用阶段：调 claude 实施共识修改
  report.ts           # Archive 存档（.duet-review/<ts>/）+ report.md 渲染
  types.ts            # zod schema 与全部共享类型
  parse.ts            # extractJson 括号配平提取 + findings/responses 解析
  utils/proc.ts       # runCli 子进程封装（stdin / 超时 / 收集输出）
  reviewers/codex.ts  # CodexReviewer：spawn、JSONL 解析、session 管理
  reviewers/claude.ts # ClaudeReviewer：spawn、JSON 解析、session 管理、applyFix
tests/
  helpers/tmpRepo.ts  # 临时 git 仓库 fixture
  fakes/bin/codex     # 假 codex 可执行（node 脚本，按场景回放）
  fakes/bin/claude    # 假 claude 可执行
  *.test.ts           # 单元 + 集成测试
scripts/
  smoke.sh            # 真实 CLI 冒烟测试
```

每条 ESM 相对导入必须带 `.js` 后缀（如 `import { runCli } from './utils/proc.js'`），TypeScript NodeNext 模式要求如此。

---

### Task 1: 项目脚手架

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/cli.ts`

- [ ] **Step 1: 写 package.json**

```json
{
  "name": "duet-review",
  "version": "0.1.0",
  "description": "codex × claude 双评审 CLI：并行 review、多轮讨论、自动应用共识修改",
  "type": "module",
  "bin": { "duet-review": "dist/cli.js" },
  "files": ["dist"],
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "dev": "tsx src/cli.ts"
  },
  "dependencies": {
    "commander": "^12.1.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "tsx": "^4.16.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: 写 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "skipLibCheck": true,
    "sourceMap": false,
    "types": ["node"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: 写 vitest.config.ts**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
```

- [ ] **Step 4: 写 .gitignore**

```
node_modules/
dist/
.duet-review/
```

- [ ] **Step 5: 写 src/cli.ts 占位入口**

```ts
#!/usr/bin/env node
console.log('duet-review: 尚未实现');
```

- [ ] **Step 6: 安装依赖并验证构建**

Run: `pnpm install && pnpm build && node dist/cli.js`
Expected: 安装成功；编译无错误；打印 `duet-review: 尚未实现`

- [ ] **Step 7: 验证 vitest 可运行**

Run: `pnpm test`
Expected: `No test files found`（退出码非 0 没关系，能启动即可；后续任务补测试）

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json vitest.config.ts .gitignore src/cli.ts
git commit -m "chore: 项目脚手架（TypeScript + vitest + commander/zod）"
```

---

### Task 2: 数据类型与 JSON 解析（types.ts / parse.ts）

**Files:**
- Create: `src/types.ts`, `src/parse.ts`
- Test: `tests/parse.test.ts`

- [ ] **Step 1: 写 src/types.ts（无需先写测试，纯类型与 schema 声明）**

```ts
import { z } from 'zod';

export const severitySchema = z.enum(['critical', 'major', 'minor', 'nit']);

export const findingSchema = z.object({
  id: z.string().min(1),
  file: z.string().min(1),
  line: z.number().int().positive().nullable(),
  severity: severitySchema,
  title: z.string().min(1),
  description: z.string(),
  suggestion: z.string(),
});

export const reviewOutputSchema = z.object({
  findings: z.array(findingSchema),
});

export const stanceSchema = z.enum(['agree', 'disagree', 'modify', 'withdraw']);

export const responseSchema = z.object({
  findingId: z.string().min(1),
  stance: stanceSchema,
  comment: z.string(),
  revisedSuggestion: z.string().nullable(),
});

export const discussionOutputSchema = z.object({
  responses: z.array(responseSchema),
});

export type Severity = z.infer<typeof severitySchema>;
export type Finding = z.infer<typeof findingSchema>;
export type ReviewOutput = z.infer<typeof reviewOutputSchema>;
export type Stance = z.infer<typeof stanceSchema>;
export type DiscussionResponse = z.infer<typeof responseSchema>;
export type DiscussionOutput = z.infer<typeof discussionOutputSchema>;

export type ReviewerName = 'codex' | 'claude';

/** 双方 reviewer 的统一接口；start 建立会话，reply 续接会话 */
export interface Reviewer {
  readonly name: ReviewerName;
  start(prompt: string): Promise<string>;
  reply(prompt: string): Promise<string>;
}

/** 内部立场：pending 表示该方还未对当前版本的 suggestion 表态 */
export type InternalStance = Stance | 'pending';

export type FindingState = 'open' | 'consensus' | 'dropped' | 'disputed';

export interface TrackedFinding {
  finding: Finding; // 当前内容（modify 后 suggestion 会被更新）
  author: ReviewerName;
  codexStance: InternalStance;
  claudeStance: InternalStance;
  state: FindingState;
  history: Array<{ round: number; reviewer: ReviewerName; response: DiscussionResponse }>;
}
```

- [ ] **Step 2: 写失败测试 tests/parse.test.ts**

```ts
import { describe, expect, it } from 'vitest';
import { extractJson, parseDiscussionOutput, parseReviewOutput } from '../src/parse.js';

describe('extractJson', () => {
  it('解析裸 JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('解析 markdown 代码块包裹的 JSON', () => {
    expect(extractJson('前言\n```json\n{"a":1}\n```\n后记')).toEqual({ a: 1 });
  });

  it('解析夹杂说明文字的 JSON（取第一个配平对象）', () => {
    expect(extractJson('我的结论如下：{"a":{"b":"x}y"}} 完毕')).toEqual({ a: { b: 'x}y' } });
  });

  it('无 JSON 时抛错', () => {
    expect(() => extractJson('没有任何对象')).toThrow('未找到 JSON');
  });

  it('JSON 不完整时抛错', () => {
    expect(() => extractJson('{"a":')).toThrow();
  });
});

describe('parseReviewOutput', () => {
  it('解析合法 findings', () => {
    const text = JSON.stringify({
      findings: [{
        id: 'f1', file: 'src/a.ts', line: 10, severity: 'major',
        title: '空指针', description: 'x 可能为 null', suggestion: '加判空',
      }],
    });
    const out = parseReviewOutput(text);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].severity).toBe('major');
  });

  it('severity 非法时抛出含字段信息的错误', () => {
    const text = JSON.stringify({
      findings: [{ id: 'f1', file: 'a', line: null, severity: 'huge', title: 't', description: '', suggestion: '' }],
    });
    expect(() => parseReviewOutput(text)).toThrow(/severity/);
  });
});

describe('parseDiscussionOutput', () => {
  it('解析合法 responses', () => {
    const text = '```json\n' + JSON.stringify({
      responses: [{ findingId: 'f1', stance: 'agree', comment: '同意', revisedSuggestion: null }],
    }) + '\n```';
    const out = parseDiscussionOutput(text);
    expect(out.responses[0].stance).toBe('agree');
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm vitest run tests/parse.test.ts`
Expected: FAIL —— `Cannot find module '../src/parse.js'`

- [ ] **Step 4: 实现 src/parse.ts**

```ts
import { discussionOutputSchema, reviewOutputSchema, type DiscussionOutput, type ReviewOutput } from './types.js';

/** 从模型输出文本中提取第一个配平的 JSON 对象（容忍 markdown 代码块与前后说明文字） */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  if (start === -1) throw new Error('输出中未找到 JSON 对象');

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return JSON.parse(candidate.slice(start, i + 1));
    }
  }
  throw new Error('输出中的 JSON 对象不完整');
}

function formatZodError(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .map((i) => `${i.path.join('.')}: ${i.message}`)
    .join('; ');
}

export function parseReviewOutput(text: string): ReviewOutput {
  const raw = extractJson(text);
  const result = reviewOutputSchema.safeParse(raw);
  if (!result.success) throw new Error(`findings 不符合 schema —— ${formatZodError(result.error)}`);
  return result.data;
}

export function parseDiscussionOutput(text: string): DiscussionOutput {
  const raw = extractJson(text);
  const result = discussionOutputSchema.safeParse(raw);
  if (!result.success) throw new Error(`responses 不符合 schema —— ${formatZodError(result.error)}`);
  return result.data;
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm vitest run tests/parse.test.ts`
Expected: PASS（8 个用例全绿）

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/parse.ts tests/parse.test.ts
git commit -m "feat: findings/responses 数据模型与容错 JSON 解析"
```

---

### Task 3: 子进程封装（utils/proc.ts）

**Files:**
- Create: `src/utils/proc.ts`
- Test: `tests/proc.test.ts`

- [ ] **Step 1: 写失败测试 tests/proc.test.ts**

```ts
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/utils/proc.js';

describe('runCli', () => {
  it('收集 stdout 与退出码', async () => {
    const res = await runCli('node', ['-e', 'console.log("hello")']);
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toBe('hello');
    expect(res.timedOut).toBe(false);
  });

  it('收集 stderr 与非零退出码', async () => {
    const res = await runCli('node', ['-e', 'console.error("boom"); process.exit(3)']);
    expect(res.code).toBe(3);
    expect(res.stderr.trim()).toBe('boom');
  });

  it('通过 stdin 传入内容', async () => {
    const res = await runCli('node', ['-e', 'process.stdin.pipe(process.stdout)'], { stdin: 'piped-data' });
    expect(res.stdout).toBe('piped-data');
  });

  it('超时会杀死进程并标记 timedOut', async () => {
    const res = await runCli('node', ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 300 });
    expect(res.timedOut).toBe(true);
  });

  it('命令不存在时 reject', async () => {
    await expect(runCli('definitely-not-a-cmd-xyz', [])).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/proc.test.ts`
Expected: FAIL —— `Cannot find module '../src/utils/proc.js'`

- [ ] **Step 3: 实现 src/utils/proc.ts**

```ts
import { spawn } from 'node:child_process';

export interface RunOptions {
  cwd?: string;
  stdin?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function runCli(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, opts.timeoutMs)
      : null;

    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });

    child.stdin.end(opts.stdin ?? '');
  });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/proc.test.ts`
Expected: PASS（5 个用例全绿）

- [ ] **Step 5: Commit**

```bash
git add src/utils/proc.ts tests/proc.test.ts
git commit -m "feat: runCli 子进程封装（stdin/超时/输出收集）"
```

---

### Task 4: git diff 收集（git.ts）

**Files:**
- Create: `src/git.ts`, `tests/helpers/tmpRepo.ts`
- Test: `tests/git.test.ts`

- [ ] **Step 1: 写测试辅助 tests/helpers/tmpRepo.ts**

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export interface TmpRepo {
  dir: string;
  git(...args: string[]): void;
  write(file: string, content: string): void;
}

/** 创建带一次初始提交的临时 git 仓库 */
export function makeTmpRepo(): TmpRepo {
  const dir = mkdtempSync(join(tmpdir(), 'duet-review-test-'));
  const git = (...args: string[]) => {
    execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  };
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(dir, 'a.txt'), 'line1\n');
  git('add', '.');
  git('commit', '-m', 'init');
  return {
    dir,
    git,
    write: (file, content) => writeFileSync(join(dir, file), content),
  };
}
```

- [ ] **Step 2: 写失败测试 tests/git.test.ts**

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NoDiffError, collectDiff, ensureGitRepo } from '../src/git.js';
import { makeTmpRepo } from './helpers/tmpRepo.js';

describe('ensureGitRepo', () => {
  it('git 仓库内不抛错', async () => {
    const repo = makeTmpRepo();
    await expect(ensureGitRepo(repo.dir)).resolves.toBeUndefined();
  });

  it('非 git 目录抛错', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'duet-review-nogit-'));
    await expect(ensureGitRepo(dir)).rejects.toThrow('不是 git 仓库');
  });
});

describe('collectDiff', () => {
  it('只有 unstaged 变更时返回 unstaged diff', async () => {
    const repo = makeTmpRepo();
    repo.write('a.txt', 'line1\nline2\n');
    const res = await collectDiff(repo.dir);
    expect(res.source).toBe('unstaged');
    expect(res.patch).toContain('+line2');
  });

  it('staged 与 unstaged 并存时只取 staged', async () => {
    const repo = makeTmpRepo();
    repo.write('a.txt', 'line1\nstaged-change\n');
    repo.git('add', 'a.txt');
    repo.write('a.txt', 'line1\nstaged-change\nunstaged-change\n');
    const res = await collectDiff(repo.dir);
    expect(res.source).toBe('staged');
    expect(res.patch).toContain('+staged-change');
    expect(res.patch).not.toContain('+unstaged-change');
  });

  it('无任何变更时抛 NoDiffError', async () => {
    const repo = makeTmpRepo();
    await expect(collectDiff(repo.dir)).rejects.toBeInstanceOf(NoDiffError);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm vitest run tests/git.test.ts`
Expected: FAIL —— `Cannot find module '../src/git.js'`

- [ ] **Step 4: 实现 src/git.ts**

```ts
import { runCli } from './utils/proc.js';

export class NoDiffError extends Error {
  constructor() {
    super('没有可审查的变更（staged 与 unstaged 均为空）');
    this.name = 'NoDiffError';
  }
}

export interface DiffResult {
  source: 'staged' | 'unstaged';
  patch: string;
}

export async function ensureGitRepo(cwd: string): Promise<void> {
  const res = await runCli('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
  if (res.code !== 0) throw new Error(`当前目录不是 git 仓库: ${cwd}`);
}

/** 设计约定：优先 staged（git diff --cached），为空才取 unstaged（git diff），不含 untracked */
export async function collectDiff(cwd: string): Promise<DiffResult> {
  const staged = await runCli('git', ['diff', '--cached'], { cwd });
  if (staged.code !== 0) throw new Error(`git diff --cached 失败: ${staged.stderr}`);
  if (staged.stdout.trim() !== '') return { source: 'staged', patch: staged.stdout };

  const unstaged = await runCli('git', ['diff'], { cwd });
  if (unstaged.code !== 0) throw new Error(`git diff 失败: ${unstaged.stderr}`);
  if (unstaged.stdout.trim() !== '') return { source: 'unstaged', patch: unstaged.stdout };

  throw new NoDiffError();
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm vitest run tests/git.test.ts`
Expected: PASS（5 个用例全绿）

- [ ] **Step 6: Commit**

```bash
git add src/git.ts tests/git.test.ts tests/helpers/tmpRepo.ts
git commit -m "feat: staged 优先的 git diff 收集"
```

---

### Task 5: Prompt 构建与 codex output-schema（prompts.ts）

**Files:**
- Create: `src/prompts.ts`
- Test: `tests/prompts.test.ts`

prompt 全部用中文书写，但要求模型输出的 JSON 字段值中 `file`/`id` 保持原样。`buildCodexOutputSchemas` 生成两个 JSON Schema 文件内容（初始 review 用、讨论轮用），运行时由 cli.ts 写入存档目录后把路径传给 codex `--output-schema`。

- [ ] **Step 1: 写失败测试 tests/prompts.test.ts**

```ts
import { describe, expect, it } from 'vitest';
import {
  buildApplyPrompt,
  buildDiscussionPrompt,
  buildInitialReviewPrompt,
  buildRetryPrompt,
  codexDiscussionSchema,
  codexReviewSchema,
} from '../src/prompts.js';
import type { TrackedFinding } from '../src/types.js';

function tracked(over: Partial<TrackedFinding> = {}): TrackedFinding {
  return {
    finding: {
      id: 'cx-1', file: 'src/a.ts', line: 3, severity: 'major',
      title: '缺少判空', description: 'x 可能为 null', suggestion: '增加 if (!x) return;',
    },
    author: 'codex',
    codexStance: 'agree',
    claudeStance: 'pending',
    state: 'open',
    history: [],
    ...over,
  };
}

describe('buildInitialReviewPrompt', () => {
  it('包含 diff、来源说明与 schema 字段要求', () => {
    const p = buildInitialReviewPrompt('diff --git a/a.txt b/a.txt\n+line2', 'staged');
    expect(p).toContain('diff --git');
    expect(p).toContain('staged');
    for (const key of ['findings', 'severity', 'suggestion']) expect(p).toContain(key);
  });
});

describe('buildDiscussionPrompt', () => {
  it('列出对方 findings 与最新评论，并要求对每条表态', () => {
    const t = tracked();
    const p = buildDiscussionPrompt('claude', [t], 1);
    expect(p).toContain('cx-1');
    expect(p).toContain('缺少判空');
    for (const s of ['agree', 'disagree', 'modify', 'withdraw']) expect(p).toContain(s);
  });
});

describe('buildApplyPrompt', () => {
  it('只包含共识 findings 并明确禁止其他改动', () => {
    const t = tracked({ state: 'consensus' });
    const p = buildApplyPrompt([t]);
    expect(p).toContain('cx-1');
    expect(p).toContain('不要做任何列表之外的修改');
  });
});

describe('buildRetryPrompt', () => {
  it('携带解析错误信息', () => {
    expect(buildRetryPrompt('severity: Invalid enum value')).toContain('Invalid enum value');
  });
});

describe('codex output schemas', () => {
  it('review schema 约束 findings 数组与 severity 枚举', () => {
    const props = codexReviewSchema.properties.findings.items.properties;
    expect(props.severity.enum).toEqual(['critical', 'major', 'minor', 'nit']);
    expect(codexReviewSchema.required).toEqual(['findings']);
  });

  it('discussion schema 约束 stance 枚举', () => {
    const props = codexDiscussionSchema.properties.responses.items.properties;
    expect(props.stance.enum).toEqual(['agree', 'disagree', 'modify', 'withdraw']);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/prompts.test.ts`
Expected: FAIL —— `Cannot find module '../src/prompts.js'`

- [ ] **Step 3: 实现 src/prompts.ts**

```ts
import type { ReviewerName, TrackedFinding } from './types.js';

const FINDING_JSON_SPEC = `输出必须是一个 JSON 对象，且只输出 JSON，不要输出其他文字：
{
  "findings": [
    {
      "id": "短且稳定的标识，如 f1、f2",
      "file": "相对路径",
      "line": 行号数字或 null,
      "severity": "critical | major | minor | nit",
      "title": "一句话标题",
      "description": "问题说明",
      "suggestion": "具体修改建议，含必要代码片段"
    }
  ]
}
没有问题时输出 {"findings": []}。`;

const RESPONSE_JSON_SPEC = `输出必须是一个 JSON 对象，且只输出 JSON，不要输出其他文字：
{
  "responses": [
    {
      "findingId": "对应 finding 的 id",
      "stance": "agree | disagree | modify | withdraw",
      "comment": "理由",
      "revisedSuggestion": "stance=modify 时给出修订后的完整建议，否则为 null"
    }
  ]
}
立场含义：agree=认可当前建议；disagree=反对并给出理由；modify=建议修订（必须给 revisedSuggestion）；withdraw=撤回自己提出的 finding（只能用于自己提出的条目）。`;

export function buildInitialReviewPrompt(patch: string, source: 'staged' | 'unstaged'): string {
  return `你是一名严格的代码评审者。请审查下面这份 ${source} 的 git diff。
你可以读取仓库中的相关文件来理解上下文，但不要修改任何文件。
只报告 diff 中改动引入或直接相关的问题（正确性、安全、性能、可维护性），不要泛泛而谈。

${FINDING_JSON_SPEC}

=== DIFF 开始 ===
${patch}
=== DIFF 结束 ===`;
}

function renderFinding(t: TrackedFinding): string {
  const f = t.finding;
  const lastComments = t.history
    .slice(-2)
    .map((h) => `  - [${h.reviewer} 第${h.round}轮 ${h.response.stance}] ${h.response.comment}`)
    .join('\n');
  return `- id: ${f.id}（提出方: ${t.author}）
  file: ${f.file}${f.line ? `:${f.line}` : ''}  severity: ${f.severity}
  title: ${f.title}
  description: ${f.description}
  当前 suggestion: ${f.suggestion}${lastComments ? `\n  最新讨论:\n${lastComments}` : ''}`;
}

export function buildDiscussionPrompt(me: ReviewerName, open: TrackedFinding[], round: number): string {
  return `这是第 ${round} 轮讨论。下面是仍未达成共识的 findings（含双方最新意见）。
请逐条表态：对方提出的条目你可以 agree / disagree / modify；你自己提出的条目，若被说服可以 withdraw，若想修订可以 modify，坚持则 agree。
必须覆盖下列所有 findingId，不得遗漏。

${open.map(renderFinding).join('\n\n')}

${RESPONSE_JSON_SPEC}`;
}

export function buildRetryPrompt(parseError: string): string {
  return `你上一条输出无法解析为要求的 JSON：${parseError}
请重新输出，只输出符合 schema 的 JSON 对象，不要包含任何其他文字或代码块标记。`;
}

export function buildApplyPrompt(consensus: TrackedFinding[]): string {
  return `讨论已结束。下面是双方达成共识的修改项，请把它们逐条应用到工作区代码中。
要求：
1. 严格按照每条的 suggestion 实施；
2. 不要做任何列表之外的修改（不要顺手重构、不要改格式）；
3. 完成后用一段简短文字总结你改了哪些文件。

${consensus.map(renderFinding).join('\n\n')}`;
}

/** 传给 codex --output-schema 的 JSON Schema（初始 review） */
export const codexReviewSchema = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          file: { type: 'string' },
          line: { type: ['number', 'null'] },
          severity: { enum: ['critical', 'major', 'minor', 'nit'] },
          title: { type: 'string' },
          description: { type: 'string' },
          suggestion: { type: 'string' },
        },
        required: ['id', 'file', 'line', 'severity', 'title', 'description', 'suggestion'],
        additionalProperties: false,
      },
    },
  },
  required: ['findings'],
  additionalProperties: false,
} as const;

/** 传给 codex --output-schema 的 JSON Schema（讨论轮） */
export const codexDiscussionSchema = {
  type: 'object',
  properties: {
    responses: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          findingId: { type: 'string' },
          stance: { enum: ['agree', 'disagree', 'modify', 'withdraw'] },
          comment: { type: 'string' },
          revisedSuggestion: { type: ['string', 'null'] },
        },
        required: ['findingId', 'stance', 'comment', 'revisedSuggestion'],
        additionalProperties: false,
      },
    },
  },
  required: ['responses'],
  additionalProperties: false,
} as const;
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/prompts.test.ts`
Expected: PASS（6 个用例全绿）

- [ ] **Step 5: Commit**

```bash
git add src/prompts.ts tests/prompts.test.ts
git commit -m "feat: 评审/讨论/应用阶段 prompt 与 codex output-schema"
```

---

### Task 6: 假 CLI 可执行（测试基础设施）

**Files:**
- Create: `tests/fakes/bin/codex`, `tests/fakes/bin/claude`, `tests/helpers/fakeCli.ts`

假 CLI 是后续 Task 7/8/12 测试的地基。工作方式：环境变量 `DUET_FAKE_DIR` 指向一个场景目录；每个假 CLI 在其中维护自己的调用计数文件，第 N 次调用就输出 `<name>-reply-N.txt` 的内容（codex 包成 JSONL，claude 包成结果 JSON），同时把本次 argv 和 stdin 追加记录到 `<name>-calls.jsonl` 供断言。

- [ ] **Step 1: 写 tests/fakes/bin/codex（无扩展名，含 shebang）**

```js
#!/usr/bin/env node
// 假 codex：按 DUET_FAKE_DIR 场景回放输出，模拟 `codex exec --json` 的 JSONL 事件流
const fs = require('node:fs');
const path = require('node:path');

// 预检调用（codex --version）直接应答，不消耗场景计数
if (process.argv.includes('--version')) { console.log('fake-codex 0.0.0'); process.exit(0); }

const dir = process.env.DUET_FAKE_DIR;
if (!dir) { console.error('DUET_FAKE_DIR 未设置'); process.exit(99); }

let stdin = '';
try { stdin = fs.readFileSync(0, 'utf8'); } catch {}

const countFile = path.join(dir, 'codex-count');
const n = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) + 1 : 1;
fs.writeFileSync(countFile, String(n));

fs.appendFileSync(
  path.join(dir, 'codex-calls.jsonl'),
  JSON.stringify({ n, argv: process.argv.slice(2), stdin }) + '\n',
);

const replyFile = path.join(dir, `codex-reply-${n}.txt`);
if (!fs.existsSync(replyFile)) { console.error(`场景缺少 ${replyFile}`); process.exit(98); }
const message = fs.readFileSync(replyFile, 'utf8');

// 模拟 codex --json 的 JSONL：会话事件 + 最终 agent 消息
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fake-codex-session-1' }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: message } }));
```

- [ ] **Step 2: 写 tests/fakes/bin/claude**

```js
#!/usr/bin/env node
// 假 claude：按 DUET_FAKE_DIR 场景回放输出，模拟 `claude -p --output-format json` 的结果 JSON
const fs = require('node:fs');
const path = require('node:path');

// 预检调用（claude --version）直接应答，不消耗场景计数
if (process.argv.includes('--version')) { console.log('fake-claude 0.0.0'); process.exit(0); }

const dir = process.env.DUET_FAKE_DIR;
if (!dir) { console.error('DUET_FAKE_DIR 未设置'); process.exit(99); }

let stdin = '';
try { stdin = fs.readFileSync(0, 'utf8'); } catch {}

const countFile = path.join(dir, 'claude-count');
const n = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) + 1 : 1;
fs.writeFileSync(countFile, String(n));

fs.appendFileSync(
  path.join(dir, 'claude-calls.jsonl'),
  JSON.stringify({ n, argv: process.argv.slice(2), stdin }) + '\n',
);

const replyFile = path.join(dir, `claude-reply-${n}.txt`);
if (!fs.existsSync(replyFile)) { console.error(`场景缺少 ${replyFile}`); process.exit(98); }
const message = fs.readFileSync(replyFile, 'utf8');

console.log(JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: message,
  session_id: 'fake-claude-session-1',
}));
```

- [ ] **Step 3: 写 tests/helpers/fakeCli.ts**

```ts
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const FAKES_BIN = resolve(import.meta.dirname, '../fakes/bin');

export interface FakeScenario {
  dir: string;
  /** PATH 前置假 bin、注入 DUET_FAKE_DIR 后的 env */
  env: NodeJS.ProcessEnv;
  setReply(cli: 'codex' | 'claude', n: number, content: string): void;
  calls(cli: 'codex' | 'claude'): Array<{ n: number; argv: string[]; stdin: string }>;
}

export function makeFakeScenario(): FakeScenario {
  chmodSync(join(FAKES_BIN, 'codex'), 0o755);
  chmodSync(join(FAKES_BIN, 'claude'), 0o755);
  const dir = mkdtempSync(join(tmpdir(), 'duet-review-fake-'));
  return {
    dir,
    env: {
      ...process.env,
      PATH: `${FAKES_BIN}:${process.env.PATH}`,
      DUET_FAKE_DIR: dir,
    },
    setReply(cli, n, content) {
      writeFileSync(join(dir, `${cli}-reply-${n}.txt`), content);
    },
    calls(cli) {
      try {
        return readFileSync(join(dir, `${cli}-calls.jsonl`), 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
  };
}
```

注意：`runCli` 当前不透传自定义 env 给 reviewer —— Task 7/8 中 reviewer 构造函数需要接收 `env` 并传给 `runCli`（生产代码默认 `process.env`，测试注入假 PATH）。

- [ ] **Step 4: 手工验证假 CLI 行为**

Run:
```bash
chmod +x tests/fakes/bin/codex tests/fakes/bin/claude
FAKE=$(mktemp -d) && echo 'hello-from-codex' > "$FAKE/codex-reply-1.txt" && \
  DUET_FAKE_DIR=$FAKE tests/fakes/bin/codex exec --json - <<< 'prompt' && \
  cat "$FAKE/codex-calls.jsonl"
```
Expected: 两行 JSONL（thread.started + item.completed 含 hello-from-codex）；calls.jsonl 记录了 argv 与 stdin

- [ ] **Step 5: Commit**

```bash
git add tests/fakes tests/helpers/fakeCli.ts
git commit -m "test: 可回放场景的假 codex/claude 可执行"
```

---

### Task 7: CodexReviewer（reviewers/codex.ts）

**Files:**
- Create: `src/reviewers/codex.ts`
- Test: `tests/codex.test.ts`

- [ ] **Step 1: 写失败测试 tests/codex.test.ts**

```ts
import { describe, expect, it } from 'vitest';
import { CodexReviewer, parseCodexJsonl } from '../src/reviewers/codex.js';
import { makeFakeScenario } from './helpers/fakeCli.js';

describe('parseCodexJsonl', () => {
  it('提取 session id 与最终 agent 消息', () => {
    const jsonl = [
      JSON.stringify({ type: 'thread.started', thread_id: 's-123' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: '思考' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '最终结论' } }),
    ].join('\n');
    expect(parseCodexJsonl(jsonl)).toEqual({ sessionId: 's-123', lastMessage: '最终结论' });
  });

  it('兼容 session_id 字段名并跳过非 JSON 行', () => {
    const jsonl = ['垃圾行', JSON.stringify({ session_id: 's-9' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } })].join('\n');
    expect(parseCodexJsonl(jsonl)).toEqual({ sessionId: 's-9', lastMessage: 'ok' });
  });

  it('缺消息时 lastMessage 为 null', () => {
    expect(parseCodexJsonl(JSON.stringify({ thread_id: 's-1' }))).toEqual({ sessionId: 's-1', lastMessage: null });
  });
});

describe('CodexReviewer', () => {
  function make(scenario = makeFakeScenario()) {
    const reviewer = new CodexReviewer({
      cwd: process.cwd(),
      timeoutMs: 10_000,
      reviewSchemaFile: '/tmp/review-schema.json',
      discussionSchemaFile: '/tmp/discussion-schema.json',
      env: scenario.env,
    });
    return { scenario, reviewer };
  }

  it('start 走 exec 子命令、read-only 沙箱、stdin 传 prompt，并返回消息', async () => {
    const { scenario, reviewer } = make();
    scenario.setReply('codex', 1, '初始评审结果');
    const out = await reviewer.start('请评审这个 diff');
    expect(out).toBe('初始评审结果');
    const call = scenario.calls('codex')[0];
    expect(call.argv).toEqual([
      'exec', '--json', '-s', 'read-only', '--output-schema', '/tmp/review-schema.json', '-',
    ]);
    expect(call.stdin).toBe('请评审这个 diff');
  });

  it('reply 用 exec resume 续接同一会话', async () => {
    const { scenario, reviewer } = make();
    scenario.setReply('codex', 1, '初始');
    scenario.setReply('codex', 2, '第二轮');
    await reviewer.start('第一轮');
    const out = await reviewer.reply('第二轮 prompt');
    expect(out).toBe('第二轮');
    const call = scenario.calls('codex')[1];
    expect(call.argv).toEqual([
      'exec', 'resume', 'fake-codex-session-1', '--json', '-s', 'read-only',
      '--output-schema', '/tmp/discussion-schema.json', '-',
    ]);
  });

  it('未 start 直接 reply 抛错', async () => {
    const { reviewer } = make();
    await expect(reviewer.reply('x')).rejects.toThrow('会话不存在');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/codex.test.ts`
Expected: FAIL —— `Cannot find module '../src/reviewers/codex.js'`

- [ ] **Step 3: 实现 src/reviewers/codex.ts**

```ts
import { runCli } from '../utils/proc.js';
import type { Reviewer } from '../types.js';

export interface CodexOptions {
  cwd: string;
  timeoutMs: number;
  reviewSchemaFile: string;
  discussionSchemaFile: string;
  env?: NodeJS.ProcessEnv;
}

const SESSION_KEYS = new Set(['thread_id', 'session_id', 'conversation_id']);

/** 递归找事件对象里第一个会话 id 字段 */
function findSessionId(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;
  for (const [k, v] of Object.entries(value)) {
    if (SESSION_KEYS.has(k) && typeof v === 'string' && v) return v;
    const nested = findSessionId(v);
    if (nested) return nested;
  }
  return null;
}

export function parseCodexJsonl(jsonl: string): { sessionId: string | null; lastMessage: string | null } {
  let sessionId: string | null = null;
  let lastMessage: string | null = null;
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let evt: any;
    try { evt = JSON.parse(trimmed); } catch { continue; }
    sessionId ??= findSessionId(evt);
    if (evt?.item?.type === 'agent_message' && typeof evt.item.text === 'string') {
      lastMessage = evt.item.text;
    } else if (evt?.type === 'agent_message' && typeof evt.message === 'string') {
      lastMessage = evt.message;
    }
  }
  return { sessionId, lastMessage };
}

export class CodexReviewer implements Reviewer {
  readonly name = 'codex' as const;
  private sessionId: string | null = null;

  constructor(private readonly opts: CodexOptions) {}

  async start(prompt: string): Promise<string> {
    return this.exec(
      ['exec', '--json', '-s', 'read-only', '--output-schema', this.opts.reviewSchemaFile, '-'],
      prompt,
    );
  }

  async reply(prompt: string): Promise<string> {
    if (!this.sessionId) throw new Error('codex 会话不存在，无法 resume');
    return this.exec(
      ['exec', 'resume', this.sessionId, '--json', '-s', 'read-only',
        '--output-schema', this.opts.discussionSchemaFile, '-'],
      prompt,
    );
  }

  private async exec(args: string[], prompt: string): Promise<string> {
    const res = await runCli('codex', args, {
      cwd: this.opts.cwd,
      stdin: prompt,
      timeoutMs: this.opts.timeoutMs,
      env: this.opts.env,
    });
    if (res.timedOut) throw new Error('codex 调用超时');
    if (res.code !== 0) throw new Error(`codex 退出码 ${res.code}: ${res.stderr.slice(-2000)}`);
    const { sessionId, lastMessage } = parseCodexJsonl(res.stdout);
    if (sessionId) this.sessionId = sessionId;
    if (!this.sessionId) throw new Error('未能从 codex 输出解析 session id');
    if (lastMessage === null) throw new Error('未能从 codex 输出解析最终消息');
    return lastMessage;
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/codex.test.ts`
Expected: PASS（6 个用例全绿）

- [ ] **Step 5: Commit**

```bash
git add src/reviewers/codex.ts tests/codex.test.ts
git commit -m "feat: CodexReviewer（exec/resume、JSONL 解析、read-only 沙箱）"
```

---

### Task 8: ClaudeReviewer（reviewers/claude.ts）

**Files:**
- Create: `src/reviewers/claude.ts`
- Test: `tests/claude.test.ts`

- [ ] **Step 1: 写失败测试 tests/claude.test.ts**

```ts
import { describe, expect, it } from 'vitest';
import { ClaudeReviewer, parseClaudeResult } from '../src/reviewers/claude.js';
import { makeFakeScenario } from './helpers/fakeCli.js';

const READ_ONLY = ['--allowedTools', 'Read', 'Grep', 'Glob'];

function make(scenario = makeFakeScenario()) {
  const reviewer = new ClaudeReviewer({ cwd: process.cwd(), timeoutMs: 10_000, env: scenario.env });
  return { scenario, reviewer };
}

describe('ClaudeReviewer', () => {
  it('start 用 -p + json 输出 + 只读工具，stdin 传 prompt', async () => {
    const { scenario, reviewer } = make();
    scenario.setReply('claude', 1, '初始评审');
    const out = await reviewer.start('请评审');
    expect(out).toBe('初始评审');
    const call = scenario.calls('claude')[0];
    expect(call.argv).toEqual(['-p', '--output-format', 'json', ...READ_ONLY]);
    expect(call.stdin).toBe('请评审');
  });

  it('reply 用 --resume 续接同一会话', async () => {
    const { scenario, reviewer } = make();
    scenario.setReply('claude', 1, '初始');
    scenario.setReply('claude', 2, '第二轮');
    await reviewer.start('第一轮');
    const out = await reviewer.reply('第二轮 prompt');
    expect(out).toBe('第二轮');
    expect(scenario.calls('claude')[1].argv).toEqual([
      '-p', '--resume', 'fake-claude-session-1', '--output-format', 'json', ...READ_ONLY,
    ]);
  });

  it('applyFix 用写权限工具集与 acceptEdits', async () => {
    const { scenario, reviewer } = make();
    scenario.setReply('claude', 1, '初始');
    scenario.setReply('claude', 2, '已应用修改');
    await reviewer.start('第一轮');
    const out = await reviewer.applyFix('请应用共识');
    expect(out).toBe('已应用修改');
    expect(scenario.calls('claude')[1].argv).toEqual([
      '-p', '--resume', 'fake-claude-session-1', '--output-format', 'json',
      '--permission-mode', 'acceptEdits',
      '--allowedTools', 'Read', 'Grep', 'Glob', 'Edit', 'Write',
    ]);
  });

  it('未 start 直接 reply/applyFix 抛错', async () => {
    const { reviewer } = make();
    await expect(reviewer.reply('x')).rejects.toThrow('会话不存在');
    await expect(reviewer.applyFix('x')).rejects.toThrow('会话不存在');
  });

});

describe('parseClaudeResult', () => {
  it('提取 result 与 session_id', () => {
    const parsed = parseClaudeResult(JSON.stringify({ result: 'r', session_id: 's1', is_error: false }));
    expect(parsed).toEqual({ result: 'r', sessionId: 's1' });
  });

  it('is_error 为 true 时抛错', () => {
    expect(() => parseClaudeResult(JSON.stringify({ result: '坏了', session_id: 's', is_error: true })))
      .toThrow('claude 返回错误');
  });

  it('缺 result 字段抛错', () => {
    expect(() => parseClaudeResult(JSON.stringify({ session_id: 's' }))).toThrow('缺少 result');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/claude.test.ts`
Expected: FAIL —— `Cannot find module '../src/reviewers/claude.js'`

- [ ] **Step 3: 实现 src/reviewers/claude.ts**

```ts
import { runCli } from '../utils/proc.js';
import type { Reviewer } from '../types.js';

export interface ClaudeOptions {
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

const READ_ONLY_TOOLS = ['--allowedTools', 'Read', 'Grep', 'Glob'];
const WRITE_TOOLS = ['--allowedTools', 'Read', 'Grep', 'Glob', 'Edit', 'Write'];

export function parseClaudeResult(stdout: string): { result: string; sessionId: string | null } {
  let parsed: any;
  try {
    parsed = JSON.parse(stdout);
  } catch (e) {
    throw new Error(`claude 输出不是合法 JSON: ${(e as Error).message}`);
  }
  if (parsed.is_error) throw new Error(`claude 返回错误: ${parsed.result ?? '(无详情)'}`);
  if (typeof parsed.result !== 'string') throw new Error('claude 输出缺少 result 字段');
  return { result: parsed.result, sessionId: typeof parsed.session_id === 'string' ? parsed.session_id : null };
}

export class ClaudeReviewer implements Reviewer {
  readonly name = 'claude' as const;
  private sessionId: string | null = null;

  constructor(private readonly opts: ClaudeOptions) {}

  async start(prompt: string): Promise<string> {
    return this.exec(['-p', '--output-format', 'json', ...READ_ONLY_TOOLS], prompt);
  }

  async reply(prompt: string): Promise<string> {
    return this.exec(
      ['-p', '--resume', this.requireSession(), '--output-format', 'json', ...READ_ONLY_TOOLS],
      prompt,
    );
  }

  /** 应用阶段：续接同一会话，授予写权限 */
  async applyFix(prompt: string): Promise<string> {
    return this.exec(
      ['-p', '--resume', this.requireSession(), '--output-format', 'json',
        '--permission-mode', 'acceptEdits', ...WRITE_TOOLS],
      prompt,
    );
  }

  private requireSession(): string {
    if (!this.sessionId) throw new Error('claude 会话不存在，无法 resume');
    return this.sessionId;
  }

  private async exec(args: string[], prompt: string): Promise<string> {
    const res = await runCli('claude', args, {
      cwd: this.opts.cwd,
      stdin: prompt,
      timeoutMs: this.opts.timeoutMs,
      env: this.opts.env,
    });
    if (res.timedOut) throw new Error('claude 调用超时');
    if (res.code !== 0) throw new Error(`claude 退出码 ${res.code}: ${res.stderr.slice(-2000)}`);
    const { result, sessionId } = parseClaudeResult(res.stdout);
    if (sessionId) this.sessionId = sessionId;
    if (!this.sessionId) throw new Error('未能从 claude 输出解析 session_id');
    return result;
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/claude.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/reviewers/claude.ts tests/claude.test.ts
git commit -m "feat: ClaudeReviewer（-p/--resume、applyFix 写权限通道）"
```

---

### Task 9: 共识状态机与轮次控制（orchestrator.ts）

**Files:**
- Create: `src/orchestrator.ts`
- Test: `tests/orchestrator.test.ts`

状态机规则（与设计文档 4.1 一致）：
- finding 初始：作者方 stance=agree，对方=pending，state=open。
- 应用某方 responses：该方对每条 findingId 设置 stance。
  - `withdraw` 且该方是作者 → state=dropped；非作者的 withdraw 视为 disagree（记录 warning）。
  - `modify` 且带 revisedSuggestion → 更新 `finding.suggestion`，该方 stance=agree（认可自己修订后的版本），**另一方** stance 重置为 pending（需对新版本重新表态）。`modify` 缺 revisedSuggestion 视为 disagree。
  - `agree`/`disagree` → 直接记录。
- 每轮双方都应用完后评估：双方 stance 均为 agree → consensus；dropped 保持；其余 open。
- 轮数耗尽仍 open → disputed。

- [ ] **Step 1: 写失败测试 tests/orchestrator.test.ts**

```ts
import { describe, expect, it } from 'vitest';
import { applyResponses, evaluate, initTracked, openFindings, runDiscussion } from '../src/orchestrator.js';
import type { DiscussionResponse, Finding, Reviewer } from '../src/types.js';

function finding(id: string, over: Partial<Finding> = {}): Finding {
  return { id, file: 'a.ts', line: 1, severity: 'major', title: 't-' + id, description: 'd', suggestion: 's0', ...over };
}

function resp(findingId: string, stance: DiscussionResponse['stance'], over: Partial<DiscussionResponse> = {}): DiscussionResponse {
  return { findingId, stance, comment: 'c', revisedSuggestion: null, ...over };
}

describe('initTracked', () => {
  it('给双方 finding 加 cx-/cl- 前缀并设初始立场', () => {
    const tracked = initTracked([finding('1')], [finding('1')]);
    expect(tracked.map((t) => t.finding.id)).toEqual(['cx-1', 'cl-1']);
    const cx = tracked[0];
    expect(cx.author).toBe('codex');
    expect(cx.codexStance).toBe('agree');
    expect(cx.claudeStance).toBe('pending');
    expect(cx.state).toBe('open');
  });
});

describe('applyResponses + evaluate', () => {
  it('双方 agree 达成共识', () => {
    const tracked = initTracked([finding('1')], []);
    applyResponses(tracked, 'claude', [resp('cx-1', 'agree')], 1);
    evaluate(tracked);
    expect(tracked[0].state).toBe('consensus');
  });

  it('作者 withdraw 后标记 dropped', () => {
    const tracked = initTracked([finding('1')], []);
    applyResponses(tracked, 'claude', [resp('cx-1', 'disagree')], 1);
    applyResponses(tracked, 'codex', [resp('cx-1', 'withdraw')], 2);
    evaluate(tracked);
    expect(tracked[0].state).toBe('dropped');
  });

  it('非作者 withdraw 视为 disagree', () => {
    const tracked = initTracked([finding('1')], []);
    applyResponses(tracked, 'claude', [resp('cx-1', 'withdraw')], 1);
    expect(tracked[0].claudeStance).toBe('disagree');
  });

  it('modify 更新 suggestion 并把对方立场重置为 pending', () => {
    const tracked = initTracked([finding('1')], []);
    applyResponses(tracked, 'claude', [resp('cx-1', 'modify', { revisedSuggestion: 's1' })], 1);
    expect(tracked[0].finding.suggestion).toBe('s1');
    expect(tracked[0].claudeStance).toBe('agree');
    expect(tracked[0].codexStance).toBe('pending');
    evaluate(tracked);
    expect(tracked[0].state).toBe('open'); // codex 还没对 s1 表态

    applyResponses(tracked, 'codex', [resp('cx-1', 'agree')], 2);
    evaluate(tracked);
    expect(tracked[0].state).toBe('consensus');
  });

  it('modify 缺 revisedSuggestion 视为 disagree', () => {
    const tracked = initTracked([finding('1')], []);
    applyResponses(tracked, 'claude', [resp('cx-1', 'modify')], 1);
    expect(tracked[0].claudeStance).toBe('disagree');
    expect(tracked[0].finding.suggestion).toBe('s0');
  });

  it('history 记录每次 response', () => {
    const tracked = initTracked([finding('1')], []);
    applyResponses(tracked, 'claude', [resp('cx-1', 'agree')], 1);
    expect(tracked[0].history).toEqual([
      { round: 1, reviewer: 'claude', response: resp('cx-1', 'agree') },
    ]);
  });
});

describe('runDiscussion', () => {
  function fakeReviewer(name: 'codex' | 'claude', replies: string[]): Reviewer & { prompts: string[] } {
    const prompts: string[] = [];
    return {
      name,
      prompts,
      async start() { throw new Error('讨论阶段不应调用 start'); },
      async reply(prompt: string) {
        prompts.push(prompt);
        const r = replies.shift();
        if (!r) throw new Error(`${name} 没有更多脚本回复`);
        return r;
      },
    };
  }

  const agreeAll = (ids: string[]) =>
    JSON.stringify({ responses: ids.map((id) => resp(id, 'agree')) });

  it('第一轮全部 agree 则提前收敛', async () => {
    const codex = fakeReviewer('codex', [agreeAll(['cx-1', 'cl-1'])]);
    const claude = fakeReviewer('claude', [agreeAll(['cx-1', 'cl-1'])]);
    const tracked = initTracked([finding('1')], [finding('1')]);
    const result = await runDiscussion({ codex, claude, tracked, maxRounds: 3, onProgress: () => {} });
    expect(result.rounds).toBe(1);
    expect(tracked.every((t) => t.state === 'consensus')).toBe(true);
  });

  it('轮数耗尽仍未收敛的 finding 标记 disputed', async () => {
    const disagreeAll = JSON.stringify({ responses: [resp('cx-1', 'disagree')] });
    const keep = JSON.stringify({ responses: [resp('cx-1', 'agree')] });
    const codex = fakeReviewer('codex', [keep, keep]);
    const claude = fakeReviewer('claude', [disagreeAll, disagreeAll]);
    const tracked = initTracked([finding('1')], []);
    const result = await runDiscussion({ codex, claude, tracked, maxRounds: 2, onProgress: () => {} });
    expect(result.rounds).toBe(2);
    expect(tracked[0].state).toBe('disputed');
  });

  it('解析失败重试一次（buildRetryPrompt）后成功', async () => {
    const codex = fakeReviewer('codex', ['这不是 JSON', agreeAll(['cl-1'])]);
    const claude = fakeReviewer('claude', [agreeAll(['cl-1'])]);
    const tracked = initTracked([], [finding('1')]);
    await runDiscussion({ codex, claude, tracked, maxRounds: 3, onProgress: () => {} });
    expect(codex.prompts).toHaveLength(2);
    expect(codex.prompts[1]).toContain('无法解析');
    expect(tracked[0].state).toBe('consensus');
  });

  it('重试仍失败则抛错', async () => {
    const codex = fakeReviewer('codex', ['坏的', '还是坏的']);
    const claude = fakeReviewer('claude', [agreeAll(['cl-1'])]);
    const tracked = initTracked([], [finding('1')]);
    await expect(
      runDiscussion({ codex, claude, tracked, maxRounds: 3, onProgress: () => {} }),
    ).rejects.toThrow('codex');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/orchestrator.test.ts`
Expected: FAIL —— `Cannot find module '../src/orchestrator.js'`

- [ ] **Step 3: 实现 src/orchestrator.ts**

```ts
import { parseDiscussionOutput } from './parse.js';
import { buildDiscussionPrompt, buildRetryPrompt } from './prompts.js';
import type { DiscussionResponse, Finding, Reviewer, ReviewerName, TrackedFinding } from './types.js';

export function initTracked(codexFindings: Finding[], claudeFindings: Finding[]): TrackedFinding[] {
  const make = (f: Finding, author: ReviewerName, prefix: string): TrackedFinding => ({
    finding: { ...f, id: `${prefix}-${f.id}` },
    author,
    codexStance: author === 'codex' ? 'agree' : 'pending',
    claudeStance: author === 'claude' ? 'agree' : 'pending',
    state: 'open',
    history: [],
  });
  return [
    ...codexFindings.map((f) => make(f, 'codex', 'cx')),
    ...claudeFindings.map((f) => make(f, 'claude', 'cl')),
  ];
}

export function openFindings(tracked: TrackedFinding[]): TrackedFinding[] {
  return tracked.filter((t) => t.state === 'open');
}

export function applyResponses(
  tracked: TrackedFinding[],
  reviewer: ReviewerName,
  responses: DiscussionResponse[],
  round: number,
): void {
  const byId = new Map(tracked.map((t) => [t.finding.id, t]));
  for (const response of responses) {
    const t = byId.get(response.findingId);
    if (!t || t.state !== 'open') continue; // 容忍模型回应了未知/已关闭条目
    t.history.push({ round, reviewer, response });

    let stance = response.stance;
    if (stance === 'withdraw' && t.author !== reviewer) stance = 'disagree';
    if (stance === 'modify') {
      if (response.revisedSuggestion) {
        t.finding.suggestion = response.revisedSuggestion;
        // 修订者认可新版本，另一方需重新表态
        if (reviewer === 'codex') { t.codexStance = 'agree'; t.claudeStance = 'pending'; }
        else { t.claudeStance = 'agree'; t.codexStance = 'pending'; }
        continue;
      }
      stance = 'disagree';
    }
    if (stance === 'withdraw') { t.state = 'dropped'; continue; }
    if (reviewer === 'codex') t.codexStance = stance;
    else t.claudeStance = stance;
  }
}

export function evaluate(tracked: TrackedFinding[]): void {
  for (const t of tracked) {
    if (t.state !== 'open') continue;
    if (t.codexStance === 'agree' && t.claudeStance === 'agree') t.state = 'consensus';
  }
}

export interface DiscussionDeps {
  codex: Reviewer;
  claude: Reviewer;
  tracked: TrackedFinding[];
  maxRounds: number;
  onProgress: (message: string) => void;
  /** 每轮双方原始输出的存档回调（可选） */
  onRoundOutput?: (round: number, reviewer: ReviewerName, raw: string) => void;
}

async function askWithRetry(reviewer: Reviewer, prompt: string): Promise<{ raw: string; responses: DiscussionResponse[] }> {
  const first = await reviewer.reply(prompt);
  try {
    return { raw: first, responses: parseDiscussionOutput(first).responses };
  } catch (e) {
    const second = await reviewer.reply(buildRetryPrompt((e as Error).message));
    try {
      return { raw: second, responses: parseDiscussionOutput(second).responses };
    } catch (e2) {
      throw new Error(`${reviewer.name} 的讨论输出重试后仍无法解析: ${(e2 as Error).message}`);
    }
  }
}

export async function runDiscussion(deps: DiscussionDeps): Promise<{ rounds: number }> {
  const { codex, claude, tracked, maxRounds, onProgress, onRoundOutput } = deps;
  let round = 0;
  while (round < maxRounds) {
    const open = openFindings(tracked);
    if (open.length === 0) break;
    round++;
    onProgress(`第 ${round}/${maxRounds} 轮讨论：${open.length} 条 finding 待收敛`);

    const [codexOut, claudeOut] = await Promise.all([
      askWithRetry(codex, buildDiscussionPrompt('codex', open, round)),
      askWithRetry(claude, buildDiscussionPrompt('claude', open, round)),
    ]);
    onRoundOutput?.(round, 'codex', codexOut.raw);
    onRoundOutput?.(round, 'claude', claudeOut.raw);

    applyResponses(tracked, 'codex', codexOut.responses, round);
    applyResponses(tracked, 'claude', claudeOut.responses, round);
    evaluate(tracked);

    const stats = {
      consensus: tracked.filter((t) => t.state === 'consensus').length,
      dropped: tracked.filter((t) => t.state === 'dropped').length,
      open: openFindings(tracked).length,
    };
    onProgress(`第 ${round} 轮结束：共识 ${stats.consensus}，撤销 ${stats.dropped}，待定 ${stats.open}`);
  }

  for (const t of tracked) if (t.state === 'open') t.state = 'disputed';
  return { rounds: round };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/orchestrator.test.ts`
Expected: PASS（11 个用例全绿）

- [ ] **Step 5: 运行全部测试防回归**

Run: `pnpm test`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator.ts tests/orchestrator.test.ts
git commit -m "feat: 共识状态机与多轮讨论控制"
```

---

### Task 10: 存档与报告（report.ts）

**Files:**
- Create: `src/report.ts`
- Test: `tests/report.test.ts`

- [ ] **Step 1: 写失败测试 tests/report.test.ts**

```ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { Archive, renderReport } from '../src/report.js';
import type { TrackedFinding } from '../src/types.js';

function tracked(id: string, state: TrackedFinding['state']): TrackedFinding {
  return {
    finding: { id, file: 'src/a.ts', line: 3, severity: 'major', title: '标题-' + id, description: '描述', suggestion: '建议' },
    author: 'codex',
    codexStance: 'agree',
    claudeStance: state === 'consensus' ? 'agree' : 'disagree',
    state,
    history: [],
  };
}

describe('Archive', () => {
  it('在 .duet-review/<时间戳>/ 下创建目录并写文件', () => {
    const root = mkdtempSync(join(tmpdir(), 'duet-archive-'));
    const archive = new Archive(root, new Date('2026-06-11T10:30:00Z'));
    expect(archive.dir).toContain(join(root, '.duet-review'));
    expect(archive.dir).toContain('2026-06-11T10-30-00');
    archive.write('00-diff.patch', 'diff 内容');
    expect(readFileSync(join(archive.dir, '00-diff.patch'), 'utf8')).toBe('diff 内容');
  });
});

describe('renderReport', () => {
  it('按状态分组渲染共识/分歧/撤销', () => {
    const md = renderReport({
      source: 'staged',
      rounds: 2,
      tracked: [tracked('cx-1', 'consensus'), tracked('cx-2', 'disputed'), tracked('cx-3', 'dropped')],
      applySummary: '修改了 src/a.ts',
    });
    expect(md).toContain('# duet-review 报告');
    expect(md).toContain('共识');
    expect(md).toContain('cx-1');
    expect(md).toContain('分歧');
    expect(md).toContain('cx-2');
    expect(md).toContain('撤销');
    expect(md).toContain('cx-3');
    expect(md).toContain('修改了 src/a.ts');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/report.test.ts`
Expected: FAIL —— `Cannot find module '../src/report.js'`

- [ ] **Step 3: 实现 src/report.ts**

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TrackedFinding } from './types.js';

export class Archive {
  readonly dir: string;

  constructor(repoRoot: string, now: Date = new Date()) {
    const ts = now.toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, '');
    this.dir = join(repoRoot, '.duet-review', ts);
    mkdirSync(this.dir, { recursive: true });
  }

  write(name: string, content: string): void {
    writeFileSync(join(this.dir, name), content);
  }
}

export interface ReportInput {
  source: 'staged' | 'unstaged';
  rounds: number;
  tracked: TrackedFinding[];
  applySummary: string | null;
}

function section(title: string, items: TrackedFinding[]): string {
  if (items.length === 0) return `## ${title}\n\n（无）\n`;
  const body = items
    .map((t) => {
      const f = t.finding;
      const loc = f.line ? `${f.file}:${f.line}` : f.file;
      const talk = t.history
        .map((h) => `> 第${h.round}轮 ${h.reviewer} [${h.response.stance}]: ${h.response.comment}`)
        .join('\n');
      return `### ${f.id} · ${f.title}\n\n- 位置: \`${loc}\`\n- 严重度: ${f.severity}\n- 提出方: ${t.author}\n\n${f.description}\n\n**建议:** ${f.suggestion}\n${talk ? `\n${talk}\n` : ''}`;
    })
    .join('\n');
  return `## ${title}（${items.length}）\n\n${body}\n`;
}

export function renderReport(input: ReportInput): string {
  const by = (s: TrackedFinding['state']) => input.tracked.filter((t) => t.state === s);
  return [
    '# duet-review 报告',
    '',
    `- 审查对象: ${input.source} diff`,
    `- 讨论轮数: ${input.rounds}`,
    `- 结果: 共识 ${by('consensus').length} / 分歧 ${by('disputed').length} / 撤销 ${by('dropped').length}`,
    '',
    section('共识（已应用）', by('consensus')),
    section('分歧（未改动，请人工裁决）', by('disputed')),
    section('撤销', by('dropped')),
    input.applySummary ? `## 应用结果\n\n${input.applySummary}\n` : '',
  ].join('\n');
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/report.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/report.ts tests/report.test.ts
git commit -m "feat: 存档目录与 markdown 报告渲染"
```

---

### Task 11: 初始评审与应用阶段（orchestrator 补充 + apply.ts）

**Files:**
- Modify: `src/orchestrator.ts`（追加 `runInitialReviews`）
- Create: `src/apply.ts`
- Test: `tests/initialReviews.test.ts`, `tests/apply.test.ts`

- [ ] **Step 1: 写失败测试 tests/initialReviews.test.ts**

```ts
import { describe, expect, it } from 'vitest';
import { runInitialReviews } from '../src/orchestrator.js';
import type { Reviewer } from '../src/types.js';

const REVIEW = JSON.stringify({
  findings: [{ id: 'f1', file: 'a.ts', line: 1, severity: 'minor', title: 't', description: 'd', suggestion: 's' }],
});

function scripted(name: 'codex' | 'claude', startReply: string, retryReply?: string): Reviewer & { prompts: string[] } {
  const prompts: string[] = [];
  let started = false;
  return {
    name,
    prompts,
    async start(p: string) { prompts.push(p); started = true; return startReply; },
    async reply(p: string) {
      if (!started) throw new Error('未 start');
      prompts.push(p);
      if (!retryReply) throw new Error('不应触发重试');
      return retryReply;
    },
  };
}

describe('runInitialReviews', () => {
  it('并行启动双方并解析 findings', async () => {
    const codex = scripted('codex', REVIEW);
    const claude = scripted('claude', REVIEW);
    const res = await runInitialReviews({ codex, claude, prompt: '评审 prompt', onProgress: () => {} });
    expect(res.codexFindings).toHaveLength(1);
    expect(res.claudeFindings).toHaveLength(1);
    expect(codex.prompts).toEqual(['评审 prompt']);
  });

  it('解析失败时通过 reply 重试一次', async () => {
    const codex = scripted('codex', '不是 JSON', REVIEW);
    const claude = scripted('claude', REVIEW);
    const res = await runInitialReviews({ codex, claude, prompt: 'p', onProgress: () => {} });
    expect(res.codexFindings).toHaveLength(1);
    expect(codex.prompts[1]).toContain('无法解析');
  });

  it('重试仍失败则抛错并指明是哪个 reviewer', async () => {
    const codex = scripted('codex', REVIEW);
    const claude = scripted('claude', '坏', '还是坏');
    await expect(
      runInitialReviews({ codex, claude, prompt: 'p', onProgress: () => {} }),
    ).rejects.toThrow('claude');
  });
});
```

- [ ] **Step 2: 写失败测试 tests/apply.test.ts**

```ts
import { describe, expect, it } from 'vitest';
import { applyConsensus } from '../src/apply.js';
import { initTracked } from '../src/orchestrator.js';
import type { Finding } from '../src/types.js';

const f: Finding = { id: '1', file: 'a.ts', line: 1, severity: 'major', title: 't', description: 'd', suggestion: 's' };

describe('applyConsensus', () => {
  it('无共识项时不调用 claude，返回 null', async () => {
    let called = false;
    const out = await applyConsensus({
      consensus: [],
      applyFix: async () => { called = true; return 'x'; },
      onProgress: () => {},
    });
    expect(out).toBeNull();
    expect(called).toBe(false);
  });

  it('有共识项时调用 applyFix 并返回总结', async () => {
    const tracked = initTracked([f], []);
    tracked[0].state = 'consensus';
    const prompts: string[] = [];
    const out = await applyConsensus({
      consensus: tracked,
      applyFix: async (p) => { prompts.push(p); return '改好了'; },
      onProgress: () => {},
    });
    expect(out).toBe('改好了');
    expect(prompts[0]).toContain('cx-1');
    expect(prompts[0]).toContain('不要做任何列表之外的修改');
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm vitest run tests/initialReviews.test.ts tests/apply.test.ts`
Expected: FAIL —— 找不到 `runInitialReviews` 导出 / `../src/apply.js` 模块

- [ ] **Step 4: 在 src/orchestrator.ts 末尾追加 runInitialReviews**

```ts
export interface InitialReviewDeps {
  codex: Reviewer;
  claude: Reviewer;
  prompt: string;
  onProgress: (message: string) => void;
  onOutput?: (reviewer: ReviewerName, raw: string) => void;
}

async function startWithRetry(reviewer: Reviewer, prompt: string): Promise<{ raw: string; findings: Finding[] }> {
  const first = await reviewer.start(prompt);
  try {
    return { raw: first, findings: parseReviewOutput(first).findings };
  } catch (e) {
    const second = await reviewer.reply(buildRetryPrompt((e as Error).message));
    try {
      return { raw: second, findings: parseReviewOutput(second).findings };
    } catch (e2) {
      throw new Error(`${reviewer.name} 的初始评审输出重试后仍无法解析: ${(e2 as Error).message}`);
    }
  }
}

export async function runInitialReviews(deps: InitialReviewDeps): Promise<{
  codexFindings: Finding[];
  claudeFindings: Finding[];
}> {
  deps.onProgress('并行启动 codex 与 claude 初始评审…');
  const [cx, cl] = await Promise.all([
    startWithRetry(deps.codex, deps.prompt),
    startWithRetry(deps.claude, deps.prompt),
  ]);
  deps.onOutput?.('codex', cx.raw);
  deps.onOutput?.('claude', cl.raw);
  deps.onProgress(`初始评审完成：codex ${cx.findings.length} 条，claude ${cl.findings.length} 条`);
  return { codexFindings: cx.findings, claudeFindings: cl.findings };
}
```

同时在文件顶部 import 中补充 `parseReviewOutput`（来自 `./parse.js`）。

- [ ] **Step 5: 实现 src/apply.ts**

```ts
import { buildApplyPrompt } from './prompts.js';
import type { TrackedFinding } from './types.js';

export interface ApplyDeps {
  consensus: TrackedFinding[];
  /** 由 ClaudeReviewer.applyFix 绑定而来 */
  applyFix: (prompt: string) => Promise<string>;
  onProgress: (message: string) => void;
}

export async function applyConsensus(deps: ApplyDeps): Promise<string | null> {
  if (deps.consensus.length === 0) {
    deps.onProgress('没有达成共识的修改项，跳过应用阶段');
    return null;
  }
  deps.onProgress(`应用 ${deps.consensus.length} 条共识修改（由 claude 执行）…`);
  return deps.applyFix(buildApplyPrompt(deps.consensus));
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm vitest run tests/initialReviews.test.ts tests/apply.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/orchestrator.ts src/apply.ts tests/initialReviews.test.ts tests/apply.test.ts
git commit -m "feat: 初始评审（带重试）与共识应用阶段"
```

---

### Task 12: 主流程接线与端到端集成测试（main.ts / cli.ts）

**Files:**
- Create: `src/main.ts`
- Modify: `src/cli.ts`（替换 Task 1 的占位）
- Test: `tests/e2e.test.ts`

`main()` 放在独立模块并接受注入的 `env`/`log`，cli.ts 只做参数解析——这样集成测试可以直接调 `main()` 配假 CLI 的 PATH。

- [ ] **Step 1: 写失败测试 tests/e2e.test.ts**

```ts
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../src/main.js';
import { makeFakeScenario } from './helpers/fakeCli.js';
import { makeTmpRepo } from './helpers/tmpRepo.js';

const review = (id: string) =>
  JSON.stringify({ findings: [{ id, file: 'a.txt', line: 1, severity: 'major', title: 'T' + id, description: 'D', suggestion: 'S' }] });
const agree = (...ids: string[]) =>
  JSON.stringify({ responses: ids.map((findingId) => ({ findingId, stance: 'agree', comment: 'ok', revisedSuggestion: null })) });

describe('duet-review 端到端（假 CLI）', () => {
  it('完整流程：初始评审 → 一轮讨论收敛 → 应用 → 存档', async () => {
    const repo = makeTmpRepo();
    repo.write('a.txt', 'line1\nline2\n'); // unstaged 变更
    const scenario = makeFakeScenario();
    scenario.setReply('codex', 1, review('1'));
    scenario.setReply('claude', 1, review('1'));
    scenario.setReply('codex', 2, agree('cx-1', 'cl-1'));
    scenario.setReply('claude', 2, agree('cx-1', 'cl-1'));
    scenario.setReply('claude', 3, '已应用 2 处修改');

    const logs: string[] = [];
    const code = await main({
      cwd: repo.dir, maxRounds: 3, timeoutMs: 30_000,
      env: scenario.env, log: (m) => logs.push(m),
    });

    expect(code).toBe(0);

    // 存档完整
    const runs = readdirSync(join(repo.dir, '.duet-review'));
    expect(runs).toHaveLength(1);
    const dir = join(repo.dir, '.duet-review', runs[0]);
    for (const f of ['00-diff.patch', '01-codex-review.json', '01-claude-review.json',
      '02-codex-round.json', '02-claude-round.json', 'consensus.json', 'report.md']) {
      expect(existsSync(join(dir, f)), `缺少 ${f}`).toBe(true);
    }

    // codex 第二次调用走了 resume
    expect(scenario.calls('codex')[1].argv.slice(0, 3)).toEqual(['exec', 'resume', 'fake-codex-session-1']);

    // claude 第三次调用是写权限的应用阶段
    const apply = scenario.calls('claude')[2];
    expect(apply.argv).toContain('acceptEdits');
    expect(apply.stdin).toContain('不要做任何列表之外的修改');

    // 报告与终端摘要
    const report = readFileSync(join(dir, 'report.md'), 'utf8');
    expect(report).toContain('cx-1');
    expect(report).toContain('已应用 2 处修改');
    expect(logs.some((l) => l.includes('共识 2 条已应用'))).toBe(true);
  });

  it('无变更时友好退出（退出码 0，不调用任何 CLI 评审）', async () => {
    const repo = makeTmpRepo();
    const scenario = makeFakeScenario();
    const logs: string[] = [];
    const code = await main({ cwd: repo.dir, maxRounds: 3, timeoutMs: 30_000, env: scenario.env, log: (m) => logs.push(m) });
    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('没有可审查的变更');
    expect(scenario.calls('codex')).toHaveLength(0);
  });

  it('双方都无 finding 时跳过讨论与应用', async () => {
    const repo = makeTmpRepo();
    repo.write('a.txt', 'line1\nline2\n');
    const scenario = makeFakeScenario();
    scenario.setReply('codex', 1, JSON.stringify({ findings: [] }));
    scenario.setReply('claude', 1, JSON.stringify({ findings: [] }));
    const logs: string[] = [];
    const code = await main({ cwd: repo.dir, maxRounds: 3, timeoutMs: 30_000, env: scenario.env, log: (m) => logs.push(m) });
    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('双方都没有发现问题');
    expect(scenario.calls('claude')).toHaveLength(1); // 只有初始评审
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/e2e.test.ts`
Expected: FAIL —— `Cannot find module '../src/main.js'`

- [ ] **Step 3: 实现 src/main.ts**

```ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyConsensus } from './apply.js';
import { NoDiffError, collectDiff, ensureGitRepo } from './git.js';
import { initTracked, runDiscussion, runInitialReviews } from './orchestrator.js';
import { buildInitialReviewPrompt, codexDiscussionSchema, codexReviewSchema } from './prompts.js';
import { Archive, renderReport } from './report.js';
import { ClaudeReviewer } from './reviewers/claude.js';
import { CodexReviewer } from './reviewers/codex.js';
import { runCli } from './utils/proc.js';

export interface MainOptions {
  cwd: string;
  maxRounds: number;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}

async function ensureCli(cmd: string, env: NodeJS.ProcessEnv | undefined): Promise<void> {
  let failure: string | null = null;
  try {
    const res = await runCli(cmd, ['--version'], { env, timeoutMs: 30_000 });
    if (res.code !== 0) failure = res.stderr.trim();
  } catch (e) {
    failure = (e as Error).message;
  }
  if (failure !== null) throw new Error(`未找到可用的 ${cmd} CLI，请先安装并登录（${failure}）`);
}

export async function main(options: MainOptions): Promise<number> {
  const log = options.log ?? ((m: string) => console.log(m));
  const { cwd, env } = options;

  await Promise.all([ensureCli('codex', env), ensureCli('claude', env)]);
  await ensureGitRepo(cwd);

  let diff;
  try {
    diff = await collectDiff(cwd);
  } catch (e) {
    if (e instanceof NoDiffError) {
      log(e.message);
      return 0;
    }
    throw e;
  }
  log(`审查对象: ${diff.source} diff（${diff.patch.split('\n').length} 行）`);

  const archive = new Archive(cwd);
  archive.write('00-diff.patch', diff.patch);
  const reviewSchemaFile = join(archive.dir, 'codex-review-schema.json');
  const discussionSchemaFile = join(archive.dir, 'codex-discussion-schema.json');
  writeFileSync(reviewSchemaFile, JSON.stringify(codexReviewSchema, null, 2));
  writeFileSync(discussionSchemaFile, JSON.stringify(codexDiscussionSchema, null, 2));

  const codex = new CodexReviewer({ cwd, timeoutMs: options.timeoutMs, reviewSchemaFile, discussionSchemaFile, env });
  const claude = new ClaudeReviewer({ cwd, timeoutMs: options.timeoutMs, env });

  const initial = await runInitialReviews({
    codex, claude,
    prompt: buildInitialReviewPrompt(diff.patch, diff.source),
    onProgress: log,
    onOutput: (reviewer, raw) => archive.write(`01-${reviewer}-review.json`, raw),
  });

  const tracked = initTracked(initial.codexFindings, initial.claudeFindings);
  if (tracked.length === 0) {
    log('双方都没有发现问题 🎉');
    archive.write('report.md', renderReport({ source: diff.source, rounds: 0, tracked, applySummary: null }));
    return 0;
  }

  const { rounds } = await runDiscussion({
    codex, claude, tracked,
    maxRounds: options.maxRounds,
    onProgress: log,
    onRoundOutput: (round, reviewer, raw) =>
      archive.write(`${String(round + 1).padStart(2, '0')}-${reviewer}-round.json`, raw),
  });

  const consensus = tracked.filter((t) => t.state === 'consensus');
  const disputed = tracked.filter((t) => t.state === 'disputed');

  const applySummary = await applyConsensus({
    consensus,
    applyFix: (prompt) => claude.applyFix(prompt),
    onProgress: log,
  });

  archive.write('consensus.json', JSON.stringify(tracked, null, 2));
  archive.write('report.md', renderReport({ source: diff.source, rounds, tracked, applySummary }));

  log('');
  log(`完成：共识 ${consensus.length} 条已应用，分歧 ${disputed.length} 条待人工裁决`);
  for (const t of disputed) log(`  ⚠ ${t.finding.id} ${t.finding.title}（${t.finding.file}）`);
  log(`完整记录: ${archive.dir}`);

  const gitignorePath = join(cwd, '.gitignore');
  const ignored = existsSync(gitignorePath) && readFileSync(gitignorePath, 'utf8').includes('.duet-review');
  if (!ignored) log('提示: 建议把 .duet-review/ 加入 .gitignore');

  return 0;
}
```

- [ ] **Step 4: 改写 src/cli.ts**

```ts
#!/usr/bin/env node
import { Command } from 'commander';
import { main } from './main.js';

const program = new Command();
program
  .name('duet-review')
  .description('codex × claude 双评审：并行 review、多轮讨论、自动应用共识修改')
  .option('--max-rounds <n>', '讨论轮数上限', '3')
  .option('--timeout <minutes>', '单次 CLI 调用超时（分钟）', '10')
  .parse();

const opts = program.opts<{ maxRounds: string; timeout: string }>();
const maxRounds = Number(opts.maxRounds);
const timeoutMinutes = Number(opts.timeout);

if (!Number.isInteger(maxRounds) || maxRounds < 1) {
  console.error('✖ --max-rounds 必须是 ≥1 的整数');
  process.exit(1);
}
if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
  console.error('✖ --timeout 必须是正数（分钟）');
  process.exit(1);
}

main({ cwd: process.cwd(), maxRounds, timeoutMs: timeoutMinutes * 60_000 }).then(
  (code) => process.exit(code),
  (err) => {
    console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
```

- [ ] **Step 5: 运行集成测试确认通过**

Run: `pnpm vitest run tests/e2e.test.ts`
Expected: PASS（3 个用例全绿）

- [ ] **Step 6: 运行全部测试与构建防回归**

Run: `pnpm test && pnpm build && node dist/cli.js --help`
Expected: 测试全绿；构建成功；打印帮助文本（含 --max-rounds 与 --timeout）

- [ ] **Step 7: Commit**

```bash
git add src/main.ts src/cli.ts tests/e2e.test.ts
git commit -m "feat: 主流程接线、CLI 入口与端到端集成测试"
```

---

### Task 13: 真实 CLI 冒烟测试、README 与全局安装

**Files:**
- Create: `scripts/smoke.sh`, `README.md`

- [ ] **Step 1: 写 scripts/smoke.sh**

```bash
#!/usr/bin/env bash
# 真实 CLI 冒烟测试：消耗真实 token，仅手动运行。
# 在临时仓库制造明显 bug，跑完整 duet-review 流程。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
pnpm -C "$ROOT" build

TMP=$(mktemp -d)
cd "$TMP"
git init -b main -q
git config user.email smoke@example.com
git config user.name smoke

cat > calc.js <<'EOF'
function divide(a, b) {
  return a / b;
}
module.exports = { divide };
EOF
git add . && git commit -qm init

cat > calc.js <<'EOF'
function divide(a, b) {
  return a / b;
}
function parseAmount(s) {
  return parseInt(s);
}
module.exports = { divide, parseAmount };
EOF

node "$ROOT/dist/cli.js" --max-rounds 2

echo '=== 应用后的 calc.js ==='
cat calc.js
echo '=== 存档目录 ==='
ls .duet-review/*/
```

- [ ] **Step 2: 手动运行冒烟测试**

Run: `chmod +x scripts/smoke.sh && ./scripts/smoke.sh`
Expected: 全流程跑通——双方给出 findings（除零、parseInt 缺 radix 之类）、讨论收敛、claude 应用共识修改、存档目录含全部文件。

**已知风险与应对（执行者注意）：**
- 若真实 codex 的 `exec resume` 不接受 `--output-schema`（报 unknown argument）：把 `CodexReviewer.reply()` 中的 `'--output-schema', this.opts.discussionSchemaFile` 两个参数移除，仅靠 prompt 中的 JSON 约束 + parse.ts 容错解析；同步更新 `tests/codex.test.ts` 中对 resume argv 的断言。
- 若真实 codex 的 JSONL 事件结构与 `parseCodexJsonl` 的两种形态都不匹配：把冒烟运行时的原始 stdout 存下来（临时在 exec() 里 `console.error(res.stdout)`），按真实事件形态扩展 `parseCodexJsonl`（保持已有测试通过，新增一个真实形态的用例）。
- 若真实 claude `--allowedTools` 多值传参不生效（工具被拒）：改为单参数逗号分隔 `--allowedTools Read,Grep,Glob` 并更新断言。

- [ ] **Step 3: 写 README.md**

```markdown
# duet-review

codex × claude 双评审 CLI：并行调用两个编码代理审查你的 git diff，
让它们多轮讨论收敛，最后由 claude 把达成共识的修改直接应用到工作区。

## 前置条件

- Node.js ≥ 20
- 已安装并登录 [codex CLI](https://github.com/openai/codex) 与 [Claude Code](https://claude.com/claude-code)

## 安装

\`\`\`bash
pnpm install && pnpm build && pnpm link --global
\`\`\`

## 使用

在任意 git 仓库中（有 staged 变更时只审 staged，否则审 unstaged）：

\`\`\`bash
duet-review                 # 默认最多 3 轮讨论，单次调用超时 10 分钟
duet-review --max-rounds 5 --timeout 20
\`\`\`

## 工作流程

1. 收集 diff（staged 优先）
2. codex 与 claude 并行初始评审（均为只读模式）
3. 多轮互评：对每条 finding 表态 agree / disagree / modify / withdraw，
   程序化判定共识，全部收敛或达到轮数上限即停止
4. claude 续接评审会话，把共识修改应用到工作区（仅此阶段有写权限）
5. 分歧项不改代码，在终端列出供人工裁决

## 产物

每次运行在 `.duet-review/<时间戳>/` 留下完整记录：
diff、双方每轮原始输出、共识状态（consensus.json）、人类可读报告（report.md）。
建议把 `.duet-review/` 加入 `.gitignore`。
```

- [ ] **Step 4: 验证全局安装**

Run: `pnpm link --global && cd $(mktemp -d) && duet-review --help && git init -q . && duet-review; cd -`
Expected: `--help` 正常；在空仓库中运行提示「没有可审查的变更」退出码 0

- [ ] **Step 5: 最终回归**

Run: `pnpm test && pnpm build`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add scripts/smoke.sh README.md
git commit -m "docs: README 与真实 CLI 冒烟测试脚本"
```

---

## 完成定义

- `pnpm test` 全绿（单元 + 集成）。
- `./scripts/smoke.sh` 真实跑通一次（消耗 token，手动执行）。
- `duet-review` 全局可用，在无变更仓库友好退出。
- 设计文档第 2 节的全部决策均已落实：staged 优先、互评多轮、程序化共识、claude 应用共识项、会话续接不降级、只读/写权限分离。
