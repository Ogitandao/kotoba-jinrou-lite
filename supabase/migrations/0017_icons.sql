-- =============================================================================
-- 0017_icons.sql — アイコンカタログ＋選択RPC／DM招待カード発行RPC（Lite）
-- =============================================================================
-- アイコンはプリセット選択制（画像アップロードなし）。画像ファイルは
-- 当面クライアント同梱（client/icons/icon-<key>.webp）だが、カタログは
-- このテーブルで管理する。将来の追加（勝利数解放・コイン直販・おぎ
-- 描き下ろし等）はこのテーブルへ行を足すだけで対応でき、アプリ更新
-- なしで増やせる設計にする（画像配信を Storage へ移す際も key は不変）。
--
-- - icons：カタログ正本。tier は free / win / coin。
--   free は全ユーザーが所有扱い（user_icons への登録不要で選択可）。
--   win は win_threshold（ワードウルフ勝利数）到達で解放、coin は
--   price_coins で直販する想定だが、解放・購入の実装は次フェーズ。
--   本マイグレーションでは無料15種だけを seed する。
-- - user_icons：free 以外の所有記録（購入・解放の付与先）。
-- - profiles.icon_key（0001 で追加済み）が「選択中アイコン」の正本。
--   変更は kl_set_icon 経由のみ（所有チェックをサーバー側で行う）。
--
-- あわせて本バッチで2つの既存関数を拡張する：
-- - kl_search_user：返却に icon_key を追加（戻り型が変わるため drop→create）
-- - ww_list_rooms：hostIconKey を追加（jsonb の中身追加のみ）
--
-- DM 招待カードの発行 RPC（kl_send_invite）もここに入れる：
-- 受信・参加側は実装済みで、発行側が未実装だった。招待カードの
-- invite_payload は { roomId, roomTitle, password }（0004 の形式）。
-- 非公開ルームのパスワードは rooms.password_hash が照合の正本で、
-- 平文は DB に残らない。そのため発行時に本人が入力したパスワードを
-- ハッシュと照合し、一致した場合だけカードへ平文を載せる（受信者
-- 本人の画面表示・コピー・入室用。読めるのは DM 当事者だけ＝RLS）。
--
-- 冪等性：create table if not exists / on conflict / drop if exists 等で
-- 再実行してもエラーにならない形にしてある。
-- =============================================================================

-- ---------- アイコンカタログ ----------
create table if not exists public.icons (
  key text primary key,
  name text not null,
  tier text not null check (tier in ('free', 'win', 'coin')),
  price_coins integer check (price_coins is null or price_coins > 0),
  win_threshold integer check (win_threshold is null or win_threshold > 0),
  sort integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table public.icons is
  'アイコンのカタログ（DB管理）。tier=free は全員選択可、win は勝利数解放、coin はコイン直販（解放・購入は次フェーズ）。画像は key から決まる（当面はクライアント同梱 icons/icon-<key>.webp）。';

insert into public.icons (key, name, tier, sort) values
  ('dog',     'いぬ',       'free', 1),
  ('cat',     'ねこ',       'free', 2),
  ('rabbit',  'うさぎ',     'free', 3),
  ('bear',    'くま',       'free', 4),
  ('panda',   'パンダ',     'free', 5),
  ('penguin', 'ペンギン',   'free', 6),
  ('owl',     'ふくろう',   'free', 7),
  ('fox',     'きつね',     'free', 8),
  ('tanuki',  'たぬき',     'free', 9),
  ('chick',   'ひよこ',     'free', 10),
  ('frog',    'かえる',     'free', 11),
  ('koala',   'こあら',     'free', 12),
  ('tiger',   'とら',       'free', 13),
  ('seal',    'あざらし',   'free', 14),
  ('wolf',    'おおかみ',   'free', 15)
on conflict (key) do update
  set name = excluded.name, tier = excluded.tier, sort = excluded.sort, active = true;

-- ---------- アイコン所有（free 以外） ----------
create table if not exists public.user_icons (
  user_id uuid not null references auth.users (id) on delete cascade,
  icon_key text not null references public.icons (key),
  acquired_via text not null default 'purchase'
    check (acquired_via in ('purchase', 'win_unlock', 'grant')),
  created_at timestamptz not null default now(),
  primary key (user_id, icon_key)
);

comment on table public.user_icons is
  'free 以外のアイコンの所有記録。free は全員所有扱いのため行を作らない。';

-- profiles.icon_key → icons.key の FK（0001 時点ではカタログが無かった）
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_icon_key_fk'
  ) then
    alter table public.profiles
      add constraint profiles_icon_key_fk
      foreign key (icon_key) references public.icons (key);
  end if;
end;
$$;

alter table public.icons enable row level security;
alter table public.user_icons enable row level security;

drop policy if exists "icons: read all (authenticated)" on public.icons;
create policy "icons: read all (authenticated)"
  on public.icons for select to authenticated using (true);

drop policy if exists "user_icons: read own" on public.user_icons;
create policy "user_icons: read own"
  on public.user_icons for select to authenticated
  using (user_id = (select auth.uid()));

revoke all on table public.icons, public.user_icons from anon;
grant select on table public.icons, public.user_icons to authenticated;

-- ---------- アイコン選択 ----------
-- 所有チェック：free は無条件、それ以外は user_icons に行がある場合のみ。
-- 勝利数解放・コイン購入の付与は次フェーズ（ここでは所有済み判定のみ）。
create or replace function public.kl_set_icon(p_icon_key text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  cat public.icons%rowtype;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  select * into cat from public.icons
   where key = p_icon_key and active;
  if not found then
    raise exception 'ICON_NOT_FOUND: そのアイコンは存在しません' using errcode = 'P0001';
  end if;
  if cat.tier <> 'free'
     and not exists (select 1 from public.user_icons ui
                      where ui.user_id = me and ui.icon_key = cat.key) then
    raise exception 'ICON_NOT_OWNED: そのアイコンはまだ持っていません' using errcode = 'P0001';
  end if;
  update public.profiles set icon_key = cat.key where id = me;
  return jsonb_build_object('iconKey', cat.key);
end;
$$;

revoke all on function public.kl_set_icon(text) from public, anon;
grant execute on function public.kl_set_icon(text) to authenticated;

-- ---------- ID検索に icon_key を追加（0005 の再定義） ----------
drop function if exists public.kl_search_user(text);
create function public.kl_search_user(p_public_id text)
returns table (
  id uuid, public_id text, display_name text,
  icon_key text, icon_emoji text, icon_bg text, bio text,
  popularity integer, relation text
)
language plpgsql stable security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  return query
  select p.id, p.public_id, p.display_name, p.icon_key, p.icon_emoji, p.icon_bg, p.bio,
         p.popularity,
         case
           when public.kl_are_friends(me, p.id) then 'friend'
           when exists (select 1 from public.friend_requests r
                         where r.from_id = me and r.to_id = p.id) then 'requested_out'
           when exists (select 1 from public.friend_requests r
                         where r.from_id = p.id and r.to_id = me) then 'requested_in'
           when exists (select 1 from public.blocks b
                         where b.blocker_id = p.id and b.blocked_id = me) then 'blocked_by'
           else 'none'
         end
    from public.profiles p
   where upper(p.public_id) = upper(trim(p_public_id))
     and p.id <> me
     and not exists (select 1 from public.blocks b
                      where b.blocker_id = me and b.blocked_id = p.id);
end;
$$;

revoke all on function public.kl_search_user(text) from public, anon;
grant execute on function public.kl_search_user(text) to authenticated;

-- ---------- ルーム一覧に hostIconKey を追加（0016 の再定義） ----------
create or replace function public.ww_list_rooms()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(item order by created_at desc), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'id', r.id,
      'title', r.title,
      'isPrivate', r.is_private,
      'beginner', r.beginner_welcome,
      'capacity', r.capacity,
      'status', r.status,
      'reversalEnabled', r.reversal_enabled,
      'genre', r.genre,
      'hostId', r.host_id,
      'hostName', hp.display_name,
      'hostIcon', hp.icon_emoji,
      'hostIconKey', hp.icon_key,
      'hostBg', hp.icon_bg,
      'memberCount', (select count(*) from public.room_members m
                       where m.room_id = r.id),
      'isMember', exists (select 1 from public.room_members m
                           where m.room_id = r.id and m.user_id = auth.uid()),
      'isHost', r.host_id = auth.uid(),
      'createdAt', r.created_at
    ) as item, r.created_at
    from public.rooms r
    join public.profiles hp on hp.id = r.host_id
    where r.status <> 'closed'
      and (not r.is_private
           or r.host_id = auth.uid()
           or exists (select 1 from public.room_members m
                       where m.room_id = r.id and m.user_id = auth.uid()))
  ) s
$$;

-- ---------- DM招待カードの発行 ----------
-- 発行できるのはルームのメンバーだけ。宛先はフレンドのみ（DM の
-- 既存ルールと同じ）。非公開ルームはパスワードのハッシュ照合を通った
-- 場合だけ、平文をカードに載せる。
create or replace function public.kl_send_invite(
  p_to uuid, p_room uuid, p_password text default null
)
returns public.dm_messages
language plpgsql security definer set search_path = public, extensions
as $$
declare
  me uuid := auth.uid();
  room public.rooms%rowtype;
  msg public.dm_messages%rowtype;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  if p_to = me then
    raise exception 'SELF_ACTION: 自分には送れません' using errcode = 'P0001';
  end if;
  perform public.kl_require_user(p_to);
  if public.kl_blocked_either(me, p_to) then
    raise exception 'BLOCKED: このユーザーには送れません' using errcode = 'P0001';
  end if;
  if not public.kl_are_friends(me, p_to) then
    raise exception 'NOT_FRIENDS: 招待はフレンドにのみ送れます' using errcode = 'P0001';
  end if;
  select * into room from public.rooms where id = p_room;
  if not found then
    raise exception 'ROOM_NOT_FOUND: ルームが存在しません' using errcode = 'P0001';
  end if;
  if room.status <> 'lobby' then
    raise exception 'ROOM_BUSY: このルームには今は招待できません' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.room_members m
                  where m.room_id = room.id and m.user_id = me) then
    raise exception 'NOT_A_MEMBER: 招待できるのはルームのメンバーだけです' using errcode = 'P0001';
  end if;
  if room.is_private then
    if p_password is null
       or room.password_hash <> crypt(p_password, room.password_hash) then
      raise exception 'WRONG_PASSWORD: パスワードが違います' using errcode = 'P0001';
    end if;
  end if;
  insert into public.dm_messages (sender_id, recipient_id, kind, invite_payload)
  values (
    me, p_to, 'invite',
    jsonb_build_object(
      'roomId', room.id,
      'roomTitle', room.title,
      'password', case when room.is_private then p_password else null end
    )
  )
  returning * into msg;
  return msg;
end;
$$;

revoke all on function public.kl_send_invite(uuid, uuid, text) from public, anon;
grant execute on function public.kl_send_invite(uuid, uuid, text) to authenticated;
