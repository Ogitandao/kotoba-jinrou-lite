-- =============================================================================
-- 0014_game_unit_start_flow.sql — ゲーム単位制＋新開始フロー＋ポイントの
-- ルーム滞在中累積（Lite）
-- =============================================================================
-- 2026-11-24 夜のおぎ決定（計画書 lite-plan-draft.md「開始フロー」
-- 「ゲーム単位制」「ペナルティ」節が正本）：
-- - 3ゲーム1セット制を廃止し、1ゲームごとに完結させる。内部的には
--   ww_sets を「1ゲームだけのコンテナ」（games_per_set = 1）として
--   残し、勝敗カウント・結果行・ペナルティ連携の既存基盤を壊さない
-- - ゲーム終了後は全員いったん待機室に戻る（ルームは lobby に復帰し、
--   準備OKは全員リセットされる）
-- - 開始フロー（0011 のカウントダウン方式を置き換え）：
--   開始条件＝満室＋ルームマスター以外の全員が「準備OK！」＋
--   マスターが「ゲームスタート！」を押したときだけ。全員が押さないと
--   開始できない
-- - マスターは待機室で準備OKを押さない人をキックできる（ww_kick_member）
-- - マスターが退室したら参加順で最古参のメンバーへマスターを移譲する。
--   誰も残らなければルームは closed
-- - 満室＋全員準備OKが揃った時刻を rooms.all_ready_at に記録する
--   （将来の通報判定用の証跡。処分処理自体は未実装）
-- - 違反ポイントの累積範囲を「セット内」から「ルーム滞在中」へ：
--   room_members.violation_points に累積し、退室・キック・強制退室で
--   行が消えれば実質リセットされる
-- =============================================================================

-- ---------- 証跡：全員準備OKが揃った時刻 ----------

alter table public.rooms
  add column if not exists all_ready_at timestamptz;

comment on column public.rooms.all_ready_at is
  '満室＋マスター以外の全員が準備OKになった時刻（通報判定用の証跡）。条件が崩れたら NULL に戻る。';

-- ---------- 0011 のカウントダウン基盤を撤去 ----------

drop function if exists public.ww_request_start(uuid);
drop function if exists public.ww_cancel_start(uuid);
alter table public.rooms drop column if exists start_requested_by;
alter table public.rooms drop column if exists start_countdown_ends_at;

-- ---------- 違反ポイント（ルーム滞在中累積） ----------

alter table public.room_members
  add column if not exists violation_points numeric not null default 0;

comment on column public.room_members.violation_points is
  'ルーム滞在中の違反ポイント累積（合計1.0で強制退室）。メンバー行が消える（退室・キック・強制退室）と実質リセットされる。';

-- ---------- all_ready_at の再計算（内部専用） ----------

create or replace function public.ww__refresh_all_ready(p_room uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  room public.rooms%rowtype;
  n integer;
  not_ready integer;
begin
  select * into room from public.rooms where id = p_room;
  if not found then
    return;
  end if;
  if room.status <> 'lobby' then
    if room.all_ready_at is not null then
      update public.rooms set all_ready_at = null where id = p_room;
    end if;
    return;
  end if;
  select count(*),
         count(*) filter (where not m.ready and m.user_id <> room.host_id)
    into n, not_ready
    from public.room_members m
   where m.room_id = p_room;
  if n = room.capacity and not_ready = 0 then
    if room.all_ready_at is null then
      update public.rooms set all_ready_at = now() where id = p_room;
    end if;
  elsif room.all_ready_at is not null then
    update public.rooms set all_ready_at = null where id = p_room;
  end if;
end;
$$;

-- ---------- 準備OK（0008 の再定義：証跡の再計算を追加） ----------

create or replace function public.ww_set_ready(p_room uuid, p_ready boolean)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  n integer;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  update public.room_members set ready = p_ready
   where room_id = p_room and user_id = me;
  get diagnostics n = row_count;
  if n = 0 then
    raise exception 'NOT_A_MEMBER: このルームに参加していません' using errcode = 'P0001';
  end if;
  perform public.ww__refresh_all_ready(p_room);
end;
$$;

-- ---------- 参加（0010 の再定義：証跡の再計算を追加） ----------

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
  perform public.ww__refresh_all_ready(p_room);
end;
$$;

-- ---------- 退室（0011 の再定義：マスター移譲＋ポイントリセット） ----------
-- メンバー行を消すため、その人の滞在中ポイント（violation_points）も
-- 一緒に消える＝退出でリセット（おぎ決定の読み替えどおり）。

create or replace function public.ww_leave_room(p_room uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  room public.rooms%rowtype;
  next_host uuid;
begin
  delete from public.room_members where room_id = p_room and user_id = me;
  if not found then
    return;
  end if;
  select * into room from public.rooms where id = p_room;
  if found and room.host_id = me then
    select user_id into next_host
      from public.room_members
     where room_id = p_room
     order by joined_at
     limit 1;
    if next_host is not null then
      update public.rooms set host_id = next_host where id = p_room;
    elsif room.status = 'lobby' then
      -- 誰も残らなければルームを閉じる（対戦中の空ルームは見回りに任せる）
      update public.rooms set status = 'closed' where id = p_room;
    end if;
  end if;
  perform public.ww__refresh_all_ready(p_room);
end;
$$;

-- ---------- キック（マスターのみ・待機室のみ） ----------

create or replace function public.ww_kick_member(p_room uuid, p_target uuid)
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
  if room.host_id <> me then
    raise exception 'NOT_HOST: キックできるのはルームマスターだけです' using errcode = 'P0001';
  end if;
  if room.status <> 'lobby' then
    raise exception 'ROOM_BUSY: キックは待機室でのみできます' using errcode = 'P0001';
  end if;
  if p_target = room.host_id then
    raise exception 'INVALID_TARGET: マスターはキックできません' using errcode = 'P0001';
  end if;
  delete from public.room_members
   where room_id = p_room and user_id = p_target;
  if not found then
    raise exception 'NOT_A_MEMBER: 対象はこのルームのメンバーではありません' using errcode = 'P0001';
  end if;
  perform public.ww__refresh_all_ready(p_room);
end;
$$;

-- ---------- ゲーム開始（0011 の ww_start_set を置き換え） ----------

create or replace function public.ww__start_game_now(p_room uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  room public.rooms%rowtype;
  ids uuid[];
  not_ready integer;
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
  if ids is null or array_length(ids, 1) <> room.capacity then
    raise exception 'ROOM_NOT_FULL: 満室にならないと開始できません（現在 % / % 人）',
      coalesce(array_length(ids, 1), 0), room.capacity using errcode = 'P0001';
  end if;
  select count(*) into not_ready
    from public.room_members
   where room_id = p_room and user_id <> room.host_id and not ready;
  if not_ready > 0 then
    raise exception 'NOT_ALL_READY: 全員が準備OKを押さないと開始できません' using errcode = 'P0001';
  end if;

  -- ゲーム単位制：セットは「1ゲームだけのコンテナ」として作る
  insert into public.ww_sets (room_id, player_ids, games_per_set)
  values (p_room, ids, 1)
  returning * into set_row;
  update public.rooms set status = 'playing', all_ready_at = null where id = p_room;
  game := public.ww__new_game(set_row, 1);
  return jsonb_build_object('setId', set_row.id, 'gameId', game.id);
end;
$$;

create or replace function public.ww_start_game(p_room uuid)
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
  if room.host_id <> me then
    raise exception 'NOT_HOST: 開始できるのはルームマスターだけです' using errcode = 'P0001';
  end if;
  return public.ww__start_game_now(p_room);
end;
$$;

-- 旧開始 RPC は廃止（クライアントは ww_start_game に切り替える）
drop function if exists public.ww_start_set(uuid);
drop function if exists public.ww__start_set_now(uuid);

-- ---------- result 終了時：次ゲームへ進まず待機室へ戻す（0010 の再定義） ----------

create or replace function public.ww__advance_expired(p_game public.ww_games)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  set_row public.ww_sets%rowtype;
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
        -- 違反ポイント合計1.0のプレイヤーがいる：強制退室を確定する
        perform public.ww__terminate_set(
          set_row, set_row.terminate_after_game_user_ids, p_game.id, 'rule_violation');
      else
        -- ゲーム単位制：次ゲームは作らず、全員いったん待機室に戻る。
        -- 準備OKはリセットし、次のゲームは改めて全員の準備OKから
        update public.ww_sets
           set status = 'finished', finished_at = now()
         where id = set_row.id;
        update public.rooms set status = 'lobby', all_ready_at = null
         where id = p_game.room_id;
        update public.room_members set ready = false where room_id = p_game.room_id;
      end if;
    else
      null;
  end case;
end;
$$;

-- ---------- 強制終了（0010 の再定義：文言をゲーム単位に＋準備リセット） ----------

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
  update public.rooms set status = 'lobby', all_ready_at = null where id = p_set.room_id;
  update public.room_members set ready = false where room_id = p_set.room_id;
  -- マスター本人が強制退室の対象なら、最古参の残存メンバーへ移譲する
  if exists (select 1 from public.rooms h
              where h.id = p_set.room_id and h.host_id = any (p_user_ids)) then
    update public.rooms
       set host_id = (select m.user_id from public.room_members m
                       where m.room_id = p_set.room_id
                         and not (m.user_id = any (p_user_ids))
                       order by m.joined_at limit 1)
     where id = p_set.room_id
       and exists (select 1 from public.room_members m
                    where m.room_id = p_set.room_id
                      and not (m.user_id = any (p_user_ids)));
  end if;
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
    '対戦は終了しました。完了したゲームの勝敗は記録されています。');
end;
$$;

-- ---------- 違反ポイント記録（0013 の再定義：累積先をルーム滞在中へ） ----------

create or replace function public.ww__record_vote_skips(p_game public.ww_games)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  pid uuid;
  v_has_valid boolean;
  v_has_row boolean;
  v_msgs integer;
  v_points numeric;
  v_kind text;
  v_total numeric;
begin
  update public.ww_games set skips_recorded = true
  where id = p_game.id and not skips_recorded;
  if not found then
    return;
  end if;

  for pid in
    select unnest(player_ids) from public.ww_sets where id = p_game.set_id
  loop
    select
      exists (
        select 1 from public.ww_votes v
        where v.game_id = p_game.id and v.vote_round = p_game.vote_round
          and v.voter_id = pid and v.target_id is not null),
      exists (
        select 1 from public.ww_votes v
        where v.game_id = p_game.id and v.vote_round = p_game.vote_round
          and v.voter_id = pid)
      into v_has_valid, v_has_row;

    select count(*) into v_msgs
    from public.ww_messages m
    where m.game_id = p_game.id and m.sender_id = pid and m.kind = 'chat';

    if v_has_valid then
      if v_msgs > 0 then
        continue;
      end if;
      v_points := 0.5;
      v_kind := 'silent_play';
    elsif v_msgs = 0 and not v_has_row then
      v_points := 1.0;
      v_kind := 'silent_no_vote';
    else
      v_points := 0.5;
      v_kind := 'vote_skip';
    end if;

    -- ポイント行（制限・通知なし）
    insert into public.penalty_events
      (user_id, track, kind, room_id, set_id, game_id, step, minutes, points, forced_removal)
    values
      (pid, 'afk', v_kind, p_game.room_id, p_game.set_id, p_game.id, null, 0, v_points, false);

    -- 累積はルーム滞在中（room_members.violation_points）。
    -- メンバー行が無い場合は今回分だけで判定する（通常は起きない）
    update public.room_members
       set violation_points = violation_points + v_points
     where room_id = p_game.room_id and user_id = pid
     returning violation_points into v_total;
    if v_total is null then
      v_total := v_points;
    end if;

    if v_total >= 1.0 then
      perform public.kl__apply_penalty(
        pid, 'afk', v_kind, p_game.room_id, p_game.set_id, p_game.id, true,
        case when v_kind = 'silent_no_vote'
          then '対戦中に発言も投票もなかったため、強制退室となりました。'
          else '対戦中の違反ポイントが上限（1.0）に達したため、強制退室となりました。'
        end);
      update public.ww_sets
      set terminate_after_game_user_ids = (
        select array_agg(distinct x)
        from unnest(terminate_after_game_user_ids || pid) as x)
      where id = p_game.set_id;
    end if;
  end loop;
end;
$$;

-- ---------- sweep（0011 の再定義：カウントダウン完走処理を撤去） ----------

create or replace function public.ww_sweep()
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  game public.ww_games%rowtype;
  n integer := 0;
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
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- ---------- 実行権限 ----------

revoke all on function public.ww__refresh_all_ready(uuid) from public, anon, authenticated;
revoke all on function public.ww__start_game_now(uuid) from public, anon, authenticated;
revoke all on function public.ww_start_game(uuid) from public, anon;
revoke all on function public.ww_kick_member(uuid, uuid) from public, anon;
grant execute on function public.ww_start_game(uuid) to authenticated;
grant execute on function public.ww_kick_member(uuid, uuid) to authenticated;
