import { describe, expect, it } from 'vitest';
import { ClaudeReviewer, parseClaudeResult } from '../src/reviewers/claude.js';
import { makeFakeScenario } from './helpers/fakeCli.js';

const READ_ONLY = ['--allowedTools', 'Read', 'Grep', 'Glob'];

function make(scenario = makeFakeScenario()) {
  const reviewer = new ClaudeReviewer({ cwd: process.cwd(), timeoutMs: 10_000, env: scenario.env });
  return { scenario, reviewer };
}

describe('ClaudeReviewer', () => {
  it('start 用 -p + json 输出 + 只读工具，stdin 传 prompt', async () => {
    const { scenario, reviewer } = make();
    scenario.setReply('claude', 1, '初始评审');
    const out = await reviewer.start('请评审');
    expect(out).toBe('初始评审');
    const call = scenario.calls('claude')[0];
    expect(call.argv).toEqual(['-p', '--output-format', 'json', ...READ_ONLY]);
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
      '-p', '--resume', 'fake-claude-session-1', '--output-format', 'json', ...READ_ONLY,
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
      '-p', '--resume', 'fake-claude-session-1', '--output-format', 'json',
      '--permission-mode', 'acceptEdits',
      '--allowedTools', 'Read', 'Grep', 'Glob', 'Edit', 'Write',
    ]);
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

describe('parseClaudeResult', () => {
  it('提取 result 与 session_id', () => {
    const parsed = parseClaudeResult(JSON.stringify({ result: 'r', session_id: 's1', is_error: false }));
    expect(parsed).toEqual({ result: 'r', sessionId: 's1' });
  });

  it('is_error 为 true 时抛错', () => {
    expect(() => parseClaudeResult(JSON.stringify({ result: '坏了', session_id: 's', is_error: true })))
      .toThrow('claude 返回错误');
  });

  it('缺 result 字段抛错', () => {
    expect(() => parseClaudeResult(JSON.stringify({ session_id: 's' }))).toThrow('缺少 result');
  });

  it('非法 JSON 抛错', () => {
    expect(() => parseClaudeResult('not json')).toThrow('不是合法 JSON');
  });
});
