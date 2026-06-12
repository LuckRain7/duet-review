import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyConsensus } from './apply.js';
import { NoDiffError, collectDiff, ensureGitRepo } from './git.js';
import { initTracked, runDiscussion, runInitialReviews } from './orchestrator.js';
import { buildInitialReviewPrompt, codexDiscussionSchema, codexReviewSchema } from './prompts.js';
import { Archive, renderReport } from './report.js';
import { ClaudeReviewer } from './reviewers/claude.js';
import { CodexReviewer } from './reviewers/codex.js';
import type { ReviewerName } from './types.js';
import { Spinner, renderFileTree, renderFindingsPanel, renderStanceTable } from './ui.js';
import { runCli } from './utils/proc.js';

export interface MainOptions {
  cwd: string;
  maxRounds: number;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}

async function ensureCli(cmd: string, env: NodeJS.ProcessEnv | undefined): Promise<void> {
  let failure: string | null = null;
  try {
    const res = await runCli(cmd, ['--version'], { env, timeoutMs: 30_000 });
    if (res.code !== 0) failure = res.stderr.trim();
  } catch (e) {
    failure = (e as Error).message;
  }
  if (failure !== null) throw new Error(`未找到可用的 ${cmd} CLI，请先安装并登录（${failure}）`);
}

export async function main(options: MainOptions): Promise<number> {
  // 注入了自定义 log（测试/管道）时动画静默；直连终端时 spinner 接管输出行
  const spinner = new Spinner(options.log ? { isTTY: false, write: () => true } : process.stdout);
  const log = options.log ?? ((m: string) => spinner.interrupt(m));
  const { cwd, env } = options;

  await Promise.all([ensureCli('codex', env), ensureCli('claude', env)]);
  await ensureGitRepo(cwd);

  let diff;
  try {
    diff = await collectDiff(cwd);
  } catch (e) {
    if (e instanceof NoDiffError) {
      log(e.message);
      return 0;
    }
    throw e;
  }
  log(`审查对象: ${diff.label} diff（${diff.patch.split('\n').length} 行，${diff.files.length} 个文件）`);
  for (const line of renderFileTree(diff.files).split('\n')) log(`  ${line}`);

  const archive = new Archive(cwd);
  try {
    archive.write('00-diff.patch', diff.patch);
    const reviewSchemaFile = join(archive.dir, 'codex-review-schema.json');
    const discussionSchemaFile = join(archive.dir, 'codex-discussion-schema.json');
    writeFileSync(reviewSchemaFile, JSON.stringify(codexReviewSchema, null, 2));
    writeFileSync(discussionSchemaFile, JSON.stringify(codexDiscussionSchema, null, 2));

    // 实时透出双方代理的过程输出（思考/命令/工具调用/消息），TTY 下置灰与主日志区分
    const dim = !options.log && process.stdout.isTTY ? (s: string) => `\x1b[2m${s}\x1b[0m` : (s: string) => s;
    const onActivity = (name: ReviewerName) => (text: string) => {
      for (const line of text.split('\n')) log(dim(`  [${name}] ${line}`));
    };
    const codex = new CodexReviewer({
      cwd, timeoutMs: options.timeoutMs, reviewSchemaFile, discussionSchemaFile, env,
      onActivity: onActivity('codex'),
    });
    const claude = new ClaudeReviewer({ cwd, timeoutMs: options.timeoutMs, env, onActivity: onActivity('claude') });

    const reviewing = new Set<ReviewerName>(['codex', 'claude']);
    const reviewStatus = () =>
      `初始评审中（${(['codex', 'claude'] as const).map((n) => `${n} ${reviewing.has(n) ? '⏳' : '✓'}`).join(' · ')}）`;
    spinner.start(reviewStatus());
    const initial = await runInitialReviews({
      codex, claude,
      prompt: buildInitialReviewPrompt(diff.patch, diff.label),
      onProgress: log,
      onOutput: (reviewer, raw) => archive.write(`01-${reviewer}-review.json`, raw),
      onReviewerDone: (reviewer) => {
        reviewing.delete(reviewer);
        spinner.update(reviewStatus());
      },
    });
    spinner.stop();

    const tracked = initTracked(initial.codexFindings, initial.claudeFindings);
    if (tracked.length === 0) {
      log('双方都没有发现问题 🎉');
      archive.write('report.md', renderReport({ label: diff.label, rounds: 0, tracked, applySummary: null }));
      return 0;
    }
    log('');
    log(renderFindingsPanel(tracked, process.stdout.isTTY ? (process.stdout.columns ?? 80) : 100));

    const { rounds } = await runDiscussion({
      codex, claude, tracked,
      maxRounds: options.maxRounds,
      onProgress: log,
      // 轮次文件序号 = round+1，使其在目录中排在 01-*-review.json 之后
      onRoundOutput: (round, reviewer, raw) =>
        archive.write(`${String(round + 1).padStart(2, '0')}-${reviewer}-round.json`, raw),
      onRoundStart: (round, openCount) =>
        spinner.start(`第 ${round}/${options.maxRounds} 轮讨论：${openCount} 条待收敛，等待双方回应…`),
      onRoundEnd: (_round, current) => {
        spinner.stop();
        log(renderStanceTable(current));
        log('');
      },
    });

    const consensus = tracked.filter((t) => t.state === 'consensus');
    const disputed = tracked.filter((t) => t.state === 'disputed');

    if (consensus.length > 0) spinner.start(`应用 ${consensus.length} 条共识修复中…`);
    const applySummary = await applyConsensus({
      consensus,
      applyFix: (prompt) => claude.applyFix(prompt),
      onProgress: log,
    });
    spinner.stop();

    archive.write('consensus.json', JSON.stringify(tracked, null, 2));
    archive.write('report.md', renderReport({ label: diff.label, rounds, tracked, applySummary }));

    log('');
    log(`完成：共识 ${consensus.length} 条已应用，分歧 ${disputed.length} 条待人工裁决`);
    for (const t of disputed) log(`  ⚠ ${t.finding.id} ${t.finding.title}（${t.finding.file}）`);
    log(`完整记录: ${archive.dir}`);

    const gitignorePath = join(cwd, '.gitignore');
    const ignored = existsSync(gitignorePath) && readFileSync(gitignorePath, 'utf8').includes('.duet-review');
    if (!ignored) log('提示: 建议把 .duet-review/ 加入 .gitignore');

    return 0;
  } catch (e) {
    log(`运行中断，已生成的部分存档: ${archive.dir}`);
    throw e;
  } finally {
    spinner.stop();
  }
}
