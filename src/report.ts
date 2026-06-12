import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TrackedFinding } from './types.js';

export class Archive {
  readonly dir: string;

  constructor(repoRoot: string, now: Date = new Date()) {
    const ts = now.toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, '');
    this.dir = join(repoRoot, '.duet-review', ts);
    mkdirSync(this.dir, { recursive: true });
  }

  write(name: string, content: string): void {
    writeFileSync(join(this.dir, name), content);
  }
}

export interface ReportInput {
  label: string;
  rounds: number;
  tracked: TrackedFinding[];
  applySummary: string | null;
}

function section(title: string, items: TrackedFinding[]): string {
  if (items.length === 0) return `## ${title}\n\n（无）\n`;
  const body = items
    .map((t) => {
      const f = t.finding;
      const loc = f.line ? `${f.file}:${f.line}` : f.file;
      const talk = t.history
        .map((h) => `> 第${h.round}轮 ${h.reviewer} [${h.response.stance}]: ${h.response.comment}`)
        .join('\n');
      return `### ${f.id} · ${f.title}\n\n- 位置: \`${loc}\`\n- 严重度: ${f.severity}\n- 提出方: ${t.author}\n\n${f.description}\n\n**建议:** ${f.suggestion}\n${talk ? `\n${talk}\n` : ''}`;
    })
    .join('\n');
  return `## ${title}（${items.length}）\n\n${body}\n`;
}

export function renderReport(input: ReportInput): string {
  const by = (s: TrackedFinding['state']) => input.tracked.filter((t) => t.state === s);
  return [
    '# duet-review 报告',
    '',
    `- 审查对象: ${input.label} diff`,
    `- 讨论轮数: ${input.rounds}`,
    `- 结果: 共识 ${by('consensus').length} / 分歧 ${by('disputed').length} / 撤销 ${by('dropped').length}`,
    '',
    section('共识（已应用）', by('consensus')),
    section('分歧（未改动，请人工裁决）', by('disputed')),
    section('撤销', by('dropped')),
    input.applySummary ? `## 应用结果\n\n${input.applySummary}\n` : '',
  ].join('\n');
}
