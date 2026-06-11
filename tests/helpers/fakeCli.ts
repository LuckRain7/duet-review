import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const FAKES_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../fakes/bin');

export interface FakeScenario {
  dir: string;
  /** PATH 前置假 bin、注入 DUET_FAKE_DIR 后的 env */
  env: NodeJS.ProcessEnv;
  setReply(cli: 'codex' | 'claude', n: number, content: string): void;
  calls(cli: 'codex' | 'claude'): Array<{ n: number; argv: string[]; stdin: string }>;
}

export function makeFakeScenario(): FakeScenario {
  chmodSync(join(FAKES_BIN, 'codex'), 0o755);
  chmodSync(join(FAKES_BIN, 'claude'), 0o755);
  const dir = mkdtempSync(join(tmpdir(), 'duet-review-fake-'));
  return {
    dir,
    env: {
      ...process.env,
      PATH: `${FAKES_BIN}:${process.env.PATH}`,
      DUET_FAKE_DIR: dir,
    },
    setReply(cli, n, content) {
      writeFileSync(join(dir, `${cli}-reply-${n}.txt`), content);
    },
    calls(cli) {
      try {
        return readFileSync(join(dir, `${cli}-calls.jsonl`), 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
  };
}
