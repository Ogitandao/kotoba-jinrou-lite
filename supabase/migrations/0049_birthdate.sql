-- =============================================================================
-- 0049_birthdate.sql — 生年月日（初回セットアップ・変更不可・年齢確認）
-- =============================================================================
-- 決定の正本：追補26（2026-11-26 おぎ決定・むぜたん設計）。
-- - 入力はログイン直後の初回セットアップで、名前決定ポップアップと同時に
--   行う（自己申告のみ、本人確認なし）
-- - profiles.birthdate に保存し、一度登録したら変更不可
-- - 13歳未満は登録不可（kl_set_birthdate が UNDERAGE で拒否）
-- - 月額課金上限は年齢帯別：15歳以下 5,000円／16〜19歳 20,000円／
--   20歳以上 無制限。判定ヘルパー kl_monthly_cap_yen を用意するが、
--   購入処理への適用は課金実装フェーズ（本書では用意まで）
--
-- 変更不可の担保：
-- - kl_set_birthdate が「未設定のときだけ」書き込む（設定済みは
--   BIRTHDATE_ALREADY_SET で拒否）
-- - profiles_guard_server_fields に birthdate を追加し、クライアントの
--   直接 UPDATE では書き換えられないようにする（0010 の penalty_until と
--   同じ方式。SECURITY DEFINER の RPC 内は postgres 実行で通る）
-- =============================================================================

alter table public.profiles
  add column if not exists birthdate date;

comment on column public.profiles.birthdate is
'生年月日（自己申告）。初回セットアップで kl_set_birthdate だけが設定し、設定後は変更不可。年齢確認と課金上限の判定に使う。';

-- birthdate もクライアント直接変更を巻き戻す対象に追加（0010 の定義を拡張）
create or replace function public.profiles_guard_server_fields()
returns trigger
language plpgsql
as $$
begin
  if current_user not in ('postgres', 'service_role') then
    new.popularity := old.popularity;
    new.wordwolf_wins := old.wordwolf_wins;
    new.public_id := old.public_id;
    new.penalty_until := old.penalty_until;
    new.rules_agreed_at := old.rules_agreed_at;
    new.birthdate := old.birthdate;
  end if;
  return new;
end;
$$;

-- ---------- 生年月日の登録（初回のみ） ----------

create or replace function public.kl_set_birthdate(p_birthdate date)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_current date;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  if p_birthdate is null then
    raise exception 'BIRTHDATE_REQUIRED: 生年月日を入力してください' using errcode = 'P0001';
  end if;
  select birthdate into v_current from public.profiles where id = me;
  if v_current is not null then
    raise exception 'BIRTHDATE_ALREADY_SET: 生年月日は登録後に変更できません' using errcode = 'P0001';
  end if;
  -- 13歳未満は登録不可（未来の日付もここで弾かれる）
  if p_birthdate > (v_today - interval '13 years')::date then
    raise exception 'UNDERAGE: 13歳未満の方は登録できません' using errcode = 'P0001';
  end if;
  update public.profiles set birthdate = p_birthdate where id = me;
  return jsonb_build_object('birthdate', p_birthdate);
end;
$$;

-- ---------- 年齢→月額課金上限（円）の判定ヘルパー ----------
-- 課金実装フェーズで購入 RPC が使う想定。判定は JST の暦日。
-- 15歳以下 5,000／16〜19歳 20,000／20歳以上は NULL（無制限）。
-- birthdate が NULL の場合も NULL（未設定は購入側で別途止める想定）。

create or replace function public.kl_monthly_cap_yen(p_birthdate date)
returns integer
language sql stable set search_path = public
as $$
  select case
    when p_birthdate is null then null
    when extract(year from age((now() at time zone 'Asia/Tokyo')::date, p_birthdate)) < 16 then 5000
    when extract(year from age((now() at time zone 'Asia/Tokyo')::date, p_birthdate)) < 20 then 20000
    else null
  end;
$$;

-- ---------- 実行権限 ----------

revoke all on function public.kl_set_birthdate(date) from public, anon;
grant execute on function public.kl_set_birthdate(date) to authenticated;
-- ヘルパーはサーバー側（将来の購入 RPC）専用。クライアントには開かない
revoke all on function public.kl_monthly_cap_yen(date) from public, anon, authenticated;
