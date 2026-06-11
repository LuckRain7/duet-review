import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export interface RunOptions {
  cwd?: string;
  stdin?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** stdout 每产出一个完整行就回调一次（不含换行符），用于实时展示流式输出 */
  onStdoutLine?: (line: string) => void;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function runCli(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let lineBuf = '';
    // 多字节 UTF-8 字符可能被 chunk 边界切开，必须用 StringDecoder 跨 chunk 解码
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, opts.timeoutMs)
      : null;

    child.stdout.on('data', (d: Buffer) => {
      const chunk = stdoutDecoder.write(d);
      stdout += chunk;
      if (!opts.onStdoutLine) return;
      lineBuf += chunk;
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop()!;
      for (const line of lines) opts.onStdoutLine(line);
    });
    child.stderr.on('data', (d: Buffer) => (stderr += stderrDecoder.write(d)));

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      const tail = stdoutDecoder.end();
      stdout += tail;
      stderr += stderrDecoder.end();
      if (opts.onStdoutLine) {
        lineBuf += tail;
        if (lineBuf) opts.onStdoutLine(lineBuf);
      }
      resolve({ code, stdout, stderr, timedOut });
    });

    child.stdin.end(opts.stdin ?? '');
  });
}
