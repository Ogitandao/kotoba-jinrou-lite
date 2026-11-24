-- =============================================================================
-- 0004_dm_gifts.sql — DM（個人チャット）／ギフト／通報（Lite）
-- =============================================================================
-- DM は本家の方針をそのまま踏襲：
-- - 読めるのは送信者と受信者だけ（RLS）
-- - 送信は RPC kl_send_dm 経由のみ（フレンド関係・ブロック・URL禁止を
--   サーバー側で判定する。本家決定：DM で送れるのはテキストとギフトのみ、
--   リンクと画像は禁止）
-- - kind は text / invite / gift の3種。invite は非公開ルームの招待
--   カードで、invite_payload に { roomId, password } を持つ（Lite 決定：
--   招待カード上にパスワードを表示しコピーボタンを付ける。照合の正本は
--   rooms.password_hash 側）
-- - read_at は受信者が既読にした時刻（未読バッジ用）
--
-- ギフト：カタログはテーブル（gift_catalog）に持ち、価格の正本とする。
-- 送信の取引（残高消費→台帳→履歴→人気度→ギフトカードDM）は
-- RPC kl_send_gift が1トランザクションで行う。
-- =============================================================================

create table if not exists public.dm_messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references auth.users (id) on delete cascade,
  recipient_id uuid not null references auth.users (id) on delete cascade,
  kind text not null default 'text',
  body text,
  invite_payload jsonb,
  gift_payload jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  constraint dm_messages_no_self check (sender_id <> recipient_id),
  constraint dm_messages_kind_check check (kind in ('text', 'invite', 'gift')),
  constraint dm_messages_body_check check (
    (kind = 'text' and body is not null and length(body) between 1 and 500)
    or (kind = 'invite' and invite_payload is not null)
    or (kind = 'gift' and gift_payload is not null)
  ),
  constraint dm_messages_no_url check (
    body is null
    or body !~* 'https?://|www\.'
  )
);

comment on table public.dm_messages is
  '個人チャット（DM）。読めるのは当事者だけ、送信は RPC kl_send_dm / kl_send_gift 経由のみ。';
comment on column public.dm_messages.invite_payload is
  '招待カード { roomId, password }。パスワードは受信者本人の画面表示用（照合の正本は rooms.password_hash）。';
comment on column public.dm_messages.gift_payload is
  'ギフトカード { historyId, giftKey, name, icon, price }。取引の正本は gift_history。';

create index if not exists dm_messages_pair_idx
  on public.dm_messages (sender_id, recipient_id, created_at desc);
create index if not exists dm_messages_recipient_idx
  on public.dm_messages (recipient_id, created_at desc);

create table if not exists public.gift_catalog (
  key text primary key,
  name text not null,
  icon text not null,
  price integer not null check (price > 0),
  sort integer not null default 0,
  active boolean not null default true
);

comment on table public.gift_catalog is
  'ギフトのカタログ（価格の正本）。Lite は数種類から開始し、段階的に増やす。';

insert into public.gift_catalog (key, name, icon, price, sort) values
  ('heart',       'ハート',     '❤️',   30, 1),
  ('flower',      'お花',       '🌸',   50, 2),
  ('candy',       'キャンディ', '🍬',  100, 3),
  ('coffee',      'コーヒー',   '☕',  100, 4),
  ('cake',        'ケーキ',     '🎂',  300, 5),
  ('teddy',       'テディベア', '🧸',  500, 6),
  ('ring',        '指輪',       '💍', 1000, 7),
  ('crown',       '王冠',       '👑', 3000, 8)
on conflict (key) do update
  set name = excluded.name, icon = excluded.icon,
      price = excluded.price, sort = excluded.sort, active = true;

create table if not exists public.gift_history (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references auth.users (id) on delete cascade,
  receiver_id uuid not null references auth.users (id) on delete cascade,
  gift_key text not null references public.gift_catalog (key),
  price integer not null check (price > 0),
  created_at timestamptz not null default now(),
  constraint gift_history_no_self check (sender_id <> receiver_id)
);

comment on table public.gift_history is
  'ギフト送信履歴。price は送信時点の価格（検算用）。coin_ledger の gift_sent 行の ref_id はこの id。もらった側にコインは入らず、人気度だけが price 分上がる（本家ルール）。';

create index if not exists gift_history_receiver_idx
  on public.gift_history (receiver_id, created_at desc);
create index if not exists gift_history_sender_idx
  on public.gift_history (sender_id, created_at desc);

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references auth.users (id) on delete cascade,
  target_user_id uuid references auth.users (id) on delete set null,
  target_kind text not null check (target_kind in ('user', 'dm_message', 'room_message')),
  target_ref uuid,
  reason text not null,
  detail text,
  status text not null default 'pending' check (status in ('pending', 'handled', 'dismissed')),
  created_at timestamptz not null default now()
);

comment on table public.reports is
  '通報。書き込みは自分の通報のみ（RLS）。処理は運営側（service_role）。自動モデレーションは G-C 前の宿題で、ここは入り口と保管だけ。';

alter table public.dm_messages enable row level security;
alter table public.gift_catalog enable row level security;
alter table public.gift_history enable row level security;
alter table public.reports enable row level security;

drop policy if exists "dm_messages: read by participants" on public.dm_messages;
create policy "dm_messages: read by participants"
  on public.dm_messages for select to authenticated
  using (sender_id = (select auth.uid()) or recipient_id = (select auth.uid()));

drop policy if exists "gift_catalog: read all (authenticated)" on public.gift_catalog;
create policy "gift_catalog: read all (authenticated)"
  on public.gift_catalog for select to authenticated using (true);

drop policy if exists "gift_history: read by parties" on public.gift_history;
create policy "gift_history: read by parties"
  on public.gift_history for select to authenticated
  using (sender_id = (select auth.uid()) or receiver_id = (select auth.uid()));

drop policy if exists "reports: insert own" on public.reports;
create policy "reports: insert own"
  on public.reports for insert to authenticated
  with check (reporter_id = (select auth.uid()));

drop policy if exists "reports: read own" on public.reports;
create policy "reports: read own"
  on public.reports for select to authenticated
  using (reporter_id = (select auth.uid()));

revoke all on table public.dm_messages, public.gift_catalog, public.gift_history, public.reports from anon;
grant select on table public.dm_messages, public.gift_catalog, public.gift_history to authenticated;
grant select, insert on table public.reports to authenticated;
