-- =============================================================================
-- 0052_message_delete.sql — DM／グループメッセージの削除（送信者による取消）
-- =============================================================================
-- 2026-11-26 おぎ要望：DM のメッセージを長押しで削除できるようにする。
-- 仕様：
-- - 消せるのは自分の text メッセージだけ（ギフト／招待／システムは不可）
-- - ソフトデリート（deleted_at を立てる）。本文は DB に残す
--   （通報時のスナップショット等、モデレーションの証跡を壊さないため）。
--   読み取り側は deleted_at があれば本文を渡さず「削除されました」表示にする
-- - 誕生日ガード（0050）の対象にはしない（退出・ブロック等と同じく
--   後始末系の操作として常時可能に保つ）
-- =============================================================================

alter table public.dm_messages
  add column if not exists deleted_at timestamptz;
alter table public.kl_group_messages
  add column if not exists deleted_at timestamptz;

comment on column public.dm_messages.deleted_at is
  '送信者が削除した時刻。読み取り側は本文を伏せて削除表示にする（本文自体は証跡として保持）';
comment on column public.kl_group_messages.deleted_at is
  '送信者が削除した時刻。読み取り側は本文を伏せて削除表示にする（本文自体は証跡として保持）';

create or replace function public.kl_delete_dm_message(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  msg public.dm_messages%rowtype;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  select * into msg from public.dm_messages where id = p_id;
  if not found then
    raise exception 'MESSAGE_NOT_FOUND: メッセージが存在しません' using errcode = 'P0001';
  end if;
  if msg.sender_id <> me then
    raise exception 'NOT_OWN_MESSAGE: 自分のメッセージだけ削除できます' using errcode = 'P0001';
  end if;
  if msg.kind <> 'text' then
    raise exception 'NOT_DELETABLE: このメッセージは削除できません' using errcode = 'P0001';
  end if;
  if msg.deleted_at is not null then
    return; -- 冪等：削除済みなら何もしない
  end if;
  update public.dm_messages set deleted_at = now() where id = p_id;
end;
$$;

create or replace function public.kl_delete_group_message(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  msg public.kl_group_messages%rowtype;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  select * into msg from public.kl_group_messages where id = p_id;
  if not found then
    raise exception 'MESSAGE_NOT_FOUND: メッセージが存在しません' using errcode = 'P0001';
  end if;
  if msg.sender_id is null or msg.sender_id <> me then
    raise exception 'NOT_OWN_MESSAGE: 自分のメッセージだけ削除できます' using errcode = 'P0001';
  end if;
  if msg.kind <> 'text' then
    raise exception 'NOT_DELETABLE: このメッセージは削除できません' using errcode = 'P0001';
  end if;
  if msg.deleted_at is not null then
    return;
  end if;
  update public.kl_group_messages set deleted_at = now() where id = p_id;
end;
$$;

revoke all on function public.kl_delete_dm_message(uuid) from public, anon;
revoke all on function public.kl_delete_group_message(uuid) from public, anon;
grant execute on function public.kl_delete_dm_message(uuid) to authenticated;
grant execute on function public.kl_delete_group_message(uuid) to authenticated;
