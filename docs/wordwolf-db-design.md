# ワードウルフ進行の DB 方式設計

> **2026-11-24 深夜の仕様変更（0014/0015 で実装済み）**：本書の
> 「1セット = 3ゲーム」「ww_start_set（ホストのみ）」の記述は
> 旧仕様。現在は**ゲーム単位制**（ww_sets は games_per_set=1 の
> コンテナとして温存し、result 終了時は次ゲームを作らず全員が
> 待機室に戻る）＋**新開始フロー**（ww_start_game：満室＋マスター
> 以外の全員が準備OK＋マスター開始。ルーム作成時に人数 4〜8 を
> 設定）＋**待機室チャット**（ww_room_messages）に置き換わっている。
> 違反ポイントの累積も「セット内」から「ルーム滞在中」
> （room_members.violation_points）に変更。フェーズ遷移・締め切り
> 判定・合図と見回りの方式（本書 §1）自体は不変。


2026-11-24 作成。Lite の技術的な山場「DB 方式ワードウルフ進行」の
設計正本。ルールの正本は本家エンジン
（`werewolf-battle-revival/src/wordwolf/engine.mjs`、2026-11-23
おぎ確定仕様）とセッション
（`src/server/wordwolf-session.mjs`）で、本書はそのルールを
「常駐サーバーなし・Supabase のみ」で回すための状態設計に落とした
もの。本家のファイルは無変更、Lite は独立系統として実装する。

## 1. 方式の要点

- ゲームの状態はすべて DB の行に持つ。常駐プロセスのメモリには
  置かない（Render 不要の前提条件）。
- 各フェーズは「終了時刻（`phase_deadline_at`）」を持つ。時刻の
  権威は DB の `now()` のみで、クライアントの時計は表示用
  カウントダウンにしか使わない。
- 進行の駆動力は2系統：
  1. **クライアントの合図**：フェーズ終了時刻の到達（または投票の
     全員完了）を検知したクライアントが RPC `ww_advance` を呼ぶ。
     先着1件だけが遷移を実行し、後続は冪等に弾かれる。
  2. **pg_cron の見回り**：`ww_sweep()` が締め切りを過ぎたまま
     放置されたゲームを拾って進める。全員がアプリを閉じた部屋の
     保険。分単位の間隔なので、短いフェーズ（投票15秒など）の
     主駆動力にはしない（計画書 §4 の合意どおり）。
- 公平性：発言・投票・逆転回答の受付可否は「受付時点の DB 時刻が
  そのフェーズの `phase_deadline_at` より前か」で判定する。
  遷移がまだ実行されていなくても、締め切りを過ぎたアクションは
  拒否される。つまり「合図の遅れ＝受付時間の延長」にはならない。

## 2. フェーズ遷移モデル

1ゲームのフェーズ（本家セッションの流れをそのまま DB 化）：

| フェーズ | 制限時間 | 終了時の遷移 |
|---|---|---|
| `intro`（開始待機・お題配布） | 15秒 | → `discussion` |
| `discussion`（話し合い） | 4〜6人=300秒／7〜8人=360秒（2026-11-26 おぎ決定で短縮） | → `voting` |
| `voting`（投票） | 15秒（全員投票が揃えば早期解決） | 投票解決（下記） |
| `reversal`（逆転回答） | 30秒 | 回答 or 時間切れで解決 → `result` |
| `result`（結果発表・余韻） | 15秒 | 次ゲームの `intro` or セット終了 |
| `done`（ゲーム終了） | — | — |

投票解決の分岐（本家エンジン `resolveVote` と同一ルール）：

- 有効票ゼロ（全員スルー含む）→ ウルフ側の勝ち（理由 `no_votes`）
- 同票で未延長 → `discussion` に戻し +60秒の延長話し合い、
  `vote_round = 2` でもう1回だけ投票
- 延長後の再投票でも同票 → ウルフ側の勝ち（理由 `tie`）
- 追放者が市民 → ウルフ側の勝ち（理由 `citizen_exiled`）
- 追放者がウルフ：
  - 部屋設定の逆転回答が OFF → 市民の勝ち（理由 `wolf_exiled`）
  - ON → `reversal` へ。追放されたウルフが6択から市民側のお題を
    当てればウルフ側の逆転勝ち、外す／時間切れなら市民の勝ち
    （理由はいずれも `reversal`）

セット：1セット = 3ゲーム。`result` 終了時点で次ゲームがあれば
新しい `ww_games` 行を作って `intro` から始め、なければセットを
終了してルームを待機状態（`lobby`）へ戻す。

その他の確定ルール（本家準拠）：

- 参加人数 4〜8人。ウルフ数は 4〜7人=1人／8人=2人
- プレイヤーには自分のお題だけが見え、自分が市民かウルフかは
  知らされない（秘匿は §4 のテーブル分離で担保）
- 投票は1人1票・自分には投票不可・スルー（棄権=null）可
- 逆転回答の6択 = 市民側のお題（正解）1件＋ダミー5件。ダミーは
  他のお題ペアから同カテゴリ優先で選び、ウルフに配られたお題は
  絶対に含めない。並び順はランダム、正解の印は付けない

フェーズ遷移の実行条件（`ww_advance` / `ww_sweep` 共通）：

- 対象行を `SELECT ... FOR UPDATE` でロックし、現在フェーズと
  `phase_version` を確認してから遷移する。遷移のたびに
  `phase_version` を +1 する
- 合図側が期待したフェーズと現在のフェーズが違う場合は
  「遷移済み」として現状態を返すだけ（二重合図・競合合図は
  エラーにしない＝冪等）
- 締め切り前の合図は「まだ進めない（not_yet）」として現状態を返す。
  ただし投票フェーズで全員の投票が揃った場合だけは、締め切り前でも
  早期解決する（本家セッションの挙動と同一）

## 3. テーブル設計

適用先は `supabase/migrations/0006_wordwolf.sql`。要点：

| テーブル | 役割 |
|---|---|
| `rooms` | ルーム本体。公開可否・パスワードハッシュ（平文は保存しない）・定員・状態（lobby/playing/closed）・逆転回答 ON/OFF |
| `room_members` | ルーム参加者（room_id × user_id） |
| `ww_topics` | お題ペア（市民側／ウルフ側／カテゴリ）。sim/topics.json と同一の22組を seed |
| `ww_sets` | 1セット（3ゲーム）の束。参加者スナップショット `player_ids` を持つ |
| `ww_games` | ゲーム本体。phase / phase_version / phase_deadline_at / votes_cast / exiled_id / winner / reversal_choices 等の公開状態 |
| `ww_game_secrets` | 秘匿列（お題ペア・ウルフ割当）。ww_games から分離 |
| `ww_player_topics` | プレイヤーごとの配布お題（自分の行だけ見える） |
| `ww_messages` | 話し合いの発言（最大200文字） |
| `ww_votes` | 投票（vote_round ごと。target_id null = スルー） |
| `ww_results` | ゲーム結果（勝敗・理由）。勝利数は profiles.wordwolf_wins にも加算 |

## 4. 秘匿と RLS

- `ww_game_secrets` / `ww_topics` / `ww_votes` は RLS 有効・ポリシー
  なし＝Data API からは一切読めない。SECURITY DEFINER の RPC 内部
  でのみ参照する
- `ww_player_topics` は自分の行だけ SELECT 可（自分のお題のみ）
- `rooms` は公開ルームのみ全員に SELECT 可。非公開はホストと
  メンバーだけ（非公開ルームは一覧に出さない、本家方針）
- メンバー判定は SECURITY DEFINER のヘルパー `kl_is_room_member`
  に寄せて RLS の再帰を避ける
- 個人ビューは RPC `ww_player_view` が組み立てる：自分のお題・
  フェーズ情報だけを返し、陣営とお題ペアは result 以降にだけ開示
  する（sim/server.mjs の playerView と同じ形）

## 5. RPC

すべて SECURITY DEFINER。エラーは `'CODE: 説明'`（P0001）で返し、
sim/server.mjs とコードを揃える。

- ルーム：`ww_create_room`（非公開は100コイン消費まで含む）/
  `ww_join_room`（パスワード照合はサーバー側）/ `ww_leave_room`
- 開始：`ww_start_set`（ホストのみ、4〜8人）
- アクション：`ww_post_message` / `ww_cast_vote`（全員分が揃えば
  早期解決）/ `ww_submit_reversal`
- 進行：`ww_advance(game, expected_version)`（期待バージョンが
  違えば遷移済みとして現状態を返す＝冪等。sim は期待フェーズで
  判定するが、SQL 版は phase_version でより厳密に判定する）/
  `ww_sweep()`（締め切り超過分を一括で進める）
- 参照：`ww_player_view`

## 6. 適用と運用

- 適用手順は `docs/supabase-apply-runbook.md`（SQL Editor で
  0001→0006 の順に実行）。pg_cron の `ww-sweep`（毎分）は
  0006 の末尾で登録を試みるが、Free プランで拡張が無効な場合は
  通知だけ出て失敗しない。その場合はダッシュボードで pg_cron を
  有効化してから該当ブロックだけ再実行する
- Realtime は ww_games（フェーズ変化）/ ww_messages / dm_messages
  を publication に追加済み。締め切り表示は受信した
  phase_deadline_at を正とする
- 未設計の残件：途中離脱の DB 方式版（ハートビート＋sweep での
  離脱確定）。実プレイのフィードバックを見てから設計する