import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export interface TmpRepo {
  dir: string;
  git(...args: string[]): void;
  write(file: string, content: string): void;
}

/** 创建带一次初始提交的临时 git 仓库 */
export function makeTmpRepo(): TmpRepo {
  const dir = mkdtempSync(join(tmpdir(), 'duet-review-test-'));
  const git = (...args: string[]) => {
    execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  };
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(dir, 'a.txt'), 'line1\n');
  git('add', '.');
  git('commit', '-m', 'init');
  return {
    dir,
    git,
    write: (file, content) => writeFileSync(join(dir, file), content),
  };
}
