#!/bin/bash
# 全検証スイートを「順番に」実行する（実DBスイートの並行実行は誤判定の元）。
# 使い方:
#   bash scripts/verify-all.sh              # 全部
#   bash scripts/verify-all.sh fresh lobby  # 名前を指定したものだけ
# 終了コード: 1つでも失敗したら 1。
# verify-realtime-dm は VM から WSS が張れないため対象外（実機確認領域）。
cd "$(dirname "$0")/.." || exit 1

SUITES=(
  function-guards.py
  verify-lobby verify-social-ui verify-game-ui verify-kick-side
  verify-spec-gaps-ui verify-icons verify-social verify-penalty
  verify-fresh verify-supabase-mode verify-wordwolf-db
  verify-startflow-db verify-penalty-db verify-genre-db
  verify-icons-invite-db verify-ng-db verify-appeals-db verify-auth-db
  verify-clear-db verify-ticker-db verify-tutorial-db verify-e2e-session
  verify-group-db verify-gameflows-db verify-moderation2-db verify-push-db
  verify-spec-gaps-db verify-stall-kick-db verify-dissolve-db
)

if [ "$#" -gt 0 ]; then
  WANTED=()
  for a in "$@"; do
    if [ "$a" = "function-guards.py" ]; then WANTED+=("function-guards.py");
    else WANTED+=("verify-$a"); fi
  done
  SUITES=("${WANTED[@]}")
fi

FAILED=()
for s in "${SUITES[@]}"; do
  echo "===== $s"
  if [ "$s" = "function-guards.py" ]; then
    python3 scripts/function-guards.py > /tmp/va-out.txt 2>&1
  else
    timeout 600 node "scripts/$s.mjs" > /tmp/va-out.txt 2>&1
  fi
  rc=$?
  tail -1 /tmp/va-out.txt
  if [ $rc -ne 0 ]; then
    FAILED+=("$s")
    echo "!!!!! $s FAILED (rc=$rc) — 出力の末尾:"
    tail -5 /tmp/va-out.txt
  fi
done

echo
if [ "${#FAILED[@]}" -gt 0 ]; then
  echo "=== FAILED: ${FAILED[*]} ==="
  exit 1
fi
echo "=== ALL GREEN (${#SUITES[@]} suites) ==="
