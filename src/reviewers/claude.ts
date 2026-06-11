import { runCli } from '../utils/proc.js';
import type { Reviewer } from '../types.js';

export interface ClaudeOptions {
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  /** 实时输出回调：claude 每产生一个事件（工具调用/消息文本）就回调一次 */
  onActivity?: (text: string) => void;
}

const READ_ONLY_TOOLS = ['--allowedTools', 'Read', 'Grep', 'Glob'];
const WRITE_TOOLS = ['--allowedTools', 'Read', 'Grep', 'Glob', 'Edit', 'Write'];
// -p 配合 stream-json 必须带 --verbose，事件随会话进行逐行产出
const STREAM_OUTPUT = ['--output-format', 'stream-json', '--verbose'];

/** 解析 stream-json 的 JSONL 事件流，取最终 result 事件的结果与 session_id */
export function parseClaudeStream(stdout: string): { result: string; sessionId: string | null } {
  let sessionId: string | null = null;
  let resultEvent: any = null;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let evt: any;
    try { evt = JSON.parse(trimmed); } catch { continue; }
    if (typeof evt.session_id === 'string' && evt.session_id) sessionId = evt.session_id;
    if (evt.type === 'result') resultEvent = evt;
  }
  if (resultEvent === null) throw new Error('claude 输出中没有 result 事件');
  if (resultEvent.is_error) throw new Error(`claude 返回错误: ${resultEvent.result ?? '(无详情)'}`);
  if (typeof resultEvent.result !== 'string') throw new Error('claude 输出缺少 result 字段');
  return { result: resultEvent.result, sessionId };
}

/** 把 stream-json 的单个事件格式化为实时展示文本；不需要展示的事件返回 null */
export function formatClaudeEvent(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  let evt: any;
  try { evt = JSON.parse(trimmed); } catch { return null; }
  if (evt.type !== 'assistant' || !Array.isArray(evt.message?.content)) return null;
  const parts: string[] = [];
  for (const block of evt.message.content) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text) parts.push(block.text);
    if (block.type === 'tool_use' && typeof block.name === 'string') {
      parts.push(`⚒ ${block.name} ${JSON.stringify(block.input ?? {})}`);
    }
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

export class ClaudeReviewer implements Reviewer {
  readonly name = 'claude' as const;
  private sessionId: string | null = null;

  constructor(private readonly opts: ClaudeOptions) {}

  async start(prompt: string): Promise<string> {
    return this.exec(['-p', ...STREAM_OUTPUT, ...READ_ONLY_TOOLS], prompt);
  }

  async reply(prompt: string): Promise<string> {
    return this.exec(
      ['-p', '--resume', this.requireSession(), ...STREAM_OUTPUT, ...READ_ONLY_TOOLS],
      prompt,
    );
  }

  /** 应用阶段：续接同一会话，授予写权限 */
  async applyFix(prompt: string): Promise<string> {
    return this.exec(
      ['-p', '--resume', this.requireSession(), ...STREAM_OUTPUT,
        '--permission-mode', 'acceptEdits', ...WRITE_TOOLS],
      prompt,
    );
  }

  private requireSession(): string {
    if (!this.sessionId) throw new Error('claude 会话不存在，无法 resume');
    return this.sessionId;
  }

  private async exec(args: string[], prompt: string): Promise<string> {
    const { onActivity } = this.opts;
    const res = await runCli('claude', args, {
      cwd: this.opts.cwd,
      stdin: prompt,
      timeoutMs: this.opts.timeoutMs,
      env: this.opts.env,
      onStdoutLine: onActivity
        ? (line) => {
            const text = formatClaudeEvent(line);
            if (text !== null) onActivity(text);
          }
        : undefined,
    });
    const cmdStr = ['claude', ...args].join(' ');
    if (res.timedOut) throw new Error(`claude 调用超时（${cmdStr}）`);
    if (res.code !== 0) throw new Error(`claude 退出码 ${res.code}（${cmdStr}）: ${res.stderr.slice(-2000)}`);
    const { result, sessionId } = parseClaudeStream(res.stdout);
    if (sessionId) this.sessionId = sessionId;
    if (!this.sessionId) throw new Error('未能从 claude 输出解析 session_id');
    return result;
  }
}
