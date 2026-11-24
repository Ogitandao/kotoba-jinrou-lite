-- 0018_tutorial.sql
-- チュートリアル＋ようこそDM（2026-11-25 おぎ承認仕様）：
-- - 同意ゲートのサーバー側強制：未同意（profiles.rules_agreed_at が NULL）の
--   ユーザーは ww_create_room / ww_join_room を RULES_NOT_AGREED で拒否する。
--   同意の記録は従来どおり kl_agree_rules（0010）が担い、チュートリアル
--   モーダルの「同意してはじめる」から呼ばれる。
-- - ようこそDM：新規登録（handle_new_user）でシステム会話へ kind='welcome'
--   のメッセージを1件送る。クライアントは本文＋「チュートリアルはこちら」
--   ボタンとして描画し、いつでもチュートリアルを見返せるようにする。
-- - kl_mark_system_dm_read は 'welcome' も既読化対象に含める。

-- ---------- dm_messages に kind='welcome' を追加 ----------
alter table public.dm_messages
drop constraint if exists dm_messages_kind_check;
alter table public.dm_messages
add constraint dm_messages_kind_check
check (kind in ('text', 'invite', 'gift', 'system', 'welcome'));
alter table public.dm_messages
drop constraint if exists dm_messages_body_check;
alter table public.dm_messages
add constraint dm_messages_body_check check (
(kind = 'text' and body is not null and length(body) between 1 and 500)
or (kind = 'invite' and invite_payload is not null)
or (kind = 'gift' and gift_payload is not null)
or (kind = 'system' and body is not null and length(body) between 1 and 1000
and sender_id is null)
or (kind = 'welcome' and body is not null and length(body) between 1 and 1000
and sender_id is null)
);

-- ---------- 同意チェック（内部専用） ----------
create or replace function public.kl__assert_rules_agreed(p_user uuid)
returns void
language plpgsql stable security definer set search_path = public
as $$
declare
v_agreed timestamptz;
begin
select rules_agreed_at into v_agreed from public.profiles where id = p_user;
if v_agreed is null then
raise exception 'RULES_NOT_AGREED: ルームに入るにはチュートリアルへの同意が必要です'
using errcode = 'P0001';
end if;
end;
$$;

revoke all on function public.kl__assert_rules_agreed(uuid) from public, anon, authenticated;

-- ---------- ルーム作成（0016 の再定義：同意チェックを追加） ----------
create or replace function public.ww_create_room(
p_title text,
p_is_private boolean default false,
p_password text default null,
p_beginner_welcome boolean default false,
p_reversal_enabled boolean default true,
p_capacity integer default 8,
p_genre text default null
)
returns public.rooms
language plpgsql security definer set search_path = public, extensions
as $$
declare
me uuid := auth.uid();
room public.rooms%rowtype;
spent record;
begin
if me is null then
raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
end if;
perform public.kl__assert_not_penalized(me);
perform public.kl__assert_rules_agreed(me);
if p_is_private and (p_password is null or length(p_password) < 4) then
raise exception 'PASSWORD_REQUIRED: 非公開ルームには4文字以上のパスワードが必要です' using errcode = 'P0001';
end if;
-- ジャンルは ww_topics に実在するカテゴリだけ許可する（未知の値は
-- おまかせ扱いにせず弾く。クライアントは固定リストから選ぶ前提）
if p_genre is not null and not exists (
  select 1 from public.ww_topics t where t.active and t.category = p_genre
) then
raise exception 'INVALID_GENRE: ジャンルが存在しません' using errcode = 'P0001';
end if;

insert into public.rooms (host_id, title, is_private, password_hash,
beginner_welcome, capacity, reversal_enabled, genre)
values (me, coalesce(nullif(trim(p_title), ''), ''), p_is_private,
case when p_is_private then crypt(p_password, gen_salt('bf')) end,
p_beginner_welcome, p_capacity, p_reversal_enabled, p_genre)
returning * into room;

insert into public.room_members (room_id, user_id) values (room.id, me);

if p_is_private then
select * into spent from public.kl_spend_coins(me, 100);
insert into public.coin_ledger (user_id, delta_free, delta_paid, reason, ref_id)
values (me, -spent.spent_free, -spent.spent_paid, 'private_room', room.id);
end if;
return room;
end;
$$;

revoke all on function public.ww_create_room(text, boolean, text, boolean, boolean, integer, text) from public, anon;
grant execute on function public.ww_create_room(text, boolean, text, boolean, boolean, integer, text) to authenticated;

-- ---------- 参加（0014 の再定義：同意チェックを追加） ----------
create or replace function public.ww_join_room(
  p_room uuid, p_password text default null
)
returns void
language plpgsql security definer set search_path = public, extensions
as $$
declare
  me uuid := auth.uid();
  room public.rooms%rowtype;
  n integer;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  perform public.kl__assert_not_penalized(me);
  perform public.kl__assert_rules_agreed(me);
  select * into room from public.rooms where id = p_room;
  if not found then
    raise exception 'ROOM_NOT_FOUND: ルームが存在しません' using errcode = 'P0001';
  end if;
  if room.status <> 'lobby' then
    raise exception 'ROOM_BUSY: このルームには今は入れません' using errcode = 'P0001';
  end if;
  if room.is_private
     and not (room.password_hash = crypt(coalesce(p_password, ''), room.password_hash)) then
    raise exception 'WRONG_PASSWORD: パスワードが違います' using errcode = 'P0001';
  end if;
  select count(*) into n from public.room_members where room_id = p_room;
  if n >= room.capacity
     and not exists (select 1 from public.room_members
                      where room_id = p_room and user_id = me) then
    raise exception 'ROOM_FULL: ルームが満員です' using errcode = 'P0001';
  end if;
  insert into public.room_members (room_id, user_id) values (p_room, me)
  on conflict do nothing;
  perform public.ww__refresh_all_ready(p_room);
end;
$$;

-- ---------- システムDM既読化（0010 の再定義：'welcome' も対象に） ----------
create or replace function public.kl_mark_system_dm_read()
returns integer
language plpgsql security definer set search_path = public
as $$
declare
me uuid:= auth.uid();
n integer;
begin
if me is null then
raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
end if;
update public.dm_messages set read_at = now()
where kind in ('system', 'welcome') and recipient_id = me and read_at is null;
get diagnostics n = row_count;
return n;
end;
$$;

revoke all on function public.kl_mark_system_dm_read() from public, anon;
grant execute on function public.kl_mark_system_dm_read() to authenticated;

-- ---------- 新規登録（0003 の再定義：ようこそDMを追加） ----------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, public_id, display_name)
  values (
    new.id,
    public.generate_public_id(),
    coalesce(new.raw_user_meta_data ->> 'display_name', 'ななし')
  )
  on conflict (id) do nothing;

  insert into public.coin_wallets (user_id, free_balance)
  values (new.id, 100)
  on conflict (user_id) do nothing;

  insert into public.coin_ledger (user_id, delta_free, reason)
  values (new.id, 100, 'welcome');

  -- ようこそDM（システム会話へ1件だけ。チュートリアルへの導線つき）
  insert into public.dm_messages (sender_id, recipient_id, kind, body)
  values (null, new.id, 'welcome',
    'ことば人狼へようこそ！🎉' || chr(10) ||
    '登録ありがとうございます。登録ボーナスとして100コインをプレゼントしました。' || chr(10) ||
    'はじめてルームに入るときに、遊び方とルールのチュートリアルが表示されます。下の「チュートリアルはこちら」からいつでも見返せます。' || chr(10) ||
    'みんなで楽しく遊びましょう！');

  return new;
end;
$$;
