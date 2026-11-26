-- =============================================================================
-- 0054_grant_clears.sql — kl_conversation_clears の読み取り権限を付与
-- =============================================================================
-- 0053 で表を作った際、authenticated ロールへの grant が漏れていたため、
-- クライアントからの select が permission denied になり、トーク削除が
-- 画面に反映されなかった（2026-11-26 おぎの実機確認で発覚）。
-- 書き込みは kl_clear_conversation（security definer）経由のみなので
-- select だけを許可する。
-- =============================================================================

grant select on public.kl_conversation_clears to authenticated;
