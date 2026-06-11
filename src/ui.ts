import type { FindingState, InternalStance, TrackedFinding } from './types.js';

/** 终端展示层：CJK 宽度对齐、双栏面板、立场矩阵与 loading 动画 */

/** East Asian Wide/Fullwidth 的常用区段；够覆盖中文、全角标点、日文假名与常见 emoji */
function isWideChar(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) || // Hangul Jamo
    // 杂项符号区段里 EastAsianWidth=Wide 的 emoji（✅❌❗ 等）；✓✗⚠ 等 Neutral 符号保持宽 1
    codePoint === 0x2705 || (codePoint >= 0x2753 && codePoint <= 0x2755) || codePoint === 0x2757 ||
    codePoint === 0x274c || codePoint === 0x274e || (codePoint >= 0x2795 && codePoint <= 0x2797) ||
    (codePoint >= 0x2b1b && codePoint <= 0x2b1c) || codePoint === 0x2b50 || codePoint === 0x2b55 ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) || // CJK 部首/汉字/假名等
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) || // Hangul 音节
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK 兼容汉字
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) || // CJK 兼容形式
    (codePoint >= 0xff00 && codePoint <= 0xff60) || // 全角 ASCII/标点
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) || // emoji（🔴🟡🚀 等）
    (codePoint >= 0x20000 && codePoint <= 0x3fffd) // CJK 扩展
  );
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += isWideChar(ch.codePointAt(0)!) ? 2 : 1;
  return width;
}

export function padDisplay(text: string, width: number): string {
  const pad = width - displayWidth(text);
  return pad > 0 ? text + ' '.repeat(pad) : text;
}

/** 单条 finding 完整渲染：id+severity、file:line、title、description、suggestion，超宽折行不截字 */
function findingLines(t: TrackedFinding, colWidth: number): string[] {
  const { finding } = t;
  const loc = finding.line === null ? finding.file : `${finding.file}:${finding.line}`;
  return [
    `${finding.id} [${finding.severity}]`,
    loc,
    finding.title,
    '',
    finding.description,
    '',
    `建议: ${finding.suggestion}`,
  ].flatMap((l) => wrapDisplay(l, colWidth));
}

function columnLines(side: TrackedFinding[], colWidth: number): string[] {
  if (side.length === 0) return ['（无）'];
  return side.flatMap((t, i) => (i === 0 ? [] : ['']).concat(findingLines(t, colWidth)));
}

/** 初评结果双栏面板：codex 左栏，claude 右栏 */
export function renderFindingsPanel(tracked: TrackedFinding[], totalWidth = 80): string {
  const colWidth = Math.floor((totalWidth - 7) / 2); // │␣..␣│␣..␣│ 共 7 列边框/留白
  const codex = columnLines(tracked.filter((t) => t.author === 'codex'), colWidth);
  const claude = columnLines(tracked.filter((t) => t.author === 'claude'), colWidth);

  const header = (name: string, count: number) => {
    const label = `─ ${name} (${count}) `;
    return label + '─'.repeat(colWidth + 2 - displayWidth(label));
  };
  const codexCount = tracked.filter((t) => t.author === 'codex').length;
  const claudeCount = tracked.filter((t) => t.author === 'claude').length;

  const lines: string[] = [];
  lines.push('┌' + header('codex', codexCount) + '┬' + header('claude', claudeCount) + '┐');
  const height = Math.max(codex.length, claude.length);
  for (let i = 0; i < height; i++) {
    lines.push(`│ ${padDisplay(codex[i] ?? '', colWidth)} │ ${padDisplay(claude[i] ?? '', colWidth)} │`);
  }
  lines.push('└' + '─'.repeat(colWidth + 2) + '┴' + '─'.repeat(colWidth + 2) + '┘');
  return lines.join('\n');
}

type FileTreeNode = Map<string, FileTreeNode>;

/** 单子节点的目录链合并为一段路径，如 src/util/chat/ 或 src/only/index.ts */
function collapseChain(name: string, node: FileTreeNode): [string, FileTreeNode] {
  while (node.size === 1) {
    const [childName, child] = [...node.entries()][0];
    name = `${name}/${childName}`;
    node = child;
  }
  return [name, node];
}

function fileTreeLines(node: FileTreeNode, prefix: string, isRoot: boolean): string[] {
  const entries = [...node.entries()]
    .map(([name, child]) => collapseChain(name, child))
    .sort(([na, a], [nb, b]) => (b.size > 0 ? 1 : 0) - (a.size > 0 ? 1 : 0) || na.localeCompare(nb));
  return entries.flatMap(([name, child], i) => {
    const last = i === entries.length - 1;
    // 根级条目（可能多根并列）平铺不带连接符，子层级再开始画树枝
    const connector = isRoot ? '' : last ? '└── ' : '├── ';
    const childPrefix = isRoot ? '' : prefix + (last ? '    ' : '│   ');
    const label = child.size > 0 ? `${name}/` : name;
    return [prefix + connector + label, ...fileTreeLines(child, childPrefix, false)];
  });
}

/** 变更文件列表渲染为目录树 */
export function renderFileTree(files: string[]): string {
  const root: FileTreeNode = new Map();
  for (const file of files) {
    let node = root;
    for (const part of file.split('/')) {
      if (!node.has(part)) node.set(part, new Map());
      node = node.get(part)!;
    }
  }
  return fileTreeLines(root, '', true).join('\n');
}

const STANCE_MARK: Record<InternalStance, string> = {
  agree: '✓ agree',
  disagree: '✗ disagree',
  modify: '~ modify',
  withdraw: '⊘ withdraw',
  pending: '· pending',
};

const STATE_MARK: Record<FindingState, string> = {
  consensus: '✅ 共识',
  open: '⏳ 待定',
  dropped: '🗑 撤销',
  disputed: '⚠️ 分歧',
};

/** 每轮结束后的立场矩阵：finding × (codex, claude, 状态) */
export function renderStanceTable(tracked: TrackedFinding[]): string {
  const idWidth = Math.max(4, ...tracked.map((t) => displayWidth(t.finding.id)));
  const stanceWidth = 12;
  const lines = [
    ` ${padDisplay('', idWidth)}  ${padDisplay('codex', stanceWidth)}${padDisplay('claude', stanceWidth)}状态`,
  ];
  for (const t of tracked) {
    lines.push(
      ` ${padDisplay(t.finding.id, idWidth)}  ${padDisplay(STANCE_MARK[t.codexStance], stanceWidth)}${padDisplay(STANCE_MARK[t.claudeStance], stanceWidth)}${STATE_MARK[t.state]}`,
    );
  }
  return lines.join('\n');
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export interface SpinnerStream {
  isTTY?: boolean;
  write(s: string): boolean;
}

/** 等待动画：TTY 下单行重绘「⠋ 文案 12s」；非 TTY 静默，只透传 interrupt 的日志行 */
export class Spinner {
  private timer: NodeJS.Timeout | null = null;
  private text = '';
  private startedAt = 0;
  private frame = 0;

  constructor(
    private stream: SpinnerStream,
    private now: () => number = Date.now,
  ) {}

  private get tty(): boolean {
    return this.stream.isTTY === true;
  }

  start(text: string): void {
    this.stop();
    this.text = text;
    this.startedAt = this.now();
    this.frame = 0;
    if (!this.tty) return;
    this.render();
    this.timer = setInterval(() => this.render(), 100);
    this.timer.unref?.();
  }

  update(text: string): void {
    this.text = text;
    if (this.timer) this.render();
  }

  /** 在动画行之上打印一条日志，动画继续 */
  interrupt(line: string): void {
    this.clearLine();
    this.stream.write(line + '\n');
    if (this.timer) this.render();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.clearLine();
    this.timer = null;
  }

  private clearLine(): void {
    if (this.tty && this.timer) this.stream.write('\r\x1b[K');
  }

  private render(): void {
    const secs = Math.floor((this.now() - this.startedAt) / 1000);
    const elapsed = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
    const frame = SPINNER_FRAMES[this.frame++ % SPINNER_FRAMES.length];
    this.stream.write(`\r\x1b[K${frame} ${this.text} ${elapsed}`);
  }
}

/** 按显示宽度折行（CJK 字符宽 2），保留原有换行，不丢弃任何字符；tab 展开为空格避免边框错位 */
export function wrapDisplay(text: string, width: number): string[] {
  const out: string[] = [];
  for (const raw of text.replace(/\t/g, '    ').split('\n')) {
    if (displayWidth(raw) <= width) {
      out.push(raw);
      continue;
    }
    let line = '';
    let used = 0;
    for (const ch of raw) {
      const w = isWideChar(ch.codePointAt(0)!) ? 2 : 1;
      if (used + w > width) {
        out.push(line);
        line = '';
        used = 0;
      }
      line += ch;
      used += w;
    }
    out.push(line);
  }
  return out;
}
