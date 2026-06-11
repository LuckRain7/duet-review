#!/usr/bin/env node
import { Command } from 'commander';
import { main } from './main.js';

const program = new Command();
program
  .name('duet-review')
  .description('codex × claude 双评审：并行 review、多轮讨论、自动应用共识修改')
  .option('--max-rounds <n>', '讨论轮数上限', '3')
  .option('--timeout <minutes>', '单次 CLI 调用超时（分钟）', '10')
  .parse();

const opts = program.opts<{ maxRounds: string; timeout: string }>();
const maxRounds = Number(opts.maxRounds);
const timeoutMinutes = Number(opts.timeout);

if (!Number.isInteger(maxRounds) || maxRounds < 1) {
  console.error('✖ --max-rounds 必须是 ≥1 的整数');
  process.exit(1);
}
if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
  console.error('✖ --timeout 必须是正数（分钟）');
  process.exit(1);
}

main({ cwd: process.cwd(), maxRounds, timeoutMs: timeoutMinutes * 60_000 }).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
