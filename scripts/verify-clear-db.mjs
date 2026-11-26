// トーク削除（0053）の実 DB 検証
// - kl_clear_conversation が clears 行を記録し、再削除で時刻が更新される
// - 空キーは BAD_KEY
// - 0052 の送信取消 RPC（kl_delete_dm_message）が撤去されている
// ※ 一覧からの除外そのものはクライアント側の絞り込みで担保し、
//    意味論は verify-social（sim）と verify-social-ui で確認する
// 実行：node scripts/verify-clear-db.mjs
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
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const mkClient = () => createClient(URL_, KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const rpcErr = (error) => {
  const m = /([A-Z_]+):/.exec(error?.message ?? '');
  return m ? m[1] : (error?.message ?? 'unknown');
};
async function rpc(client, fn, args) {
  let last;
  for (let i = 0; i < 6; i++) {
    try { last = await client.rpc(fn, args); } catch (e) { last = { data: null, error: e }; }
    if (!last.error || !/fetch failed/i.test(last.error.message ?? '')) break;
    await sleepMs(1000 * (i + 1));
  }
  return { data: last.data, error: last.error, code: last.error ? rpcErr(last.error) : null };
}
async function signup(tag) {
  const sb = mkClient();
  const { data, error } = await sb.auth.signUp({
    email: `kl.lite.clear.${tag}${stamp}@gmail.com`, password: pw,
    options: { data: { test_marker: 'test/lite', display_name: `削除検証${tag}` } },
  });
  if (error || !data?.session) throw new Error(`signup ${tag}: ${error?.message ?? 'session なし'}`);
  await sleepMs(300);
  await rpc(sb, 'kl_set_birthdate', { p_birthdate: '1995-01-01' });
  await rpc(sb, 'kl_agree_rules', {});
  return { sb, id: data.user.id };
}

const A = await signup('a');
const B = await signup('b');
await rpc(A.sb, 'kl_send_friend_request', { p_to: B.id });
await rpc(B.sb, 'kl_respond_friend_request', { p_from: A.id, p_accept: true });
const sent = await rpc(A.sb, 'kl_send_dm', { p_to: B.id, p_body: 'トーク削除テスト' });
check('DM送信できる', !sent.error, sent.error?.message ?? '');

const clear1 = await rpc(A.sb, 'kl_clear_conversation', { p_key: B.id });
check('トーク削除を記録できる', !clear1.error, clear1.error?.message ?? '');
const row1 = sql1(`select cleared_at from public.kl_conversation_clears where user_id = '${A.id}' and conv_key = '${B.id}'`);
check('clears 行が自分の分だけ立つ（相手には無い）',
  !!row1.cleared_at
  && sql(`select 1 as x from public.kl_conversation_clears where user_id = '${B.id}' and conv_key = '${A.id}'`).length === 0);

await sleepMs(1100);
const clear2 = await rpc(A.sb, 'kl_clear_conversation', { p_key: B.id });
const row2 = sql1(`select cleared_at from public.kl_conversation_clears where user_id = '${A.id}' and conv_key = '${B.id}'`);
check('再削除で cleared_at が更新される', !clear2.error && row2.cleared_at > row1.cleared_at);

const bad = await rpc(A.sb, 'kl_clear_conversation', { p_key: '' });
check('空キーは BAD_KEY', bad.code === 'BAD_KEY', bad.code ?? '');

const grp = await rpc(A.sb, 'kl_create_group', { p_name: '削除検証', p_member_ids: [B.id] });
const gClear = await rpc(A.sb, 'kl_clear_conversation', { p_key: grp.data.id });
const grow = sql1(`select cleared_at from public.kl_conversation_clears where user_id = '${A.id}' and conv_key = '${grp.data.id}'`);
check('グループのトーク削除も同じ仕組みで記録できる', !gClear.error && !!grow.cleared_at);

const gone = await rpc(A.sb, 'kl_delete_dm_message', { p_id: sent.data.id });
check('0052 の送信取消 RPC は撤去済み', !!gone.error);

console.log(`\n=== ${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} ===`);
process.exit(failures === 0 ? 0 : 1);
