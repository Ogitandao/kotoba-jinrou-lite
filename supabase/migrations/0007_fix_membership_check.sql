-- =============================================================================
-- 0007_fix_membership_check.sql — 参加者チェック式の修正
-- =============================================================================
-- 実DB検証（2026-11-24）で判明した 0006 のバグ修正。
-- `me = any (select player_ids ...)` は player_ids が uuid[] のため
-- 「operator does not exist: uuid = uuid[]」(42883) になり、
-- ww_post_message / ww_cast_vote / ww_player_view が常に失敗していた。
-- exists + 配列に対する any に書き換える。他のロジックは 0006 と同一。
-- =============================================================================

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
  if not (exists (select 1 from public.ww_sets s where s.id = game.set_id and me = any (s.player_ids))) then
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
  if not (exists (select 1 from public.ww_sets s where s.id = game.set_id and me = any (s.player_ids))) then
    raise exception 'NOT_A_PLAYER: このゲームの参加者ではありません' using errcode = 'P0001';
  end if;
  perform public.ww__require_window(game, array['voting']);
  if exists (select 1 from public.ww_votes
              where game_id = p_game and vote_round = game.vote_round and voter_id = me) then
    raise exception 'ALREADY_SUBMITTED: すでに投票済みです' using errcode = 'P0001';
  end if;
  if p_target is not null then
    if not (exists (select 1 from public.ww_sets s where s.id = game.set_id and p_target = any (s.player_ids))) then
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
  if not (exists (select 1 from public.ww_sets s where s.id = game.set_id and me = any (s.player_ids))) then
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
