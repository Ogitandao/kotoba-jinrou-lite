-- 0044: スタートダッシュ（新規ユーザー特典）
-- 新規ユーザーは登録から、ログインした日ごとに7日分・合計500コインを
-- 分割で受け取れる（50,50,50,50,100,100,100。連続でなくてよい）。
-- 期間限定ではなく新規全員が対象（2026-11-26 おぎ）。対象は本機能の
-- 開始日（2026-11-26 JST）以降に作られたアカウント。
-- 通常のログインボーナス（+10/日）と同時に受け取る。

create table if not exists public.kl_starter_bonus (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  days_claimed integer not null default 0 check (days_claimed between 0 and 7),
  last_claim_date date,
  updated_at timestamptz not null default now()
);

alter table public.kl_starter_bonus enable row level security;

drop policy if exists kl_starter_bonus_select_own on public.kl_starter_bonus;
create policy kl_starter_bonus_select_own on public.kl_starter_bonus
  for select to authenticated using (user_id = auth.uid());

create or replace function public.kl_claim_login_bonus()
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  today_jst date := (now() at time zone 'Asia/Tokyo')::date;
  w public.coin_wallets%rowtype;
  amounts int[] := array[50, 50, 50, 50, 100, 100, 100];
  daily int := 0;
  s_days int := 0;
  s_last date := null;
  s_grant int := 0;
  s_day int := null;
  eligible boolean := false;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  select * into w from public.coin_wallets where user_id = me for update;
  if not found then
    raise exception 'USER_NOT_FOUND: 財布が存在しません' using errcode = 'P0001';
  end if;

  if w.last_login_bonus_date is distinct from today_jst then
    daily := 10;
  end if;

  select days_claimed, last_claim_date into s_days, s_last
    from public.kl_starter_bonus where user_id = me;
  select exists (
    select 1 from public.profiles p
     where p.id = me
       and p.created_at >= '2026-11-26T00:00:00+09'::timestamptz
  ) into eligible;
  if eligible and coalesce(s_days, 0) < 7 and s_last is distinct from today_jst then
    s_day := coalesce(s_days, 0) + 1;
    s_grant := amounts[s_day];
  end if;

  if daily = 0 and s_grant = 0 then
    return jsonb_build_object('claimed', false, 'amount', 0,
      'starterAmount', 0, 'starterDay', null,
      'starterDaysClaimed', coalesce(s_days, 0),
      'freeBalance', w.free_balance, 'paidBalance', w.paid_balance);
  end if;

  update public.coin_wallets
     set free_balance = free_balance + daily + s_grant,
         last_login_bonus_date = case
           when daily > 0 then today_jst else last_login_bonus_date end
   where user_id = me
   returning * into w;
  if daily > 0 then
    insert into public.coin_ledger (user_id, delta_free, reason)
    values (me, daily, 'daily_login');
  end if;
  if s_grant > 0 then
    insert into public.coin_ledger (user_id, delta_free, reason)
    values (me, s_grant, 'starter_login');
    insert into public.kl_starter_bonus (user_id, days_claimed, last_claim_date, updated_at)
    values (me, s_day, today_jst, now())
    on conflict (user_id) do update
      set days_claimed = excluded.days_claimed,
          last_claim_date = excluded.last_claim_date,
          updated_at = now();
  end if;

  return jsonb_build_object('claimed', true, 'amount', daily,
    'starterAmount', s_grant, 'starterDay', s_day,
    'starterDaysClaimed', coalesce(s_day, s_days),
    'freeBalance', w.free_balance, 'paidBalance', w.paid_balance);
end;
$$;

revoke all on function public.kl_claim_login_bonus() from public, anon;
grant execute on function public.kl_claim_login_bonus() to authenticated;
