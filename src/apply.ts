import { buildApplyPrompt } from './prompts.js';
import type { TrackedFinding } from './types.js';

export interface ApplyDeps {
  consensus: TrackedFinding[];
  /** 由 ClaudeReviewer.applyFix 绑定而来 */
  applyFix: (prompt: string) => Promise<string>;
  onProgress: (message: string) => void;
}

export async function applyConsensus(deps: ApplyDeps): Promise<string | null> {
  if (deps.consensus.length === 0) {
    deps.onProgress('没有达成共识的修改项，跳过应用阶段');
    return null;
  }
  deps.onProgress(`应用 ${deps.consensus.length} 条共识修改（由 claude 执行）…`);
  return deps.applyFix(buildApplyPrompt(deps.consensus));
}
