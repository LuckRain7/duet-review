import { parseDiscussionOutput, parseReviewOutput } from './parse.js';
import { buildDiscussionPrompt, buildRetryPrompt } from './prompts.js';
import { REVIEWER_PREFIX, type DiscussionResponse, type Finding, type Reviewer, type ReviewerName, type TrackedFinding } from './types.js';

export function initTracked(codexFindings: Finding[], claudeFindings: Finding[]): TrackedFinding[] {
  const make = (f: Finding, author: ReviewerName): TrackedFinding => ({
    finding: { ...f, id: `${REVIEWER_PREFIX[author]}-${f.id}` },
    author,
    codexStance: author === 'codex' ? 'agree' : 'pending',
    claudeStance: author === 'claude' ? 'agree' : 'pending',
    state: 'open',
    history: [],
  });
  return [
    ...codexFindings.map((f) => make(f, 'codex')),
    ...claudeFindings.map((f) => make(f, 'claude')),
  ];
}

export function openFindings(tracked: TrackedFinding[]): TrackedFinding[] {
  return tracked.filter((t) => t.state === 'open');
}

export function applyResponses(
  tracked: TrackedFinding[],
  reviewer: ReviewerName,
  responses: DiscussionResponse[],
  round: number,
): void {
  const byId = new Map(tracked.map((t) => [t.finding.id, t]));
  for (const response of responses) {
    const t = byId.get(response.findingId);
    if (!t || t.state !== 'open') continue; // 容忍模型回应了未知/已关闭条目
    t.history.push({ round, reviewer, response });

    let stance = response.stance;
    if (stance === 'withdraw' && t.author !== reviewer) stance = 'disagree';
    if (stance === 'modify') {
      if (response.revisedSuggestion) {
        // 同轮双方都 modify 时为 last-write-wins：后应用方的 revision 覆盖生效，
        // 先应用方的 revision 保留在 history 中，其 stance 被重置为 pending，下轮对新版本重新表态。
        t.finding.suggestion = response.revisedSuggestion;
        // 修订者认可新版本，另一方需重新表态
        if (reviewer === 'codex') { t.codexStance = 'agree'; t.claudeStance = 'pending'; }
        else { t.claudeStance = 'agree'; t.codexStance = 'pending'; }
        continue;
      }
      stance = 'disagree';
    }
    if (stance === 'withdraw') { t.state = 'dropped'; continue; }
    // 同轮双方并行回应：若对方本轮已修订此条目，本方的表态针对的是旧版本，
    // 不计入立场（保持 pending），下轮对新版本重新表态；意见仍留在 history。
    const revisedByOtherThisRound = t.history.some(
      (h) => h.round === round && h.reviewer !== reviewer
        && h.response.stance === 'modify' && h.response.revisedSuggestion,
    );
    if (revisedByOtherThisRound) continue;
    if (reviewer === 'codex') t.codexStance = stance;
    else t.claudeStance = stance;
  }
}

export function evaluate(tracked: TrackedFinding[]): void {
  for (const t of tracked) {
    if (t.state !== 'open') continue;
    if (t.codexStance === 'agree' && t.claudeStance === 'agree') t.state = 'consensus';
  }
}

export interface DiscussionDeps {
  codex: Reviewer;
  claude: Reviewer;
  /** 会被就地变更：state/stance/suggestion/history 在讨论过程中直接更新 */
  tracked: TrackedFinding[];
  maxRounds: number;
  onProgress: (message: string) => void;
  /** 每轮双方原始输出的存档回调（可选） */
  onRoundOutput?: (round: number, reviewer: ReviewerName, raw: string) => void;
  /** 每轮开始等待双方回应前触发（用于展示层启动等待动画） */
  onRoundStart?: (round: number, openCount: number) => void;
  /** 每轮立场结算后触发，current 为当前全量 tracked 状态 */
  onRoundEnd?: (round: number, current: TrackedFinding[]) => void;
}

async function askWithRetry(reviewer: Reviewer, prompt: string): Promise<{ raw: string; responses: DiscussionResponse[] }> {
  const first = await reviewer.reply(prompt);
  try {
    return { raw: first, responses: parseDiscussionOutput(first).responses };
  } catch (e) {
    const second = await reviewer.reply(buildRetryPrompt((e as Error).message));
    try {
      return { raw: second, responses: parseDiscussionOutput(second).responses };
    } catch (e2) {
      throw new Error(`${reviewer.name} 的讨论输出重试后仍无法解析: ${(e2 as Error).message}`);
    }
  }
}

export async function runDiscussion(deps: DiscussionDeps): Promise<{ rounds: number }> {
  const { codex, claude, tracked, maxRounds, onProgress, onRoundOutput } = deps;
  let round = 0;
  while (round < maxRounds) {
    const open = openFindings(tracked);
    if (open.length === 0) break;
    round++;
    onProgress(`第 ${round}/${maxRounds} 轮讨论：${open.length} 条 finding 待收敛`);
    deps.onRoundStart?.(round, open.length);

    const [codexOut, claudeOut] = await Promise.all([
      askWithRetry(codex, buildDiscussionPrompt('codex', open, round)),
      askWithRetry(claude, buildDiscussionPrompt('claude', open, round)),
    ]);
    onRoundOutput?.(round, 'codex', codexOut.raw);
    onRoundOutput?.(round, 'claude', claudeOut.raw);

    applyResponses(tracked, 'codex', codexOut.responses, round);
    applyResponses(tracked, 'claude', claudeOut.responses, round);
    evaluate(tracked);

    const stats = {
      consensus: tracked.filter((t) => t.state === 'consensus').length,
      dropped: tracked.filter((t) => t.state === 'dropped').length,
      open: openFindings(tracked).length,
    };
    onProgress(`第 ${round} 轮结束：共识 ${stats.consensus}，撤销 ${stats.dropped}，待定 ${stats.open}`);
    deps.onRoundEnd?.(round, tracked);
  }

  for (const t of tracked) if (t.state === 'open') t.state = 'disputed';
  return { rounds: round };
}

export interface InitialReviewDeps {
  codex: Reviewer;
  claude: Reviewer;
  prompt: string;
  onProgress: (message: string) => void;
  onOutput?: (reviewer: ReviewerName, raw: string) => void;
  /** 单个 reviewer 初评完成（含解析成功）时触发 */
  onReviewerDone?: (reviewer: ReviewerName) => void;
}

async function startWithRetry(reviewer: Reviewer, prompt: string): Promise<{ raw: string; findings: Finding[] }> {
  const first = await reviewer.start(prompt);
  try {
    return { raw: first, findings: parseReviewOutput(first).findings };
  } catch (e) {
    const second = await reviewer.reply(buildRetryPrompt((e as Error).message));
    try {
      return { raw: second, findings: parseReviewOutput(second).findings };
    } catch (e2) {
      throw new Error(`${reviewer.name} 的初始评审输出重试后仍无法解析: ${(e2 as Error).message}`);
    }
  }
}

export async function runInitialReviews(deps: InitialReviewDeps): Promise<{
  codexFindings: Finding[];
  claudeFindings: Finding[];
}> {
  deps.onProgress('并行启动 codex 与 claude 初始评审…');
  const withDone = <T>(p: Promise<T>, name: ReviewerName) =>
    p.then((r) => { deps.onReviewerDone?.(name); return r; });
  const [cx, cl] = await Promise.all([
    withDone(startWithRetry(deps.codex, deps.prompt), 'codex'),
    withDone(startWithRetry(deps.claude, deps.prompt), 'claude'),
  ]);
  deps.onOutput?.('codex', cx.raw);
  deps.onOutput?.('claude', cl.raw);
  deps.onProgress(`初始评审完成：codex ${cx.findings.length} 条，claude ${cl.findings.length} 条`);
  return { codexFindings: cx.findings, claudeFindings: cl.findings };
}
