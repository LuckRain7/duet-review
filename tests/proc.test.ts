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

  it('onStdoutLine 按完整行实时回调，含无换行结尾的末行', async () => {
    const lines: string[] = [];
    const res = await runCli(
      'node',
      ['-e', 'process.stdout.write("a\\nb\\nc")'],
      { onStdoutLine: (l) => lines.push(l) },
    );
    expect(lines).toEqual(['a', 'b', 'c']);
    expect(res.stdout).toBe('a\nb\nc'); // 全量 stdout 不受影响
  });

  it('多字节 UTF-8 字符被 chunk 边界切开时不产生乱码', async () => {
    const lines: string[] = [];
    // 把「中」(e4 b8 ad) 拆成两次 write，模拟字符横跨 chunk 边界
    const res = await runCli(
      'node',
      ['-e', `
        const buf = Buffer.from('前中后');
        process.stdout.write(buf.subarray(0, 4));
        setTimeout(() => { process.stdout.write(buf.subarray(4)); process.stdout.write('\\n尾'); }, 50);
      `],
      { onStdoutLine: (l) => lines.push(l) },
    );
    expect(res.stdout).toBe('前中后\n尾');
    expect(lines).toEqual(['前中后', '尾']);
    expect(res.stdout).not.toContain('�');
  });
});
