-- =============================================================================
-- 0012_player_view_remain.sql — 個人ビューへ残り秒数・自分の発言数を追加
-- =============================================================================
-- 話し合い中の無発言警告（2026-11-24 おぎ追加指摘）：
-- 「話し合いフェーズで自分の発言が0件のまま残り1分を切ったら警告
-- バナーを出す」の判定を、クライアントの時計ではなくサーバー時刻
-- 基準で一貫させるため、ww_player_view に以下を追加する。
-- - phaseRemainSec：フェーズ締め切りまでの残り秒数（DB の now() 基準）
-- - myMessageCount：このゲームでの自分の発言数（kind='chat' のみ）
-- 本体は 0011 の ww_player_view の再定義（追加2項目のみ差分）。
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
    'phaseRemainSec', case
      when game.phase_deadline_at is null then null
      else greatest(0, ceil(extract(epoch from (game.phase_deadline_at - now())))::integer)
    end,
    'myMessageCount', (
      select count(*)::integer from public.ww_messages m
       where m.game_id = p_game and m.sender_id = me and m.kind = 'chat'
    ),
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
