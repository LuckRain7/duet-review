import { describe, expect, it } from 'vitest';
import { CodexReviewer, parseCodexJsonl } from '../src/reviewers/codex.js';
import { makeFakeScenario } from './helpers/fakeCli.js';

describe('parseCodexJsonl', () => {
  it('提取 session id 与最终 agent 消息', () => {
    const jsonl = [
      JSON.stringify({ type: 'thread.started', thread_id: 's-123' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: '思考' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '最终结论' } }),
    ].join('\n');
    expect(parseCodexJsonl(jsonl)).toEqual({ sessionId: 's-123', lastMessage: '最终结论' });
  });

  it('兼容 session_id 字段名并跳过非 JSON 行', () => {
    const jsonl = ['垃圾行', JSON.stringify({ session_id: 's-9' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } })].join('\n');
    expect(parseCodexJsonl(jsonl)).toEqual({ sessionId: 's-9', lastMessage: 'ok' });
  });

  it('缺消息时 lastMessage 为 null', () => {
    expect(parseCodexJsonl(JSON.stringify({ thread_id: 's-1' }))).toEqual({ sessionId: 's-1', lastMessage: null });
  });
});

describe('CodexReviewer', () => {
  function make(scenario = makeFakeScenario()) {
    const reviewer = new CodexReviewer({
      cwd: process.cwd(),
      timeoutMs: 10_000,
      reviewSchemaFile: '/tmp/review-schema.json',
      discussionSchemaFile: '/tmp/discussion-schema.json',
      env: scenario.env,
    });
    return { scenario, reviewer };
  }

  it('start 走 exec 子命令、read-only 沙箱、stdin 传 prompt，并返回消息', async () => {
    const { scenario, reviewer } = make();
    scenario.setReply('codex', 1, '初始评审结果');
    const out = await reviewer.start('请评审这个 diff');
    expect(out).toBe('初始评审结果');
    const call = scenario.calls('codex')[0];
    expect(call.argv).toEqual([
      'exec', '--json', '-s', 'read-only', '--output-schema', '/tmp/review-schema.json', '-',
    ]);
    expect(call.stdin).toBe('请评审这个 diff');
  });

  it('reply 用 exec resume 续接同一会话', async () => {
    const { scenario, reviewer } = make();
    scenario.setReply('codex', 1, '初始');
    scenario.setReply('codex', 2, '第二轮');
    await reviewer.start('第一轮');
    const out = await reviewer.reply('第二轮 prompt');
    expect(out).toBe('第二轮');
    const call = scenario.calls('codex')[1];
    expect(call.argv).toEqual([
      'exec', 'resume', 'fake-codex-session-1', '--json',
      '-c', 'sandbox_mode="read-only"',
      '--output-schema', '/tmp/discussion-schema.json', '-',
    ]);
  });

  it('未 start 直接 reply 抛错', async () => {
    const { reviewer } = make();
    await expect(reviewer.reply('x')).rejects.toThrow('会话不存在');
  });

  it('codex 进程非零退出时抛出含退出码的错误', async () => {
    const { reviewer } = make(); // 故意不 setReply，假 CLI 会 exit 98
    await expect(reviewer.start('prompt')).rejects.toThrow('codex 退出码 98');
  });
});
