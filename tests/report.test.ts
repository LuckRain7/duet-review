import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { Archive, renderReport } from '../src/report.js';
import type { TrackedFinding } from '../src/types.js';

function tracked(id: string, state: TrackedFinding['state']): TrackedFinding {
  return {
    finding: { id, file: 'src/a.ts', line: 3, severity: 'major', title: '标题-' + id, description: '描述', suggestion: '建议' },
    author: 'codex',
    codexStance: 'agree',
    claudeStance: state === 'consensus' ? 'agree' : 'disagree',
    state,
    history: [],
  };
}

describe('Archive', () => {
  it('在 .duet-review/<时间戳>/ 下创建目录并写文件', () => {
    const root = mkdtempSync(join(tmpdir(), 'duet-archive-'));
    const archive = new Archive(root, new Date('2026-06-11T10:30:00Z'));
    expect(archive.dir).toContain(join(root, '.duet-review'));
    expect(archive.dir).toContain('2026-06-11T10-30-00');
    archive.write('00-diff.patch', 'diff 内容');
    expect(readFileSync(join(archive.dir, '00-diff.patch'), 'utf8')).toBe('diff 内容');
  });
});

describe('renderReport', () => {
  it('按状态分组渲染共识/分歧/撤销', () => {
    const md = renderReport({
      label: 'main...HEAD',
      rounds: 2,
      tracked: [tracked('cx-1', 'consensus'), tracked('cx-2', 'disputed'), tracked('cx-3', 'dropped')],
      applySummary: '修改了 src/a.ts',
    });
    expect(md).toContain('# duet-review 报告');
    expect(md).toContain('共识');
    expect(md).toContain('cx-1');
    expect(md).toContain('分歧');
    expect(md).toContain('cx-2');
    expect(md).toContain('撤销');
    expect(md).toContain('cx-3');
    expect(md).toContain('修改了 src/a.ts');
    expect(md).toContain('审查对象: main...HEAD diff');
  });
});
