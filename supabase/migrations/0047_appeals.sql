-- 0047: 異議申し立て（enforcement-design §4 / U8）
-- - 対象は harassment トラックの「7日以上の制限」（minutes = -1 の
--   無期限を含む）のみ。afk・マスター放置は対象外
-- - 1処分1回（penalty_event_id に一意制約）、期限は処分から30日
--   （無期限処分は期限なし）
-- - 審査はスプレッドシート＋Apps Script。DB 側は専用 RPC と
--   トークンで受け、service_role キーは渡さない（§4.3）
-- - 解除しても処分歴（階段）は残す（§4.4 / U8-③）

-- ---------- appeals ----------
create table if not exists public.appeals (
  id uuid primary key default gen_random_uuid(),
  penalty_event_id uuid not null unique references public.penalty_events (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  reason_text text not null check (char_length(reason_text) between 1 and 500),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  dm_sent_at timestamptz
);
create index if not exists appeals_user_idx on public.appeals (user_id, created_at desc);
alter table public.appeals enable row level security;
comment on table public.appeals is
  '異議申し立て（§4）。クライアントからは RPC 経由でのみ触る（ポリシーは作らない）。';

-- ---------- penalty_events.kind に申立て結果の記録行を追加 ----------
alter table public.penalty_events drop constraint if exists penalty_events_kind_check;
alter table public.penalty_events add constraint penalty_events_kind_check
  check (kind = any (array['vote_skip', 'abandon', 'manual', 'silent_play',
    'silent_no_vote', 'warning', 'violation', 'master_stall',
    'appeal_lifted', 'appeal_rejected']));

-- ---------- 申立て処理トークン（Apps Script の Script Properties と対） ----------
insert into public.kl_config (key, value)
values ('appeal_token', encode(gen_random_bytes(24), 'hex'))
on conflict (key) do nothing;

create or replace function public.kl__appeal_token_ok(p_token text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.kl_config
    where key = 'appeal_token' and value = p_token and p_token is not null and length(p_token) >= 32
  );
$$;
revoke execute on function public.kl__appeal_token_ok(text) from public, anon, authenticated;

-- ---------- 申立て対象の判定（内部共用） ----------
-- 対象：自分の harassment 処分で、minutes が -1（無期限）か 10080（7日）以上
create or replace function public.kl__appeal_eligible(p_event public.penalty_events)
returns boolean
language sql immutable
as $$
  select p_event.track = 'harassment'
     and (p_event.minutes = -1 or p_event.minutes >= 10080);
$$;

-- ---------- 自分の申立て可能一覧（クライアント用） ----------
create or replace function public.kl_my_appealable_penalties()
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'penaltyEventId', e.id,
      'minutes', e.minutes,
      'createdAt', e.created_at,
      'penaltyUntil', e.penalty_until,
      'category', coalesce((
        select c.decision_reason from public.moderation_cases c
        where c.penalty_event_id = e.id order by c.created_at desc limit 1
      ), '嫌がらせ・暴言等'),
      'deadline', case when e.minutes = -1 then null
                       else e.created_at + interval '30 days' end,
      'alreadyAppealed', a.id is not null,
      'appealStatus', a.status
    ) order by e.created_at desc)
    from public.penalty_events e
    left join public.appeals a on a.penalty_event_id = e.id
    where e.user_id = me
      and public.kl__appeal_eligible(e)
      and (e.minutes = -1 or e.created_at > now() - interval '30 days' or a.id is not null)
  ), '[]'::jsonb);
end;
$$;
grant execute on function public.kl_my_appealable_penalties() to authenticated;

-- ---------- 申立て送信 ----------
create or replace function public.kl_submit_appeal(p_penalty_event_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  e public.penalty_events;
  v_reason text := trim(coalesce(p_reason, ''));
  v_id uuid;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  select * into e from public.penalty_events where id = p_penalty_event_id;
  if not found or e.user_id <> me then
    raise exception 'PENALTY_NOT_FOUND: 対象の処分が見つかりません' using errcode = 'P0001';
  end if;
  if not public.kl__appeal_eligible(e) then
    raise exception 'NOT_APPEALABLE: この処分は異議申し立ての対象外です' using errcode = 'P0001';
  end if;
  if e.minutes <> -1 and e.created_at <= now() - interval '30 days' then
    raise exception 'APPEAL_DEADLINE_PASSED: 申立て期限（処分から30日）を過ぎています' using errcode = 'P0001';
  end if;
  if v_reason = '' then
    raise exception 'REASON_EMPTY: 申立ての理由を入力してください' using errcode = 'P0001';
  end if;
  if char_length(v_reason) > 500 then
    raise exception 'REASON_TOO_LONG: 理由は500文字以内で入力してください' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.appeals where penalty_event_id = e.id) then
    raise exception 'ALREADY_APPEALED: この処分には既に申し立て済みです' using errcode = 'P0001';
  end if;
  insert into public.appeals (penalty_event_id, user_id, reason_text)
  values (e.id, me, v_reason)
  returning id into v_id;
  perform public.kl__send_system_dm(me,
    '利用制限に対する異議申し立てを受け付けました。確認にはお時間をいただく場合があります。結果はこのシステムDMでお知らせします。' || chr(10)
    || '※申し立ては1つの処分につき1回までです。この結果が最終判断となります。');
  return jsonb_build_object('appealId', v_id);
end;
$$;
grant execute on function public.kl_submit_appeal(uuid, text) to authenticated;

-- ---------- シート同期用：未処理の申立て一覧（トークン必須） ----------
create or replace function public.kl_list_appeals_for_sheet(p_token text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
begin
  if not public.kl__appeal_token_ok(p_token) then
    raise exception 'INVALID_TOKEN: トークンが一致しません' using errcode = 'P0001';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'appealId', a.id,
      'receivedAt', to_char(a.created_at at time zone 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI'),
      'publicId', p.public_id,
      'displayName', p.display_name,
      'trackLabel', 'ハラスメント',
      'stepLabel', case e.minutes when -1 then '無期限' when 43200 then '30日（2段目）'
                                  when 10080 then '7日（1段目）'
                                  else e.minutes::text || '分' end,
      'penaltyAt', to_char(e.created_at at time zone 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI'),
      'untilLabel', case when e.penalty_until = 'infinity'::timestamptz then '無期限'
                         else to_char(e.penalty_until at time zone 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI') end,
      'category', coalesce((
        select c.decision_reason from public.moderation_cases c
        where c.penalty_event_id = e.id order by c.created_at desc limit 1
      ), '嫌がらせ・暴言等'),
      'reasonText', a.reason_text
    ) order by a.created_at asc)
    from public.appeals a
    join public.penalty_events e on e.id = a.penalty_event_id
    join public.profiles p on p.id = a.user_id
    where a.status = 'pending'
  ), '[]'::jsonb);
end;
$$;
grant execute on function public.kl_list_appeals_for_sheet(text) to anon, authenticated;

-- ---------- 判定の反映（トークン必須・冪等） ----------
create or replace function public.kl_resolve_appeal(p_appeal_id uuid, p_accept boolean, p_token text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  a public.appeals;
  e public.penalty_events;
  v_new_status text := case when p_accept then 'accepted' else 'rejected' end;
  v_rows integer;
  v_until timestamptz;
  v_until_label text;
begin
  if not public.kl__appeal_token_ok(p_token) then
    raise exception 'INVALID_TOKEN: トークンが一致しません' using errcode = 'P0001';
  end if;
  -- 原子的な状態遷移：pending から動かせた実行だけが先へ進む（冪等性の核）
  update public.appeals
     set status = v_new_status, decided_at = now()
   where id = p_appeal_id and status = 'pending'
  returning * into a;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return jsonb_build_object('ok', true, 'skipped', true);
  end if;
  select * into e from public.penalty_events where id = a.penalty_event_id;

  if p_accept then
    -- 対象処分の終了時刻を取り消し、残りの有効な処分から再計算する。
    -- 処分歴そのもの（階段計算）は残す（U8-③）
    update public.penalty_events set penalty_until = null where id = e.id;
    select max(penalty_until) into v_until
      from public.penalty_events
     where user_id = a.user_id and minutes <> 0 and penalty_until is not null;
    if v_until is not null and v_until <= now() then
      v_until := null;
    end if;
    update public.profiles set penalty_until = v_until where id = a.user_id;
    insert into public.penalty_events (user_id, track, kind, minutes)
    values (a.user_id, 'harassment', 'appeal_lifted', 0);
    perform public.kl__send_system_dm(a.user_id,
      '申し立てを確認した結果、利用制限を解除しました。ご不便をおかけしました。' || chr(10)
      || '引き続きルールを守ってお楽しみください。');
  else
    insert into public.penalty_events (user_id, track, kind, minutes)
    values (a.user_id, 'harassment', 'appeal_rejected', 0);
    select penalty_until into v_until from public.profiles where id = a.user_id;
    v_until_label := case
      when v_until is null or v_until <= now() then '（制限期間は終了しています）'
      when v_until = 'infinity'::timestamptz then '無期限'
      else to_char(v_until at time zone 'Asia/Tokyo', 'YYYY年MM月DD日 HH24時MI分') end;
    perform public.kl__send_system_dm(a.user_id,
      '申し立てを確認しましたが、違反が確認されたため、利用制限の解除はできません。' || chr(10)
      || '■ 制限期間：〜 ' || v_until_label || chr(10)
      || 'この判断が最終となります。');
  end if;
  update public.appeals set dm_sent_at = now() where id = a.id;
  return jsonb_build_object('ok', true, 'status', v_new_status);
end;
$$;
grant execute on function public.kl_resolve_appeal(uuid, boolean, text) to anon, authenticated;

-- ---------- 保持期間の掃除（申立て実装と同時に入れる約束・0034） ----------
create or replace function public.kl__retention_cleanup()
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_n integer;
begin
  delete from public.moderation_cases c
   where c.retention_until is not null
     and c.retention_until < now()
     and not exists (
       select 1 from public.appeals a
        where a.penalty_event_id = c.penalty_event_id and a.status = 'pending'
     );
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke execute on function public.kl__retention_cleanup() from public, anon, authenticated;

select cron.schedule('kl-retention-cleanup', '17 4 * * *', 'select public.kl__retention_cleanup()')
where not exists (select 1 from cron.job where jobname = 'kl-retention-cleanup');
