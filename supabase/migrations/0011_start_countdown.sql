-- =============================================================================
-- 0011_start_countdown.sql — 開始カウントダウンフロー＋挨拶タイム（Lite）
-- =============================================================================
-- 2026-11-24 おぎ決定（実機フィードバック）：
-- - 待機室の開始ボタンは「ゲーム開始」。ホストに限らずメンバーなら
--   誰か1人が押すと、全員に10秒のカウントダウン（フロート表示）が立つ
-- - 押した本人はキャンセル可、他のメンバーは「退室する」で抜けられる。
--   誰か1人でも退室したらカウントダウンは停止する。完走でセット開始
-- - 準備OK（0008 の ww_set_ready／ready 列）はフローとして廃止する
--   （列・関数は互換のため残置し、クライアントからは使わない）
-- - 開始待機フェーズ（intro）は「挨拶タイム」：お題はまだ渡さず、
--   話し合い（discussion）に入ってから表示する
-- 定数：カウントダウン秒数＝ww_request_start 内の START_COUNTDOWN_SECONDS、
-- 挨拶タイム秒数＝ww__new_game 内の INTRO_SECONDS。変更はその1箇所。
-- =============================================================================

alter table public.rooms
  add column if not exists start_requested_by uuid references auth.users (id),
  add column if not exists start_countdown_ends_at timestamptz;

comment on column public.rooms.start_countdown_ends_at is
  '開始カウントダウンの終了時刻。非 null ならカウントダウン中（start_requested_by が押した人）。';

-- ---------- 開始カウントダウンを立てる（メンバーなら誰でも） ----------

create or replace function public.ww_request_start(p_room uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  START_COUNTDOWN_SECONDS constant integer := 10;
  me uuid := auth.uid();
  room public.rooms%rowtype;
  n integer;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  select * into room from public.rooms where id = p_room for update;
  if not found then
    raise exception 'ROOM_NOT_FOUND: ルームが存在しません' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.room_members m
     where m.room_id = p_room and m.user_id = me
  ) then
    raise exception 'NOT_A_MEMBER: このルームに参加していません' using errcode = 'P0001';
  end if;
  if room.status <> 'lobby' then
    raise exception 'ROOM_BUSY: すでに進行中です' using errcode = 'P0001';
  end if;
  select count(*) into n from public.room_members where room_id = p_room;
  if n < 4 or n > 8 then
    raise exception 'INVALID_PLAYER_COUNT: ワードウルフは4〜8人です' using errcode = 'P0001';
  end if;
  -- すでに立っている場合はそのまま返す（連打・同時押し対策）
  if room.start_countdown_ends_at is null then
    update public.rooms
       set start_requested_by = me,
           start_countdown_ends_at = now() + make_interval(secs => START_COUNTDOWN_SECONDS)
     where id = p_room
     returning * into room;
  end if;
  return jsonb_build_object('startCountdown', jsonb_build_object(
    'by', room.start_requested_by,
    'endsAt', room.start_countdown_ends_at
  ));
end;
$$;

-- ---------- カウントダウンのキャンセル（押した本人のみ） ----------

create or replace function public.ww_cancel_start(p_room uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  room public.rooms%rowtype;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  select * into room from public.rooms where id = p_room for update;
  if not found then
    raise exception 'ROOM_NOT_FOUND: ルームが存在しません' using errcode = 'P0001';
  end if;
  if room.start_countdown_ends_at is not null
     and room.start_requested_by is distinct from me then
    raise exception 'NOT_REQUESTER: キャンセルできるのは開始を押した本人だけです' using errcode = 'P0001';
  end if;
  update public.rooms
     set start_requested_by = null, start_countdown_ends_at = null
   where id = p_room;
end;
$$;

-- ---------- 退室したらカウントダウン停止（0006 の再定義） ----------

create or replace function public.ww_leave_room(p_room uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  n integer;
begin
  delete from public.room_members where room_id = p_room and user_id = me;
  get diagnostics n = row_count;
  -- 誰か1人でも退室したらカウントダウンは止まる
  if n > 0 then
    update public.rooms
       set start_requested_by = null, start_countdown_ends_at = null
     where id = p_room and status = 'lobby'
       and start_countdown_ends_at is not null;
  end if;
end;
$$;

-- ---------- セット開始の本体（権限チェックなし。呼び出し側で担保） ----------

create or replace function public.ww__start_set_now(p_room uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  room public.rooms%rowtype;
  ids uuid[];
  set_row public.ww_sets%rowtype;
  game public.ww_games%rowtype;
begin
  select * into room from public.rooms where id = p_room for update;
  if not found then
    raise exception 'ROOM_NOT_FOUND: ルームが存在しません' using errcode = 'P0001';
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
  update public.rooms
     set status = 'playing',
         start_requested_by = null,
         start_countdown_ends_at = null
   where id = p_room;
  game := public.ww__new_game(set_row, 1);
  return jsonb_build_object('setId', set_row.id, 'gameId', game.id);
end;
$$;

-- ---------- セット開始（0006 の再定義） ----------
-- ホストの直接開始に加えて、カウントダウン完走後の合図（メンバーなら
-- 誰からでも可）を受け付ける。

create or replace function public.ww_start_set(p_room uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  room public.rooms%rowtype;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  select * into room from public.rooms where id = p_room;
  if not found then
    raise exception 'ROOM_NOT_FOUND: ルームが存在しません' using errcode = 'P0001';
  end if;
  if room.host_id <> me
     and not (
       room.start_countdown_ends_at is not null
       and room.start_countdown_ends_at <= now()
       and exists (
         select 1 from public.room_members m
          where m.room_id = p_room and m.user_id = me
       )
     ) then
    raise exception 'NOT_HOST: 開始できるのはホストだけです' using errcode = 'P0001';
  end if;
  return public.ww__start_set_now(p_room);
end;
$$;

-- ---------- 新規ゲーム（0006 の再定義：挨拶タイム秒数を定数化） ----------

create or replace function public.ww__new_game(p_set public.ww_sets, p_index integer)
returns public.ww_games
language plpgsql security definer set search_path = public
as $$
declare
  INTRO_SECONDS constant integer := 15; -- 挨拶タイムの長さ（変更はここ）
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
          now() + make_interval(secs => INTRO_SECONDS),
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

-- ---------- sweep（0010 の再定義：カウントダウン完走の自動開始を追加） ----------

create or replace function public.ww_sweep()
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  game public.ww_games%rowtype;
  room_row public.rooms%rowtype;
  n integer := 0;
begin
  perform public.ww__detect_abandons();
  -- 開始カウントダウンが完走したのに合図が届いていないルームを開始する
  for room_row in
    select * from public.rooms
     where status = 'lobby'
       and start_countdown_ends_at is not null
       and start_countdown_ends_at <= now()
     for update skip locked
  loop
    begin
      perform public.ww__start_set_now(room_row.id);
    exception when others then
      -- 人数不足など開始条件を満たさない場合はカウントダウンを畳む
      update public.rooms
         set start_requested_by = null, start_countdown_ends_at = null
       where id = room_row.id;
    end;
  end loop;
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

-- ---------- 個人ビュー（0010 の再定義：intro 中はお題を渡さない） ----------

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
    'playerIds', to_jsonb(v_player_ids),
    'setStatus', v_set_status,
    'terminatedUserIds', to_jsonb(coalesce(v_terminated_user_ids, '{}'::uuid[])),
    -- 挨拶タイム（intro）中はお題をまだ見せない
    'myTopic', case when game.phase = 'intro' then null else my_topic end,
    'myVoteCast', v_my_vote_cast,
    'myVoteTarget', v_my_vote_target,
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

revoke all on function public.ww_request_start(uuid) from public, anon;
revoke all on function public.ww_cancel_start(uuid) from public, anon;
revoke all on function public.ww__start_set_now(uuid) from public, anon, authenticated;
grant execute on function public.ww_request_start(uuid) to authenticated;
grant execute on function public.ww_cancel_start(uuid) to authenticated;
