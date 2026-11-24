-- =============================================================================
-- 0015_room_chat.sql — 待機室チャット（Lite）
-- =============================================================================
-- 2026-11-24 おぎ決定：Lite はテキストのみで従量課金がないため、
-- 待機室は「待機チャット」の場として正式化する（ゲーム前・ゲーム間に
-- 自由に雑談できる）。対戦中チャット（ww_messages、ゲーム単位）とは
-- 別に、ルーム単位のチャットログを持つ。
-- - 読み取り：メンバーだけが RLS で読める（ホストもメンバー行を持つ）
-- - 書き込み：ww_post_room_message RPC 経由のみ（メンバー確認＋
--   文字数チェックをサーバー側で行う）
-- =============================================================================

create table if not exists public.ww_room_messages (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  sender_id uuid references auth.users (id) on delete cascade,
  kind text not null default 'chat' check (kind in ('chat', 'system')),
  body text not null check (length(body) between 1 and 200),
  created_at timestamptz not null default now(),
  constraint ww_room_messages_sender_check check (
    (kind = 'chat' and sender_id is not null)
    or (kind = 'system' and sender_id is null)
  )
);

comment on table public.ww_room_messages is
  '待機室チャット（ルーム単位）。ゲーム前・ゲーム間の雑談用。書き込みは ww_post_room_message 経由のみ。';

create index if not exists ww_room_messages_room_idx
  on public.ww_room_messages (room_id, created_at);

alter table public.ww_room_messages enable row level security;

drop policy if exists "ww_room_messages: members read" on public.ww_room_messages;
create policy "ww_room_messages: members read"
  on public.ww_room_messages for select to authenticated
  using (public.kl_is_room_member(room_id));

revoke all on table public.ww_room_messages from anon;
grant select on table public.ww_room_messages to authenticated;

-- ---------- 待機室チャットへの投稿 ----------

create or replace function public.ww_post_room_message(p_room uuid, p_body text)
returns public.ww_room_messages
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  msg public.ww_room_messages%rowtype;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.room_members m
     where m.room_id = p_room and m.user_id = me
  ) then
    raise exception 'NOT_A_MEMBER: このルームに参加していません' using errcode = 'P0001';
  end if;
  if p_body is null or length(trim(p_body)) = 0 then
    raise exception 'EMPTY_MESSAGE: 本文が空です' using errcode = 'P0001';
  end if;
  if length(p_body) > 200 then
    raise exception 'MESSAGE_TOO_LONG: 文字数上限を超えています' using errcode = 'P0001';
  end if;
  insert into public.ww_room_messages (room_id, sender_id, body)
  values (p_room, me, p_body) returning * into msg;
  return msg;
end;
$$;

revoke all on function public.ww_post_room_message(uuid, text) from public, anon;
grant execute on function public.ww_post_room_message(uuid, text) to authenticated;

-- ---------- Realtime ----------

do $$
begin
  alter publication supabase_realtime add table public.ww_room_messages;
exception when duplicate_object then null;
end $$;
