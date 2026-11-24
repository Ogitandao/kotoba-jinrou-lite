-- =============================================================================
-- 0006_wordwolf.sql — ルームとワードウルフ進行（DB方式、Lite）
-- =============================================================================
-- 設計正本：docs/wordwolf-db-design.md ＋ ローカル実証 sim/server.mjs。
-- 状態はすべて DB の行に持ち、フェーズごとに phase_deadline_at を持つ。
-- 時刻の権威は DB の now() のみ。進行は RPC ww_advance（クライアントの
-- 合図、先着1件・冪等）と ww_sweep（pg_cron の見回り）の2系統。
-- 発言・投票・逆転回答は、遷移が未実行でも締め切りを過ぎていれば拒否する。
--
-- 秘匿の分離：
-- - ww_game_secrets：RLS 有効・ポリシーなし＝API からは一切読めない。
--   SECURITY DEFINER の RPC 内部でのみ参照する
-- - ww_player_topics：自分の行だけ読める（自分のお題のみ）
-- - ww_votes：ポリシーなし＝RPC 経由のみ。票数は ww_games.votes_cast で公開
-- 勝敗の winner は 'wolves' / 'citizens'（sim・本家エンジンと同値）。
-- =============================================================================

-- ---------- ルーム ----------

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references auth.users (id) on delete cascade,
  title text not null default '',
  is_private boolean not null default false,
  password_hash text,
  beginner_welcome boolean not null default false,
  capacity integer not null default 8 check (capacity between 4 and 8),
  status text not null default 'lobby' check (status in ('lobby', 'playing', 'closed')),
  reversal_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint rooms_private_needs_hash check (not is_private or password_hash is not null)
);

comment on table public.rooms is
  'ワードウルフのルーム。非公開は一覧に出さず、入室は部屋ID＋パスワード照合（RPC）か DM の招待カードから。パスワードはハッシュのみ保存する。';

drop trigger if exists rooms_set_updated_at on public.rooms;
create trigger rooms_set_updated_at
  before update on public.rooms
  for each row execute function public.set_updated_at();

create table if not exists public.room_members (
  room_id uuid not null references public.rooms (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

create index if not exists room_members_user_idx
  on public.room_members (user_id);

-- ---------- ワードウルフ ----------

create table if not exists public.ww_topics (
  id serial primary key,
  category text,
  citizen text not null,
  wolf text not null,
  active boolean not null default true
);

comment on table public.ww_topics is
  'お題ペア（市民側／ウルフ側）。API からは読めない（RPC 内部専用）。';

-- お題ペアは sim/topics.json（本家から独立コピーした22組）と同一にする
insert into public.ww_topics (category, citizen, wolf)
select v.category, v.citizen, v.wolf
  from (values
    ('飲み物', 'コーヒー', 'ウーロン茶'),
    ('食べ物', 'そば', 'うどん'),
    ('食べ物', 'りんご', 'なし'),
    ('食べ物', 'カレー', 'シチュー'),
    ('食べ物', 'スイカ', 'メロン'),
    ('場所', '海', 'プール'),
    ('スポーツ', 'スキー', 'スケート'),
    ('動物', '犬', '猫'),
    ('季節・イベント', '夏休み', '冬休み'),
    ('場所', '水族館', '動物園'),
    ('乗り物', '電車', 'バス'),
    ('遊び・趣味', 'ピアノ', 'ギター'),
    ('食べ物', '寿司', '焼肉'),
    ('場所', '温泉', 'サウナ'),
    ('場所', '映画館', 'カラオケ'),
    ('食べ物', 'パン', 'ごはん'),
    ('自然・天気', '雪', '雨'),
    ('スポーツ', 'サッカー', '野球'),
    ('遊び・趣味', '読書', 'ゲーム'),
    ('季節・イベント', '花火', 'イルミネーション'),
    ('食べ物', 'ケーキ', 'プリン'),
    ('自然・天気', '山', '川')
  ) as v(category, citizen, wolf)
 where not exists (
   select 1 from public.ww_topics t
    where t.citizen = v.citizen and t.wolf = v.wolf
 );

create table if not exists public.ww_sets (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  status text not null default 'running' check (status in ('running', 'finished')),
  games_per_set integer not null default 3,
  player_ids uuid[] not null,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create table if not exists public.ww_games (
  id uuid primary key default gen_random_uuid(),
  set_id uuid not null references public.ww_sets (id) on delete cascade,
  room_id uuid not null references public.rooms (id) on delete cascade,
  game_index integer not null,
  phase text not null default 'intro'
    check (phase in ('intro', 'discussion', 'voting', 'reversal', 'result', 'done')),
  phase_version integer not null default 0,
  phase_started_at timestamptz not null default now(),
  phase_deadline_at timestamptz,
  discussion_seconds integer not null,
  vote_round integer not null default 1,
  extended boolean not null default false,
  votes_cast integer not null default 0,
  exiled_id uuid references auth.users (id),
  winner text check (winner in ('wolves', 'citizens')),
  win_reason text,
  reversal_choices text[],
  reversal_outcome jsonb,
  created_at timestamptz not null default now(),
  unique (set_id, game_index)
);

create index if not exists ww_games_sweep_idx
  on public.ww_games (phase_deadline_at)
  where phase <> 'done';

create table if not exists public.ww_game_secrets (
  game_id uuid primary key references public.ww_games (id) on delete cascade,
  citizen_topic text not null,
  wolf_topic text not null,
  category text,
  wolf_ids uuid[] not null
);

comment on table public.ww_game_secrets is
  '秘匿情報（お題ペアとウルフの割当）。RLS 有効・ポリシーなし＝API から読めない。RPC 内部専用。';

create table if not exists public.ww_player_topics (
  game_id uuid not null references public.ww_games (id) on delete cascade,
  player_id uuid not null references auth.users (id) on delete cascade,
  topic text not null,
  primary key (game_id, player_id)
);

create table if not exists public.ww_messages (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.ww_games (id) on delete cascade,
  sender_id uuid not null references auth.users (id) on delete cascade,
  body text not null check (length(body) between 1 and 200),
  created_at timestamptz not null default now()
);

create index if not exists ww_messages_game_idx
  on public.ww_messages (game_id, created_at);

create table if not exists public.ww_votes (
  game_id uuid not null references public.ww_games (id) on delete cascade,
  vote_round integer not null,
  voter_id uuid not null references auth.users (id) on delete cascade,
  target_id uuid references auth.users (id),
  created_at timestamptz not null default now(),
  primary key (game_id, vote_round, voter_id)
);

comment on table public.ww_votes is
  '投票。target_id が null はスルー（棄権）。ポリシーなし＝RPC 経由のみ（票の中身は秘匿）。';

create table if not exists public.ww_results (
  id uuid primary key default gen_random_uuid(),
  set_id uuid not null references public.ww_sets (id) on delete cascade,
  game_id uuid not null references public.ww_games (id) on delete cascade,
  game_index integer not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  won boolean not null,
  winner text not null check (winner in ('wolves', 'citizens')),
  reason text not null,
  created_at timestamptz not null default now(),
  unique (game_id, user_id)
);

-- ---------- メンバー判定ヘルパー（RLS 再帰回避用） ----------

create or replace function public.kl_is_room_member(p_room uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.room_members m
    where m.room_id = p_room and m.user_id = auth.uid()
  ) or exists (
    select 1 from public.rooms r
    where r.id = p_room and r.host_id = auth.uid()
  )
$$;

-- ---------- RLS ----------

alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.ww_topics enable row level security;
alter table public.ww_sets enable row level security;
alter table public.ww_games enable row level security;
alter table public.ww_game_secrets enable row level security;
alter table public.ww_player_topics enable row level security;
alter table public.ww_messages enable row level security;
alter table public.ww_votes enable row level security;
alter table public.ww_results enable row level security;

-- ルーム：公開は全員、非公開はホストとメンバーだけ（非公開は一覧に出ない）
drop policy if exists "rooms: read public or member" on public.rooms;
create policy "rooms: read public or member"
  on public.rooms for select to authenticated
  using (not is_private or public.kl_is_room_member(id));

drop policy if exists "room_members: read own rooms" on public.room_members;
create policy "room_members: read own rooms"
  on public.room_members for select to authenticated
  using (public.kl_is_room_member(room_id));

drop policy if exists "ww_sets: read by members" on public.ww_sets;
create policy "ww_sets: read by members"
  on public.ww_sets for select to authenticated
  using (public.kl_is_room_member(room_id));

drop policy if exists "ww_games: read by members" on public.ww_games;
create policy "ww_games: read by members"
  on public.ww_games for select to authenticated
  using (public.kl_is_room_member(room_id));

-- ww_game_secrets / ww_topics / ww_votes はポリシーを作らない（API から読めない）

drop policy if exists "ww_player_topics: read own only" on public.ww_player_topics;
create policy "ww_player_topics: read own only"
  on public.ww_player_topics for select to authenticated
  using (player_id = (select auth.uid()));

drop policy if exists "ww_messages: read by members" on public.ww_messages;
create policy "ww_messages: read by members"
  on public.ww_messages for select to authenticated
  using (exists (select 1 from public.ww_games g
                  where g.id = game_id and public.kl_is_room_member(g.room_id)));

drop policy if exists "ww_results: read by members" on public.ww_results;
create policy "ww_results: read by members"
  on public.ww_results for select to authenticated
  using (exists (select 1 from public.ww_games g
                  where g.id = game_id and public.kl_is_room_member(g.room_id)));

revoke all on table public.rooms, public.room_members, public.ww_topics,
  public.ww_sets, public.ww_games, public.ww_game_secrets,
  public.ww_player_topics, public.ww_messages, public.ww_votes,
  public.ww_results from anon;
grant select on table public.rooms, public.room_members, public.ww_sets,
  public.ww_games, public.ww_player_topics, public.ww_messages,
  public.ww_results to authenticated;

-- ---------- ルーム RPC ----------

-- ルーム作成。非公開は100コイン（無料分から消費、台帳に private_room）。
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
  me uuid := auth.uid();
  room public.rooms%rowtype;
  spent record;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
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
  me uuid := auth.uid();
  room public.rooms%rowtype;
  n integer;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
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

create or replace function public.ww_leave_room(p_room uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
begin
  delete from public.room_members where room_id = p_room and user_id = me;
end;
$$;

-- ---------- ゲーム開始 ----------

create or replace function public.ww__new_game(p_set public.ww_sets, p_index integer)
returns public.ww_games
language plpgsql security definer set search_path = public
as $$
declare
  topic public.ww_topics%rowtype;
  wolf_count integer;
  wolf_ids uuid[];
  game public.ww_games%rowtype;
  pid uuid;
begin
  select * into topic from public.ww_topics where active order by random() limit 1;
  wolf_count := case when array_length(p_set.player_ids, 1) >= 8 then 2 else 1 end;
  select array_agg(x) into wolf_ids
    from (select unnest(p_set.player_ids) as x order by random() limit wolf_count) s;

  insert into public.ww_games (set_id, room_id, game_index, phase,
                               phase_deadline_at, discussion_seconds)
  values (p_set.id, p_set.room_id, p_index, 'intro',
          now() + interval '15 seconds',
          case when array_length(p_set.player_ids, 1) <= 6 then 300 else 480 end)
  returning * into game;

  insert into public.ww_game_secrets (game_id, citizen_topic, wolf_topic, category, wolf_ids)
  values (game.id, topic.citizen, topic.wolf, topic.category, wolf_ids);

  foreach pid in array p_set.player_ids loop
    insert into public.ww_player_topics (game_id, player_id, topic)
    values (game.id, pid,
            case when pid = any(wolf_ids) then topic.wolf else topic.citizen end);
  end loop;
  return game;
end;
$$;

create or replace function public.ww_start_set(p_room uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  room public.rooms%rowtype;
  ids uuid[];
  set_row public.ww_sets%rowtype;
  game public.ww_games%rowtype;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  select * into room from public.rooms where id = p_room for update;
  if not found then
    raise exception 'ROOM_NOT_FOUND: ルームが存在しません' using errcode = 'P0001';
  end if;
  if room.host_id <> me then
    raise exception 'NOT_HOST: 開始できるのはホストだけです' using errcode = 'P0001';
  end if;
  if room.status <> 'lobby' then
    raise exception 'ROOM_BUSY: すでに進行中です' using errcode = 'P0001';
  end if;
  select array_agg(user_id order by joined_at) into ids
    from public.room_members where room_id = p_room;
  if ids is null or array_length(ids, 1) < 4 or array_length(ids, 1) > 8 then
    raise exception 'INVALID_PLAYER_COUNT: ワードウルフは4〜8人です' using errcode = 'P0001';
  end if;

  insert into public.ww_sets (room_id, player_ids) values (p_room, ids)
  returning * into set_row;
  update public.rooms set status = 'playing' where id = p_room;
  game := public.ww__new_game(set_row, 1);
  return jsonb_build_object('setId', set_row.id, 'gameId', game.id);
end;
$$;

-- ---------- アクション RPC（締め切りチェック付き） ----------

-- フェーズ違いより先にフェーズ適合を見て、次に締め切りを見る
-- （sim/server.mjs の _requireActionWindow と同じ順序・同じコード）。
create or replace function public.ww__require_window(
  p_game public.ww_games, p_phases text[]
)
returns void
language plpgsql
as $$
begin
  if not (p_game.phase = any (p_phases)) then
    raise exception 'INVALID_PHASE: 現在のフェーズでは実行できません' using errcode = 'P0001';
  end if;
  if now() >= p_game.phase_deadline_at then
    raise exception 'DEADLINE_PASSED: 締め切りを過ぎています' using errcode = 'P0001';
  end if;
end;
$$;

create or replace function public.ww_post_message(p_game uuid, p_body text)
returns public.ww_messages
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  game public.ww_games%rowtype;
  msg public.ww_messages%rowtype;
begin
  select * into game from public.ww_games where id = p_game;
  if not found then
    raise exception 'GAME_NOT_FOUND: ゲームが存在しません' using errcode = 'P0001';
  end if;
  if not (me = any (select player_ids from public.ww_sets s where s.id = game.set_id)) then
    raise exception 'NOT_A_PLAYER: このゲームの参加者ではありません' using errcode = 'P0001';
  end if;
  perform public.ww__require_window(game, array['intro', 'discussion']);
  if p_body is null or length(trim(p_body)) = 0 then
    raise exception 'EMPTY_MESSAGE: 本文が空です' using errcode = 'P0001';
  end if;
  if length(p_body) > 200 then
    raise exception 'MESSAGE_TOO_LONG: 文字数上限を超えています' using errcode = 'P0001';
  end if;
  insert into public.ww_messages (game_id, sender_id, body)
  values (p_game, me, p_body) returning * into msg;
  return msg;
end;
$$;

create or replace function public.ww_cast_vote(p_game uuid, p_target uuid default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  game public.ww_games%rowtype;
  player_count integer;
begin
  select * into game from public.ww_games where id = p_game for update;
  if not found then
    raise exception 'GAME_NOT_FOUND: ゲームが存在しません' using errcode = 'P0001';
  end if;
  select array_length(s.player_ids, 1) into player_count
    from public.ww_sets s where s.id = game.set_id;
  if not (me = any (select player_ids from public.ww_sets s where s.id = game.set_id)) then
    raise exception 'NOT_A_PLAYER: このゲームの参加者ではありません' using errcode = 'P0001';
  end if;
  perform public.ww__require_window(game, array['voting']);
  if exists (select 1 from public.ww_votes
              where game_id = p_game and vote_round = game.vote_round and voter_id = me) then
    raise exception 'ALREADY_SUBMITTED: すでに投票済みです' using errcode = 'P0001';
  end if;
  if p_target is not null then
    if not (p_target = any (select player_ids from public.ww_sets s where s.id = game.set_id)) then
      raise exception 'UNKNOWN_PLAYER: 投票先が存在しません' using errcode = 'P0001';
    end if;
    if p_target = me then
      raise exception 'INVALID_TARGET: 自分には投票できません' using errcode = 'P0001';
    end if;
  end if;
  insert into public.ww_votes (game_id, vote_round, voter_id, target_id)
  values (p_game, game.vote_round, me, p_target);
  update public.ww_games set votes_cast = votes_cast + 1
   where id = p_game returning * into game;
  -- 全員投票が揃ったら締め切りを待たずに早期解決する
  if game.votes_cast >= player_count then
    perform public.ww__resolve_vote(game);
  end if;
  return jsonb_build_object('ok', true, 'votesCast', game.votes_cast);
end;
$$;

create or replace function public.ww_submit_reversal(p_game uuid, p_choice text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  game public.ww_games%rowtype;
  sec public.ww_game_secrets%rowtype;
  correct boolean;
begin
  select * into game from public.ww_games where id = p_game for update;
  if not found then
    raise exception 'GAME_NOT_FOUND: ゲームが存在しません' using errcode = 'P0001';
  end if;
  perform public.ww__require_window(game, array['reversal']);
  if me <> game.exiled_id then
    raise exception 'NOT_EXILED_WOLF: 逆転回答ができるのは追放されたウルフだけです' using errcode = 'P0001';
  end if;
  if not (p_choice = any (coalesce(game.reversal_choices, array[]::text[]))) then
    raise exception 'INVALID_CHOICE: 候補の中から選んでください' using errcode = 'P0001';
  end if;
  select * into sec from public.ww_game_secrets where game_id = p_game;
  correct := (p_choice = sec.citizen_topic);
  update public.ww_games
     set reversal_outcome = jsonb_build_object(
           'attempted', true, 'correct', correct, 'timedOut', false)
   where id = p_game;
  perform public.ww__finish(game, case when correct then 'wolves' else 'citizens' end, 'reversal');
  return jsonb_build_object('correct', correct);
end;
$$;

-- ---------- 進行エンジン ----------

create or replace function public.ww__set_phase(
  p_game_id uuid, p_phase text, p_deadline timestamptz
)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  update public.ww_games
     set phase = p_phase,
         phase_started_at = now(),
         phase_deadline_at = p_deadline,
         phase_version = phase_version + 1
   where id = p_game_id;
end;
$$;

-- 勝敗確定：結果行を書き、勝利数を加算し、result（余韻15秒）へ。
create or replace function public.ww__finish(
  p_game public.ww_games, p_winner text, p_reason text
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  sec public.ww_game_secrets%rowtype;
  ids uuid[];
  pid uuid;
  is_wolf boolean;
  won boolean;
begin
  select * into sec from public.ww_game_secrets where game_id = p_game.id;
  select player_ids into ids from public.ww_sets where id = p_game.set_id;

  update public.ww_games
     set winner = p_winner, win_reason = p_reason, exiled_id = coalesce(exiled_id, p_game.exiled_id)
   where id = p_game.id;

  foreach pid in array ids loop
    is_wolf := pid = any (sec.wolf_ids);
    won := case when p_winner = 'wolves' then is_wolf else not is_wolf end;
    insert into public.ww_results (set_id, game_id, game_index, user_id, won, winner, reason)
    values (p_game.set_id, p_game.id, p_game.game_index, pid, won, p_winner, p_reason)
    on conflict (game_id, user_id) do nothing;
    if won then
      update public.profiles set wordwolf_wins = wordwolf_wins + 1 where id = pid;
    end if;
  end loop;

  perform public.ww__set_phase(p_game.id, 'result', now() + interval '15 seconds');
end;
$$;

-- 投票解決（本家エンジン resolveVote・sim と同一ルール）
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
      perform public.ww__finish(p_game, 'wolves', 'tie');
    end if;
    return;
  end if;

  exiled := top_targets[1];
  update public.ww_games set exiled_id = exiled where id = p_game.id;
  p_game.exiled_id := exiled;

  if exiled = any (sec.wolf_ids) then
    if room.reversal_enabled then
      v_citizen := sec.citizen_topic;
      v_wolf := sec.wolf_topic;
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

-- 締め切り到達時の遷移（合図・見回りの共通処理）
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
      if p_game.game_index < set_row.games_per_set then
        next_game := public.ww__new_game(set_row, p_game.game_index + 1);
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

-- クライアントの合図。期待バージョンが違う場合は遷移済みとして
-- 現状態を返すだけ（二重合図・競合合図はエラーにしない＝冪等）。
create or replace function public.ww_advance(p_game uuid, p_expected_version integer)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  game public.ww_games%rowtype;
  player_count integer;
begin
  select * into game from public.ww_games where id = p_game for update;
  if not found then
    raise exception 'GAME_NOT_FOUND: ゲームが存在しません' using errcode = 'P0001';
  end if;
  if game.phase = 'done' or game.phase_version <> p_expected_version then
    return jsonb_build_object('advanced', false, 'reason', 'already_advanced',
      'phase', game.phase, 'phaseVersion', game.phase_version);
  end if;
  select array_length(s.player_ids, 1) into player_count
    from public.ww_sets s where s.id = game.set_id;
  if game.phase = 'voting' and game.votes_cast >= player_count then
    perform public.ww__resolve_vote(game);
    select * into game from public.ww_games where id = p_game;
    return jsonb_build_object('advanced', true, 'early', true,
      'phase', game.phase, 'phaseVersion', game.phase_version);
  end if;
  if now() < game.phase_deadline_at then
    return jsonb_build_object('advanced', false, 'reason', 'not_yet',
      'phase', game.phase, 'phaseVersion', game.phase_version);
  end if;
  perform public.ww__advance_expired(game);
  select * into game from public.ww_games where id = p_game;
  return jsonb_build_object('advanced', true, 'early', false,
    'phase', game.phase, 'phaseVersion', game.phase_version);
end;
$$;

-- pg_cron の見回り。締め切りを過ぎたゲームをすべて1段進める。
create or replace function public.ww_sweep()
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  game public.ww_games%rowtype;
  n integer := 0;
begin
  for game in
    select * from public.ww_games
     where phase <> 'done' and phase_deadline_at is not null
       and phase_deadline_at <= now()
     order by phase_deadline_at
     for update skip locked
  loop
    perform public.ww__advance_expired(game);
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- 個人ビュー（自分のお題だけ。陣営は result 以降にだけ開示）
create or replace function public.ww_player_view(p_game uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  game public.ww_games%rowtype;
  sec public.ww_game_secrets%rowtype;
  my_topic text;
  finished boolean;
  view jsonb;
begin
  select * into game from public.ww_games where id = p_game;
  if not found then
    raise exception 'GAME_NOT_FOUND: ゲームが存在しません' using errcode = 'P0001';
  end if;
  if not (me = any (select player_ids from public.ww_sets s where s.id = game.set_id)) then
    raise exception 'NOT_A_PLAYER: このゲームの参加者ではありません' using errcode = 'P0001';
  end if;
  select topic into my_topic from public.ww_player_topics
   where game_id = p_game and player_id = me;
  finished := game.phase in ('result', 'done');
  view := jsonb_build_object(
    'gameId', game.id,
    'gameIndex', game.game_index,
    'phase', game.phase,
    'phaseVersion', game.phase_version,
    'phaseDeadlineAt', game.phase_deadline_at,
    'voteRound', game.vote_round,
    'extended', game.extended,
    'votesCast', game.votes_cast,
    'myTopic', my_topic,
    'exiledId', case when finished or game.phase = 'reversal' then game.exiled_id end,
    'winner', case when finished then game.winner end,
    'winReason', case when finished then game.win_reason end
  );
  if game.phase = 'reversal' and me = game.exiled_id then
    view := view || jsonb_build_object('reversalChoices', game.reversal_choices);
  end if;
  if finished then
    select * into sec from public.ww_game_secrets where game_id = p_game;
    view := view || jsonb_build_object(
      'topicPair', jsonb_build_object('citizen', sec.citizen_topic, 'wolf', sec.wolf_topic),
      'reversalOutcome', game.reversal_outcome
    );
  end if;
  return view;
end;
$$;

-- ---------- 実行権限 ----------

revoke all on function public.ww_create_room(text, boolean, text, boolean, boolean, integer) from public, anon;
revoke all on function public.ww_join_room(uuid, text) from public, anon;
revoke all on function public.ww_leave_room(uuid) from public, anon;
revoke all on function public.ww_start_set(uuid) from public, anon;
revoke all on function public.ww_post_message(uuid, text) from public, anon;
revoke all on function public.ww_cast_vote(uuid, uuid) from public, anon;
revoke all on function public.ww_submit_reversal(uuid, text) from public, anon;
revoke all on function public.ww_advance(uuid, integer) from public, anon;
revoke all on function public.ww_player_view(uuid) from public, anon;
revoke all on function public.ww_sweep() from public, anon, authenticated;
revoke all on function public.kl_is_room_member(uuid) from public, anon;

grant execute on function public.ww_create_room(text, boolean, text, boolean, boolean, integer) to authenticated;
grant execute on function public.ww_join_room(uuid, text) to authenticated;
grant execute on function public.ww_leave_room(uuid) to authenticated;
grant execute on function public.ww_start_set(uuid) to authenticated;
grant execute on function public.ww_post_message(uuid, text) to authenticated;
grant execute on function public.ww_cast_vote(uuid, uuid) to authenticated;
grant execute on function public.ww_submit_reversal(uuid, text) to authenticated;
grant execute on function public.ww_advance(uuid, integer) to authenticated;
grant execute on function public.ww_player_view(uuid) to authenticated;
grant execute on function public.kl_is_room_member(uuid) to authenticated;

-- ---------- Realtime ----------

do $$
begin
  alter publication supabase_realtime add table public.ww_games;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.ww_messages;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.dm_messages;
exception when duplicate_object then null;
end $$;

-- ---------- pg_cron（見回り） ----------
-- Free プランでは pg_cron の有効化がダッシュボード側で必要な場合がある。
-- 有効化されていない環境では、このブロックは通知だけ出して失敗しない。
do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule('ww-sweep', '* * * * *', 'select public.ww_sweep()');
exception when others then
  raise notice 'pg_cron の登録をスキップしました（%）。ダッシュボードで pg_cron を有効化してから再実行してください。', sqlerrm;
end $$;
