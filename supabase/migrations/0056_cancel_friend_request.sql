-- =============================================================================
-- 0056_cancel_friend_request.sql — フレンド申請の取り消し（申請者側）
-- =============================================================================
-- 2026-11-26 おぎ要望：申請した側が「申請中」をタップして申請を
-- 取り消せるようにする（確認ポップアップを挟むのはクライアント側）。
-- 申請行を消すだけの後片付け系操作なので、0050 の生年月日ガードの
-- 対象にはしない（退出・ブロック解除などと同じ扱い）。
-- =============================================================================

create or replace function public.kl_cancel_friend_request(p_to uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  delete from public.friend_requests
  where from_id = me and to_id = p_to;
  if not found then
    raise exception 'REQUEST_NOT_FOUND: 申請が存在しません' using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function public.kl_cancel_friend_request(uuid) from public, anon;
grant execute on function public.kl_cancel_friend_request(uuid) to authenticated;
