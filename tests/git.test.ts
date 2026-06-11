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
});
