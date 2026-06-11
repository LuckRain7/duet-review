import { discussionOutputSchema, reviewOutputSchema, type DiscussionOutput, type ReviewOutput } from './types.js';

/** 规范化单个 finding 对象，补全真实 CLI 可能省略的 id / title 字段 */
function normalizeFinding(f: Record<string, unknown>, idx: number): Record<string, unknown> {
  const normalized = { ...f };
  if (!normalized.id || typeof normalized.id !== 'string') {
    normalized.id = `f${idx + 1}`;
  }
  if (!normalized.title || typeof normalized.title !== 'string') {
    const desc = typeof normalized.description === 'string' ? normalized.description : '';
    normalized.title = desc.split(/[.。!！]/)[0].trim().slice(0, 80) || `finding-${idx + 1}`;
  }
  // 未知 severity 不做映射，留给 zod 校验拒绝 → 触发一次重试，仍失败则硬错误。
  // 有意不静默降级：宁可让模型重新输出，也不替它猜严重程度。
  // 规范化 severity：真实 codex 可能输出 "warning" 等非标准值
  if (typeof normalized.severity === 'string') {
    const sev = normalized.severity.toLowerCase();
    if (sev === 'error' || sev === 'critical') normalized.severity = 'critical';
    else if (sev === 'warning' || sev === 'warn' || sev === 'major') normalized.severity = 'major';
    else if (sev === 'info' || sev === 'minor') normalized.severity = 'minor';
    else if (sev === 'nit' || sev === 'style') normalized.severity = 'nit';
  }
  return normalized;
}

/** 规范化 findings 数组 */
function normalizeFindings(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || !('findings' in raw)) return raw;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.findings)) return raw;
  return { ...obj, findings: obj.findings.map((f: unknown, i: number) =>
    f !== null && typeof f === 'object' ? normalizeFinding(f as Record<string, unknown>, i) : f
  ) };
}

/** 从模型输出文本中提取第一个配平的 JSON 对象（容忍 markdown 代码块与前后说明文字） */
export function extractJson(text: string): unknown {
  // 只匹配明确标记为 json 的代码块，避免误抓 suggestion 字段内嵌的 ```js 代码示例
  const fenced = text.match(/```json\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  if (start === -1) throw new Error('输出中未找到 JSON 对象');

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return JSON.parse(candidate.slice(start, i + 1));
    }
  }
  throw new Error('输出中的 JSON 对象不完整');
}

function formatZodError(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .map((i) => `${i.path.join('.')}: ${i.message}`)
    .join('; ');
}

export function parseReviewOutput(text: string): ReviewOutput {
  const raw = normalizeFindings(extractJson(text));
  const result = reviewOutputSchema.safeParse(raw);
  if (!result.success) throw new Error(`findings 不符合 schema —— ${formatZodError(result.error)}`);
  return result.data;
}

export function parseDiscussionOutput(text: string): DiscussionOutput {
  const raw = extractJson(text);
  const result = discussionOutputSchema.safeParse(raw);
  if (!result.success) throw new Error(`responses 不符合 schema —— ${formatZodError(result.error)}`);
  return result.data;
}
