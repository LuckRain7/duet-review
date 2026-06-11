import { describe, expect, it } from 'vitest';
import { ClaudeReviewer, formatClaudeEvent, parseClaudeStream } from '../src/reviewers/claude.js';
import { makeFakeScenario } from './helpers/fakeCli.js';

const READ_ONLY = ['--allowedTools', 'Read', 'Grep', 'Glob'];
const STREAM = ['--output-format', 'stream-json', '--verbose'];

function make(scenario = makeFakeScenario(), onActivity?: (text: string) => void) {
  const reviewer = new ClaudeReviewer({ cwd: process.cwd(), timeoutMs: 10_000, env: scenario.env, onActivity });
  return { scenario, reviewer };
}

describe('ClaudeReviewer', () => {
  it('start 用 -p + stream-json 输出 + 只读工具，stdin 传 prompt', async () => {
    const { scenario, reviewer } = make();
    scenario.setReply('claude', 1, '初始评审');
    const out = await reviewer.start('请评审');
    expect(out).toBe('初始评审');
    const call = scenario.calls('claude')[0];
    expect(call.argv).toEqual(['-p', ...STREAM, ...READ_ONLY]);
    expect(call.stdin).toBe('请评审');
  });

  it('reply 用 --resume 续接同一会话', async () => {
    const { scenario, reviewer } = make();
    scenario.setReply('claude', 1, '初始');
    scenario.setReply('claude', 2, '第二轮');
    await reviewer.start('第一轮');
    const out = await reviewer.reply('第二轮 prompt');
    expect(out).toBe('第二轮');
    expect(scenario.calls('claude')[1].argv).toEqual([
      '-p', '--resume', 'fake-claude-session-1', ...STREAM, ...READ_ONLY,
    ]);
  });

  it('applyFix 用写权限工具集与 acceptEdits', async () => {
    const { scenario, reviewer } = make();
    scenario.setReply('claude', 1, '初始');
    scenario.setReply('claude', 2, '已应用修改');
    await reviewer.start('第一轮');
    const out = await reviewer.applyFix('请应用共识');
    expect(out).toBe('已应用修改');
    expect(scenario.calls('claude')[1].argv).toEqual([
      '-p', '--resume', 'fake-claude-session-1', ...STREAM,
      '--permission-mode', 'acceptEdits',
      '--allowedTools', 'Read', 'Grep', 'Glob', 'Edit', 'Write',
    ]);
  });

  it('onActivity 实时收到 assistant 消息文本', async () => {
    const seen: string[] = [];
    const { scenario, reviewer } = make(makeFakeScenario(), (t) => seen.push(t));
    scenario.setReply('claude', 1, '实时消息内容');
    await reviewer.start('请评审');
    expect(seen).toContain('实时消息内容');
  });

  it('未 start 直接 reply/applyFix 抛错', async () => {
    const { reviewer } = make();
    await expect(reviewer.reply('x')).rejects.toThrow('会话不存在');
    await expect(reviewer.applyFix('x')).rejects.toThrow('会话不存在');
  });

  it('claude 进程非零退出时抛出含退出码的错误', async () => {
    const { reviewer } = make(); // 故意不 setReply，假 CLI 会 exit 98
    await expect(reviewer.start('prompt')).rejects.toThrow('claude 退出码 98');
  });
});

describe('parseClaudeStream', () => {
  const lines = (...evts: unknown[]) => evts.map((e) => JSON.stringify(e)).join('\n');

  it('提取 result 事件的结果与 session_id', () => {
    const parsed = parseClaudeStream(lines(
      { type: 'system', subtype: 'init', session_id: 's1' },
      { type: 'assistant', message: { content: [{ type: 'text', text: '过程' }] }, session_id: 's1' },
      { type: 'result', result: 'r', is_error: false, session_id: 's1' },
    ));
    expect(parsed).toEqual({ result: 'r', sessionId: 's1' });
  });

  it('容忍非 JSON 行（混入的日志）', () => {
    const parsed = parseClaudeStream('开场杂讯\n' + lines({ type: 'result', result: 'r', is_error: false, session_id: 's' }));
    expect(parsed.result).toBe('r');
  });

  it('is_error 为 true 时抛错', () => {
    expect(() => parseClaudeStream(lines({ type: 'result', result: '坏了', is_error: true, session_id: 's' })))
      .toThrow('claude 返回错误');
  });

  it('缺 result 字段抛错', () => {
    expect(() => parseClaudeStream(lines({ type: 'result', is_error: false, session_id: 's' }))).toThrow('缺少 result');
  });

  it('没有 result 事件抛错', () => {
    expect(() => parseClaudeStream(lines({ type: 'system', session_id: 's' }))).toThrow('没有 result 事件');
  });
});

describe('formatClaudeEvent', () => {
  it('assistant 文本块原样透出', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '分析中' }] } });
    expect(formatClaudeEvent(line)).toBe('分析中');
  });

  it('tool_use 块展示工具名与完整入参', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/a/b.ts' } }] },
    });
    expect(formatClaudeEvent(line)).toBe('⚒ Read {"file_path":"/a/b.ts"}');
  });

  it('非 assistant 事件与非 JSON 行返回 null', () => {
    expect(formatClaudeEvent(JSON.stringify({ type: 'result', result: 'r' }))).toBeNull();
    expect(formatClaudeEvent('not json')).toBeNull();
  });
});
