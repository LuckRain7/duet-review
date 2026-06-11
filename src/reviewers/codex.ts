import { runCli } from '../utils/proc.js';
import type { Reviewer } from '../types.js';

export interface CodexOptions {
  cwd: string;
  timeoutMs: number;
  reviewSchemaFile: string;
  discussionSchemaFile: string;
  env?: NodeJS.ProcessEnv;
}

const SESSION_KEYS = new Set(['thread_id', 'session_id', 'conversation_id']);

/** 递归找事件对象里第一个会话 id 字段 */
function findSessionId(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;
  for (const [k, v] of Object.entries(value)) {
    if (SESSION_KEYS.has(k) && typeof v === 'string' && v) return v;
    const nested = findSessionId(v);
    if (nested) return nested;
  }
  return null;
}

export function parseCodexJsonl(jsonl: string): { sessionId: string | null; lastMessage: string | null } {
  let sessionId: string | null = null;
  let lastMessage: string | null = null;
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let evt: any;
    try { evt = JSON.parse(trimmed); } catch { continue; }
    sessionId ??= findSessionId(evt);
    if (evt?.item?.type === 'agent_message' && typeof evt.item.text === 'string') {
      lastMessage = evt.item.text;
    } else if (evt?.type === 'agent_message' && typeof evt.message === 'string') {
      lastMessage = evt.message;
    }
  }
  return { sessionId, lastMessage };
}

export class CodexReviewer implements Reviewer {
  readonly name = 'codex' as const;
  private sessionId: string | null = null;

  constructor(private readonly opts: CodexOptions) {}

  async start(prompt: string): Promise<string> {
    return this.exec(
      ['exec', '--json', '-s', 'read-only', '--output-schema', this.opts.reviewSchemaFile, '-'],
      prompt,
    );
  }

  async reply(prompt: string): Promise<string> {
    if (!this.sessionId) throw new Error('codex 会话不存在，无法 resume');
    return this.exec(
      ['exec', 'resume', this.sessionId, '--json',
        '-c', 'sandbox_mode="read-only"',
        '--output-schema', this.opts.discussionSchemaFile, '-'],
      prompt,
    );
  }

  private async exec(args: string[], prompt: string): Promise<string> {
    const res = await runCli('codex', args, {
      cwd: this.opts.cwd,
      stdin: prompt,
      timeoutMs: this.opts.timeoutMs,
      env: this.opts.env,
    });
    const cmdStr = ['codex', ...args].join(' ');
    if (res.timedOut) throw new Error(`codex 调用超时（${cmdStr}）`);
    if (res.code !== 0) throw new Error(`codex 退出码 ${res.code}（${cmdStr}）: ${res.stderr.slice(-2000)}`);
    const { sessionId, lastMessage } = parseCodexJsonl(res.stdout);
    if (sessionId) this.sessionId = sessionId;
    if (!this.sessionId) throw new Error('未能从 codex 输出解析 session_id');
    if (lastMessage === null) throw new Error('未能从 codex 输出解析最终消息');
    return lastMessage;
  }
}
