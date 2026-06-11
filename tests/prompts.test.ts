import { describe, expect, it } from 'vitest';
import {
  buildApplyPrompt,
  buildDiscussionPrompt,
  buildInitialReviewPrompt,
  buildRetryPrompt,
  codexDiscussionSchema,
  codexReviewSchema,
} from '../src/prompts.js';
import type { TrackedFinding } from '../src/types.js';

function tracked(over: Partial<TrackedFinding> = {}): TrackedFinding {
  return {
    finding: {
      id: 'cx-1', file: 'src/a.ts', line: 3, severity: 'major',
      title: '缺少判空', description: 'x 可能为 null', suggestion: '增加 if (!x) return;',
    },
    author: 'codex',
    codexStance: 'agree',
    claudeStance: 'pending',
    state: 'open',
    history: [],
    ...over,
  };
}

describe('buildInitialReviewPrompt', () => {
  it('包含 diff、来源说明与 schema 字段要求', () => {
    const p = buildInitialReviewPrompt('diff --git a/a.txt b/a.txt\n+line2', 'staged');
    expect(p).toContain('diff --git');
    expect(p).toContain('staged');
    for (const key of ['findings', 'severity', 'suggestion']) expect(p).toContain(key);
  });
});

describe('buildDiscussionPrompt', () => {
  it('列出对方 findings 与最新评论，并要求对每条表态', () => {
    const t = tracked();
    const p = buildDiscussionPrompt('claude', [t], 1);
    expect(p).toContain('cx-1');
    expect(p).toContain('缺少判空');
    for (const s of ['agree', 'disagree', 'modify', 'withdraw']) expect(p).toContain(s);
  });
});

describe('buildApplyPrompt', () => {
  it('只包含共识 findings 并明确禁止其他改动', () => {
    const t = tracked({ state: 'consensus' });
    const p = buildApplyPrompt([t]);
    expect(p).toContain('cx-1');
    expect(p).toContain('不要做任何列表之外的修改');
  });
});

describe('buildRetryPrompt', () => {
  it('携带解析错误信息', () => {
    expect(buildRetryPrompt('severity: Invalid enum value')).toContain('Invalid enum value');
  });
});

describe('codex output schemas', () => {
  it('review schema 约束 findings 数组与 severity 枚举', () => {
    const props = codexReviewSchema.properties.findings.items.properties;
    expect(props.severity.enum).toEqual(['critical', 'major', 'minor', 'nit']);
    expect(codexReviewSchema.required).toEqual(['findings']);
  });

  it('discussion schema 约束 stance 枚举', () => {
    const props = codexDiscussionSchema.properties.responses.items.properties;
    expect(props.stance.enum).toEqual(['agree', 'disagree', 'modify', 'withdraw']);
  });
});
