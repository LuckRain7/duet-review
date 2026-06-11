import { runCli } from '../utils/proc.js';
import type { Reviewer } from '../types.js';

export interface ClaudeOptions {
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

const READ_ONLY_TOOLS = ['--allowedTools', 'Read', 'Grep', 'Glob'];
const WRITE_TOOLS = ['--allowedTools', 'Read', 'Grep', 'Glob', 'Edit', 'Write'];

export function parseClaudeResult(stdout: string): { result: string; sessionId: string | null } {
  let parsed: any;
  try {
    parsed = JSON.parse(stdout);
  } catch (e) {
    throw new Error(`claude 输出不是合法 JSON: ${(e as Error).message}`);
  }
  if (parsed.is_error) throw new Error(`claude 返回错误: ${parsed.result ?? '(无详情)'}`);
  if (typeof parsed.result !== 'string') throw new Error('claude 输出缺少 result 字段');
  return { result: parsed.result, sessionId: typeof parsed.session_id === 'string' ? parsed.session_id : null };
}

export class ClaudeReviewer implements Reviewer {
  readonly name = 'claude' as const;
  private sessionId: string | null = null;

  constructor(private readonly opts: ClaudeOptions) {}

  async start(prompt: string): Promise<string> {
    return this.exec(['-p', '--output-format', 'json', ...READ_ONLY_TOOLS], prompt);
  }

  async reply(prompt: string): Promise<string> {
    return this.exec(
      ['-p', '--resume', this.requireSession(), '--output-format', 'json', ...READ_ONLY_TOOLS],
      prompt,
    );
  }

  /** 应用阶段：续接同一会话，授予写权限 */
  async applyFix(prompt: string): Promise<string> {
    return this.exec(
      ['-p', '--resume', this.requireSession(), '--output-format', 'json',
        '--permission-mode', 'acceptEdits', ...WRITE_TOOLS],
      prompt,
    );
  }

  private requireSession(): string {
    if (!this.sessionId) throw new Error('claude 会话不存在，无法 resume');
    return this.sessionId;
  }

  private async exec(args: string[], prompt: string): Promise<string> {
    const res = await runCli('claude', args, {
      cwd: this.opts.cwd,
      stdin: prompt,
      timeoutMs: this.opts.timeoutMs,
      env: this.opts.env,
    });
    const cmdStr = ['claude', ...args].join(' ');
    if (res.timedOut) throw new Error(`claude 调用超时（${cmdStr}）`);
    if (res.code !== 0) throw new Error(`claude 退出码 ${res.code}（${cmdStr}）: ${res.stderr.slice(-2000)}`);
    const { result, sessionId } = parseClaudeResult(res.stdout);
    if (sessionId) this.sessionId = sessionId;
    if (!this.sessionId) throw new Error('未能从 claude 输出解析 session_id');
    return result;
  }
}
