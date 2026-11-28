#!/usr/bin/env python3
"""共有DB関数の「責務ガード」。

背景（2026-11-28 の回帰）: handle_new_user を表示名の都合で再定義した際、
0018 で入っていた ようこそDM の挿入が脱落し、誰にも気づかれなかった。
再定義は関数全体の置き換えになるため、変更対象でない責務まで消えうる。

このスクリプトは、監視対象の関数の現在の定義から「責務マーカー」
（書き込むテーブル / 呼び出す関数 / 投げるエラーコード）を抽出し、
基準ファイル（function-baseline.json）と照合する。基準にあるマーカーが
現在定義から消えていたら FAIL として報告する（＝写し漏らしの検知）。
新しいマーカーは参考表示のみ（意図した追加は失敗にしない）。

使い方:
  python3 scripts/function-guards.py                # 照合（CI・総ざらいで実行）
  python3 scripts/function-guards.py --write-baseline  # 基準を作り直す
      ※ 基準の更新は「責務の追加・削除を意図した変更」のときだけ行い、
        その意図を migration のコメントに残すこと。
"""
import json
import re
import subprocess
import sys
from pathlib import Path

REF = "dtdwkluanoaqiaruzbwe"
HELPER = "/home/hatch/workspace/custom-connectors/custom.supabase/bin/supabase_api.py"
BASELINE = Path(__file__).with_name("function-baseline.json")

# 監視対象：再定義されやすく、副作用が複数の責務を持つ共有関数
WATCH = [
    "handle_new_user",
    "ww_create_room",
    "ww_join_room",
    "ww_leave_room",
    "ww_kick_member",
    "ww_set_ready",
    "ww__start_game_now",
    "ww_start_game",
    "ww__advance_expired",
    "ww__terminate_set",
    "ww__detect_abandons",
    "ww__cleanup_lobby_rooms",
    "ww_sweep",
    "kl__detect_stalls",
    "kl__moderation_sweep",
    "kl__apply_penalty",
    "kl_send_dm",
    "kl_send_group_message",
    "kl_send_gift",
    "kl_claim_login_bonus",
]


def run_sql(sql):
    out = subprocess.run(
        ["python3", HELPER, "query", REF, sql],
        capture_output=True, text=True, timeout=120,
    )
    if out.returncode != 0:
        raise RuntimeError(f"SQL 実行に失敗: {out.stderr[:200]}")
    return json.loads(out.stdout)


def fetch_def(name):
    # 取得結果は 4000 文字で切られるため、定義を分割して取る
    pieces = []
    start = 1
    while True:
        rows = run_sql(
            "select substr(pg_get_functiondef(oid), "
            f"{start}, 2800) as piece from pg_proc where proname = '{name}'"
        )
        if not rows:
            return None
        piece = rows[0]["piece"] or ""
        pieces.append(piece)
        if len(piece) < 2800:
            break
        start += 2800
    return "".join(pieces)


def markers(defn: str) -> list[str]:
    d = defn.lower()
    found = set()
    for verb, table in re.findall(
        r"(insert into|update|delete from)\s+public\.(\w+)", d
    ):
        found.add(f"{verb} {table}")
    for fn in re.findall(r"perform\s+public\.(\w+)", d):
        found.add(f"perform {fn}")
    for fn in re.findall(r"(?:select|from)\s+public\.(kl__\w+|ww__\w+)\s*\(", d):
        found.add(f"call {fn}")
    for code in re.findall(r"'([a-z_]{3,}):", d):
        found.add(f"raise {code}")
    return sorted(found)


def main() -> int:
    current = {}
    for name in WATCH:
        defn = fetch_def(name)
        if defn is None:
            print(f"MISSING FUNCTION: {name}（定義が存在しない）")
            return 1
        current[name] = markers(defn)

    if "--write-baseline" in sys.argv:
        BASELINE.write_text(json.dumps(current, ensure_ascii=False, indent=1))
        print(f"基準を書き直した: {BASELINE.name}（{len(current)} 関数）")
        return 0

    if not BASELINE.exists():
        print("基準ファイルがない。--write-baseline で作成すること。")
        return 1
    baseline = json.loads(BASELINE.read_text())

    failed = False
    for name in WATCH:
        base = set(baseline.get(name, []))
        now = set(current[name])
        lost = base - now
        gained = now - base
        if lost:
            failed = True
            print(f"FAIL {name}: 基準にある責務が消えている")
            for m in sorted(lost):
                print(f"   - {m}")
        if gained:
            print(f"note {name}: 新しい責務（意図した追加なら基準を更新）")
            for m in sorted(gained):
                print(f"   + {m}")
    if failed:
        print("\n=== FAIL: 責務の脱落を検知した ===")
        print("再定義で写し漏らした可能性が高い。意図した削除なら、")
        print("その意図を migration に残したうえで --write-baseline を実行。")
        return 1
    print(f"=== PASS: {len(WATCH)} 関数の責務は基準どおり ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
