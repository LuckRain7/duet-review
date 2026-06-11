import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initTracked } from '../src/orchestrator.js';
import type { Finding } from '../src/types.js';
import { Spinner, displayWidth, padDisplay, renderFileTree, renderFindingsPanel, renderStanceTable, truncateDisplay } from '../src/ui.js';

function makeFakeStream(isTTY: boolean) {
  const chunks: string[] = [];
  return {
    chunks,
    stream: { isTTY, write: (s: string) => { chunks.push(s); return true; } },
  };
}

const finding = (id: string, over: Partial<Finding> = {}): Finding => ({
  id, file: 'src/git.ts', line: 24, severity: 'major',
  title: '错误处理遗漏 stderr 信息', description: 'D', suggestion: 'S', ...over,
});

describe('displayWidth', () => {
  it('ASCII 每字符宽 1', () => {
    expect(displayWidth('abc')).toBe(3);
  });

  it('CJK 每字符宽 2', () => {
    expect(displayWidth('中文')).toBe(4);
    expect(displayWidth('a中b')).toBe(4);
  });

  it('全角标点宽 2', () => {
    expect(displayWidth('（）')).toBe(4);
  });
});

describe('padDisplay', () => {
  it('按显示宽度补空格', () => {
    expect(padDisplay('中', 5)).toBe('中   ');
    expect(padDisplay('ab', 4)).toBe('ab  ');
  });

  it('超宽不截断也不补', () => {
    expect(padDisplay('中文字', 4)).toBe('中文字');
  });
});

describe('renderFindingsPanel', () => {
  const tracked = initTracked(
    [finding('1'), finding('2', { severity: 'minor', file: 'src/parse.ts', line: 10, title: '正则可能误匹配代码块' })],
    [finding('1', { file: 'src/main.ts', line: 48, title: '日志缺少变更文件列表' })],
  );

  it('双栏标题带各自数量', () => {
    const panel = renderFindingsPanel(tracked);
    expect(panel).toContain('─ codex (2) ');
    expect(panel).toContain('─ claude (1) ');
  });

  it('左栏含 codex finding，右栏含 claude finding', () => {
    const lines = renderFindingsPanel(tracked).split('\n');
    const cx1 = lines.find((l) => l.includes('cx-1'))!;
    expect(cx1).toBeDefined();
    // cx-1 在分隔符左侧
    expect(cx1.indexOf('cx-1')).toBeLessThan(cx1.lastIndexOf('│') );
    const cl1 = lines.find((l) => l.includes('cl-1'))!;
    expect(cl1.indexOf('cl-1')).toBeGreaterThan(cl1.indexOf('│'));
  });

  it('展示 severity、位置与标题', () => {
    const panel = renderFindingsPanel(tracked);
    expect(panel).toContain('[major]');
    expect(panel).toContain('src/parse.ts:10');
    expect(panel).toContain('日志缺少变更文件列表');
  });

  it('所有行显示宽度一致（CJK 对齐）', () => {
    const lines = renderFindingsPanel(tracked).split('\n');
    const widths = new Set(lines.map((l) => displayWidth(l)));
    expect(widths.size).toBe(1);
  });

  it('一侧为空时显示（无）', () => {
    const onlyCodex = initTracked([finding('1')], []);
    expect(renderFindingsPanel(onlyCodex)).toContain('（无）');
  });
});

describe('renderStanceTable', () => {
  const tracked = initTracked([finding('1'), finding('2')], [finding('1')]);

  it('包含表头与每条 finding 的行', () => {
    tracked[0].claudeStance = 'agree';
    tracked[0].state = 'consensus';
    tracked[1].claudeStance = 'disagree';
    tracked[2].state = 'dropped';
    const table = renderStanceTable(tracked);
    const lines = table.split('\n');
    expect(lines[0]).toMatch(/codex\s+claude\s+状态/);
    expect(table).toContain('cx-1');
    expect(table).toContain('cx-2');
    expect(table).toContain('cl-1');
  });

  it('立场与状态符号正确', () => {
    const t = initTracked([finding('1')], [finding('1')]);
    t[0].claudeStance = 'agree';
    t[0].state = 'consensus';
    t[1].claudeStance = 'disagree' as const;
    const table = renderStanceTable(t);
    const row1 = table.split('\n').find((l) => l.startsWith(' cx-1'))!;
    expect(row1).toContain('✓ agree');
    expect(row1).toContain('✅ 共识');
    const row2 = table.split('\n').find((l) => l.startsWith(' cl-1'))!;
    expect(row2).toContain('✗ disagree');
    expect(row2).toContain('⏳ 待定');
  });

  it('dropped 与 disputed 状态有对应标识', () => {
    const t = initTracked([finding('1'), finding('2')], []);
    t[0].state = 'dropped';
    t[1].state = 'disputed';
    const table = renderStanceTable(t);
    expect(table).toContain('🗑 撤销');
    expect(table).toContain('⚠️ 分歧');
  });

  it('pending 立场显示待表态', () => {
    const t = initTracked([finding('1')], []);
    expect(renderStanceTable(t)).toContain('· pending');
  });
});

describe('Spinner', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('TTY 下周期性重绘动画帧与已等待秒数', () => {
    const { chunks, stream } = makeFakeStream(true);
    const spinner = new Spinner(stream);
    spinner.start('初始评审中…');
    vi.advanceTimersByTime(1300);
    spinner.stop();
    const all = chunks.join('');
    expect(all).toContain('初始评审中…');
    expect(all).toContain('⠋');
    expect(all).toContain('1s');
    expect(all).toContain('\r');
  });

  it('stop 后清行且不再输出', () => {
    const { chunks, stream } = makeFakeStream(true);
    const spinner = new Spinner(stream);
    spinner.start('等待中');
    vi.advanceTimersByTime(200);
    spinner.stop();
    const lenAfterStop = chunks.length;
    expect(chunks[chunks.length - 1]).toContain('\x1b[K');
    vi.advanceTimersByTime(1000);
    expect(chunks.length).toBe(lenAfterStop);
  });

  it('update 替换文案但保留计时', () => {
    const { chunks, stream } = makeFakeStream(true);
    const spinner = new Spinner(stream);
    spinner.start('codex 评审中 · claude 评审中');
    vi.advanceTimersByTime(2000);
    spinner.update('codex 已完成 · claude 评审中');
    vi.advanceTimersByTime(200);
    spinner.stop();
    const all = chunks.join('');
    expect(all).toContain('codex 已完成 · claude 评审中');
    expect(all).toContain('2s');
  });

  it('interrupt 清掉动画行、打印日志后动画继续', () => {
    const { chunks, stream } = makeFakeStream(true);
    const spinner = new Spinner(stream);
    spinner.start('等待中');
    vi.advanceTimersByTime(200);
    spinner.interrupt('第 1 轮结束');
    expect(chunks.join('')).toContain('第 1 轮结束\n');
    const len = chunks.length;
    vi.advanceTimersByTime(200);
    expect(chunks.length).toBeGreaterThan(len); // 动画仍在重绘
    spinner.stop();
  });

  it('非 TTY 下动画静默，interrupt 仍输出日志行', () => {
    const { chunks, stream } = makeFakeStream(false);
    const spinner = new Spinner(stream);
    spinner.start('等待中');
    vi.advanceTimersByTime(500);
    spinner.interrupt('一条日志');
    spinner.stop();
    expect(chunks.join('')).toBe('一条日志\n');
  });
});

describe('renderFileTree', () => {
  it('根级文件直接按行列出', () => {
    expect(renderFileTree(['b.txt', 'a.txt'])).toBe('a.txt\nb.txt');
  });

  it('同目录文件归组到目录下，使用 ├── 与 └── 连接符', () => {
    expect(renderFileTree(['src/a.ts', 'src/b.ts'])).toBe(
      ['src/', '├── a.ts', '└── b.ts'].join('\n'),
    );
  });

  it('单子节点目录链合并为一段路径', () => {
    expect(renderFileTree(['src/util/chat/a.ts', 'src/util/chat/b.ts'])).toBe(
      ['src/util/chat/', '├── a.ts', '└── b.ts'].join('\n'),
    );
  });

  it('唯一文件的目录链整体折叠为一行', () => {
    expect(renderFileTree(['src/only/index.ts'])).toBe('src/only/index.ts');
  });

  it('嵌套子树用 │ 延续竖线，末枝用空白缩进', () => {
    expect(renderFileTree(['src/a/x.ts', 'src/a/y.ts', 'src/b.ts'])).toBe(
      [
        'src/',
        '├── a/',
        '│   ├── x.ts',
        '│   └── y.ts',
        '└── b.ts',
      ].join('\n'),
    );
  });

  it('目录排在文件之前', () => {
    expect(renderFileTree(['src/aaa.ts', 'src/zzz/x.ts', 'src/zzz/y.ts'])).toBe(
      [
        'src/',
        '├── zzz/',
        '│   ├── x.ts',
        '│   └── y.ts',
        '└── aaa.ts',
      ].join('\n'),
    );
  });
});

describe('truncateDisplay', () => {
  it('显示宽度内原样返回', () => {
    expect(truncateDisplay('abc', 5)).toBe('abc');
  });

  it('超宽按显示宽度截断并加省略号', () => {
    expect(truncateDisplay('中文标题很长', 9)).toBe('中文标题…');
    expect(displayWidth(truncateDisplay('中文标题很长', 9))).toBeLessThanOrEqual(9);
  });
});
