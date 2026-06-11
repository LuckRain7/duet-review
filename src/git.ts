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
  files: string[];
}

export async function ensureGitRepo(cwd: string): Promise<void> {
  const res = await runCli('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
  if (res.code !== 0) throw new Error(`当前目录不是 git 仓库: ${cwd}`);
}

/** 设计约定：优先 staged（git diff --cached），为空才取 unstaged（git diff），不含 untracked */
export async function collectDiff(cwd: string): Promise<DiffResult> {
  const staged = await runCli('git', ['diff', '--cached'], { cwd });
  if (staged.code !== 0) throw new Error(`git diff --cached 失败: ${staged.stderr}`);
  if (staged.stdout.trim() !== '') {
    return { source: 'staged', patch: staged.stdout, files: await listFiles(cwd, ['--cached']) };
  }

  const unstaged = await runCli('git', ['diff'], { cwd });
  if (unstaged.code !== 0) throw new Error(`git diff 失败: ${unstaged.stderr}`);
  if (unstaged.stdout.trim() !== '') {
    return { source: 'unstaged', patch: unstaged.stdout, files: await listFiles(cwd, []) };
  }

  throw new NoDiffError();
}

async function listFiles(cwd: string, extraArgs: string[]): Promise<string[]> {
  // core.quotepath 默认会把非 ASCII 文件名转义成带引号的八进制串，显式关闭
  const res = await runCli('git', ['-c', 'core.quotepath=false', 'diff', '--name-only', ...extraArgs], { cwd });
  if (res.code !== 0) throw new Error(`git diff --name-only 失败: ${res.stderr}`);
  return res.stdout.split('\n').filter((f) => f.trim() !== '');
}
