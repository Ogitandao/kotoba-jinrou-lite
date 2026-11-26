-- =============================================================================
-- 0053_conversation_clear.sql — トーク（会話）単位の削除に作り替える
-- =============================================================================
-- 2026-11-26 おぎの意図が確定：消したいのは個別の吹き出しではなく、
-- 「その人とのチャットログ丸ごと」を「消す側の画面からだけ」消すこと
-- （例：ブロックした相手との会話を自分のトーク一覧に残したくない）。
-- 相手の画面には一切影響しない。新しいメッセージが来れば、その分だけ
-- 会話は一覧に戻る（LINE のトーク削除と同じ考え方）。
--
-- - 0052 の送信取消（deleted_at＋kl_delete_*）は廃止する
-- - 「いつ時点までの会話を消したか」をユーザー×会話で持ち、読み取り側は
--   その時刻より後のメッセージだけを出す（cleared_at 方式）
-- - conv_key：DM は相手のユーザーID、システムは 'system'、グループは
--   グループID（いずれも文字列）
-- =============================================================================

alter table public.dm_messages drop column if exists deleted_at;
alter table public.kl_group_messages drop column if exists deleted_at;
drop function if exists public.kl_delete_dm_message(uuid);
drop function if exists public.kl_delete_group_message(uuid);

create table if not exists public.kl_conversation_clears (
  user_id uuid not null references auth.users (id) on delete cascade,
  conv_key text not null,
  cleared_at timestamptz not null default now(),
  primary key (user_id, conv_key)
);

comment on table public.kl_conversation_clears is
  'トーク削除の記録：このユーザーの画面では cleared_at 以前の会話を表示しない。相手の画面には影響しない。書き込みは kl_clear_conversation 経由のみ';

alter table public.kl_conversation_clears enable row level security;

drop policy if exists conversation_clears_select_own on public.kl_conversation_clears;
create policy conversation_clears_select_own on public.kl_conversation_clears
  for select to authenticated using (user_id = auth.uid());

create or replace function public.kl_clear_conversation(p_key text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  if p_key is null or length(trim(p_key)) = 0 then
    raise exception 'BAD_KEY: 会話の指定が不正です' using errcode = 'P0001';
  end if;
  insert into public.kl_conversation_clears (user_id, conv_key, cleared_at)
  values (me, p_key, now())
  on conflict (user_id, conv_key)
  do update set cleared_at = excluded.cleared_at;
end;
$$;

revoke all on function public.kl_clear_conversation(text) from public, anon;
grant execute on function public.kl_clear_conversation(text) to authenticated;
