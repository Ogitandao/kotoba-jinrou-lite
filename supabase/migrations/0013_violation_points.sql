-- ============================================================
-- 0013: 違反ポイント制（2026-11-24 おぎ確定）
-- ------------------------------------------------------------
-- 投票解決時の違反をポイントで統一する：
--   発言0件＋未投票（投票行為そのものがない） …… 1.0ポイント
--   発言0件＋投票あり ………………………………… 0.5ポイント
--   発言あり＋未投票／棄権 ………………………… 0.5ポイント
--   発言あり＋投票あり ……………………………… 0ポイント
-- ポイントはセット内で累積し、合計1.0に達した時点で
-- 強制退室＋ペナルティ階段+1（離脱系トラック）。
-- 退室とセット終了の確定は従来どおり result 終了時
-- （terminate_after_game_user_ids 経由）。
-- 1.0未満のポイントは制限もDM通知も発生させない
-- （penalty_events に minutes = 0 の行として記録するだけ。
--  段階計算 kl__apply_penalty は minutes <> 0 の行だけを見る）。
-- セットが変われば集計対象も変わるため、ポイントは実質リセット。
--
-- 注意：明示的な棄権（target が NULL の投票行）は「投票なし」
-- には数えない。その場にいて意思表示したものとして、
-- 発言があれば vote_skip（0.5）、発言がなければ silent_play でも
-- vote_skip でもなく「投票行あり」として扱う：
-- 発言0＋棄権は vote_skip（0.5）になる。
-- （silent_no_vote は投票行そのものがない場合のみ）
-- ============================================================

-- ---------- penalty_events の拡張 ----------

alter table public.penalty_events
  add column if not exists points numeric not null default 0;

alter table public.penalty_events
  drop constraint if exists penalty_events_kind_check;
alter table public.penalty_events
  add constraint penalty_events_kind_check
  check (kind in ('vote_skip', 'abandon', 'manual', 'silent_play', 'silent_no_vote'));

comment on column public.penalty_events.points is
'違反ポイント（0.5 / 1.0）。ポイントだけの行は minutes = 0・step は NULL で、制限も通知も発生しない。セット内合計1.0で kl__apply_penalty が別行として適用される。';

comment on column public.ww_sets.terminate_after_game_user_ids is
'違反ポイント合計1.0到達で強制退室が決まったプレイヤー。現在のゲームの result 終了時に退室＋セット終了を確定する。';

-- ---------- 違反ポイントの記録（内部専用） ----------

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

    select coalesce(sum(points), 0) into v_total
    from public.penalty_events
    where user_id = pid and set_id = p_game.set_id;

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

revoke all on function public.ww__record_vote_skips(public.ww_games) from public, anon, authenticated;
