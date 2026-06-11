import { describe, expect, it } from 'vitest';
import { runInitialReviews } from '../src/orchestrator.js';
import type { Reviewer } from '../src/types.js';

const REVIEW = JSON.stringify({
  findings: [{ id: 'f1', file: 'a.ts', line: 1, severity: 'minor', title: 't', description: 'd', suggestion: 's' }],
});

function scripted(name: 'codex' | 'claude', startReply: string, retryReply?: string): Reviewer & { prompts: string[] } {
  const prompts: string[] = [];
  let started = false;
  return {
    name,
    prompts,
    async start(p: string) { prompts.push(p); started = true; return startReply; },
    async reply(p: string) {
      if (!started) throw new Error('未 start');
      prompts.push(p);
      if (!retryReply) throw new Error('不应触发重试');
      return retryReply;
    },
  };
}

describe('runInitialReviews', () => {
  it('并行启动双方并解析 findings', async () => {
    const codex = scripted('codex', REVIEW);
    const claude = scripted('claude', REVIEW);
    const res = await runInitialReviews({ codex, claude, prompt: '评审 prompt', onProgress: () => {} });
    expect(res.codexFindings).toHaveLength(1);
    expect(res.claudeFindings).toHaveLength(1);
    expect(codex.prompts).toEqual(['评审 prompt']);
  });

  it('解析失败时通过 reply 重试一次', async () => {
    const codex = scripted('codex', '不是 JSON', REVIEW);
    const claude = scripted('claude', REVIEW);
    const res = await runInitialReviews({ codex, claude, prompt: 'p', onProgress: () => {} });
    expect(res.codexFindings).toHaveLength(1);
    expect(codex.prompts[1]).toContain('无法解析');
  });

  it('每个 reviewer 完成时触发 onReviewerDone', async () => {
    const codex = scripted('codex', REVIEW);
    const claude = scripted('claude', REVIEW);
    const done: string[] = [];
    await runInitialReviews({
      codex, claude, prompt: 'p', onProgress: () => {},
      onReviewerDone: (name) => done.push(name),
    });
    expect(done.sort()).toEqual(['claude', 'codex']);
  });

  it('重试仍失败则抛错并指明是哪个 reviewer', async () => {
    const codex = scripted('codex', REVIEW);
    const claude = scripted('claude', '坏', '还是坏');
    await expect(
      runInitialReviews({ codex, claude, prompt: 'p', onProgress: () => {} }),
    ).rejects.toThrow('claude');
  });
});
