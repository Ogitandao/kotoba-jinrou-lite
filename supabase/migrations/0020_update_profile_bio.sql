-- 0020: 自己紹介の編集 RPC（2026-11-25 おぎ指摘：編集する術がない）
-- ロビーのプロフィールカードで自己紹介をタップ → 編集モーダル → ここで保存。
-- 上限は仕様どおり100文字。空文字は「未設定に戻す」として許可する。
create or replace function public.kl_update_profile(p_bio text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  v_bio text := coalesce(trim(p_bio), '');
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  if char_length(v_bio) > 100 then
    raise exception 'BIO_TOO_LONG: 自己紹介は100文字までです' using errcode = 'P0001';
  end if;
  update public.profiles set bio = v_bio where id = me;
  return jsonb_build_object('bio', v_bio);
end;
$$;

revoke all on function public.kl_update_profile(text) from public, anon;
grant execute on function public.kl_update_profile(text) to authenticated;
