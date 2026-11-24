# Supabase スキーマ適用手順書（Lite）

対象プロジェクト：`kotoba-jinrou-lite`
（https://dtdwkluanoaqiaruzbwe.supabase.co / ap-northeast-1）

適用は Management API 経由でむぜたんが直接行う（0010 以降はすべて
この方式で適用済み。トークンは Lite プロジェクト専用スコープ）。
各ファイルは冪等（再実行してもエラーにならない）にしてあるので、
失敗しても原因を取り除いて同じファイルを実行し直せばよい。
（おぎがスマホの SQL Editor へ長い SQL を手貼りする運用は、貼り付け
欠落でエラーになるため避ける）

## 手順

1. ダッシュボードでプロジェクト `kotoba-jinrou-lite` を開く
2. 左メニューの **SQL Editor** → **New query**
3. 下の表の順に、ファイルの中身を丸ごと貼って **Run** を押す。
   1ファイルずつ実行し、エラーが出たらそこで止めて内容をむぜたんに
   共有する（次のファイルへ進まない）
4. 全部終わったら「確認クエリ」を実行して結果を共有する

| 順 | ファイル | 内容 |
|---|---|---|
| 1 | `supabase/migrations/0001_profiles.sql` | プロフィール＋公開ID＋登録トリガ |
| 2 | `supabase/migrations/0002_friends.sql` | フレンド申請／関係／ブロック |
| 3 | `supabase/migrations/0003_coins.sql` | コイン財布・台帳＋登録ボーナス |
| 4 | `supabase/migrations/0004_dm_gifts.sql` | DM・ギフトカタログ（8種 seed）・通報 |
| 5 | `supabase/migrations/0005_rpc_social.sql` | ソーシャル系 RPC（kl_*） |
| 6 | `supabase/migrations/0006_wordwolf.sql` | ルーム＋ワードウルフ進行（ww_*）・Realtime・pg_cron |
| 7 | `supabase/migrations/0007_fix_membership_check.sql` | 0006 の参加者チェック式のバグ修正（実DB検証で判明・適用必須） |
| 8 | `supabase/migrations/0008_ready_and_room_list.sql` | 準備OK（room_members.ready＋ww_set_ready）＋公開ルーム一覧RPC（ww_list_rooms）。対戦画面フェーズで追加・実DB適用済み |
| 9 | `supabase/migrations/0009_player_view_enrich.sql` | ww_player_view 拡張（playerIds／自分の投票／終了後の正体開示）。対戦画面フェーズで追加・実DB適用済み |
| 10 | `supabase/migrations/0010_penalty.sql` | ペナルティ（penalty_events／profiles.penalty_until・rules_agreed_at／ハートビート／離脱検知／スルー記録／システムDM・システムログ／参加・作成の制限チェック／ルール同意RPC）。ペナルティフェーズで追加・実DB適用済み（2026-11-24、Management API 経由） |
| 11 | `supabase/migrations/0011_start_countdown.sql` | 開始カウントダウン（rooms.start_requested_by／start_countdown_ends_at、ww_request_start／ww_cancel_start、ww_leave_room のカウントダウン解除、ww_sweep の完走時自動開始、ww__new_game の挨拶タイム INTRO_SECONDS=15、ww_player_view は intro 中 myTopic を返さない）。実機FBフェーズで追加・実DB適用済み（2026-11-24、Management API 経由）。※開始フローは次フェーズで「準備OK＋マスター開始」方式へ作り替え決定済み（おぎ 2026-11-24 23:37）。本マイグレーションのカウントダウン基盤はその到達点として保持 |
| 12 | `supabase/migrations/0012_player_view_remain.sql` | ww_player_view 拡張（phaseRemainSec＝サーバー時刻基準の残り秒数、myMessageCount＝自分の発言数。無発言警告バナーの判定用）。実DB適用済み（2026-11-24、Management API 経由） |
| 13 | `supabase/migrations/0013_violation_points.sql` | 違反ポイント制（penalty_events.points 列追加、kind に silent_play／silent_no_vote を追加、ww__record_vote_skips をポイント制に再定義：発言0＋未投票=1.0／発言0＋投票あり=0.5／発言あり＋未投票・棄権=0.5、セット内合計1.0で強制退室＋階段適用）。実DB適用済み（2026-11-24、Management API 経由） |
| 14 | `supabase/migrations/0014_game_unit_start_flow.sql` | ゲーム単位制＋新開始フロー＋ポイントのルーム滞在中累積（おぎ 2026-11-24 23:31〜23:42 決定）。0011 のカウントダウン基盤を撤去（ww_request_start／ww_cancel_start／開始列を削除）。rooms.all_ready_at（満室＋全員準備OKの証跡）、room_members.violation_points、ww_start_game（満室＋全員準備OK＋マスター開始の3条件）、ww_kick_member、ww_leave_room のマスター移譲、ww_sets は games_per_set=1 のコンテナとして運用、result 終了時は次ゲームを作らず待機室へ戻す。実DB適用済み（2026-11-24、Management API 経由） |
| 15 | `supabase/migrations/0015_room_chat.sql` | 待機室チャット（ww_room_messages テーブル＋RLS（メンバーだけ閲覧）＋ww_post_room_message RPC＋Realtime 登録）。実DB適用済み（2026-11-24、Management API 経由） |
| 16 | `supabase/migrations/0016_topics_and_genre.sql` | お題429組の投入（確定版。合計451組・19カテゴリ）＋ジャンル表示・選択（rooms.genre 追加、ww_create_room に p_genre、ww_list_rooms に genre、ww__new_game のジャンル抽選、ww_player_view に category）。実DB適用済み（2026-11-25、Management API 経由） |
| 17 | `supabase/migrations/0017_icons.sql` | アイコンカタログ（icons／user_icons、無料15種 seed、profiles.icon_key へ FK、kl_set_icon）＋DM招待カード発行 RPC（kl_send_invite：メンバー・フレンド確認、非公開はパスワード照合を通った場合だけ平文を payload に載せる）＋kl_search_user に icon_key 追加＋ww_list_rooms に hostIconKey 追加。実DB適用済み（2026-11-25、Management API 経由） |
| 18 | `supabase/migrations/0018_tutorial.sql` | チュートリアル＋ようこそDM（dm_messages に kind='welcome' 追加、kl__assert_rules_agreed で ww_create_room／ww_join_room に同意ゲートをサーバー側強制、handle_new_user にようこそDM送信を追加、kl_mark_system_dm_read が welcome も既読化）。実DB適用済み（2026-11-25、Management API 経由） |

実 DB 検証スクリプト（新開始フローは `npm run verify:startflow-db`、
ペナルティは `npm run verify:penalty-db`、ジャンルは
`npm run verify:genre-db`、チュートリアル＋ようこそDMは
`npm run verify:tutorial-db`。旧 verify-countdown-db は
0014 でカウントダウン方式が廃止されたため削除し、startflow に置換）。

## 注意点

- **0006 の pg_cron 登録**：ファイル末尾のブロックは、pg_cron が
  無効な環境では通知（NOTICE）を出すだけで失敗しない。その場合は
  **Database → Extensions** で `pg_cron` を有効化してから、0006 の
  末尾の `do $$ ... $$;` ブロックだけを再実行する
- **pgcrypto**：パスワードのハッシュ化に使う。0001 で
  `create extension if not exists pgcrypto` を実行している。
  もし 0001 で拡張まわりのエラーが出たら、**Database →
  Extensions** で `pgcrypto` を有効化してから 0001 を再実行する
- ファイルはすべて `if not exists` / `drop policy if exists` /
  `create or replace` で書かれているため、途中まで適用された状態で
  再実行しても壊れない

## 確認クエリ（全部の適用後に実行）

```sql
-- テーブルが揃っているか（13行返るはず）
select tablename from pg_tables
 where schemaname = 'public'
 order by tablename;

-- RPC が揃っているか
select proname from pg_proc
 where pronamespace = 'public'::regnamespace
   and (proname like 'kl\_%' or proname like 'ww\_%')
 order by proname;

-- seed の確認（ギフト8件・お題451件＝初期22＋確定429）
select (select count(*) from public.gift_catalog) as gifts,
       (select count(*) from public.ww_topics) as topics;

-- pg_cron の見回りが登録されているか（1行返れば OK）
select jobname, schedule, command from cron.job;
```

## 適用後にむぜたん側で行うこと

- クライアントの SupabaseBackend で実ログイン→プロフィール取得→
  フレンド申請→DM→ギフトの一連を通す疎通確認
- OAuth（Google/Apple）の有効化は `docs/oauth-setup-runbook.md`
  の手順でおぎが実施（ログイン自体が前提になるため、スキーマ適用と
  並行して進めてよい）
