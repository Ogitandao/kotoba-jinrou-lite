-- 0028: 他人のプロフィール表示用 RPC（2026-11-25 おぎ：フレンドメニュー新設）
-- 公開してよい情報だけを返す：自己紹介・人気度・勝利数・もらったギフト集計。
-- ギフト集計の並びは 0027 と同じ（単品価格が高い順→同額なら個数順）。
create or replace function public.kl_user_profile(p_user uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  prof public.profiles%rowtype;
  gifts jsonb;
begin
  select * into prof from public.profiles where id = p_user;
  if not found then
    raise exception 'USER_NOT_FOUND: ユーザーが存在しません' using errcode = 'P0001';
  end if;
  select coalesce(jsonb_agg(item order by price desc, cnt desc), '[]'::jsonb)
    into gifts
    from (
      select jsonb_build_object(
        'giftKey', h.gift_key, 'name', c.name, 'icon', c.icon,
        'price', c.price, 'count', count(*)) as item,
        c.price as price, count(*) as cnt
      from public.gift_history h
      join public.gift_catalog c on c.key = h.gift_key
      where h.receiver_id = p_user
      group by h.gift_key, c.name, c.icon, c.price
    ) s;
  return jsonb_build_object(
    'bio', prof.bio,
    'popularity', prof.popularity,
    'wordwolfWins', prof.wordwolf_wins,
    'gifts', gifts);
end;
$$;

revoke all on function public.kl_user_profile(uuid) from public, anon;
grant execute on function public.kl_user_profile(uuid) to authenticated;
