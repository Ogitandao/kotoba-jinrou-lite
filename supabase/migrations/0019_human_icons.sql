-- 0019: 人物アイコン（男女各3）を無料プリセットに追加（2026-11-25 おぎ承認の見本シートから正式素材化）
-- 動物15種はそのまま。無料枠は合計21種になる。
insert into public.icons (key, name, tier, sort) values
  ('man1',   '男性・黒髪',         'free', 16),
  ('man2',   '男性・茶髪',         'free', 17),
  ('man3',   '男性・眼鏡',         'free', 18),
  ('woman1', '女性・ロング',       'free', 19),
  ('woman2', '女性・ボブ',         'free', 20),
  ('woman3', '女性・ポニーテール', 'free', 21)
on conflict (key) do nothing;
