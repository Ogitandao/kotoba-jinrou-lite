-- =============================================================================
-- 0059_push.sql — Web Push 通知（DM／招待／運営告知／呼び戻し）
-- 方針（2026-11-26 おぎ決定）：
-- - 対象は DM とルーム招待のみ（ギフト・フレンド申請は対象外）
-- - システムDM（ペナルティ等）は DM として扱いプッシュする
-- - イベント告知はプッシュのみ（システムDMには入れない）
-- - ロック画面に本文・名前は出さない（文言は Edge Function 側で固定）
-- - 呼び戻しは「3日以上不在・週1回まで」の制限つき
-- - 設定は歯車（設定モーダル）内に全体＋カテゴリ別のON/OFFを持つ
-- 送信は Edge Function push-send（x-cron-secret 照合、kl_config 'push_secret'）
-- =============================================================================

create table if not exists public.kl_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists kl_push_subscriptions_user
  on public.kl_push_subscriptions (user_id);
alter table public.kl_push_subscriptions enable row level security;
drop policy if exists kl_push_sub_own on public.kl_push_subscriptions;
create policy kl_push_sub_own on public.kl_push_subscriptions
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update, delete on public.kl_push_subscriptions to authenticated;

create table if not exists public.kl_push_prefs (
  user_id uuid primary key references auth.users (id) on delete cascade,
  master boolean not null default true,
  dm boolean not null default true,
  invite boolean not null default true,
  announce boolean not null default true,
  comeback boolean not null default true,
  last_comeback_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.kl_push_prefs enable row level security;
drop policy if exists kl_push_prefs_own on public.kl_push_prefs;
create policy kl_push_prefs_own on public.kl_push_prefs
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update, delete on public.kl_push_prefs to authenticated;

-- 最終アクセス（呼び戻しの不在判定用）
alter table public.profiles add column if not exists last_seen_at timestamptz;
update public.profiles set last_seen_at = now() where last_seen_at is null;

create or replace function public.kl_touch_seen()
returns void
language plpgsql security definer set search_path = public
as $$
begin
  update public.profiles set last_seen_at = now() where id = auth.uid();
end;
$$;
grant execute on function public.kl_touch_seen() to authenticated;

-- ---------- DM 到着 → push-send 呼び出し ----------
create or replace function public.kl__push_on_dm()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_secret text;
  v_req bigint;
begin
  if new.kind not in ('text', 'invite', 'system') then
    return new;
  end if;
  select value into v_secret from public.kl_config where key = 'push_secret';
  if v_secret is null then
    return new;
  end if;
  select net.http_post(
    url := 'https://dtdwkluanoaqiaruzbwe.supabase.co/functions/v1/push-send',
    body := jsonb_build_object('mode', 'dm', 'messageId', new.id),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', v_secret)
  ) into v_req;
  return new;
end;
$$;

drop trigger if exists kl_push_on_dm on public.dm_messages;
create trigger kl_push_on_dm
  after insert on public.dm_messages
  for each row execute function public.kl__push_on_dm();

-- ---------- 呼び戻し（1日1回 19:00 JST = 10:00 UTC） ----------
create or replace function public.kl__comeback_run()
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_secret text;
  v_ids uuid[];
  v_req bigint;
begin
  with targets as (
    select p.id
    from public.profiles p
    join public.kl_push_prefs pr on pr.user_id = p.id
    where p.last_seen_at < now() - interval '3 days'
      and pr.master and pr.comeback
      and (pr.last_comeback_at is null
           or pr.last_comeback_at < now() - interval '7 days')
      and exists (
        select 1 from public.kl_push_subscriptions s where s.user_id = p.id)
    limit 500
  )
  select array_agg(id) into v_ids from targets;
  if v_ids is null then
    return 0;
  end if;
  update public.kl_push_prefs
    set last_comeback_at = now()
    where user_id = any (v_ids);
  select value into v_secret from public.kl_config where key = 'push_secret';
  if v_secret is null then
    return 0;
  end if;
  select net.http_post(
    url := 'https://dtdwkluanoaqiaruzbwe.supabase.co/functions/v1/push-send',
    body := jsonb_build_object('mode', 'comeback', 'userIds', to_jsonb(v_ids)),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', v_secret)
  ) into v_req;
  return array_length(v_ids, 1);
end;
$$;
revoke execute on function public.kl__comeback_run() from public, anon, authenticated;

select cron.unschedule('kl-comeback-push')
where exists (select 1 from cron.job where jobname = 'kl-comeback-push');

select cron.schedule('kl-comeback-push', '0 10 * * *',
  'select public.kl__comeback_run()');

-- 追記：Edge Function（service_role）が読むテーブルへの明示 grant。
-- 生SQLで作ったテーブルは自動 grant が付かない（0054 の教訓）。
-- dm_messages は 0004 で作られたため service_role の SELECT が無かった
grant select on public.dm_messages to service_role;
grant select on public.kl_push_prefs to service_role;
grant select, delete on public.kl_push_subscriptions to service_role;
