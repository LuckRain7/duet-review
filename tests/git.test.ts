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

  it('返回 unstaged 变更的文件列表', async () => {
    const repo = makeTmpRepo();
    repo.write('b.txt', 'b1\n');
    repo.git('add', 'b.txt');
    repo.git('commit', '-m', 'add b');
    repo.write('a.txt', 'line1\nline2\n');
    repo.write('b.txt', 'b1\nb2\n');
    const res = await collectDiff(repo.dir);
    expect(res.files).toEqual(['a.txt', 'b.txt']);
  });

  it('返回 staged 变更的文件列表（不含 unstaged 文件）', async () => {
    const repo = makeTmpRepo();
    repo.write('b.txt', 'b1\n');
    repo.git('add', 'b.txt');
    repo.git('commit', '-m', 'add b');
    repo.write('a.txt', 'line1\nstaged-change\n');
    repo.git('add', 'a.txt');
    repo.write('b.txt', 'b1\nunstaged-change\n');
    const res = await collectDiff(repo.dir);
    expect(res.source).toBe('staged');
    expect(res.files).toEqual(['a.txt']);
  });

  it('中文文件名不被转义为八进制引号形式', async () => {
    const repo = makeTmpRepo();
    repo.write('中文文件.txt', 'v1\n');
    repo.git('add', '中文文件.txt');
    repo.git('commit', '-m', 'add cjk file');
    repo.write('中文文件.txt', 'v1\nv2\n');
    const res = await collectDiff(repo.dir);
    expect(res.files).toEqual(['中文文件.txt']);
  });

  it('无任何变更时抛 NoDiffError', async () => {
    const repo = makeTmpRepo();
    await expect(collectDiff(repo.dir)).rejects.toBeInstanceOf(NoDiffError);
  });

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
});
