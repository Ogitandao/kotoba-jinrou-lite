-- =============================================================================
-- 0005_rpc_social.sql — ソーシャル系 RPC（Lite）
-- =============================================================================
-- フレンド／DM／ギフト／コインの「書き込み」はすべて SECURITY DEFINER の
-- RPC 経由に統一し、判定（フレンド関係・ブロック・残高・締め切り等）を
-- サーバー側に寄せる。読み取りは各テーブルの RLS で直接 select する。
--
-- エラーは raise exception 'CODE: 説明'（errcode P0001）で返し、
-- クライアントとローカル実証（sim/social.mjs）は CODE で分岐する。
-- 主な CODE：
--   UNAUTHENTICATED / USER_NOT_FOUND / SELF_ACTION / ALREADY_FRIENDS /
--   ALREADY_REQUESTED / REQUEST_NOT_FOUND / BLOCKED / NOT_FRIENDS /
--   EMPTY_MESSAGE / MESSAGE_TOO_LONG / URL_NOT_ALLOWED /
--   GIFT_NOT_FOUND / INSUFFICIENT_COINS
-- =============================================================================

-- ---------- 内部ヘルパー ----------

create or replace function public.kl_pair(p_a uuid, p_b uuid)
returns uuid[]
language sql immutable
as $$ select array[least(p_a, p_b), greatest(p_a, p_b)] $$;

create or replace function public.kl_are_friends(p_a uuid, p_b uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.friendships f
    where f.user_a = least(p_a, p_b) and f.user_b = greatest(p_a, p_b)
  )
$$;

create or replace function public.kl_blocked_either(p_a uuid, p_b uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.blocks b
    where (b.blocker_id = p_a and b.blocked_id = p_b)
       or (b.blocker_id = p_b and b.blocked_id = p_a)
  )
$$;

create or replace function public.kl_require_user(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not exists (select 1 from public.profiles where id = p_id) then
    raise exception 'USER_NOT_FOUND: ユーザーが存在しません' using errcode = 'P0001';
  end if;
end;
$$;

-- 財布から消費する（無料分から先。残高不足は INSUFFICIENT_COINS）。
-- 戻り値：消費した (無料分, 課金分)。呼び出し側で台帳に記録すること。
create or replace function public.kl_spend_coins(
  p_user uuid, p_amount integer,
  out spent_free integer, out spent_paid integer
)
language plpgsql security definer set search_path = public
as $$
declare
  w public.coin_wallets%rowtype;
begin
  select * into w from public.coin_wallets where user_id = p_user for update;
  if not found then
    raise exception 'USER_NOT_FOUND: 財布が存在しません' using errcode = 'P0001';
  end if;
  if w.free_balance + w.paid_balance < p_amount then
    raise exception 'INSUFFICIENT_COINS: コインが足りません' using errcode = 'P0001';
  end if;
  spent_free := least(w.free_balance, p_amount);
  spent_paid := p_amount - spent_free;
  update public.coin_wallets
     set free_balance = free_balance - spent_free,
         paid_balance = paid_balance - spent_paid
   where user_id = p_user;
end;
$$;

-- ---------- ID 検索 ----------

-- 公開IDの完全一致検索。関係状態（friend / requested_out / requested_in /
-- blocked / none）も一緒に返す。自分と、ブロックした相手は結果に出さない。
create or replace function public.kl_search_user(p_public_id text)
returns table (
  id uuid, public_id text, display_name text,
  icon_emoji text, icon_bg text, bio text,
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
  select p.id, p.public_id, p.display_name, p.icon_emoji, p.icon_bg, p.bio,
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

-- ---------- フレンド申請 ----------

-- 申請を送る。相手から自分への申請が既にある場合は「承認」として処理する。
create or replace function public.kl_send_friend_request(p_to uuid)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  pair uuid[];
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  if p_to = me then
    raise exception 'SELF_ACTION: 自分には申請できません' using errcode = 'P0001';
  end if;
  perform public.kl_require_user(p_to);
  if public.kl_blocked_either(me, p_to) then
    raise exception 'BLOCKED: このユーザーとは申請できません' using errcode = 'P0001';
  end if;
  if public.kl_are_friends(me, p_to) then
    raise exception 'ALREADY_FRIENDS: すでにフレンドです' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.friend_requests
              where from_id = me and to_id = p_to) then
    raise exception 'ALREADY_REQUESTED: すでに申請中です' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.friend_requests
              where from_id = p_to and to_id = me) then
    delete from public.friend_requests where from_id = p_to and to_id = me;
    pair := public.kl_pair(me, p_to);
    insert into public.friendships (user_a, user_b) values (pair[1], pair[2]);
    return 'accepted';
  end if;
  insert into public.friend_requests (from_id, to_id) values (me, p_to);
  return 'requested';
end;
$$;

-- 申請への回答。p_accept = true でフレンド成立、false で却下（行を消す）。
create or replace function public.kl_respond_friend_request(p_from uuid, p_accept boolean)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  pair uuid[];
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.friend_requests
                  where from_id = p_from and to_id = me) then
    raise exception 'REQUEST_NOT_FOUND: 申請が存在しません' using errcode = 'P0001';
  end if;
  delete from public.friend_requests where from_id = p_from and to_id = me;
  if p_accept then
    pair := public.kl_pair(me, p_from);
    insert into public.friendships (user_a, user_b) values (pair[1], pair[2])
    on conflict do nothing;
    return 'accepted';
  end if;
  return 'rejected';
end;
$$;

create or replace function public.kl_remove_friend(p_other uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  pair uuid[] := public.kl_pair(me, p_other);
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  delete from public.friendships where user_a = pair[1] and user_b = pair[2];
end;
$$;

-- ブロック：関係と申請を両方向とも解除してからブロック行を作る。
create or replace function public.kl_block_user(p_other uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  pair uuid[] := public.kl_pair(me, p_other);
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  if p_other = me then
    raise exception 'SELF_ACTION: 自分はブロックできません' using errcode = 'P0001';
  end if;
  perform public.kl_require_user(p_other);
  delete from public.friendships where user_a = pair[1] and user_b = pair[2];
  delete from public.friend_requests
   where (from_id = me and to_id = p_other)
      or (from_id = p_other and to_id = me);
  insert into public.blocks (blocker_id, blocked_id) values (me, p_other)
  on conflict do nothing;
end;
$$;

create or replace function public.kl_unblock_user(p_other uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  delete from public.blocks where blocker_id = me and blocked_id = p_other;
end;
$$;

-- ---------- DM ----------

-- テキスト送信。フレンド間のみ、ブロック時は拒否、URL は禁止（本家決定）。
create or replace function public.kl_send_dm(p_to uuid, p_body text)
returns public.dm_messages
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  body text := trim(coalesce(p_body, ''));
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
    raise exception 'NOT_FRIENDS: DM はフレンド同士でのみ送れます' using errcode = 'P0001';
  end if;
  if length(body) = 0 then
    raise exception 'EMPTY_MESSAGE: 本文が空です' using errcode = 'P0001';
  end if;
  if length(body) > 500 then
    raise exception 'MESSAGE_TOO_LONG: 500文字以内で入力してください' using errcode = 'P0001';
  end if;
  if body ~* 'https?://|www\.' then
    raise exception 'URL_NOT_ALLOWED: DM ではリンクを送れません' using errcode = 'P0001';
  end if;
  insert into public.dm_messages (sender_id, recipient_id, kind, body)
  values (me, p_to, 'text', body)
  returning * into msg;
  return msg;
end;
$$;

-- 相手からのメッセージを既読にする
create or replace function public.kl_mark_dm_read(p_other uuid)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  n integer;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  update public.dm_messages
     set read_at = now()
   where sender_id = p_other and recipient_id = me and read_at is null;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---------- ギフト ----------

-- ギフト送信の取引を1トランザクションで行う：
-- 残高消費（無料分から）→ 台帳 → 履歴 → 相手の人気度 +price →
-- DM にギフトカードを差し込む。もらった側にコインは入らない。
create or replace function public.kl_send_gift(p_to uuid, p_gift_key text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  g public.gift_catalog%rowtype;
  spent record;
  hist_id uuid;
  w public.coin_wallets%rowtype;
  new_popularity integer;
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
  select * into g from public.gift_catalog where key = p_gift_key and active;
  if not found then
    raise exception 'GIFT_NOT_FOUND: ギフトが存在しません' using errcode = 'P0001';
  end if;

  select * into spent from public.kl_spend_coins(me, g.price);

  insert into public.gift_history (sender_id, receiver_id, gift_key, price)
  values (me, p_to, g.key, g.price)
  returning id into hist_id;

  insert into public.coin_ledger (user_id, delta_free, delta_paid, reason, ref_id)
  values (me, -spent.spent_free, -spent.spent_paid, 'gift_sent', hist_id);

  update public.profiles
     set popularity = popularity + g.price
   where id = p_to
   returning popularity into new_popularity;

  insert into public.dm_messages (sender_id, recipient_id, kind, gift_payload)
  values (me, p_to, 'gift', jsonb_build_object(
    'historyId', hist_id, 'giftKey', g.key,
    'name', g.name, 'icon', g.icon, 'price', g.price
  ));

  select * into w from public.coin_wallets where user_id = me;
  return jsonb_build_object(
    'historyId', hist_id,
    'price', g.price,
    'freeBalance', w.free_balance,
    'paidBalance', w.paid_balance,
    'receiverPopularity', new_popularity
  );
end;
$$;

-- ---------- コイン：ログインボーナス ----------

-- JST の日付で1日1回だけ +10（無料分）。二重受取は claimed=false で返す。
create or replace function public.kl_claim_login_bonus()
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  today_jst date := (now() at time zone 'Asia/Tokyo')::date;
  w public.coin_wallets%rowtype;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  select * into w from public.coin_wallets where user_id = me for update;
  if not found then
    raise exception 'USER_NOT_FOUND: 財布が存在しません' using errcode = 'P0001';
  end if;
  if w.last_login_bonus_date = today_jst then
    return jsonb_build_object('claimed', false, 'amount', 0,
      'freeBalance', w.free_balance, 'paidBalance', w.paid_balance);
  end if;
  update public.coin_wallets
     set free_balance = free_balance + 10,
         last_login_bonus_date = today_jst
   where user_id = me
   returning * into w;
  insert into public.coin_ledger (user_id, delta_free, reason)
  values (me, 10, 'daily_login');
  return jsonb_build_object('claimed', true, 'amount', 10,
    'freeBalance', w.free_balance, 'paidBalance', w.paid_balance);
end;
$$;

-- ---------- プレゼンス ----------

create or replace function public.kl_touch_presence()
returns void
language plpgsql security definer set search_path = public
as $$
begin
  update public.profiles set last_seen_at = now() where id = auth.uid();
end;
$$;

-- ---------- 実行権限 ----------

revoke all on function public.kl_search_user(text) from public, anon;
revoke all on function public.kl_send_friend_request(uuid) from public, anon;
revoke all on function public.kl_respond_friend_request(uuid, boolean) from public, anon;
revoke all on function public.kl_remove_friend(uuid) from public, anon;
revoke all on function public.kl_block_user(uuid) from public, anon;
revoke all on function public.kl_unblock_user(uuid) from public, anon;
revoke all on function public.kl_send_dm(uuid, text) from public, anon;
revoke all on function public.kl_mark_dm_read(uuid) from public, anon;
revoke all on function public.kl_send_gift(uuid, text) from public, anon;
revoke all on function public.kl_claim_login_bonus() from public, anon;
revoke all on function public.kl_touch_presence() from public, anon;
revoke all on function public.kl_spend_coins(uuid, integer) from public, anon, authenticated;

grant execute on function public.kl_search_user(text) to authenticated;
grant execute on function public.kl_send_friend_request(uuid) to authenticated;
grant execute on function public.kl_respond_friend_request(uuid, boolean) to authenticated;
grant execute on function public.kl_remove_friend(uuid) to authenticated;
grant execute on function public.kl_block_user(uuid) to authenticated;
grant execute on function public.kl_unblock_user(uuid) to authenticated;
grant execute on function public.kl_send_dm(uuid, text) to authenticated;
grant execute on function public.kl_mark_dm_read(uuid) to authenticated;
grant execute on function public.kl_send_gift(uuid, text) to authenticated;
grant execute on function public.kl_claim_login_bonus() to authenticated;
grant execute on function public.kl_touch_presence() to authenticated;
