-- 0066: ようこそDMの復旧（回帰の修正）
-- 0018 で handle_new_user に入れた「ようこそDM（kind='welcome')」の
-- 挿入が、0023／0024 の handle_new_user 再定義（表示名まわり）で
-- 落ちてしまい、2026-11-25 以降の新規登録者にようこそDMが
-- 届いていなかった。現行の名前処理はそのままに、DM挿入だけを戻す。
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_name text := left(coalesce(new.raw_user_meta_data ->> 'display_name', ''), 9);
  v_decided timestamptz := null;
begin
  if trim(v_name) = '' then
    v_name := 'ななし';
  else
    v_decided := now();
  end if;
  insert into public.profiles (id, public_id, display_name, name_decided_at)
  values (
    new.id,
    public.generate_public_id(),
    v_name,
    v_decided
  )
  on conflict (id) do nothing;

  insert into public.coin_wallets (user_id, free_balance)
  values (new.id, 100)
  on conflict (user_id) do nothing;

  insert into public.coin_ledger (user_id, delta_free, reason)
  values (new.id, 100, 'welcome');

  -- ようこそDM（システム会話へ1件だけ。チュートリアルへの導線つき）
  insert into public.dm_messages (sender_id, recipient_id, kind, body)
  values (null, new.id, 'welcome',
    'ことば人狼へようこそ！🎉' || chr(10) ||
    '登録ありがとうございます。登録ボーナスとして100コインをプレゼントしました。' || chr(10) ||
    'はじめてルームに入るときに、遊び方とルールのチュートリアルが表示されます。下の「チュートリアルはこちら」からいつでも見返せます。' || chr(10) ||
    'みんなで楽しく遊びましょう！');

  return new;
end;
$function$;
