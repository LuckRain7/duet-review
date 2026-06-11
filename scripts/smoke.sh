#!/usr/bin/env bash
# 真实 CLI 冒烟测试：消耗真实 token，仅手动运行。
# 在临时仓库制造明显 bug，跑完整 duet-review 流程。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
pnpm -C "$ROOT" build

TMP=$(mktemp -d)
cd "$TMP"
git init -b main -q
git config user.email smoke@example.com
git config user.name smoke

cat > calc.js <<'EOF'
function divide(a, b) {
  return a / b;
}
module.exports = { divide };
EOF
git add . && git commit -qm init

cat > calc.js <<'EOF'
function divide(a, b) {
  return a / b;
}
function parseAmount(s) {
  return parseInt(s);
}
module.exports = { divide, parseAmount };
EOF

node "$ROOT/dist/cli.js" --max-rounds 2

echo '=== 应用后的 calc.js ==='
cat calc.js
echo '=== 存档目录 ==='
ls .duet-review/*/
