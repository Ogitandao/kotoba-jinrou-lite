#!/bin/bash
# 全検証スイートを「順番に」実行する（実DBスイートの並行実行は誤判定の元）。
# 使い方:
#   bash scripts/verify-all.sh              # 全部（ただし push は除く。下記）
#   bash scripts/verify-all.sh fresh lobby  # 名前を指定したものだけ
#   bash scripts/verify-all.sh --with-push  # push も含めて全部
# 終了コード: 1つでも失敗したら 1。
# verify-realtime-dm は VM から WSS が張れないため対象外（実機確認領域）。
# verify-push-db は「お知らせ配信」の実送信テストを含み、全購読端末へ
# テスト通知が飛ぶため、既定では実行しない（2026-11-29 の日次チェックで
# 実際に通知が飛んだ事故による）。プッシュまわりを触ったときだけ
# --with-push で明示的に含めること。
cd "$(dirname "$0")/.." || exit 1

SUITES=(
  function-guards.py
  verify-lobby verify-social-ui verify-game-ui verify-kick-side
  verify-spec-gaps-ui verify-icons verify-social verify-penalty
  verify-fresh verify-supabase-mode verify-wordwolf-db
  verify-startflow-db verify-penalty-db verify-genre-db
  verify-icons-invite-db verify-ng-db verify-appeals-db verify-auth-db
  verify-clear-db verify-ticker-db verify-tutorial-db verify-e2e-session
  verify-group-db verify-gameflows-db verify-moderation2-db
  verify-spec-gaps-db verify-stall-kick-db verify-dissolve-db
)

WITH_PUSH=0
ARGS=()
for a in "$@"; do
  if [ "$a" = "--with-push" ]; then WITH_PUSH=1; else ARGS+=("$a"); fi
done
if [ "$WITH_PUSH" = "1" ]; then SUITES+=("verify-push-db"); fi
set -- "${ARGS[@]}"

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
