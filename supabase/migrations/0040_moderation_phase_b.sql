-- =============================================================================
-- 0040_moderation_phase_b.sql — 処分パイプライン Phase B（スコア判定と確定）
-- =============================================================================
-- 決定の正本：docs/enforcement-design.md §1.4／§1.5／§3＋決定記録 U1〜U10。
--
-- 構成：
-- - Edge Function moderation-run が未スコアのケースを OpenAI Moderation API
--   （omni-moderation-latest・無料枠）で採点し、本書の kl__finalize_case を
--   呼ぶ。呼び出しは pg_cron（5分毎）→ pg_net → 関数（x-cron-secret 照合。
--   秘密は kl_config に置き、関数は service role で照合する）
-- - kl__finalize_case：スコア＋NG＋重みから確定判定する頭脳。
--   即時非表示ライン（§1.4）＝違反確定。重大カテゴリ（sexual/minors
--   フラグ or ≥0.3、脅迫系 ≥0.7）は U1 により初回から無期限凍結。
--   通常カテゴリは90日窓（U2）で数え、1件目=警告／2件目=7日／
--   3件目=30日／4件目=無期限。同一面・24時間は最大2件（§1.5 エピソード上限）
--   中間帯（0.6〜ライン未満 or 重度NG）＋重み≥3.0 は仮非表示を維持。
--   それ以外は却下し、仮非表示は自動で戻す
-- - 通報者への結果DM（§5.4）＋信頼度の更新（的中+0.1／却下−0.2、§3.1）、
--   虚偽通報への警告DM（§5.7。U6：処分階段には乗せない）と、
--   警告後も却下が10件増えたら通報機能を30日制限（§3.3）
-- - 保持期間（U5／U9）：処分・警告=1年、重大=3年、非表示のみ=180日、却下=90日
--
-- 簡略化の記録：§1.4 最下行「スコア<0.6 かつ重み<3.0 は保留」は、
-- 却下（表示復旧＋結果DM）として確定させる。新たな通報が来れば
-- sweep が新しいケースを作り直すため、再評価の道は残る。
-- =============================================================================

-- ---------- 基盤 ----------

alter table public.moderation_cases
  add column if not exists scored_at timestamptz;

comment on column public.moderation_cases.scored_at is 'Phase B で Moderation スコアを取得した時刻。NULL=未スコア。';

alter table public.reporter_stats
  add column if not exists abuse_warned_dismissed integer;

comment on column public.reporter_stats.abuse_warned_dismissed is '虚偽通報の警告DMを送った時点の reports_dismissed（以後の濫用判定の基準）。';

create table if not exists public.kl_config (
  key text primary key,
  value text not null
);
alter table public.kl_config enable row level security;
revoke all on table public.kl_config from public, anon, authenticated;
grant select on table public.kl_config to service_role;
grant select on table public.moderation_cases to service_role;

insert into public.kl_config (key, value)
values ('moderation_cron_secret', gen_random_uuid()::text)
on conflict (key) do nothing;

-- ---------- ハラスメント階段（U1／U2） ----------

create or replace function public.kl__apply_harassment_penalty(
  p_user uuid,
  p_severe boolean,
  p_reason_label text,
  p_case_id uuid
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_prior integer;
  v_n integer;
  v_minutes integer;
  v_step integer;
  v_prev_until timestamptz;
  v_until timestamptz;
  v_event uuid;
  v_body text;
  v_next_label text;
begin
  -- 90日窓（U2）：窓の外の確定違反は数えない
  select count(*) into v_prior
  from public.penalty_events
  where user_id = p_user and track = 'harassment'
    and kind in ('warning', 'violation')
    and created_at > now() - interval '90 days';
  v_n := v_prior + 1;

  if not p_severe and v_n = 1 then
    -- 通常カテゴリ1件目：警告のみ（§5.2）
    insert into public.penalty_events (user_id, track, kind, step, minutes)
    values (p_user, 'harassment', 'warning', 0, 0)
    returning id into v_event;
    perform public.kl__send_system_dm(p_user,
      'あなたの発言が「ことば人狼」のルールに違反すると確認されました。今回は警告のみで、利用制限はありません。' || chr(10) || chr(10)
      || '■ 理由：' || p_reason_label || chr(10) || chr(10)
      || '次に同じ違反が確認された場合、利用制限（7日間〜）の対象になります。みんなが気持ちよく遊べるよう、ご協力をお願いします。');
    return jsonb_build_object('action', 'warning', 'count', v_n, 'eventId', v_event);
  end if;

  if p_severe or v_n >= 4 then
    v_minutes := -1; v_step := 3;
  elsif v_n = 2 then
    v_minutes := 10080; v_step := 1;
  else
    v_minutes := 43200; v_step := 2;
  end if;

  select penalty_until into v_prev_until from public.profiles where id = p_user;
  if v_minutes = -1 then
    v_until := 'infinity'::timestamptz;
  else
    v_until := greatest(coalesce(v_prev_until, now()), now()) + make_interval(mins => v_minutes);
  end if;
  update public.profiles set penalty_until = v_until where id = p_user;

  insert into public.penalty_events (user_id, track, kind, step, minutes, penalty_until)
  values (p_user, 'harassment', 'violation', v_step, v_minutes, v_until)
  returning id into v_event;

  -- §5.1（無期限は期間表記と次段階の文を差し替える）
  v_body := 'あなたの発言・行為が「ことば人狼」のルール（嫌がらせ・暴言等）に違反すると確認されたため、利用制限を行いました。' || chr(10) || chr(10)
    || '■ 理由：' || p_reason_label || chr(10)
    || '■ 制限内容：ゲームへの参加・ルーム作成ができません（ロビー・DM・フレンドは使えます）' || chr(10);
  if v_minutes = -1 then
    v_body := v_body || '■ 制限期間：無期限（解除には異議申し立ての審査が必要です）' || chr(10) || chr(10)
      || '心当たりがない場合は、運営への異議申し立てができます（1回まで）。';
  else
    v_next_label := case when v_step = 1 then '30日間' else '無期限' end;
    v_body := v_body || '■ 制限期間：' || to_char(now() at time zone 'Asia/Tokyo', 'YYYY年MM月DD日 HH24時MI分')
      || ' 〜 ' || to_char(v_until at time zone 'Asia/Tokyo', 'YYYY年MM月DD日 HH24時MI分') || chr(10) || chr(10)
      || '違反が重なると、制限期間はさらに長くなります（次回は' || v_next_label || '）。心当たりがない場合は、運営への異議申し立てができます（1回まで）。';
  end if;
  perform public.kl__send_system_dm(p_user, v_body);

  return jsonb_build_object('action', 'penalty', 'count', v_n, 'step', v_step,
    'minutes', v_minutes, 'until', v_until, 'eventId', v_event);
end;
$$;

revoke execute on function public.kl__apply_harassment_penalty(uuid, boolean, text, uuid) from public, anon, authenticated;

-- ---------- 確定判定の頭脳 ----------

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
  v_instant := v_severe or v_vg >= 0.7 or v_har >= 0.85 or v_hate >= 0.85 or v_sex >= 0.85;
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
          decision_reason = 'score:confirmed' || case when v_severe then ':severe' else '' end,
          severe = v_severe,
          penalty_event_id = (v_pen ->> 'eventId')::uuid,
          retention_until = now() + case when v_severe then interval '3 years' else interval '1 year' end,
          decided_at = now()
      where id = c.id;
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
    'severe', v_severe, 'instant', v_instant, 'mid', v_mid);
end;
$$;

revoke execute on function public.kl__finalize_case(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.kl__finalize_case(uuid, jsonb) to service_role;

-- ---------- Edge Function の定期呼び出し（pg_cron → pg_net） ----------

create or replace function public.kl__call_moderation_run()
returns bigint
language plpgsql security definer set search_path = public
as $$
declare
  v_secret text;
  v_req bigint;
begin
  select value into v_secret from public.kl_config where key = 'moderation_cron_secret';
  if v_secret is null then
    return null;
  end if;
  select net.http_post(
    url := 'https://dtdwkluanoaqiaruzbwe.supabase.co/functions/v1/moderation-run',
    body := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', v_secret)
  ) into v_req;
  return v_req;
end;
$$;

revoke execute on function public.kl__call_moderation_run() from public, anon, authenticated;

select cron.unschedule('kl-moderation-run')
where exists (select 1 from cron.job where jobname = 'kl-moderation-run');

select cron.schedule('kl-moderation-run', '*/5 * * * *',
  'select public.kl__call_moderation_run()');

-- ---------- sweep の置換（'user' 面のスナップショット追加） ----------
-- ※ この後に 0038 の sweep へ user 分岐を足した全置換が続く（別途連結）
create or replace function public.kl__moderation_sweep()
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_cases integer := 0;
  v_hidden integer := 0;
  v_stalls integer := 0;
  g record;
  v_case_id uuid;
  v_snapshot text;
  v_author uuid;
  v_surface text;
  v_ctx jsonb;
  v_ng text;
  v_weight numeric;
  v_report_ids uuid[];
  v_room uuid;
  v_same_room_reporters integer;
  v_surface_label text;
  v_msg_at timestamptz;
  s record;
  v_recent integer;
  v_confirmed_total integer;
  v_newly integer;
  v_ev record;
begin
  -- ===== ① 通報の集約 → ケース化＋仮非表示 =====
  for g in
    select target_kind, target_ref, target_user_id,
           array_agg(id) as report_ids, count(distinct reporter_id) as reporters
    from public.reports
    where status = 'pending' and case_id is null
    group by target_kind, target_ref, target_user_id
  loop
    v_surface := case g.target_kind
      when 'dm_message' then 'dm'
      when 'room_message' then 'room'
      when 'game_message' then 'game'
      when 'group_message' then 'group'
      else 'profile' end;
    v_author := g.target_user_id;
    v_snapshot := null; v_ctx := null; v_msg_at := null; v_room := null;

    if g.target_kind = 'user' then
      -- プロフィール通報：名前＋自己紹介を機械チェックの対象にする（U7）
      select display_name || case when coalesce(bio, '') <> '' then ' / ' || bio else '' end
        into v_snapshot
      from public.profiles where id = g.target_user_id;
    elsif g.target_kind = 'dm_message' then
      select body, sender_id, created_at into v_snapshot, v_author, v_msg_at
      from public.dm_messages where id = g.target_ref;
      select coalesce(jsonb_agg(jsonb_build_object('from', m.sender_id, 'body', m.body, 'at', m.created_at)
                      order by m.created_at), '[]'::jsonb) into v_ctx
      from public.dm_messages m
      where m.id in (
        select id from public.dm_messages
        where ((sender_id = (select sender_id from public.dm_messages where id = g.target_ref)
                and recipient_id = (select recipient_id from public.dm_messages where id = g.target_ref))
            or (sender_id = (select recipient_id from public.dm_messages where id = g.target_ref)
                and recipient_id = (select sender_id from public.dm_messages where id = g.target_ref)))
          and created_at <= v_msg_at order by created_at desc limit 3)
        or id in (
        select id from public.dm_messages
        where ((sender_id = (select sender_id from public.dm_messages where id = g.target_ref)
                and recipient_id = (select recipient_id from public.dm_messages where id = g.target_ref))
            or (sender_id = (select recipient_id from public.dm_messages where id = g.target_ref)
                and recipient_id = (select sender_id from public.dm_messages where id = g.target_ref)))
          and created_at > v_msg_at order by created_at asc limit 3);
    elsif g.target_kind = 'room_message' then
      select body, sender_id, created_at, room_id into v_snapshot, v_author, v_msg_at, v_room
      from public.ww_room_messages where id = g.target_ref;
      select coalesce(jsonb_agg(jsonb_build_object('from', m.sender_id, 'body', m.body, 'at', m.created_at)
                      order by m.created_at), '[]'::jsonb) into v_ctx
      from public.ww_room_messages m
      where m.room_id = v_room and m.kind = 'chat'
        and m.created_at between v_msg_at - interval '10 minutes' and v_msg_at + interval '10 minutes';
    elsif g.target_kind = 'game_message' then
      select m.body, m.sender_id, m.created_at, gm.room_id into v_snapshot, v_author, v_msg_at, v_room
      from public.ww_messages m
      join public.ww_games gm on gm.id = m.game_id
      where m.id = g.target_ref;
      select coalesce(jsonb_agg(jsonb_build_object('from', m.sender_id, 'body', m.body, 'at', m.created_at)
                      order by m.created_at), '[]'::jsonb) into v_ctx
      from public.ww_messages m
      where m.game_id = (select game_id from public.ww_messages where id = g.target_ref)
        and m.created_at between v_msg_at - interval '10 minutes' and v_msg_at + interval '10 minutes';
    elsif g.target_kind = 'group_message' then
      select body, sender_id, created_at, group_id into v_snapshot, v_author, v_msg_at, v_room
      from public.kl_group_messages where id = g.target_ref;
      select coalesce(jsonb_agg(jsonb_build_object('from', m.sender_id, 'body', m.body, 'at', m.created_at)
                      order by m.created_at), '[]'::jsonb) into v_ctx
      from public.kl_group_messages m
      where m.group_id = v_room and m.kind = 'text'
        and m.created_at between v_msg_at - interval '10 minutes' and v_msg_at + interval '10 minutes';
    end if;

    -- 重み：通報者の信頼度の合計。同一ルーム参加者同士の同時通報は半分（§3.2）
    select coalesce(sum(public.kl__reporter_trust(r.reporter_id)), 0) into v_weight
    from (select distinct reporter_id from public.reports where id = any(g.report_ids)) r;
    if v_room is not null then
      if v_surface = 'group' then
        select count(distinct r.reporter_id) into v_same_room_reporters
        from public.reports r
        join public.kl_group_members mem on mem.group_id = v_room and mem.user_id = r.reporter_id
        where r.id = any(g.report_ids);
      else
        select count(distinct r.reporter_id) into v_same_room_reporters
        from public.reports r
        join public.room_members mem on mem.room_id = v_room and mem.user_id = r.reporter_id
        where r.id = any(g.report_ids);
      end if;
      if v_same_room_reporters >= 2 then
        v_weight := v_weight / 2;
      end if;
    end if;

    v_ng := case when v_snapshot is not null then public.kl__ng_check(v_snapshot) end;

    insert into public.moderation_cases
      (target_user_id, surface, target_ref, report_ids, snapshot_text, context,
       ng_hits, report_weight, decision)
    values
      (v_author, v_surface, g.target_ref, g.report_ids, v_snapshot, v_ctx,
       case when v_ng is null then null else jsonb_build_array(v_ng) end,
       v_weight, 'pending')
    returning id into v_case_id;
    update public.reports set case_id = v_case_id where id = any(g.report_ids);
    v_cases := v_cases + 1;

    -- ② 仮非表示（§1.4：重み ≥ 3.0。スコア確定は Phase B）
    if g.target_kind <> 'user' and v_weight >= 3.0 and v_snapshot is not null then
      if g.target_kind = 'dm_message' then
        update public.dm_messages set hidden_at = now() where id = g.target_ref and hidden_at is null;
      elsif g.target_kind = 'room_message' then
        update public.ww_room_messages set hidden_at = now() where id = g.target_ref and hidden_at is null;
      elsif g.target_kind = 'game_message' then
        update public.ww_messages set hidden_at = now() where id = g.target_ref and hidden_at is null;
      elsif g.target_kind = 'group_message' then
        update public.kl_group_messages set hidden_at = now() where id = g.target_ref and hidden_at is null;
      end if;
      if found then
        v_hidden := v_hidden + 1;
        v_surface_label := case v_surface when 'dm' then 'DM' when 'room' then '待機室チャット' when 'group' then 'グループチャット' else '対戦チャット' end;
        update public.moderation_cases
        set decision = 'hidden',
            decision_reason = 'provisional:weight>=3.0' || case when v_ng is not null then '+ng:' || v_ng else '' end,
            retention_until = now() + interval '180 days',
            decided_at = now()
        where id = v_case_id;
        perform public.kl__send_system_dm(v_author,
          'あなたの投稿がルールに違反する可能性があるため、他のユーザーから見えない状態にしました。' || chr(10) || chr(10)
          || '対象：' || v_surface_label || '（' || to_char(v_msg_at at time zone 'Asia/Tokyo', 'YYYY年MM月DD日 HH24時MI分') || 'の投稿）' || chr(10) || chr(10)
          || '確認の結果、違反が認められた場合は利用制限の対象になります。違反が確認されなかった場合、表示は自動的に戻ります。');
      end if;
    end if;
  end loop;

  -- ===== ③ マスター放置の確定（ハイブリッド (b)：30日で3回）＋ U3 の階段 =====
  for s in
    select master_id from public.stall_events
    where status = 'recorded'
    group by master_id
  loop
    select count(*) into v_recent
    from public.stall_events
    where master_id = s.master_id and created_at > now() - interval '30 days';
    if v_recent < 3 then
      continue;
    end if;
    select count(*) into v_confirmed_total
    from public.stall_events
    where master_id = s.master_id and status = 'confirmed'
      and created_at > now() - interval '90 days';

    v_newly := 0;
    for v_ev in
      select * from public.stall_events
      where master_id = s.master_id and status = 'recorded'
      order by created_at asc
    loop
      update public.stall_events set status = 'confirmed' where id = v_ev.id;
      v_confirmed_total := v_confirmed_total + 1;
      v_newly := v_newly + 1;
      if v_confirmed_total <= 2 then
        insert into public.penalty_events (user_id, track, kind, room_id, minutes)
        values (s.master_id, 'afk', 'master_stall', v_ev.room_id, 0)
        returning id into v_case_id;
        update public.stall_events set penalty_event_id = v_case_id where id = v_ev.id;
      elsif v_newly = 1 or v_confirmed_total = 3 then
        -- 3回目到達のバッチで1回だけ afk 合算の処分を適用する（DMは apply_penalty が送る）
        perform public.kl__apply_penalty(s.master_id, 'afk', 'master_stall',
          v_ev.room_id, null, null, false,
          '「そろっているのにゲームを開始しない」行為が繰り返し確認されたため、利用制限を行いました。');
      end if;
      v_stalls := v_stalls + 1;
    end loop;
    -- 警告DMはバッチで1通だけ（1〜2回目の範囲に留まった場合）
    if v_newly > 0 and v_confirmed_total <= 2 then
      perform public.kl__send_system_dm(s.master_id,
        'あなたがマスターのルームで、参加者がそろって準備完了したあと、しばらくの間ゲームが開始されなかったことが確認されました。' || chr(10) || chr(10)
        || 'そろったまま開始しない状態が続くと、ルール違反として記録されます。開始できないときは、ルームを解散するか、参加者にお知らせください。今回は警告のみで、利用制限はありません。');
    end if;
  end loop;

  return jsonb_build_object('cases', v_cases, 'hidden', v_hidden, 'stallsConfirmed', v_stalls);
end;
$$;

revoke execute on function public.kl__moderation_sweep() from public, anon, authenticated;
