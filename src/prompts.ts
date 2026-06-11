import type { ReviewerName, TrackedFinding } from './types.js';

const FINDING_JSON_SPEC = `输出必须是一个 JSON 对象，且只输出 JSON，不要输出其他文字：
{
  "findings": [
    {
      "id": "短且稳定的标识，如 f1、f2",
      "file": "相对路径",
      "line": 行号数字或 null,
      "severity": "critical | major | minor | nit",
      "title": "一句话标题",
      "description": "问题说明",
      "suggestion": "具体修改建议，含必要代码片段"
    }
  ]
}
没有问题时输出 {"findings": []}。`;

const RESPONSE_JSON_SPEC = `输出必须是一个 JSON 对象，且只输出 JSON，不要输出其他文字：
{
  "responses": [
    {
      "findingId": "对应 finding 的 id",
      "stance": "agree | disagree | modify | withdraw",
      "comment": "理由",
      "revisedSuggestion": "stance=modify 时给出修订后的完整建议，否则为 null"
    }
  ]
}
立场含义：agree=认可当前建议；disagree=反对并给出理由；modify=建议修订（必须给 revisedSuggestion）；withdraw=撤回自己提出的 finding（只能用于自己提出的条目）。`;

export function buildInitialReviewPrompt(patch: string, source: 'staged' | 'unstaged'): string {
  return `你是一名严格的代码评审者。请审查下面这份 ${source} 的 git diff。
你可以读取仓库中的相关文件来理解上下文，但不要修改任何文件。
只报告 diff 中改动引入或直接相关的问题（正确性、安全、性能、可维护性），不要泛泛而谈。

${FINDING_JSON_SPEC}

=== DIFF 开始 ===
${patch}
=== DIFF 结束 ===`;
}

function renderFinding(t: TrackedFinding): string {
  const f = t.finding;
  const lastComments = t.history
    .slice(-2)
    .map((h) => `  - [${h.reviewer} 第${h.round}轮 ${h.response.stance}] ${h.response.comment}`)
    .join('\n');
  return `- id: ${f.id}（提出方: ${t.author}）
  file: ${f.file}${f.line ? `:${f.line}` : ''}  severity: ${f.severity}
  title: ${f.title}
  description: ${f.description}
  当前 suggestion: ${f.suggestion}${lastComments ? `\n  最新讨论:\n${lastComments}` : ''}`;
}

export function buildDiscussionPrompt(_me: ReviewerName, open: TrackedFinding[], round: number): string {
  return `这是第 ${round} 轮讨论。下面是仍未达成共识的 findings（含双方最新意见）。
请逐条表态：对方提出的条目你可以 agree / disagree / modify；你自己提出的条目，若被说服可以 withdraw，若想修订可以 modify，坚持则 agree。
必须覆盖下列所有 findingId，不得遗漏。

${open.map(renderFinding).join('\n\n')}

${RESPONSE_JSON_SPEC}`;
}

export function buildRetryPrompt(parseError: string): string {
  return `你上一条输出无法解析为要求的 JSON：${parseError}
请重新输出，只输出符合 schema 的 JSON 对象，不要包含任何其他文字或代码块标记。`;
}

export function buildApplyPrompt(consensus: TrackedFinding[]): string {
  return `讨论已结束。下面是双方达成共识的修改项，请把它们逐条应用到工作区代码中。
要求：
1. 严格按照每条的 suggestion 实施；
2. 不要做任何列表之外的修改（不要顺手重构、不要改格式）；
3. 完成后用一段简短文字总结你改了哪些文件。

${consensus.map(renderFinding).join('\n\n')}`;
}

/** 传给 codex --output-schema 的 JSON Schema（初始 review） */
export const codexReviewSchema = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          file: { type: 'string' },
          line: { type: ['number', 'null'] },
          severity: { enum: ['critical', 'major', 'minor', 'nit'] },
          title: { type: 'string' },
          description: { type: 'string' },
          suggestion: { type: 'string' },
        },
        required: ['id', 'file', 'line', 'severity', 'title', 'description', 'suggestion'],
        additionalProperties: false,
      },
    },
  },
  required: ['findings'],
  additionalProperties: false,
} as const;

/** 传给 codex --output-schema 的 JSON Schema（讨论轮） */
export const codexDiscussionSchema = {
  type: 'object',
  properties: {
    responses: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          findingId: { type: 'string' },
          stance: { enum: ['agree', 'disagree', 'modify', 'withdraw'] },
          comment: { type: 'string' },
          revisedSuggestion: { type: ['string', 'null'] },
        },
        required: ['findingId', 'stance', 'comment', 'revisedSuggestion'],
        additionalProperties: false,
      },
    },
  },
  required: ['responses'],
  additionalProperties: false,
} as const;
