-- 0033: ギフトカタログを正式11種に（2026-11-25 おぎ決定）
-- 仮8種に小悪魔・ドラゴン・ダイヤモンドを追加。価格階段は
-- 30/50/100/100/300/500/1,000/2,000/3,000/5,000/10,000。
-- カタログ最高額はダイヤモンド 10,000（ティッカーの高額ギフト
-- 投稿フックはカタログ最大価格に連動する）。

insert into public.gift_catalog (key, name, icon, price, sort) values
  ('devil',   '小悪魔',     '😈',  2000, 8),
  ('dragon',  'ドラゴン',   '🐲',  5000, 10),
  ('diamond', 'ダイヤモンド', '💎', 10000, 11)
on conflict (key) do update
  set name = excluded.name, icon = excluded.icon,
      price = excluded.price, sort = excluded.sort, active = true;

-- 王冠は 3,000 なので小悪魔（2,000）の後ろへずらす
update public.gift_catalog set sort = 9 where key = 'crown';
