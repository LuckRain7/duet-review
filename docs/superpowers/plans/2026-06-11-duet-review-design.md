# duet-review 设计文档

日期：2026-06-11
状态：已确认

## 1. 目标

一个全局安装的命令行工具 `duet-review`，在任意 git 项目中运行。它并行调用 `codex` 和 `claude` 两个 CLI 对当前代码变更做 code review，然后让两者就各自的发现进行多轮讨论，最终由 claude 把双方达成共识的修改直接应用到工作区，分歧项列出供用户裁决。

## 2. 已确认的决策

| 决策点 | 结论 |
|---|---|
| Review 对象 | 有 staged 变更时只审 staged（`git diff --cached`）；否则审 unstaged（`git diff`）。不含 untracked 文件（后续可扩展） |
| 讨论机制 | 互评多轮，达成共识或到轮数上限（默认 3 轮，`--max-rounds` 可调） |
| 输出形式 | 直接修改代码：共识项由 claude 应用到工作区；分歧项不改代码，仅在终端列出 |
| 修改执行者 | claude CLI（resume 评审会话，授予写权限） |
| 多轮上下文 | 会话续接：codex 用 `codex exec resume <id>`，claude 用 `--resume <id>`；resume 失败直接报错，不降级 |
| 技术栈 | Node.js + TypeScript，发布为可全局安装的 CLI（pnpm/npm） |

## 3. 整体流程

```
收集 diff（优先 staged，否则 unstaged）
        │
        ├─ 并行 ─→ codex 初始 review（read-only 沙箱）
        └─ 并行 ─→ claude 初始 review（只读工具）
        │
        ▼
讨论轮（最多 N 轮，默认 3）
   每轮：把对方对各 finding 的最新立场发给各自会话
   双方对每条 finding 标注 agree / disagree / modify / withdraw
   orchestrator 程序化判断收敛：全部 finding 立场一致 → 提前结束
        │
        ▼
应用阶段：claude resume 同一会话
   permission-mode=acceptEdits + Edit/Write 工具
   只应用「共识 finding」；分歧项终端列出
        │
        ▼
终端摘要 + 完整过程存档到 .duet-review/<时间戳>/
```

## 4. 关键机制

### 4.1 结构化 findings

双方按统一 JSON schema 输出问题列表：

```jsonc
{
  "findings": [
    {
      "id": "string",          // 稳定标识，跨轮引用
      "file": "string",
      "line": 0,               // 可为 null
      "severity": "critical | major | minor | nit",
      "title": "string",
      "description": "string",
      "suggestion": "string"   // 具体修改建议，含代码片段
    }
  ]
}
```

讨论轮中对对方 finding 的回应 schema：

```jsonc
{
  "responses": [
    {
      "findingId": "string",
      "stance": "agree | disagree | modify | withdraw",
      "comment": "string",
      "revisedSuggestion": "string | null"  // stance=modify 时给出
    }
  ]
}
```

- codex 侧用 `codex exec --output-schema <file>` 强约束输出。
- claude 侧用 prompt 约束 + 输出解析；解析失败带错误信息重试一次。
- 共识判断由 orchestrator 程序化完成（不再请模型当裁判）：一条 finding 达成共识 = 提出方维持（或 modify 后维持）且对方 stance 为 agree；双方 withdraw 视为撤销；轮数耗尽仍 disagree 的为分歧项。

### 4.2 会话续接

- codex：首轮 `codex exec --json ...`，从 JSONL 事件流解析 session id 与最终消息（辅以 `-o/--output-last-message`）；后续轮 `codex exec resume <session_id> --json ...`。
- claude：首轮 `claude -p --output-format json ...`，从结果 JSON 取 `session_id` 与 `result`；后续轮 `claude -p --resume <session_id> --output-format json ...`。
- 每轮只发送对方的最新立场，token 成本不随历史线性增长。
- resume 失败（会话过期、CLI 报错）→ 明确报错并终止，不做重发全量上下文的降级。

### 4.3 安全边界

- Review/讨论阶段一律只读：codex 用 `-s read-only`；claude 用 `--allowedTools "Read Grep Glob"`。
- 仅应用阶段的 claude 获得写权限：`--permission-mode acceptEdits --allowedTools "Read Grep Glob Edit Write"`。
- 应用阶段提示词明确限定：只实施共识 findings 列表中的修改，不做其他改动。

## 5. 模块划分

```
src/
  cli.ts              # 入口；参数解析（--max-rounds, --timeout）
  git.ts              # 仓库检测；staged/unstaged diff 收集
  reviewers/
    types.ts          # Reviewer 接口与 findings/responses 类型
    codex.ts          # codex 封装：spawn、JSONL 解析、session 管理
    claude.ts         # claude 封装：spawn、JSON 解析、session 管理
  orchestrator.ts     # 轮次控制、立场合并、共识判断
  apply.ts            # 调 claude 应用共识修改
  report.ts           # 终端实时进度 + .duet-review/ 存档
```

`Reviewer` 统一接口：

```ts
interface Reviewer {
  readonly name: 'codex' | 'claude';
  start(prompt: string): Promise<string>;   // 首轮，建立会话，返回原始输出
  reply(prompt: string): Promise<string>;   // 后续轮，resume 会话
}
```

## 6. CLI 参数

```
duet-review [options]
  --max-rounds <n>   讨论轮数上限，默认 3
  --timeout <min>    单次 CLI 调用超时（分钟），默认 10
```

YAGNI：不做 --base、--fix 开关、模型选择等，后续按需加。

## 7. 输出与存档

- 终端：实时打印阶段进度（初始 review 摘要、每轮双方立场变化、共识/分歧统计、应用结果）。
- 存档目录 `.duet-review/<ISO 时间戳>/`：
  - `00-diff.patch` — 本次审查的 diff
  - `01-codex-review.json` / `01-claude-review.json` — 初始 findings
  - `0N-codex-round.json` / `0N-claude-round.json` — 每轮回应
  - `consensus.json` — 最终共识与分歧
  - `report.md` — 人类可读完整报告
- 建议用户将 `.duet-review/` 加入 `.gitignore`（工具首次运行时提示）。

## 8. 错误处理

| 场景 | 行为 |
|---|---|
| 非 git 仓库 | 报错退出 |
| 无 diff（staged 与 unstaged 均空） | 友好提示退出 |
| codex/claude 不在 PATH | 启动时检测，报错退出 |
| CLI 调用超时（默认 10 分钟） | 终止子进程，报错退出 |
| 输出 JSON 解析失败 | 带解析错误重试一次，再失败则报错退出 |
| resume 失败 | 报错退出（不降级） |
| 应用阶段 claude 失败 | 报错退出；已存档的 consensus.json 可供手动处理 |

## 9. 测试策略

- 框架：vitest。
- 单元测试：git diff 收集逻辑、findings/responses 解析、共识判断（agree/disagree/modify/withdraw 各组合、提前收敛、轮数耗尽）。
- 集成测试：用假的 `codex` / `claude` 可执行脚本（测试时注入 PATH）模拟完整多轮对话与应用阶段，不消耗真实 token。
