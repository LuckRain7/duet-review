# duet-review

codex × claude 双评审 CLI：并行调用两个编码代理审查你的 git diff，
让它们多轮讨论收敛，最后由 claude 把达成共识的修改直接应用到工作区。

## 前置条件

- Node.js ≥ 20
- 已安装并登录 [codex CLI](https://github.com/openai/codex) 与 [Claude Code](https://claude.com/claude-code)

## 安装

```bash
pnpm install && pnpm build && pnpm link --global
```

## 使用

在任意 git 仓库中（有 staged 变更时只审 staged，否则审 unstaged）：

```bash
duet-review                 # 默认最多 3 轮讨论，单次调用超时 10 分钟
duet-review --max-rounds 5 --timeout 20
```

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

## 开发

```bash
pnpm test          # 单元 + 集成测试（假 CLI，不耗 token）
./scripts/smoke.sh # 真实 CLI 冒烟测试（消耗 token）
```
