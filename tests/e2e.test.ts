import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../src/main.js';
import { makeFakeScenario } from './helpers/fakeCli.js';
import { makeTmpRepo } from './helpers/tmpRepo.js';

const review = (id: string) =>
  JSON.stringify({ findings: [{ id, file: 'a.txt', line: 1, severity: 'major', title: 'T' + id, description: 'D', suggestion: 'S' }] });
const agree = (...ids: string[]) =>
  JSON.stringify({ responses: ids.map((findingId) => ({ findingId, stance: 'agree', comment: 'ok', revisedSuggestion: null })) });

describe('duet-review 端到端（假 CLI）', () => {
  it('完整流程：初始评审 → 一轮讨论收敛 → 应用 → 存档', async () => {
    const repo = makeTmpRepo();
    repo.write('a.txt', 'line1\nline2\n'); // unstaged 变更
    const scenario = makeFakeScenario();
    scenario.setReply('codex', 1, review('1'));
    scenario.setReply('claude', 1, review('1'));
    scenario.setReply('codex', 2, agree('cx-1', 'cl-1'));
    scenario.setReply('claude', 2, agree('cx-1', 'cl-1'));
    scenario.setReply('claude', 3, '已应用 2 处修改');

    const logs: string[] = [];
    const code = await main({
      cwd: repo.dir, maxRounds: 3, timeoutMs: 30_000,
      env: scenario.env, log: (m) => logs.push(m),
    });

    expect(code).toBe(0);

    // 存档完整
    const runs = readdirSync(join(repo.dir, '.duet-review'));
    expect(runs).toHaveLength(1);
    const dir = join(repo.dir, '.duet-review', runs[0]);
    for (const f of ['00-diff.patch', '01-codex-review.json', '01-claude-review.json',
      '02-codex-round.json', '02-claude-round.json', 'consensus.json', 'report.md']) {
      expect(existsSync(join(dir, f)), `缺少 ${f}`).toBe(true);
    }

    // codex 第二次调用走了 resume
    expect(scenario.calls('codex')[1].argv.slice(0, 3)).toEqual(['exec', 'resume', 'fake-codex-session-1']);

    // claude 第三次调用是写权限的应用阶段
    const apply = scenario.calls('claude')[2];
    expect(apply.argv).toContain('acceptEdits');
    expect(apply.stdin).toContain('不要做任何列表之外的修改');

    // 报告与终端摘要
    const report = readFileSync(join(dir, 'report.md'), 'utf8');
    expect(report).toContain('cx-1');
    expect(report).toContain('已应用 2 处修改');
    expect(logs.some((l) => l.includes('共识 2 条已应用'))).toBe(true);

    // 审查对象一行附带变更文件目录树
    expect(logs.some((l) => l.includes('1 个文件'))).toBe(true);
    expect(logs).toContain('  a.txt');

    // 初评结果以双栏面板展示，每轮结束输出立场矩阵
    const joined = logs.join('\n');
    expect(joined).toContain('─ codex (1) ');
    expect(joined).toContain('─ claude (1) ');
    expect(joined).toMatch(/cx-1.*✓ agree.*✓ agree.*✅ 共识/);
    expect(joined).toMatch(/codex\s+claude\s+状态/);
  });

  it('无变更时友好退出（退出码 0，不调用任何 CLI 评审）', async () => {
    const repo = makeTmpRepo();
    const scenario = makeFakeScenario();
    const logs: string[] = [];
    const code = await main({ cwd: repo.dir, maxRounds: 3, timeoutMs: 30_000, env: scenario.env, log: (m) => logs.push(m) });
    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('没有可审查的变更');
    expect(scenario.calls('codex')).toHaveLength(0);
  });

  it('双方都无 finding 时跳过讨论与应用', async () => {
    const repo = makeTmpRepo();
    repo.write('a.txt', 'line1\nline2\n');
    const scenario = makeFakeScenario();
    scenario.setReply('codex', 1, JSON.stringify({ findings: [] }));
    scenario.setReply('claude', 1, JSON.stringify({ findings: [] }));
    const logs: string[] = [];
    const code = await main({ cwd: repo.dir, maxRounds: 3, timeoutMs: 30_000, env: scenario.env, log: (m) => logs.push(m) });
    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('双方都没有发现问题');
    expect(scenario.calls('claude')).toHaveLength(1); // 只有初始评审
  });

  it('maxRounds 耗尽后分歧条目进入 report.md 且不触发应用', async () => {
    const repo = makeTmpRepo();
    repo.write('a.txt', 'line1\nline2\n');
    const scenario = makeFakeScenario();
    scenario.setReply('codex', 1, review('1'));
    scenario.setReply('claude', 1, review('1'));
    scenario.setReply('codex', 2, JSON.stringify({ responses: [
      { findingId: 'cx-1', stance: 'agree', comment: 'ok', revisedSuggestion: null },
      { findingId: 'cl-1', stance: 'disagree', comment: 'no', revisedSuggestion: null },
    ] }));
    scenario.setReply('claude', 2, JSON.stringify({ responses: [
      { findingId: 'cx-1', stance: 'disagree', comment: 'no', revisedSuggestion: null },
      { findingId: 'cl-1', stance: 'agree', comment: 'ok', revisedSuggestion: null },
    ] }));

    const logs: string[] = [];
    const code = await main({ cwd: repo.dir, maxRounds: 1, timeoutMs: 30_000, env: scenario.env, log: (m) => logs.push(m) });

    expect(code).toBe(0);
    const dir = join(repo.dir, '.duet-review', readdirSync(join(repo.dir, '.duet-review'))[0]);
    const report = readFileSync(join(dir, 'report.md'), 'utf8');
    expect(report).toContain('分歧');
    expect(scenario.calls('claude')).toHaveLength(2); // 初评 + 1 轮讨论，无应用调用
    expect(logs.some((l) => l.includes('分歧 2 条待人工裁决'))).toBe(true);
  });

  it('codex/claude CLI 不可用时报可读错误', async () => {
    const repo = makeTmpRepo();
    const env = { ...process.env, PATH: '/nonexistent' };
    await expect(
      main({ cwd: repo.dir, maxRounds: 3, timeoutMs: 5_000, env, log: () => {} }),
    ).rejects.toThrow(/未找到可用的 (codex|claude) CLI/);
  });
});
