# 设计：运行时自动写入 .gitignore 与产物清理提示

日期：2026-06-11

## 背景

duet-review 在目标仓库生成 `.duet-review/<时间戳>/` 产物目录。当前实现（`src/main.ts:134-136`）仅在运行结束时检查目标仓库的 .gitignore 并打印一条"建议加入 .gitignore"的提示，需要用户手动处理；运行结束后也没有任何清理产物的引导。

## 目标

1. 运行开始时自动确保目标仓库的 .gitignore 包含 `.duet-review/`，无需用户手动添加。
2. 运行正常结束后输出一条删除**本次**产物目录的命令，方便用户按需清理（仅提示，不执行）。

## 非目标

- 不删除任何文件，只输出命令供用户自行执行。
- 不清理历史评审存档（删除范围仅限本次时间戳目录）。
- 中断/失败路径不输出删除命令，保持现有"已生成的部分存档"提示。

## 设计

### 1. `src/git.ts` 新增 `ensureDuetReviewIgnored(repoRoot: string): boolean`

行为（同步实现，使用 node:fs）：

- `.gitignore` 不存在 → 创建文件，内容为 `.duet-review/\n`，返回 `true`。
- 存在但没有任何一行包含 `.duet-review` → 追加一行 `.duet-review/`（若原文件末尾无换行先补齐），返回 `true`。
- 已有某行包含 `.duet-review` → 不修改文件，返回 `false`。

返回值语义：`true` 表示本次写入了 .gitignore，调用方据此打日志。

### 2. main.ts 接入

- 在 `ensureGitRepo(cwd)` 之后、创建 `Archive` 之前调用 `ensureDuetReviewIgnored(cwd)`；返回 `true` 时打日志 `已将 .duet-review/ 加入 .gitignore`。
- 时机选择"运行开始时"：即使评审中途失败，产物目录也不会被 git 误提交。
- 删除现有结尾处的检查与提示逻辑（`src/main.ts:134-136`）。

### 3. 结束时输出删除命令

所有正常完成路径都打印：

```
如需删除本次产物: rm -rf '.duet-review/<时间戳>/'
```

路径取自 `archive.dir` 转为相对 `cwd` 的形式。覆盖的路径：

- 主流程完成（现有"完整记录: …"日志之后）。
- "双方都没有发现问题"的早退路径（该路径同样生成了存档）。

无 diff 早退路径（`NoDiffError`）不涉及——此时尚未创建 Archive。

### 4. 测试

- 单测（新文件 `tests/gitignore.test.ts` 或并入现有 git 相关测试）：覆盖 `ensureDuetReviewIgnored` 三种分支——新建文件、追加（含末尾无换行的文件）、已存在不重复写。
- e2e（`tests/e2e.test.ts` 现有用例上断言）：运行后目标仓库 .gitignore 包含 `.duet-review/`；日志中含 `如需删除本次产物` 与本次时间戳目录路径。

## 错误处理

- .gitignore 写入失败（如只读文件系统）按现有风格抛出，错误信息为中文。不做静默吞错：写不进去意味着产物会污染 git 状态，应让用户知道。

## 用户可见文案（中文，与现有风格一致）

- `已将 .duet-review/ 加入 .gitignore`
- `如需删除本次产物: rm -rf '<相对路径>'`
