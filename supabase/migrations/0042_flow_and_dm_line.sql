-- 0042 流れ判定＋DM確定ライン緩和（2026-11-25 おぎ決定）
--
-- 背景：1発言だけでは中間帯（0.6〜）止まりの嫌がらせが続くケースで、
-- 通報者が報われない問題への対策として2点を変更する。
--
-- 1) 流れ判定：同じ投稿者・同じスレッド（DMペア／ルーム／ゲーム／グループ）で、
--    直近7日以内に「中間帯以上（最大スコア>=0.6 または NG 重）」の通報ケースが
--    自分を含めて3件溜まったら、流れ全体で違反1件として確定する（警告から）。
--    数えた過去ケースは decision_reason='flow_counted' にして再カウントしない。
--    過去ケースの通報者への再通知はしない（簡略化・0040 の割り切りと同種）。
-- 2) DM の確定ライン緩和：DM は1対1で通報の重みが 3.0 に届かず仮非表示も
--    成立しにくいため、harassment/hate/sexual の確定ラインを 0.85 → 0.75 に
--    下げる（抑止目的）。処分階段（警告→7日→30日→無期限）自体は変更しない。
--    脅迫系 0.7・violence/graphic 0.7・sexual/minors の severe 扱いは全画面共通。

-- ---------- スレッドキー（ケース→会話の同一性） ----------
create or replace function public.kl__case_thread_key(p_surface text, p_ref uuid)
returns text
language plpgsql security definer set search_path = public stable
as $$
declare
  v_key text;
begin
  if p_surface = 'dm' then
    select 'dm:' || least(sender_id::text, recipient_id::text) || ':'
           || greatest(sender_id::text, recipient_id::text)
      into v_key from public.dm_messages where id = p_ref;
  elsif p_surface = 'room' then
    select 'room:' || room_id::text into v_key from public.ww_room_messages where id = p_ref;
  elsif p_surface = 'game' then
    select 'game:' || game_id::text into v_key from public.ww_messages where id = p_ref;
  elsif p_surface = 'group' then
    select 'group:' || group_id::text into v_key from public.kl_group_messages where id = p_ref;
  end if;
  return v_key;
end;
$$;

revoke execute on function public.kl__case_thread_key(text, uuid) from public, anon, authenticated;

-- ---------- finalize 差し替え ----------
create or replace function public.kl__finalize_case(
  p_case_id uuid,
  p_scores jsonb
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  c public.moderation_cases;
  s jsonb := coalesce(p_scores -> 'scores', '{}'::jsonb);
  f jsonb := coalesce(p_scores -> 'flagged', '{}'::jsonb);
  v_sm numeric := coalesce((s ->> 'sexual/minors')::numeric, 0);
  v_ht numeric := coalesce((s ->> 'harassment/threatening')::numeric, 0);
  v_hat numeric := coalesce((s ->> 'hate/threatening')::numeric, 0);
  v_vg numeric := coalesce((s ->> 'violence/graphic')::numeric, 0);
  v_har numeric := coalesce((s ->> 'harassment')::numeric, 0);
  v_hate numeric := coalesce((s ->> 'hate')::numeric, 0);
  v_sex numeric := coalesce((s ->> 'sexual')::numeric, 0);
  v_flag_minors boolean := coalesce((f ->> 'sexual/minors')::boolean, false);
  v_ng_heavy boolean;
  v_severe boolean;
  v_instant boolean;
  v_mid boolean;
  v_line_main numeric;
  v_flow boolean := false;
  v_flow_siblings integer := 0;
  v_thread text;
  v_is_message boolean;
  v_was_hidden boolean := false;
  v_newly_hidden boolean := false;
  v_reason_label text;
  v_surface_label text;
  v_episodes integer;
  v_pen jsonb;
  v_outcome text;  -- upheld / dismissed
  r_id uuid;
  v_reporter uuid;
begin
  select * into c from public.moderation_cases where id = p_case_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'CASE_NOT_FOUND');
  end if;
  if c.decision not in ('pending', 'hidden') or c.scored_at is not null then
    return jsonb_build_object('ok', true, 'skipped', true);
  end if;

  v_ng_heavy := coalesce(c.ng_hits @> '["heavy"]'::jsonb, false);
  v_severe := v_flag_minors or v_sm >= 0.3 or v_ht >= 0.7 or v_hat >= 0.7;
  -- DM だけ確定ラインを 0.75 に緩和（0042）
  v_line_main := case when c.surface = 'dm' then 0.75 else 0.85 end;
  v_instant := v_severe or v_vg >= 0.7
    or v_har >= v_line_main or v_hate >= v_line_main or v_sex >= v_line_main;
  v_mid := not v_instant
    and (greatest(v_har, v_hate, v_sex, v_ht, v_hat, v_vg) >= 0.6 or v_ng_heavy);
  v_is_message := c.surface in ('dm', 'room', 'game', 'group');
  v_surface_label := case c.surface when 'dm' then 'DM' when 'room' then '待機室チャット'
    when 'group' then 'グループチャット' else '対戦チャット' end;
  v_reason_label := case
    when v_sm >= 0.3 or v_flag_minors then '未成年者が関わる性的表現'
    when v_ht >= 0.6 or v_hat >= 0.6 then '脅迫'
    when v_har >= v_hate and v_har >= v_sex then '嫌がらせ・暴言'
    when v_hate >= v_sex then '差別的な発言'
    when v_sex >= 0.3 then '性的な発言'
    when v_vg >= 0.6 then '過激な暴力表現'
    else '不適切な発言' end;

  -- 現在の非表示状態
  if c.surface = 'dm' then
    select hidden_at is not null into v_was_hidden from public.dm_messages where id = c.target_ref;
  elsif c.surface = 'room' then
    select hidden_at is not null into v_was_hidden from public.ww_room_messages where id = c.target_ref;
  elsif c.surface = 'game' then
    select hidden_at is not null into v_was_hidden from public.ww_messages where id = c.target_ref;
  elsif c.surface = 'group' then
    select hidden_at is not null into v_was_hidden from public.kl_group_messages where id = c.target_ref;
  end if;
  v_was_hidden := coalesce(v_was_hidden, false);

  update public.moderation_cases
  set moderation_scores = p_scores, scored_at = now()
  where id = c.id;

  -- ===== 流れ判定の下調べ（中間帯のときだけ） =====
  if not v_instant and v_mid and v_is_message then
    v_thread := public.kl__case_thread_key(c.surface, c.target_ref);
    if v_thread is not null then
      select count(*) into v_flow_siblings
      from public.moderation_cases x
      where x.target_user_id = c.target_user_id
        and x.id <> c.id
        and x.surface = c.surface
        and x.created_at > now() - interval '7 days'
        and x.scored_at is not null
        and x.decision in ('dismissed', 'hidden')
        and coalesce(x.decision_reason, '') <> 'flow_counted'
        and public.kl__case_thread_key(x.surface, x.target_ref) = v_thread
        and (greatest(
              coalesce((x.moderation_scores -> 'scores' ->> 'harassment')::numeric, 0),
              coalesce((x.moderation_scores -> 'scores' ->> 'hate')::numeric, 0),
              coalesce((x.moderation_scores -> 'scores' ->> 'sexual')::numeric, 0),
              coalesce((x.moderation_scores -> 'scores' ->> 'harassment/threatening')::numeric, 0),
              coalesce((x.moderation_scores -> 'scores' ->> 'hate/threatening')::numeric, 0),
              coalesce((x.moderation_scores -> 'scores' ->> 'violence/graphic')::numeric, 0)
            ) >= 0.6
          or coalesce(x.ng_hits @> '["heavy"]'::jsonb, false));
      v_flow := v_flow_siblings >= 2;  -- 自分を含めて3件
    end if;
  end if;

  if v_instant then
    -- ===== 違反確定（§1.5） =====
    if v_is_message and not v_was_hidden then
      if c.surface = 'dm' then
        update public.dm_messages set hidden_at = now() where id = c.target_ref and hidden_at is null;
      elsif c.surface = 'room' then
        update public.ww_room_messages set hidden_at = now() where id = c.target_ref and hidden_at is null;
      elsif c.surface = 'game' then
        update public.ww_messages set hidden_at = now() where id = c.target_ref and hidden_at is null;
      elsif c.surface = 'group' then
        update public.kl_group_messages set hidden_at = now() where id = c.target_ref and hidden_at is null;
      end if;
      v_newly_hidden := found;
    end if;
    if v_newly_hidden then
      perform public.kl__send_system_dm(c.target_user_id,
        'あなたの投稿がルールに違反する可能性があるため、他のユーザーから見えない状態にしました。' || chr(10) || chr(10)
        || '対象：' || v_surface_label || chr(10) || chr(10)
        || '確認の結果、違反が認められた場合は利用制限の対象になります。違反が確認されなかった場合、表示は自動的に戻ります。');
    end if;

    -- エピソード上限（同一面・24時間で最大2件まで数える）
    select count(*) into v_episodes
    from public.moderation_cases
    where target_user_id = c.target_user_id and surface = c.surface
      and decision in ('warned', 'penalized')
      and decided_at > now() - interval '24 hours';

    if v_episodes >= 2 then
      update public.moderation_cases
      set decision = 'hidden', decision_reason = 'episode_cap',
          retention_until = now() + interval '180 days', decided_at = now()
      where id = c.id;
    else
      v_pen := public.kl__apply_harassment_penalty(c.target_user_id, v_severe, v_reason_label, c.id);
      update public.moderation_cases
      set decision = case when v_pen ->> 'action' = 'warning' then 'warned' else 'penalized' end,
          decision_reason = 'score:confirmed' || case when v_severe then ':severe' else '' end
            || case when c.surface = 'dm' then ':dm' else '' end,
          severe = v_severe,
          penalty_event_id = (v_pen ->> 'eventId')::uuid,
          retention_until = now() + case when v_severe then interval '3 years' else interval '1 year' end,
          decided_at = now()
      where id = c.id;
    end if;
    v_outcome := 'upheld';

  elsif v_flow then
    -- ===== 流れ判定で違反確定（0042） =====
    if not v_was_hidden then
      if c.surface = 'dm' then
        update public.dm_messages set hidden_at = now() where id = c.target_ref and hidden_at is null;
      elsif c.surface = 'room' then
        update public.ww_room_messages set hidden_at = now() where id = c.target_ref and hidden_at is null;
      elsif c.surface = 'game' then
        update public.ww_messages set hidden_at = now() where id = c.target_ref and hidden_at is null;
      elsif c.surface = 'group' then
        update public.kl_group_messages set hidden_at = now() where id = c.target_ref and hidden_at is null;
      end if;
      v_newly_hidden := found;
    end if;
    if v_newly_hidden then
      perform public.kl__send_system_dm(c.target_user_id,
        'あなたの投稿がルールに違反する可能性があるため、他のユーザーから見えない状態にしました。' || chr(10) || chr(10)
        || '対象：' || v_surface_label || chr(10) || chr(10)
        || '確認の結果、違反が認められた場合は利用制限の対象になります。違反が確認されなかった場合、表示は自動的に戻ります。');
    end if;

    select count(*) into v_episodes
    from public.moderation_cases
    where target_user_id = c.target_user_id and surface = c.surface
      and decision in ('warned', 'penalized')
      and decided_at > now() - interval '24 hours';

    if v_episodes >= 2 then
      update public.moderation_cases
      set decision = 'hidden', decision_reason = 'episode_cap',
          retention_until = now() + interval '180 days', decided_at = now()
      where id = c.id;
    else
      v_pen := public.kl__apply_harassment_penalty(c.target_user_id, false, v_reason_label, c.id);
      update public.moderation_cases
      set decision = case when v_pen ->> 'action' = 'warning' then 'warned' else 'penalized' end,
          decision_reason = 'flow:accumulated',
          severe = false,
          penalty_event_id = (v_pen ->> 'eventId')::uuid,
          retention_until = now() + interval '1 year',
          decided_at = now()
      where id = c.id;
      -- 数えた過去ケースは再カウントしない
      update public.moderation_cases x
      set decision_reason = 'flow_counted'
      where x.target_user_id = c.target_user_id
        and x.id <> c.id
        and x.surface = c.surface
        and x.created_at > now() - interval '7 days'
        and x.scored_at is not null
        and x.decision in ('dismissed', 'hidden')
        and coalesce(x.decision_reason, '') <> 'flow_counted'
        and public.kl__case_thread_key(x.surface, x.target_ref) = v_thread
        and (greatest(
              coalesce((x.moderation_scores -> 'scores' ->> 'harassment')::numeric, 0),
              coalesce((x.moderation_scores -> 'scores' ->> 'hate')::numeric, 0),
              coalesce((x.moderation_scores -> 'scores' ->> 'sexual')::numeric, 0),
              coalesce((x.moderation_scores -> 'scores' ->> 'harassment/threatening')::numeric, 0),
              coalesce((x.moderation_scores -> 'scores' ->> 'hate/threatening')::numeric, 0),
              coalesce((x.moderation_scores -> 'scores' ->> 'violence/graphic')::numeric, 0)
            ) >= 0.6
          or coalesce(x.ng_hits @> '["heavy"]'::jsonb, false));
    end if;
    v_outcome := 'upheld';

  elsif v_mid and c.report_weight >= 3.0 and v_is_message then
    -- ===== 中間帯＋重み：仮非表示を維持（§1.4） =====
    if not v_was_hidden then
      if c.surface = 'dm' then
        update public.dm_messages set hidden_at = now() where id = c.target_ref and hidden_at is null;
      elsif c.surface = 'room' then
        update public.ww_room_messages set hidden_at = now() where id = c.target_ref and hidden_at is null;
      elsif c.surface = 'game' then
        update public.ww_messages set hidden_at = now() where id = c.target_ref and hidden_at is null;
      elsif c.surface = 'group' then
        update public.kl_group_messages set hidden_at = now() where id = c.target_ref and hidden_at is null;
      end if;
      v_newly_hidden := found;
    end if;
    if v_newly_hidden then
      perform public.kl__send_system_dm(c.target_user_id,
        'あなたの投稿がルールに違反する可能性があるため、他のユーザーから見えない状態にしました。' || chr(10) || chr(10)
        || '対象：' || v_surface_label || chr(10) || chr(10)
        || '確認の結果、違反が認められた場合は利用制限の対象になります。違反が確認されなかった場合、表示は自動的に戻ります。');
    end if;
    update public.moderation_cases
    set decision = 'hidden', decision_reason = 'provisional:score_band+weight>=3.0',
        retention_until = now() + interval '180 days', decided_at = now()
    where id = c.id;
    v_outcome := 'upheld';

  else
    -- ===== 却下：仮非表示は自動で戻す（§1.4） =====
    if v_was_hidden then
      if c.surface = 'dm' then
        update public.dm_messages set hidden_at = null where id = c.target_ref;
      elsif c.surface = 'room' then
        update public.ww_room_messages set hidden_at = null where id = c.target_ref;
      elsif c.surface = 'game' then
        update public.ww_messages set hidden_at = null where id = c.target_ref;
      elsif c.surface = 'group' then
        update public.kl_group_messages set hidden_at = null where id = c.target_ref;
      end if;
    end if;
    update public.moderation_cases
    set decision = 'dismissed', decision_reason = 'score:below_threshold',
        retention_until = now() + interval '90 days', decided_at = now()
    where id = c.id;
    v_outcome := 'dismissed';
  end if;

  -- ===== 通報の確定＋通報者への反映（§3.1／§3.4／U6） =====
  update public.reports set status = v_outcome where id = any(c.report_ids);

  for v_reporter in
    select distinct reporter_id from public.reports where id = any(c.report_ids)
  loop
    perform public.kl__ensure_reporter_stats(v_reporter);
    if v_outcome = 'upheld' then
      update public.reporter_stats
      set reports_upheld = reports_upheld + 1,
          trust_score = least(2.0, trust_score + 0.1), updated_at = now()
      where user_id = v_reporter;
      perform public.kl__send_system_dm(v_reporter,
        '以前通報いただいた件について、ルール違反を確認し、対応しました。ご協力ありがとうございました。' || chr(10)
        || '※対応の詳しい内容はお伝えできません。');
    else
      update public.reporter_stats
      set reports_dismissed = reports_dismissed + 1,
          trust_score = greatest(0.2, trust_score - 0.2), updated_at = now()
      where user_id = v_reporter;
      perform public.kl__send_system_dm(v_reporter,
        '以前通報いただいた件を確認しましたが、ルール違反は確認できませんでした。引き続き気になることがあれば、遠慮なく通報してください。');
      -- 虚偽通報への警告（U6：処分階段には乗せない）
      declare
        st public.reporter_stats;
      begin
        select * into st from public.reporter_stats where user_id = v_reporter;
        if st.abuse_warned_at is null
           and (st.reports_dismissed >= 10 or st.trust_score < 0.3) then
          update public.reporter_stats
          set abuse_warned_at = now(), abuse_warned_dismissed = st.reports_dismissed
          where user_id = v_reporter;
          perform public.kl__send_system_dm(v_reporter,
            'あなたの通報を複数回確認しましたが、ルール違反は確認できませんでした。' || chr(10) || chr(10)
            || '通報は、みんなが安心して遊べる環境を守るための仕組みです。事実と異なる通報や、特定の人への嫌がらせ目的の通報が続く場合、通報機能の利用を制限することがあります。');
        elsif st.abuse_warned_at is not null
           and st.reports_dismissed - coalesce(st.abuse_warned_dismissed, 0) >= 10
           and (st.report_blocked_until is null or st.report_blocked_until < now()) then
          update public.reporter_stats
          set report_blocked_until = now() + interval '30 days',
              abuse_warned_dismissed = st.reports_dismissed
          where user_id = v_reporter;
        end if;
      end;
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'outcome', v_outcome,
    'severe', v_severe, 'instant', v_instant, 'mid', v_mid, 'flow', v_flow);
end;
$$;

revoke execute on function public.kl__finalize_case(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.kl__finalize_case(uuid, jsonb) to service_role;
