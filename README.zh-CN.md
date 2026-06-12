# duet-review

[English](README.md) | 简体中文

codex × claude 双评审 CLI：并行调用两个编码代理（**Codex** 与 **Claude Code**）审查你的 git diff，让它们多轮讨论、互相辩论直至收敛，最后由 Claude 把达成共识的修改直接应用到工作区。

## 工作流程

1. **收集 diff** —— staged 变更优先，为空才取 unstaged（不含 untracked 文件）。
2. **并行初始评审** —— Codex（`codex exec`）与 Claude Code（`claude -p`）各自独立审查 diff，均为只读模式。
3. **多轮讨论** —— 双方对彼此的 finding 表态 `agree` / `disagree` / `modify` / `withdraw`，由程序判定共识：
   - 双方都 agree → **达成共识**
   - `modify` 给出修订建议后，对方重置为 pending，需对新版本重新表态
   - 达到轮数上限仍未收敛 → **存为分歧**，留给人工裁决
4. **应用修复** —— Claude 续接评审会话，把共识修改应用到工作区。**仅此阶段有写权限**，评审与讨论全程只读。
5. **输出报告** —— 分歧项不改代码，在终端列出，完整记录存档到磁盘。

## 前置条件

- Node.js ≥ 20
- 已安装并登录 [codex CLI](https://github.com/openai/codex) 与 [Claude Code](https://claude.com/claude-code)

## 安装

```bash
pnpm install && pnpm build && pnpm link --global
```

## 使用

在任意 git 仓库中运行：

```bash
duet-review                          # 默认最多 3 轮讨论，单次 CLI 调用超时 10 分钟
duet-review --max-rounds 5 --timeout 20
```

| 选项 | 说明 | 默认值 |
| --- | --- | --- |
| `--max-rounds <n>` | 讨论轮数上限 | `3` |
| `--timeout <minutes>` | 单次 CLI 调用超时（分钟） | `10` |

## 产物

每次运行在 `.duet-review/<时间戳>/` 留下完整记录：

- `00-diff.patch` —— 本次审查的 diff
- `01-*-review.json` / `NN-*-round.json` —— 双方每轮的原始输出
- `consensus.json` —— 每条 finding 的最终状态
- `report.md` —— 人类可读报告

建议把 `.duet-review/` 加入 `.gitignore`（缺失时 CLI 会提示）。

## 开发

```bash
pnpm test          # 单元 + 集成测试（用假 CLI，不耗 token）
pnpm dev           # 通过 tsx 直接运行 src/cli.ts
./scripts/smoke.sh # 真实 CLI 冒烟测试（消耗真实 token）
```

测试不会调用真实 CLI：`tests/fakes/bin/` 下的假 `codex` / `claude` 可执行文件会被前置到 `PATH`，按场景预置回复。
