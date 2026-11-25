-- =============================================================================
-- 0038_group_message_reports.sql — グループ発言を通報パイプラインに接続
-- =============================================================================
-- メッセージ単位の通報導線（長押しメニュー）の受け側。
-- - reports.target_kind に 'group_message' を追加
-- - kl_report：対象の投稿者を kl_group_messages から引く
--   （システム通知は sender_id NULL のため TARGET_NOT_FOUND になる）
-- - kl__moderation_sweep：surface 'group' のケース化（文脈は同一
--   グループの前後10分）、同室半減は kl_group_members で判定、
--   仮非表示は kl_group_messages.hidden_at を立てる
-- sweep 本体は 0035 の定義に group 分岐を足した全置換。
-- =============================================================================

alter table public.reports drop constraint reports_target_kind_check;
alter table public.reports
  add constraint reports_target_kind_check
  check (target_kind in ('user', 'dm_message', 'room_message', 'game_message', 'group_message'));

-- ---------- 通報の受付（0035 の kl_report に group_message を追加） ----------

create or replace function public.kl_report(
  p_target_kind text,
  p_target_ref uuid,
  p_target_user uuid,
  p_reason text,
  p_detail text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  v_target_user uuid := p_target_user;
  v_blocked timestamptz;
  v_today integer;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  if p_target_kind not in ('user', 'dm_message', 'room_message', 'game_message', 'group_message') then
    raise exception 'INVALID_TARGET: 通報対象が不正です' using errcode = 'P0001';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 or length(p_reason) > 200
     or (p_detail is not null and length(p_detail) > 1000) then
    raise exception 'INVALID_REASON: 理由を入力してください' using errcode = 'P0001';
  end if;

  perform public.kl__ensure_reporter_stats(me);
  select report_blocked_until into v_blocked from public.reporter_stats where user_id = me;
  if v_blocked is not null and v_blocked > now() then
    raise exception 'REPORT_BLOCKED: 通報機能の利用が制限されています' using errcode = 'P0001';
  end if;

  -- 対象コンテンツから投稿者を引く（user 通報以外）
  if p_target_kind = 'dm_message' then
    select sender_id into v_target_user from public.dm_messages where id = p_target_ref;
  elsif p_target_kind = 'room_message' then
    select sender_id into v_target_user from public.ww_room_messages where id = p_target_ref;
  elsif p_target_kind = 'game_message' then
    select sender_id into v_target_user from public.ww_messages where id = p_target_ref;
  elsif p_target_kind = 'group_message' then
    select sender_id into v_target_user from public.kl_group_messages where id = p_target_ref;
  end if;
  if p_target_kind <> 'user' and v_target_user is null then
    raise exception 'TARGET_NOT_FOUND: 対象が見つかりません' using errcode = 'P0001';
  end if;
  if v_target_user = me then
    raise exception 'CANNOT_REPORT_SELF: 自分の投稿は通報できません' using errcode = 'P0001';
  end if;

  -- 同一通報者→同一対象は24時間に1回まで／1日20件まで（§3.2）
  if exists (
    select 1 from public.reports
    where reporter_id = me and target_kind = p_target_kind
      and target_ref is not distinct from p_target_ref
      and (p_target_kind <> 'user' or target_user_id = v_target_user)
      and created_at > now() - interval '24 hours'
  ) then
    raise exception 'ALREADY_REPORTED: この対象は通報済みです' using errcode = 'P0001';
  end if;
  select count(*) into v_today from public.reports
  where reporter_id = me and created_at > now() - interval '24 hours';
  if v_today >= 20 then
    raise exception 'REPORT_LIMIT: 通報は1日20件までです' using errcode = 'P0001';
  end if;

  insert into public.reports (reporter_id, target_user_id, target_kind, target_ref, reason, detail)
  values (me, v_target_user, p_target_kind, p_target_ref, trim(p_reason), p_detail);
  update public.reporter_stats
  set reports_total = reports_total + 1, updated_at = now()
  where user_id = me;

  -- 受付DM（§5.4。即時）
  perform public.kl__send_system_dm(me,
    '通報ありがとうございます。内容を確認し、ルールに違反している場合は対応します。確認には少し時間がかかることがあります。');

  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.kl_report(text, uuid, uuid, text, text) from public, anon;
grant execute on function public.kl_report(text, uuid, uuid, text, text) to authenticated;

-- ---------- 自動処理バッチ（0035 の sweep に group 面を追加した全置換） ----------

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

    if g.target_kind = 'dm_message' then
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
