# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

duet-review：codex × claude 双评审 CLI。并行调用两个编码代理（codex CLI 与 Claude Code CLI）审查 git diff，多轮讨论收敛立场，最后由 claude 把达成共识的修改应用到工作区。ESM 项目（`"type": "module"`），源码 import 必须带 `.js` 后缀（如 `from './parse.js'`）。

## 常用命令

```bash
pnpm build                       # tsc 编译到 dist/
pnpm test                        # vitest 全量测试（用假 CLI，不耗 token）
pnpm vitest run tests/parse.test.ts   # 跑单个测试文件
pnpm vitest run -t "测试名"            # 按名称过滤测试
pnpm dev                         # tsx 直接运行 src/cli.ts
./scripts/smoke.sh               # 真实 CLI 冒烟测试（消耗真实 token，仅手动运行）
```

无 lint 配置。测试超时为 30s（vitest.config.ts）。

## 架构

主流程在 `src/main.ts`：校验 CLI 可用 → `git.ts` 收集 diff（**staged 优先，为空才取 unstaged，不含 untracked**）→ `orchestrator.ts` 并行初评 → 多轮讨论 → `apply.ts` 应用共识 → `report.ts` 存档到 `.duet-review/<时间戳>/`。

### Reviewer 抽象（src/types.ts + src/reviewers/）

`Reviewer` 接口只有 `start(prompt)` / `reply(prompt)`，两个实现都通过 `utils/proc.ts` 的 `runCli` 以子进程方式调用真实 CLI，并维护 session id 以续接会话：

- **CodexReviewer**：`codex exec --json -s read-only --output-schema <file> -`，输出是 JSONL 事件流，`parseCodexJsonl` 递归找会话 id 并取最后一条 agent_message。schema 文件由 main.ts 写入存档目录后传入。
- **ClaudeReviewer**：`claude -p --output-format json --allowedTools Read Grep Glob`，用 `--resume <session_id>` 续接。额外有 `applyFix()`：续接同一会话但授予 Edit/Write 权限（`--permission-mode acceptEdits`）——**只有应用阶段有写权限**，评审/讨论阶段全程只读。

### 讨论收敛状态机（src/orchestrator.ts）

核心数据结构是 `TrackedFinding`（types.ts）：每条 finding 带 `codexStance`/`claudeStance` 和 `state`（open/consensus/dropped/disputed）。finding id 加 `cx-`/`cl-` 前缀防止双方撞 id。`applyResponses` 的规则：

- 双方都 `agree` → consensus
- `withdraw` 仅作者本人有效，他人 withdraw 降级为 disagree
- `modify` 带 revisedSuggestion → 更新 suggestion，修订者置 agree，**对方重置为 pending 需对新版本重新表态**；同轮双方都 modify 时 last-write-wins（claude 后应用）
- 达到 maxRounds 仍 open → disputed，不改代码，留给人工裁决

### 输出解析（src/parse.ts）

`extractJson` 用括号配平从模型自由文本里提取 JSON（只认 ` ```json ` 标记的代码块，避免误抓 suggestion 内嵌代码）。`normalizeFinding` 补全缺失的 id/title、把 "warning"/"error" 等非标准 severity 映射到标准值；未知 severity 故意不降级，留给 zod 拒绝。解析失败用 `buildRetryPrompt` 重试一次，再失败抛硬错误。

### 测试架构（tests/）

单元/集成测试不调真实 CLI：`tests/fakes/bin/` 下有假的 `codex` 和 `claude` 可执行文件，`tests/helpers/fakeCli.ts` 把它们前置到 PATH 并通过 `DUET_FAKE_DIR` 指向场景目录——用 `setReply(cli, n, content)` 预置第 n 次调用的回复，用 `calls(cli)` 断言实际调用的 argv/stdin。`tests/helpers/tmpRepo.ts` 创建临时 git 仓库。e2e 测试直接跑 `main()` 全流程。

## 其他

- 设计文档与实现计划在 `docs/superpowers/plans/`。
- `.duet-review/` 是运行产物目录，已在 .gitignore 中，不要提交。
- 用户可见文案（错误信息、进度日志、注释）均为中文，保持一致。
