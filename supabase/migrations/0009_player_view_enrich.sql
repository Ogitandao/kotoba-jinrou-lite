-- =============================================================================
-- 0009_player_view_enrich.sql — ww_player_view の拡充（Lite）
-- =============================================================================
-- 対戦画面フェーズで追加。従来の ww_player_view は自分の投票状態と
-- 参加者一覧を返さず、結果発表時の陣営開示も無かったため、画面側が
-- 組み立てられなかった。既存キーはすべて維持し、以下を追加する：
-- - playerIds：セット参加者（ww_sets.player_ids のスナップショット）
-- - myVoteCast / myVoteTarget：自分の投票済みか／投票先（スルーは
--   myVoteCast=true かつ myVoteTarget=null。票自体は他者には開示しない）
-- - reveal（result 以降のみ）：全員の陣営と配布お題。設計書 §4 の
--   「陣営とお題ペアは result 以降にだけ開示」に沿う
-- =============================================================================

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
begin
  select * into game from public.ww_games where id = p_game;
  if not found then
    raise exception 'GAME_NOT_FOUND: ゲームが存在しません' using errcode = 'P0001';
  end if;
  select player_ids into v_player_ids from public.ww_sets s where s.id = game.set_id;
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
    'myTopic', my_topic,
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
