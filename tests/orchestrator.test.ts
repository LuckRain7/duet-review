import { describe, expect, it } from 'vitest';
import { applyResponses, evaluate, initTracked, openFindings, runDiscussion } from '../src/orchestrator.js';
import type { DiscussionResponse, Finding, Reviewer } from '../src/types.js';

function finding(id: string, over: Partial<Finding> = {}): Finding {
  return { id, file: 'a.ts', line: 1, severity: 'major', title: 't-' + id, description: 'd', suggestion: 's0', ...over };
}

function resp(findingId: string, stance: DiscussionResponse['stance'], over: Partial<DiscussionResponse> = {}): DiscussionResponse {
  return { findingId, stance, comment: 'c', revisedSuggestion: null, ...over };
}

describe('initTracked', () => {
  it('给双方 finding 加 cx-/cl- 前缀并设初始立场', () => {
    const tracked = initTracked([finding('1')], [finding('1')]);
    expect(tracked.map((t) => t.finding.id)).toEqual(['cx-1', 'cl-1']);
    const cx = tracked[0];
    expect(cx.author).toBe('codex');
    expect(cx.codexStance).toBe('agree');
    expect(cx.claudeStance).toBe('pending');
    expect(cx.state).toBe('open');
  });
});

describe('applyResponses + evaluate', () => {
  it('双方 agree 达成共识', () => {
    const tracked = initTracked([finding('1')], []);
    applyResponses(tracked, 'claude', [resp('cx-1', 'agree')], 1);
    evaluate(tracked);
    expect(tracked[0].state).toBe('consensus');
  });

  it('作者 withdraw 后标记 dropped', () => {
    const tracked = initTracked([finding('1')], []);
    applyResponses(tracked, 'claude', [resp('cx-1', 'disagree')], 1);
    applyResponses(tracked, 'codex', [resp('cx-1', 'withdraw')], 2);
    evaluate(tracked);
    expect(tracked[0].state).toBe('dropped');
  });

  it('非作者 withdraw 视为 disagree', () => {
    const tracked = initTracked([finding('1')], []);
    applyResponses(tracked, 'claude', [resp('cx-1', 'withdraw')], 1);
    expect(tracked[0].claudeStance).toBe('disagree');
  });

  it('modify 更新 suggestion 并把对方立场重置为 pending', () => {
    const tracked = initTracked([finding('1')], []);
    applyResponses(tracked, 'claude', [resp('cx-1', 'modify', { revisedSuggestion: 's1' })], 1);
    expect(tracked[0].finding.suggestion).toBe('s1');
    expect(tracked[0].claudeStance).toBe('agree');
    expect(tracked[0].codexStance).toBe('pending');
    evaluate(tracked);
    expect(tracked[0].state).toBe('open'); // codex 还没对 s1 表态

    applyResponses(tracked, 'codex', [resp('cx-1', 'agree')], 2);
    evaluate(tracked);
    expect(tracked[0].state).toBe('consensus');
  });

  it('modify 缺 revisedSuggestion 视为 disagree', () => {
    const tracked = initTracked([finding('1')], []);
    applyResponses(tracked, 'claude', [resp('cx-1', 'modify')], 1);
    expect(tracked[0].claudeStance).toBe('disagree');
    expect(tracked[0].finding.suggestion).toBe('s0');
  });

  it('history 记录每次 response', () => {
    const tracked = initTracked([finding('1')], []);
    applyResponses(tracked, 'claude', [resp('cx-1', 'agree')], 1);
    expect(tracked[0].history).toEqual([
      { round: 1, reviewer: 'claude', response: resp('cx-1', 'agree') },
    ]);
  });

  it('同轮对方已 modify 时，本方对旧版本的表态不生效（防假共识）', () => {
    const tracked = initTracked([finding('1')], []);
    // 双方并行回应同一轮：codex 修订了 cx-1，claude 的 agree 针对的是旧版 s0
    applyResponses(tracked, 'codex', [resp('cx-1', 'modify', { revisedSuggestion: 's_new' })], 1);
    applyResponses(tracked, 'claude', [resp('cx-1', 'agree')], 1);
    evaluate(tracked);

    expect(tracked[0].finding.suggestion).toBe('s_new');
    expect(tracked[0].claudeStance).toBe('pending'); // 需对新版本重新表态
    expect(tracked[0].state).toBe('open');
    expect(tracked[0].history).toHaveLength(2); // 陈旧意见仍留档

    // 下一轮 claude 对新版本 agree 才形成共识
    applyResponses(tracked, 'claude', [resp('cx-1', 'agree')], 2);
    evaluate(tracked);
    expect(tracked[0].state).toBe('consensus');
  });

  it('双方同轮 modify 同一 finding 时 last-write-wins，先者 revision 留在 history', () => {
    const tracked = initTracked([finding('1')], []);
    applyResponses(tracked, 'codex', [resp('cx-1', 'modify', { revisedSuggestion: 's_codex' })], 1);
    applyResponses(tracked, 'claude', [resp('cx-1', 'modify', { revisedSuggestion: 's_claude' })], 1);

    expect(tracked[0].finding.suggestion).toBe('s_claude');
    expect(tracked[0].claudeStance).toBe('agree');
    expect(tracked[0].codexStance).toBe('pending'); // codex 下轮需对 s_claude 重新表态
    expect(tracked[0].history).toHaveLength(2);
    expect(tracked[0].history[0].response.revisedSuggestion).toBe('s_codex'); // 可追溯
    evaluate(tracked);
    expect(tracked[0].state).toBe('open');
  });
});

describe('runDiscussion', () => {
  function fakeReviewer(name: 'codex' | 'claude', replies: string[]): Reviewer & { prompts: string[] } {
    const prompts: string[] = [];
    return {
      name,
      prompts,
      async start() { throw new Error('讨论阶段不应调用 start'); },
      async reply(prompt: string) {
        prompts.push(prompt);
        const r = replies.shift();
        if (!r) throw new Error(`${name} 没有更多脚本回复`);
        return r;
      },
    };
  }

  const agreeAll = (ids: string[]) =>
    JSON.stringify({ responses: ids.map((id) => resp(id, 'agree')) });

  it('第一轮全部 agree 则提前收敛', async () => {
    const codex = fakeReviewer('codex', [agreeAll(['cx-1', 'cl-1'])]);
    const claude = fakeReviewer('claude', [agreeAll(['cx-1', 'cl-1'])]);
    const tracked = initTracked([finding('1')], [finding('1')]);
    const result = await runDiscussion({ codex, claude, tracked, maxRounds: 3, onProgress: () => {} });
    expect(result.rounds).toBe(1);
    expect(tracked.every((t) => t.state === 'consensus')).toBe(true);
  });

  it('轮数耗尽仍未收敛的 finding 标记 disputed', async () => {
    const disagreeAll = JSON.stringify({ responses: [resp('cx-1', 'disagree')] });
    const keep = JSON.stringify({ responses: [resp('cx-1', 'agree')] });
    const codex = fakeReviewer('codex', [keep, keep]);
    const claude = fakeReviewer('claude', [disagreeAll, disagreeAll]);
    const tracked = initTracked([finding('1')], []);
    const result = await runDiscussion({ codex, claude, tracked, maxRounds: 2, onProgress: () => {} });
    expect(result.rounds).toBe(2);
    expect(tracked[0].state).toBe('disputed');
  });

  it('解析失败重试一次（buildRetryPrompt）后成功', async () => {
    const codex = fakeReviewer('codex', ['这不是 JSON', agreeAll(['cl-1'])]);
    const claude = fakeReviewer('claude', [agreeAll(['cl-1'])]);
    const tracked = initTracked([], [finding('1')]);
    await runDiscussion({ codex, claude, tracked, maxRounds: 3, onProgress: () => {} });
    expect(codex.prompts).toHaveLength(2);
    expect(codex.prompts[1]).toContain('无法解析');
    expect(tracked[0].state).toBe('consensus');
  });

  it('重试仍失败则抛错', async () => {
    const codex = fakeReviewer('codex', ['坏的', '还是坏的']);
    const claude = fakeReviewer('claude', [agreeAll(['cl-1'])]);
    const tracked = initTracked([], [finding('1')]);
    await expect(
      runDiscussion({ codex, claude, tracked, maxRounds: 3, onProgress: () => {} }),
    ).rejects.toThrow('codex');
  });

  it('每轮触发 onRoundStart 与 onRoundEnd（带当前 tracked 状态）', async () => {
    const disagreeAll = JSON.stringify({ responses: [resp('cx-1', 'disagree')] });
    const keep = JSON.stringify({ responses: [resp('cx-1', 'agree')] });
    const codex = fakeReviewer('codex', [keep, keep]);
    const claude = fakeReviewer('claude', [disagreeAll, agreeAll(['cx-1'])]);
    const tracked = initTracked([finding('1')], []);

    const starts: Array<{ round: number; open: number }> = [];
    const ends: Array<{ round: number; states: string[] }> = [];
    await runDiscussion({
      codex, claude, tracked, maxRounds: 3, onProgress: () => {},
      onRoundStart: (round, openCount) => starts.push({ round, open: openCount }),
      onRoundEnd: (round, current) => ends.push({ round, states: current.map((t) => t.state) }),
    });

    expect(starts).toEqual([{ round: 1, open: 1 }, { round: 2, open: 1 }]);
    expect(ends.map((e) => e.round)).toEqual([1, 2]);
    expect(ends[0].states).toEqual(['open']);
    expect(ends[1].states).toEqual(['consensus']);
  });
});
