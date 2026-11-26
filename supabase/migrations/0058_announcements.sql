-- 0058: 運営のお知らせ（ティッカー用）
-- プレイヤー行動のライブ表示を廃止し、ティッカーは固定文＋運営の
-- お知らせだけを回す（2026-11-26 おぎ判断）。お知らせの出し入れは
-- このテーブルへの insert / active 切替で運用する（管理画面なし）
create table if not exists public.kl_announcements (
  id uuid primary key default gen_random_uuid(),
  text text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.kl_announcements enable row level security;
drop policy if exists kl_announcements_read on public.kl_announcements;
create policy kl_announcements_read on public.kl_announcements
  for select to authenticated using (active);
grant select on public.kl_announcements to authenticated;
