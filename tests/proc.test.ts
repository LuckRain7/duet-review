import { describe, expect, it } from 'vitest';
import { runCli } from '../src/utils/proc.js';

describe('runCli', () => {
  it('收集 stdout 与退出码', async () => {
    const res = await runCli('node', ['-e', 'console.log("hello")']);
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toBe('hello');
    expect(res.timedOut).toBe(false);
  });

  it('收集 stderr 与非零退出码', async () => {
    const res = await runCli('node', ['-e', 'console.error("boom"); process.exit(3)']);
    expect(res.code).toBe(3);
    expect(res.stderr.trim()).toBe('boom');
  });

  it('通过 stdin 传入内容', async () => {
    const res = await runCli('node', ['-e', 'process.stdin.pipe(process.stdout)'], { stdin: 'piped-data' });
    expect(res.stdout).toBe('piped-data');
  });

  it('超时会杀死进程并标记 timedOut', async () => {
    const res = await runCli('node', ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 300 });
    expect(res.timedOut).toBe(true);
  });

  it('命令不存在时 reject', async () => {
    await expect(runCli('definitely-not-a-cmd-xyz', [])).rejects.toThrow();
  });
});
