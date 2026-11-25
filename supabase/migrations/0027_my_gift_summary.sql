-- 0027: ロビーのギフト帯用「もらったギフト集計」RPC（2026-11-25 おぎ）
-- 本人分のみ返す。並びは単品価格が高い順→同額なら個数順（本家の帯ルール）。
-- 帯は表示専用（タップ不可）で、誰からもらったかは DM のギフトカードで届く。
create or replace function public.kl_my_gift_summary()
returns jsonb
language sql security definer set search_path = public
as $$
  select coalesce(jsonb_agg(item order by price desc, cnt desc), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'giftKey', h.gift_key, 'name', c.name, 'icon', c.icon,
      'price', c.price, 'count', count(*)) as item,
      c.price as price, count(*) as cnt
    from public.gift_history h
    join public.gift_catalog c on c.key = h.gift_key
    where h.receiver_id = auth.uid()
    group by h.gift_key, c.name, c.icon, c.price
  ) s;
$$;

revoke all on function public.kl_my_gift_summary() from public, anon;
grant execute on function public.kl_my_gift_summary() to authenticated;
