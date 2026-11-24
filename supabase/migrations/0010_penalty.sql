-- =============================================================================
-- 0010_penalty.sql — ペナルティ（離脱・放置／投票スルー）とルール同意（Lite）
-- =============================================================================
-- 決定の正本：計画書 lite-plan-draft.md「ペナルティ」節（2026-11-24 おぎ確定）。
--
-- 実装するもの：
-- - profiles.penalty_until（制限終了時刻）／profiles.rules_agreed_at（同意）
-- - penalty_events：適用履歴（トラック別）。段階計算の入力になる
-- - room_members.last_heartbeat_at ＋ ww_heartbeat RPC（生存信号）
-- - ww_sweep への離脱検知組み込み：ハートビート途絶→猶予2分→離脱確定
-- →セット即時強制終了（完了済みゲームの勝敗は保持、進行中は無効）
-- - 投票スルー記録：解決時に「投票なし／棄権」を数え、セット内1回目は
-- 警告＋ペナルティ加算、2回目で強制退室＋セット強制終了
-- （退室の確定は当該ゲームの result 終了時）
-- - 制限チェック：ww_create_room / ww_join_room が penalty_until を見る
-- - システムDM：dm_messages に kind='system'（sender_id は NULL）を追加し、
-- ペナルティ確定のたびに本人へ通知する（全ペナルティ共通の通知手段）
-- - ルーム内システムログ：ww_messages に kind='system' を追加し、強制
-- 退室時に「◯◯さんがゲームルールに違反したため、強制退室となりま
-- した」＋セット終了案内を流す（詳細理由は出さない）
--
-- 段階（定数は kl_penalty_minutes / kl_penalty_max_step に集約）：
-- - 離脱・放置系（afk）：1時間→3時間→6時間→12時間→24時間（上限）
-- - 段階的軽減（執行猶予方式）：最後の違反から30日ごとに現在レベルが
-- 1段下がる。ただし一度受けたユーザーのレベルは 0 に戻らない
-- （完全なゼロリセットはしない）
-- - 嫌がらせ系（harassment）：7日→30日→無期限の定数だけ用意する。
-- 処分の適用（自動調査）は処分フェーズの範囲で、適用経路は作らない
-- =============================================================================

-- ---------- profiles 拡張 ----------

alter table public.profiles
add column if not exists penalty_until timestamptz,
add column if not exists rules_agreed_at timestamptz;

comment on column public.profiles.penalty_until is
'ペナルティ制限の終了時刻。これより未来の間はルーム参加・作成をサーバー側で拒否する。RPC（kl__apply_penalty）だけが更新する。';
comment on column public.profiles.rules_agreed_at is
'初回入室時のルール同意ポップアップへ同意した時刻。kl_agree_rules だけが設定する。';

-- penalty_until / rules_agreed_at もクライアント直接変更を巻き戻す対象に追加
create or replace function public.profiles_guard_server_fields()
returns trigger
language plpgsql
as $$
begin
if current_user not in ('postgres', 'service_role') then
new.popularity:= old.popularity;
new.wordwolf_wins:= old.wordwolf_wins;
new.public_id:= old.public_id;
new.penalty_until:= old.penalty_until;
new.rules_agreed_at:= old.rules_agreed_at;
end if;
return new;
end;
$$;

-- ---------- ハートビート ----------

alter table public.room_members
add column if not exists last_heartbeat_at timestamptz;

comment on column public.room_members.last_heartbeat_at is
'対戦中プレイヤーの生存信号（ww_heartbeat で更新）。途絶から2分で離脱判定。';

create or replace function public.ww_heartbeat(p_room uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
me uuid:= auth.uid();
n integer;
begin
if me is null then
raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
end if;
update public.room_members set last_heartbeat_at = now()
where room_id = p_room and user_id = me;
get diagnostics n = row_count;
if n = 0 then
raise exception 'NOT_A_MEMBER: このルームに参加していません' using errcode = 'P0001';
end if;
end;
$$;

-- ---------- ペナルティ記録 ----------

create table if not exists public.penalty_events (
id uuid primary key default gen_random_uuid(),
user_id uuid not null references auth.users (id) on delete cascade,
track text not null check (track in ('afk', 'harassment')),
kind text not null check (kind in ('vote_skip', 'abandon', 'manual')),
room_id uuid references public.rooms (id) on delete set null,
set_id uuid references public.ww_sets (id) on delete set null,
game_id uuid references public.ww_games (id) on delete set null,
step integer,
minutes integer not null default 0,
penalty_until timestamptz,
forced_removal boolean not null default false,
created_at timestamptz not null default now()
);

comment on table public.penalty_events is
'ペナルティ適用履歴。段階計算（執行猶予方式の軽減含む）の入力。書き込みは kl__apply_penalty のみ、本人が自分の分だけ読める。';

create index if not exists penalty_events_user_track_idx
on public.penalty_events (user_id, track, created_at desc);

alter table public.penalty_events enable row level security;

drop policy if exists "penalty_events: read own" on public.penalty_events;
create policy "penalty_events: read own"
on public.penalty_events for select to authenticated
using (user_id = (select auth.uid()));

revoke all on table public.penalty_events from anon;
grant select on table public.penalty_events to authenticated;

-- ---------- セット／ゲームの拡張 ----------

alter table public.ww_sets
drop constraint if exists ww_sets_status_check;
alter table public.ww_sets
add constraint ww_sets_status_check
check (status in ('running', 'finished', 'terminated'));
alter table public.ww_sets
add column if not exists terminated_user_ids uuid[],
add column if not exists terminate_after_game_user_ids uuid[] not null default '{}',
add column if not exists terminated_reason text;

comment on column public.ww_sets.terminate_after_game_user_ids is
'スルー2回目で強制退室が決まったプレイヤー。現在のゲームの result 終了時に退室＋セット終了を確定する。';

alter table public.ww_games
add column if not exists skips_recorded boolean not null default false;

comment on column public.ww_games.skips_recorded is
'投票スルーの記録が済んだか（二重記録防止）。';

-- ---------- システムDM（dm_messages 拡張） ----------

alter table public.dm_messages
alter column sender_id drop not null;
alter table public.dm_messages
drop constraint if exists dm_messages_kind_check;
alter table public.dm_messages
add constraint dm_messages_kind_check
check (kind in ('text', 'invite', 'gift', 'system'));
alter table public.dm_messages
drop constraint if exists dm_messages_body_check;
alter table public.dm_messages
add constraint dm_messages_body_check check (
(kind = 'text' and body is not null and length(body) between 1 and 500)
or (kind = 'invite' and invite_payload is not null)
or (kind = 'gift' and gift_payload is not null)
or (kind = 'system' and body is not null and length(body) between 1 and 1000
and sender_id is null)
);

comment on column public.dm_messages.sender_id is
'送信者。kind = ''system'' のときだけ NULL（システムからの通知）。';

-- システムDM送信（内部専用）。ペナルティ通知など全ペナルティ共通の通知手段。
create or replace function public.kl__send_system_dm(p_recipient uuid, p_body text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
v_id uuid;
begin
insert into public.dm_messages (sender_id, recipient_id, kind, body)
values (null, p_recipient, 'system', p_body)
returning id into v_id;
return v_id;
end;
$$;

-- システムDMの既読化（相手ユーザーがいないため kl_mark_dm_read とは分ける）
create or replace function public.kl_mark_system_dm_read()
returns integer
language plpgsql security definer set search_path = public
as $$
declare
me uuid:= auth.uid();
n integer;
begin
if me is null then
raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
end if;
update public.dm_messages set read_at = now()
where kind = 'system' and recipient_id = me and read_at is null;
get diagnostics n = row_count;
return n;
end;
$$;

-- ---------- ルーム内システムログ（ww_messages 拡張） ----------

alter table public.ww_messages
alter column sender_id drop not null;
alter table public.ww_messages
add column if not exists kind text not null default 'chat';
alter table public.ww_messages
drop constraint if exists ww_messages_kind_check;
alter table public.ww_messages
add constraint ww_messages_kind_check check (kind in ('chat', 'system'));
alter table public.ww_messages
drop constraint if exists ww_messages_kind_sender_check;
alter table public.ww_messages
add constraint ww_messages_kind_sender_check check (
(kind = 'chat' and sender_id is not null)
or (kind = 'system' and sender_id is null)
);

-- ---------- 段階の定数（ここが実DB側の集約場所） ----------

-- トラック別・段別の制限時間（分）。-1 は無期限。
-- sim/penalty.mjs の PENALTY.ladders と必ず一致させること。
create or replace function public.kl_penalty_minutes(p_track text, p_step integer)
returns integer
language sql immutable
as $$
select case p_track
when 'afk' then (array[60, 180, 360, 720, 1440])[least(greatest(p_step, 1), 5)]
when 'harassment' then (array[10080, 43200, -1])[least(greatest(p_step, 1), 3)]
else 0
end;
$$;

create or replace function public.kl_penalty_max_step(p_track text)
returns integer
language sql immutable
as $$
select case p_track when 'afk' then 5 when 'harassment' then 3 else 1 end;
$$;

-- ---------- ペナルティ適用（内部専用） ----------

-- 段階を決め（執行猶予方式の軽減込み）、制限を積み増しし、履歴を残し、
-- 本人へシステムDMで通知する。戻り値は { step, minutes, penaltyUntil}。
create or replace function public.kl__apply_penalty(
p_user uuid,
p_track text,
p_kind text,
p_room uuid,
p_set uuid,
p_game uuid,
p_forced_removal boolean,
p_reason_text text
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
v_last_step integer;
v_last_at timestamptz;
v_level integer;
v_step integer;
v_minutes integer;
v_prev_until timestamptz;
v_until timestamptz;
v_minutes_label text;
v_until_label text;
v_body text;
begin
-- 現在レベル：最後の適用段から、30日経過ごとに1段軽減（0には戻らない）
select step, created_at into v_last_step, v_last_at
from public.penalty_events
where user_id = p_user and track = p_track and minutes <> 0
order by created_at desc
limit 1;
if v_last_step is null then
v_level:= 0;
else
v_level:= greatest(1, v_last_step
- floor(extract(epoch from (now() - v_last_at)) / 2592000)::int);
end if;
v_step:= least(v_level + 1, public.kl_penalty_max_step(p_track));
v_minutes:= public.kl_penalty_minutes(p_track, v_step);

select penalty_until into v_prev_until from public.profiles where id = p_user;
if v_minutes = -1 then
v_until:= 'infinity'::timestamptz;
else
-- 既存の制限が残っていれば、その終了時刻から積み増す
v_until:= greatest(coalesce(v_prev_until, now()), now())
+ make_interval(mins => v_minutes);
end if;
update public.profiles set penalty_until = v_until where id = p_user;

insert into public.penalty_events
(user_id, track, kind, room_id, set_id, game_id, step, minutes, penalty_until, forced_removal)
values
(p_user, p_track, p_kind, p_room, p_set, p_game, v_step, v_minutes, v_until,
coalesce(p_forced_removal, false));

v_minutes_label:= case
when v_minutes = -1 then '無期限'
when v_minutes >= 60 and v_minutes % 60 = 0 then (v_minutes / 60)::text || '時間'
else v_minutes::text || '分'
end;
v_until_label:= case
when v_minutes = -1 then '無期限'
else to_char(v_until at time zone 'Asia/Tokyo', 'YYYY年MM月DD日 HH24時MI分') || 'ごろ'
end;
v_body:= '' || chr(10)
|| p_reason_text || chr(10)
|| 'ペナルティとして ' || v_until_label
|| ' までルームへの参加・作成ができません（今回の制限：' || v_minutes_label || '）。' || chr(10)
|| 'ペナルティの回数が増えると制限時間は長くなります（30日間違反がなければ段階的に軽くなります）。対戦中は最後まで参加しましょう。';
perform public.kl__send_system_dm(p_user, v_body);

return jsonb_build_object('step', v_step, 'minutes', v_minutes, 'penaltyUntil', v_until);
end;
$$;

-- 制限中チェック（参加・作成 RPC の冒頭で使う内部ヘルパー）
create or replace function public.kl__assert_not_penalized(p_user uuid)
returns void
language plpgsql stable security definer set search_path = public
as $$
declare
v_until timestamptz;
begin
select penalty_until into v_until from public.profiles where id = p_user;
if v_until is not null and v_until > now() then
raise exception 'PENALTY_ACTIVE: ペナルティ期間中のため % までルームに参加・作成できません',
to_char(v_until at time zone 'Asia/Tokyo', 'MM月DD日 HH24時MI分')
using errcode = 'P0001';
end if;
end;
$$;

-- ---------- ルール同意 ----------

create or replace function public.kl_agree_rules()
returns void
language plpgsql security definer set search_path = public
as $$
declare
me uuid:= auth.uid();
begin
if me is null then
raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
end if;
update public.profiles set rules_agreed_at = now()
where id = me and rules_agreed_at is null;
end;
$$;

-- ---------- セット強制終了（内部専用） ----------

-- ルームを待機状態に戻し、対象者を退室させ、ログ用ゲームのチャットへ
-- システムログを流す。完了済みゲームの結果行には触らない（勝敗は有効）。
create or replace function public.ww__terminate_set(
p_set public.ww_sets,
p_user_ids uuid[],
p_log_game uuid,
p_reason text
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
uid uuid;
v_name text;
begin
update public.ww_sets
set status = 'terminated',
finished_at = now(),
terminated_user_ids = p_user_ids,
terminated_reason = p_reason,
terminate_after_game_user_ids = '{}'
where id = p_set.id;
update public.rooms set status = 'lobby' where id = p_set.room_id;
foreach uid in array p_user_ids loop
select display_name into v_name from public.profiles where id = uid;
delete from public.room_members
where room_id = p_set.room_id and user_id = uid;
insert into public.ww_messages (game_id, sender_id, kind, body)
values (p_log_game, null, 'system',
coalesce(v_name, 'プレイヤー') || 'さんがゲームルールに違反したため、強制退室となりました');
end loop;
insert into public.ww_messages (game_id, sender_id, kind, body)
values (p_log_game, null, 'system',
'セットは終了しました。完了したゲームの勝敗は記録されています。');
end;
$$;

-- ---------- 投票スルーの記録（内部専用） ----------

-- 解決が確定した投票ラウンドについて「有効な投票をしなかった」
-- プレイヤー（投票なし／棄権＝target が NULL）を数える。
-- セット内1回目は警告＋ペナルティ加算のみ、2回目は強制退室リストへ。
create or replace function public.ww__record_vote_skips(p_game public.ww_games)
returns void
language plpgsql security definer set search_path = public
as $$
declare
pid uuid;
v_skip_count integer;
v_forced boolean;
begin
update public.ww_games set skips_recorded = true
where id = p_game.id and not skips_recorded;
if not found then
return;
end if;
for pid in
select unnest(player_ids) from public.ww_sets where id = p_game.set_id
loop
if exists (
select 1 from public.ww_votes v
where v.game_id = p_game.id and v.vote_round = p_game.vote_round
and v.voter_id = pid and v.target_id is not null
) then
continue;
end if;
select count(*) + 1 into v_skip_count
from public.penalty_events
where user_id = pid and kind = 'vote_skip' and set_id = p_game.set_id;
v_forced:= v_skip_count >= 2;
perform public.kl__apply_penalty(
pid, 'afk', 'vote_skip', p_game.room_id, p_game.set_id, p_game.id, v_forced,
case when v_forced
then '対戦中の投票がセット内で2回なかったため、強制退室となりました。'
else '対戦中の投票がなかったため、ペナルティが加算されました。'
end);
if v_forced then
update public.ww_sets
set terminate_after_game_user_ids = (
select array_agg(distinct x)
from unnest(terminate_after_game_user_ids || pid) as x)
where id = p_game.set_id;
end if;
end loop;
end;
$$;

-- ---------- 離脱検知（内部専用、ww_sweep の前段） ----------

-- 進行中セットの現在ゲームについて、ハートビートが猶予2分を超えて
-- 途絶したプレイヤーを離脱確定とし、セットを即時強制終了する。
-- ハートビートが誰からも記録されていないルーム（旧データ等）は対象外。
create or replace function public.ww__detect_abandons()
returns integer
language plpgsql security definer set search_path = public
as $$
declare
s public.ww_sets%rowtype;
g public.ww_games%rowtype;
stale uuid[];
uid uuid;
n integer:= 0;
begin
for s in
select * from public.ww_sets where status = 'running' for update
loop
select * into g from public.ww_games
where set_id = s.id order by game_index desc limit 1;
if g.id is null or g.phase = 'done' then
continue;
end if;
if not exists (
select 1 from public.room_members m
where m.room_id = s.room_id and m.last_heartbeat_at is not null
) then
continue;
end if;
select array_agg(pid) into stale
from unnest(s.player_ids) as pid
where coalesce(
(select m.last_heartbeat_at from public.room_members m
where m.room_id = s.room_id and m.user_id = pid),
s.created_at)
< now() - interval '120 seconds';
if stale is null or coalesce(array_length(stale, 1), 0) = 0 then
continue;
end if;
foreach uid in array stale loop
perform public.kl__apply_penalty(
uid, 'afk', 'abandon', s.room_id, s.id, g.id, true,
'対戦中に接続が切れたまま復帰がなかったため、離脱と判定されました。');
end loop;
-- 進行中ゲームは無効（勝敗なし）。result 中なら結果は確定済みなので保持
if g.phase <> 'result' then
update public.ww_games set winner = null, win_reason = 'aborted'
where id = g.id;
end if;
perform public.ww__set_phase(g.id, 'done', null);
perform public.ww__terminate_set(s, stale, g.id, 'abandon');
n:= n + 1;
end loop;
return n;
end;
$$;

-- ---------- 参加・作成 RPC への制限チェック追加（0006 の再定義） ----------

create or replace function public.ww_create_room(
p_title text,
p_is_private boolean default false,
p_password text default null,
p_beginner_welcome boolean default false,
p_reversal_enabled boolean default true,
p_capacity integer default 8
)
returns public.rooms
language plpgsql security definer set search_path = public, extensions
as $$
declare
me uuid:= auth.uid();
room public.rooms%rowtype;
spent record;
begin
if me is null then
raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
end if;
perform public.kl__assert_not_penalized(me);
if p_is_private and (p_password is null or length(p_password) < 4) then
raise exception 'PASSWORD_REQUIRED: 非公開ルームには4文字以上のパスワードが必要です' using errcode = 'P0001';
end if;

insert into public.rooms (host_id, title, is_private, password_hash,
beginner_welcome, capacity, reversal_enabled)
values (me, coalesce(nullif(trim(p_title), ''), ''), p_is_private,
case when p_is_private then crypt(p_password, gen_salt('bf')) end,
p_beginner_welcome, p_capacity, p_reversal_enabled)
returning * into room;

insert into public.room_members (room_id, user_id) values (room.id, me);

if p_is_private then
select * into spent from public.kl_spend_coins(me, 100);
insert into public.coin_ledger (user_id, delta_free, delta_paid, reason, ref_id)
values (me, -spent.spent_free, -spent.spent_paid, 'private_room', room.id);
end if;
return room;
end;
$$;

create or replace function public.ww_join_room(
p_room uuid, p_password text default null
)
returns void
language plpgsql security definer set search_path = public, extensions
as $$
declare
me uuid:= auth.uid();
room public.rooms%rowtype;
n integer;
begin
if me is null then
raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
end if;
perform public.kl__assert_not_penalized(me);
select * into room from public.rooms where id = p_room;
if not found then
raise exception 'ROOM_NOT_FOUND: ルームが存在しません' using errcode = 'P0001';
end if;
if room.status <> 'lobby' then
raise exception 'ROOM_BUSY: このルームには今は入れません' using errcode = 'P0001';
end if;
if room.is_private
and not (room.password_hash = crypt(coalesce(p_password, ''), room.password_hash)) then
raise exception 'WRONG_PASSWORD: パスワードが違います' using errcode = 'P0001';
end if;
select count(*) into n from public.room_members where room_id = p_room;
if n >= room.capacity
and not exists (select 1 from public.room_members
where room_id = p_room and user_id = me) then
raise exception 'ROOM_FULL: ルームが満員です' using errcode = 'P0001';
end if;
insert into public.room_members (room_id, user_id) values (p_room, me)
on conflict do nothing;
end;
$$;

-- ---------- 投票解決へのスルー記録組み込み（0006 の再定義） ----------

create or replace function public.ww__resolve_vote(p_game public.ww_games)
returns void
language plpgsql security definer set search_path = public
as $$
declare
sec public.ww_game_secrets%rowtype;
room public.rooms%rowtype;
top_count integer;
top_targets uuid[];
exiled uuid;
v_citizen text;
v_wolf text;
dummies text[];
begin
select * into sec from public.ww_game_secrets where game_id = p_game.id;
select * into room from public.rooms where id = p_game.room_id;

select max(c) into top_count from (
select count(*) as c from public.ww_votes
where game_id = p_game.id and vote_round = p_game.vote_round
and target_id is not null
group by target_id
) t;

if top_count is null then
update public.ww_games set exiled_id = null where id = p_game.id;
perform public.ww__record_vote_skips(p_game);
perform public.ww__finish(p_game, 'wolves', 'no_votes');
return;
end if;

select array_agg(target_id) into top_targets from (
select target_id, count(*) as c from public.ww_votes
where game_id = p_game.id and vote_round = p_game.vote_round
and target_id is not null
group by target_id
) t where c = top_count;

if array_length(top_targets, 1) > 1 then
if not p_game.extended then
update public.ww_games set extended = true, vote_round = 2, votes_cast = 0
where id = p_game.id;
perform public.ww__set_phase(p_game.id, 'discussion', now() + interval '60 seconds');
else
update public.ww_games set exiled_id = null where id = p_game.id;
perform public.ww__record_vote_skips(p_game);
perform public.ww__finish(p_game, 'wolves', 'tie');
end if;
return;
end if;

exiled:= top_targets[1];
update public.ww_games set exiled_id = exiled where id = p_game.id;
p_game.exiled_id:= exiled;
perform public.ww__record_vote_skips(p_game);

if exiled = any (sec.wolf_ids) then
if room.reversal_enabled then
v_citizen:= sec.citizen_topic;
v_wolf:= sec.wolf_topic;
-- ダミー5件：同カテゴリ優先、ウルフのお題は絶対に含めない
-- （変数名を v_ 始まりにして ww_topics の列名との衝突を避ける）
select array_agg(word) into dummies from (
select word from (
select t.citizen as word, 0 as grp from public.ww_topics t
where t.active and t.citizen not in (v_citizen, v_wolf)
union
select t.wolf as word, 0 as grp from public.ww_topics t
where t.active and t.wolf not in (v_citizen, v_wolf)
and t.category is not distinct from sec.category
union
select t.citizen as word, 1 as grp from public.ww_topics t
where t.active and t.citizen not in (v_citizen, v_wolf)
union
select t.wolf as word, 1 as grp from public.ww_topics t
where t.active and t.wolf not in (v_citizen, v_wolf)
) u
group by word
order by min(grp), random()
limit 5
) d;
update public.ww_games
set reversal_choices = (
select array_agg(w order by random())
from unnest(array_prepend(v_citizen, coalesce(dummies, array[]::text[]))) as w
)
where id = p_game.id;
perform public.ww__set_phase(p_game.id, 'reversal', now() + interval '30 seconds');
else
perform public.ww__finish(p_game, 'citizens', 'wolf_exiled');
end if;
else
perform public.ww__finish(p_game, 'wolves', 'citizen_exiled');
end if;
end;
$$;

-- ---------- result 終了時の強制終了確定（0006 の再定義） ----------

create or replace function public.ww__advance_expired(p_game public.ww_games)
returns void
language plpgsql security definer set search_path = public
as $$
declare
set_row public.ww_sets%rowtype;
next_game public.ww_games%rowtype;
begin
case p_game.phase
when 'intro' then
perform public.ww__set_phase(
p_game.id, 'discussion',
now() + make_interval(secs => p_game.discussion_seconds));
when 'discussion' then
update public.ww_games set votes_cast = 0 where id = p_game.id;
perform public.ww__set_phase(p_game.id, 'voting', now() + interval '15 seconds');
when 'voting' then
perform public.ww__resolve_vote(p_game);
when 'reversal' then
update public.ww_games
set reversal_outcome = jsonb_build_object(
'attempted', false, 'correct', false, 'timedOut', true)
where id = p_game.id;
perform public.ww__finish(p_game, 'citizens', 'reversal');
when 'result' then
select * into set_row from public.ww_sets where id = p_game.set_id;
perform public.ww__set_phase(p_game.id, 'done', null);
if coalesce(array_length(set_row.terminate_after_game_user_ids, 1), 0) > 0 then
-- スルー2回目のプレイヤーがいる：次ゲームへ進まずセット強制終了
perform public.ww__terminate_set(
set_row, set_row.terminate_after_game_user_ids, p_game.id, 'rule_violation');
elsif p_game.game_index < set_row.games_per_set then
next_game:= public.ww__new_game(set_row, p_game.game_index + 1);
else
update public.ww_sets
set status = 'finished', finished_at = now()
where id = set_row.id;
update public.rooms set status = 'lobby' where id = p_game.room_id;
end if;
else
null;
end case;
end;
$$;

-- ---------- sweep への離脱検知組み込み（0006 の再定義） ----------

create or replace function public.ww_sweep()
returns integer
language plpgsql security definer set search_path = public
as $$
declare
game public.ww_games%rowtype;
n integer:= 0;
begin
perform public.ww__detect_abandons();
for game in
select * from public.ww_games
where phase <> 'done' and phase_deadline_at is not null
and phase_deadline_at <= now()
order by phase_deadline_at
for update skip locked
loop
perform public.ww__advance_expired(game);
n:= n + 1;
end loop;
return n;
end;
$$;

-- ---------- 個人ビューへのセット状態追加（0009 の再定義） ----------

create or replace function public.ww_player_view(p_game uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
me uuid:= auth.uid();
game public.ww_games%rowtype;
sec public.ww_game_secrets%rowtype;
my_topic text;
finished boolean;
view jsonb;
v_player_ids uuid[];
v_my_vote_cast boolean;
v_my_vote_target uuid;
v_set_status text;
v_terminated_user_ids uuid[];
begin
select * into game from public.ww_games where id = p_game;
if not found then
raise exception 'GAME_NOT_FOUND: ゲームが存在しません' using errcode = 'P0001';
end if;
select player_ids, status, terminated_user_ids
into v_player_ids, v_set_status, v_terminated_user_ids
from public.ww_sets s where s.id = game.set_id;
if not (me = any (v_player_ids)) then
raise exception 'NOT_A_PLAYER: このゲームの参加者ではありません' using errcode = 'P0001';
end if;
select topic into my_topic from public.ww_player_topics
where game_id = p_game and player_id = me;
select exists (
select 1 from public.ww_votes
where game_id = p_game and vote_round = game.vote_round and voter_id = me
), (
select target_id from public.ww_votes
where game_id = p_game and vote_round = game.vote_round and voter_id = me
)
into v_my_vote_cast, v_my_vote_target;
finished:= game.phase in ('result', 'done');
view:= jsonb_build_object(
'gameId', game.id,
'gameIndex', game.game_index,
'phase', game.phase,
'phaseVersion', game.phase_version,
'phaseDeadlineAt', game.phase_deadline_at,
'voteRound', game.vote_round,
'extended', game.extended,
'votesCast', game.votes_cast,
'playerIds', to_jsonb(v_player_ids),
'setStatus', v_set_status,
'terminatedUserIds', to_jsonb(coalesce(v_terminated_user_ids, '{}'::uuid[])),
'myTopic', my_topic,
'myVoteCast', v_my_vote_cast,
'myVoteTarget', v_my_vote_target,
'exiledId', case when finished or game.phase = 'reversal' then game.exiled_id end,
'winner', case when finished then game.winner end,
'winReason', case when finished then game.win_reason end
);
if game.phase = 'reversal' and me = game.exiled_id then
view:= view || jsonb_build_object('reversalChoices', game.reversal_choices);
end if;
if finished then
select * into sec from public.ww_game_secrets where game_id = p_game;
view:= view || jsonb_build_object(
'topicPair', jsonb_build_object('citizen', sec.citizen_topic, 'wolf', sec.wolf_topic),
'reversalOutcome', game.reversal_outcome,
'reveal', (
select jsonb_agg(jsonb_build_object(
'id', pid,
'isWolf', pid = any (sec.wolf_ids),
'topic', (select pt.topic from public.ww_player_topics pt
where pt.game_id = p_game and pt.player_id = pid)
) order by array_position(v_player_ids, pid))
from unnest(v_player_ids) as pid
)
);
end if;
return view;
end;
$$;

-- ---------- 実行権限 ----------

revoke all on function public.ww_heartbeat(uuid) from public, anon;
revoke all on function public.kl_agree_rules() from public, anon;
revoke all on function public.kl_mark_system_dm_read() from public, anon;
revoke all on function public.kl__send_system_dm(uuid, text) from public, anon, authenticated;
revoke all on function public.kl__apply_penalty(uuid, text, text, uuid, uuid, uuid, boolean, text) from public, anon, authenticated;
revoke all on function public.kl__assert_not_penalized(uuid) from public, anon, authenticated;
revoke all on function public.kl_penalty_minutes(text, integer) from public, anon, authenticated;
revoke all on function public.kl_penalty_max_step(text) from public, anon, authenticated;
revoke all on function public.ww__record_vote_skips(public.ww_games) from public, anon, authenticated;
revoke all on function public.ww__terminate_set(public.ww_sets, uuid[], uuid, text) from public, anon, authenticated;
revoke all on function public.ww__detect_abandons() from public, anon, authenticated;

grant execute on function public.ww_heartbeat(uuid) to authenticated;
grant execute on function public.kl_agree_rules() to authenticated;
grant execute on function public.kl_mark_system_dm_read() to authenticated;
