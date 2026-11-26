// ティッカー Realtime 化（0057）の実 DB 検証
// - kl_send_gift / ww__finish のフックが realtime.send に差し替わっている
// - 最高額ギフト送信が成功し、kl_ticker_events には記録されない
// ※ Broadcast の受信そのものは VM から WSS 接続できないため検証不可。
//   実機（おぎの2台）で「ロビーにいる時だけ1回流れる」を確認する
// 実行：node scripts/verify-ticker-db.mjs
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createClient } from '../client/vendor/supabase.js';

const cfg = JSON.parse(
  readFileSync(new URL('../client/kl-config.js', import.meta.url), 'utf8')
    .match(/\{[\s\S]*\}/)[0]);
const URL_ = cfg.supabaseUrl;
const KEY = cfg.supabaseKey;
const REF = 'dtdwkluanoaqiaruzbwe';
const HELPER = '/home/hatch/workspace/custom-connectors/custom.supabase/bin/supabase_api.py';
const pw = String.fromCharCode(76, 105, 116, 101, 45, 65, 117, 50, 48, 50, 54, 33);
const stamp = Date.now();

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};
function sql(q) {
  return JSON.parse(execFileSync('python3', [HELPER, 'query', REF, q],
    { encoding: 'utf8', timeout: 120000 }));
}
const sql1 = (q) => sql(q)[0] ?? {};
const mkClient = () => createClient(URL_, KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

for (const fn of ['kl_send_gift', 'ww__finish']) {
  const def = sql1(`select pg_get_functiondef(oid) as def from pg_proc where proname = '${fn}'`).def ?? '';
  check(`${fn} は Broadcast 送信に差し替え済み`,
    def.includes('realtime.send') && def.includes('kl-ticker') && !def.includes('kl__ticker_post'));
}

async function mkUser(tag) {
  const c = mkClient();
  const email = `kl.lite.ticker.${tag}${stamp}@gmail.com`;
  const { data, error } = await c.auth.signUp({ email, password: pw });
  if (error) throw new Error(`signUp ${tag}: ${error.message}`);
  await c.rpc('kl_set_birthdate', { p_birthdate: '1995-01-01' });
  await c.rpc('kl_agree_rules');
  return { c, id: data.user.id };
}

const a = await mkUser('a');
const b = await mkUser('b');
sql(`insert into public.friendships (user_a, user_b) values (least('${a.id}'::uuid, '${b.id}'::uuid), greatest('${a.id}'::uuid, '${b.id}'::uuid))`);
sql(`update public.coin_wallets set paid_balance = 50000 where user_id = '${b.id}'`);
const before = Number(sql1('select count(*)::int as n from public.kl_ticker_events').n ?? 0);

const { error: giftErr } = await b.c.rpc('kl_send_gift', { p_to: a.id, p_gift_key: 'diamond' });
check('ダイヤモンド送信', !giftErr, giftErr?.message ?? '');
const after = Number(sql1('select count(*)::int as n from public.kl_ticker_events').n ?? 0);
check('kl_ticker_events に貯めない', after === before, `${before} -> ${after}`);

console.log(failures === 0 ? '=== ALL PASS ===' : `=== ${failures} FAILURES ===`);
process.exit(failures === 0 ? 0 : 1);
