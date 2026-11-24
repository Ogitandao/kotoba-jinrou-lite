-- 0021: 自己紹介の上限を100文字→50文字に変更（2026-11-25 おぎ：100文字だと見栄えが悪い）
-- 既存の100文字超データはそのまま残す（表示側の問題は出ない範囲。新規保存から50文字制限）。
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
  if char_length(v_bio) > 50 then
    raise exception 'BIO_TOO_LONG: 自己紹介は50文字までです' using errcode = 'P0001';
  end if;
  update public.profiles set bio = v_bio where id = me;
  return jsonb_build_object('bio', v_bio);
end;
$$;

revoke all on function public.kl_update_profile(text) from public, anon;
grant execute on function public.kl_update_profile(text) to authenticated;
