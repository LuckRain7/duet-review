import { z } from 'zod';

export const severitySchema = z.enum(['critical', 'major', 'minor', 'nit']);

export const findingSchema = z.object({
  id: z.string().min(1),
  file: z.string().min(1),
  line: z.number().int().positive().nullable(),
  severity: severitySchema,
  title: z.string().min(1),
  description: z.string(),
  suggestion: z.string(),
});

export const reviewOutputSchema = z.object({
  findings: z.array(findingSchema),
});

export const stanceSchema = z.enum(['agree', 'disagree', 'modify', 'withdraw']);

export const responseSchema = z.object({
  findingId: z.string().min(1),
  stance: stanceSchema,
  comment: z.string(),
  revisedSuggestion: z.string().nullable(),
});

export const discussionOutputSchema = z.object({
  responses: z.array(responseSchema),
});

export type Severity = z.infer<typeof severitySchema>;
export type Finding = z.infer<typeof findingSchema>;
export type ReviewOutput = z.infer<typeof reviewOutputSchema>;
export type Stance = z.infer<typeof stanceSchema>;
export type DiscussionResponse = z.infer<typeof responseSchema>;
export type DiscussionOutput = z.infer<typeof discussionOutputSchema>;

export type ReviewerName = 'codex' | 'claude';

/** finding id 前缀，双方各自命名空间防撞 id；initTracked 与讨论 prompt 共用 */
export const REVIEWER_PREFIX: Record<ReviewerName, string> = { codex: 'cx', claude: 'cl' };

/** 双方 reviewer 的统一接口；start 建立会话，reply 续接会话 */
export interface Reviewer {
  readonly name: ReviewerName;
  start(prompt: string): Promise<string>;
  reply(prompt: string): Promise<string>;
}

/** 内部立场：pending 表示该方还未对当前版本的 suggestion 表态 */
export type InternalStance = Stance | 'pending';

export type FindingState = 'open' | 'consensus' | 'dropped' | 'disputed';

export interface TrackedFinding {
  finding: Finding; // 当前内容（modify 后 suggestion 会被更新）
  author: ReviewerName;
  codexStance: InternalStance;
  claudeStance: InternalStance;
  state: FindingState;
  history: Array<{ round: number; reviewer: ReviewerName; response: DiscussionResponse }>;
}
