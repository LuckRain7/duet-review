# duet-review

English | [简体中文](README.zh-CN.md)

A dual-agent code review CLI that pits **Codex** against **Claude Code**: both agents review your git diff in parallel, debate each other's findings over multiple rounds until they converge, and then Claude applies the agreed-upon fixes directly to your working tree.

## How it works

1. **Collect the diff** — staged changes take priority; falls back to unstaged if nothing is staged (untracked files are excluded).
2. **Parallel initial review** — Codex (`codex exec`) and Claude Code (`claude -p`) each review the diff independently, both in read-only mode.
3. **Multi-round discussion** — each agent responds to the other's findings with `agree` / `disagree` / `modify` / `withdraw`. Consensus is determined programmatically:
   - both agree → **consensus**
   - revised suggestion (`modify`) resets the other side to pending, so it must re-vote on the new version
   - still open after the round limit → **disputed**, left for human judgment
4. **Apply fixes** — Claude resumes its review session and applies consensus fixes to the working tree. Write permission is granted **only** in this phase; review and discussion run read-only throughout.
5. **Report** — disputed findings are listed in the terminal without touching the code, and a full archive is written to disk.

## Prerequisites

- Node.js ≥ 20
- [codex CLI](https://github.com/openai/codex) and [Claude Code](https://claude.com/claude-code) installed and logged in

## Installation

```bash
pnpm install && pnpm build && pnpm link --global
```

## Usage

Run inside any git repository:

```bash
duet-review                          # defaults: up to 3 discussion rounds, 10-minute timeout per CLI call
duet-review --max-rounds 5 --timeout 20
duet-review --base origin/main         # review the commit range origin/main...HEAD (PR-style)
```

| Option | Description | Default |
| --- | --- | --- |
| `--max-rounds <n>` | Maximum number of discussion rounds | `3` |
| `--timeout <minutes>` | Timeout per CLI invocation, in minutes | `10` |
| `--base <ref>` | Review the commit range `<ref>...HEAD` (merge-base to HEAD) instead of staged/unstaged changes | — |

> Note: terminal output (progress, reports, error messages) is currently in Chinese.

## Artifacts

Each run leaves a complete record under `.duet-review/<timestamp>/`:

- `00-diff.patch` — the diff under review
- `01-*-review.json` / `NN-*-round.json` — raw output from both agents, per round
- `consensus.json` — final state of every finding
- `report.md` — human-readable report

Add `.duet-review/` to your `.gitignore` (the CLI reminds you if it's missing).

## Development

```bash
pnpm test          # unit + integration tests (fake CLIs, no tokens consumed)
pnpm dev           # run src/cli.ts directly via tsx
./scripts/smoke.sh # smoke test against the real CLIs (consumes real tokens)
```

Tests never call the real CLIs: fake `codex` / `claude` executables under `tests/fakes/bin/` are prepended to `PATH`, with replies pre-seeded per scenario.
