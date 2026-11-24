-- =============================================================================
-- 0002_friends.sql — フレンド申請／フレンド関係／ブロック（Lite）
-- =============================================================================
-- 本家の 0012 と同じ構造。書き込みは原則 RPC（0005 の kl_*）経由で、
-- ここでは読み取りポリシーだけを開ける（判定・整合性は RPC が担保）。
-- - friend_requests：未承認の申請。承認で friendships へ移り行は消える
-- - friendships：user_a < user_b の正規化ペアで1行（相互関係）
-- - blocks：ブロック。ブロック時にフレンド関係と申請は RPC が解除する
-- =============================================================================

create table if not exists public.friend_requests (
  from_id uuid not null references auth.users (id) on delete cascade,
  to_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (from_id, to_id),
  constraint friend_requests_no_self check (from_id <> to_id)
);

comment on table public.friend_requests is
  'フレンド申請（未承認分）。書き込みは RPC kl_send_friend_request / kl_respond_friend_request 経由。';

create index if not exists friend_requests_to_idx
  on public.friend_requests (to_id, created_at);

create table if not exists public.friendships (
  user_a uuid not null references auth.users (id) on delete cascade,
  user_b uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_a, user_b),
  constraint friendships_ordered_pair check (user_a < user_b)
);

comment on table public.friendships is
  'フレンド関係（相互）。user_a < user_b の正規化ペアで1行。';

create table if not exists public.blocks (
  blocker_id uuid not null references auth.users (id) on delete cascade,
  blocked_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint blocks_no_self check (blocker_id <> blocked_id)
);

comment on table public.blocks is
  'ブロック関係。ブロックするとフレンド関係は解除され、相手からの申請・DM・ギフトは RPC が拒否する。';

create index if not exists blocks_blocked_idx
  on public.blocks (blocked_id);

alter table public.friend_requests enable row level security;
alter table public.friendships enable row level security;
alter table public.blocks enable row level security;

drop policy if exists "friend_requests: read by parties" on public.friend_requests;
create policy "friend_requests: read by parties"
  on public.friend_requests for select to authenticated
  using (from_id = (select auth.uid()) or to_id = (select auth.uid()));

drop policy if exists "friendships: read by parties" on public.friendships;
create policy "friendships: read by parties"
  on public.friendships for select to authenticated
  using (user_a = (select auth.uid()) or user_b = (select auth.uid()));

drop policy if exists "blocks: read by blocker" on public.blocks;
create policy "blocks: read by blocker"
  on public.blocks for select to authenticated
  using (blocker_id = (select auth.uid()));

revoke all on table public.friend_requests, public.friendships, public.blocks from anon;
grant select on table public.friend_requests, public.friendships, public.blocks to authenticated;
