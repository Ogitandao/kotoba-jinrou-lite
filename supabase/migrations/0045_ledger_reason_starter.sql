-- 0045: coin_ledger.reason の CHECK に 'starter_login' を追加
-- （0044 の kl_claim_login_bonus が starter 分を記録する際に必要。
-- 実DBスモークテストで 23514 を検出）

alter table public.coin_ledger
  drop constraint coin_ledger_reason_check;
alter table public.coin_ledger
  add constraint coin_ledger_reason_check
  check (reason = any (array[
    'welcome', 'daily_login', 'starter_login', 'purchase',
    'gift_sent', 'private_room', 'icon_purchase', 'refund'
  ]));
