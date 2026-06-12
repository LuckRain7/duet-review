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
