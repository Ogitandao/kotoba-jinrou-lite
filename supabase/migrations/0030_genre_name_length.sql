-- 0030: ジャンル名（ww_topics.category）の文字数制限（2026-11-25 おぎ指摘）
-- 運営がコンテンツを追加するときのルール：ジャンル名は最大8文字まで。
-- 根拠：現在の最長は「季節・イベント」7文字。ルームカードのメタ行（人数＋ジャンルチップ）が
-- 320px 幅でも崩れない上限として 8 文字を上限に固定する（UI側の都合で後から直さない）。
alter table public.ww_topics
  add constraint ww_topics_category_len check (category is null or char_length(category) <= 8);
