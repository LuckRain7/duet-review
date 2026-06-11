import { describe, expect, it } from 'vitest';
import { applyConsensus } from '../src/apply.js';
import { initTracked } from '../src/orchestrator.js';
import type { Finding } from '../src/types.js';

const f: Finding = { id: '1', file: 'a.ts', line: 1, severity: 'major', title: 't', description: 'd', suggestion: 's' };

describe('applyConsensus', () => {
  it('无共识项时不调用 claude，返回 null', async () => {
    let called = false;
    const out = await applyConsensus({
      consensus: [],
      applyFix: async () => { called = true; return 'x'; },
      onProgress: () => {},
    });
    expect(out).toBeNull();
    expect(called).toBe(false);
  });

  it('有共识项时调用 applyFix 并返回总结', async () => {
    const tracked = initTracked([f], []);
    tracked[0].state = 'consensus';
    const prompts: string[] = [];
    const out = await applyConsensus({
      consensus: tracked,
      applyFix: async (p) => { prompts.push(p); return '改好了'; },
      onProgress: () => {},
    });
    expect(out).toBe('改好了');
    expect(prompts[0]).toContain('cx-1');
    expect(prompts[0]).toContain('不要做任何列表之外的修改');
  });
});
