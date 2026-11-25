-- =============================================================================
-- 0041_reports_status_upheld.sql — reports.status に 'upheld' を追加
-- =============================================================================
-- 既存の値域は ('pending','handled','dismissed')。Phase B の
-- kl__finalize_case は確定した通報を 'upheld' で記録する
-- （reporter_stats.reports_upheld と語を揃える）。'handled' は
-- 従来値として残す。
-- =============================================================================

alter table public.reports drop constraint reports_status_check;
alter table public.reports
  add constraint reports_status_check
  check (status in ('pending', 'handled', 'dismissed', 'upheld'));
