// メッセージ削除（0052）の実 DB 検証
// - 自分の DM は削除でき、deleted_at が立つ（本文は証跡として残る）
// - 相手の DM は NOT_OWN_MESSAGE、ギフトは NOT_DELETABLE、再削除は冪等
// - グループメッセージも同じ規則
// 実行：node scripts/verify-msgdelete-db.mjs
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
    email: `kl.lite.msgdel.${tag}${stamp}@gmail.com`, password: pw,
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
const acc = await rpc(B.sb, 'kl_respond_friend_request', { p_from: A.id, p_accept: true });
check('フレンド成立', !acc.error, acc.error?.message ?? '');

// --- DM ---
const sent = await rpc(A.sb, 'kl_send_dm', { p_to: B.id, p_body: '消すテスト' });
check('DM送信できる', !sent.error && !!sent.data?.id, sent.error?.message ?? '');
const mid = sent.data.id;
const notOwn = await rpc(B.sb, 'kl_delete_dm_message', { p_id: mid });
check('相手は消せない（NOT_OWN_MESSAGE）', notOwn.code === 'NOT_OWN_MESSAGE', notOwn.code ?? '');
const del = await rpc(A.sb, 'kl_delete_dm_message', { p_id: mid });
check('自分のDMを削除できる', !del.error, del.error?.message ?? '');
const row = sql1(`select (deleted_at is not null) as deleted, (body is not null) as body_kept from public.dm_messages where id = '${mid}'`);
check('deleted_at が立ち、本文は証跡として残る', row.deleted === true && row.body_kept === true);
const again = await rpc(A.sb, 'kl_delete_dm_message', { p_id: mid });
check('再削除は冪等（エラーなし）', !again.error, again.error?.message ?? '');

// --- ギフトは削除不可 ---
const gift = await rpc(A.sb, 'kl_send_gift', { p_to: B.id, p_gift_key: 'heart' });
check('ギフト送信できる', !gift.error, gift.error?.message ?? '');
const giftMsg = sql1(`select id from public.dm_messages where sender_id = '${A.id}' and recipient_id = '${B.id}' and kind = 'gift' order by created_at desc limit 1`);
const gDel = await rpc(A.sb, 'kl_delete_dm_message', { p_id: giftMsg.id });
check('ギフトメッセージは NOT_DELETABLE', gDel.code === 'NOT_DELETABLE', gDel.code ?? '');

// --- グループ ---
const grp = await rpc(A.sb, 'kl_create_group', { p_name: '削除検証', p_member_ids: [B.id] });
check('グループ作成できる', !grp.error && !!grp.data?.id, grp.error?.message ?? '');
const gm = await rpc(A.sb, 'kl_send_group_message', { p_group: grp.data.id, p_body: 'グループ消すテスト' });
check('グループ発言できる', !gm.error && !!gm.data?.id, gm.error?.message ?? '');
const gNotOwn = await rpc(B.sb, 'kl_delete_group_message', { p_id: gm.data.id });
check('グループ：相手は消せない', gNotOwn.code === 'NOT_OWN_MESSAGE', gNotOwn.code ?? '');
const gDel2 = await rpc(A.sb, 'kl_delete_group_message', { p_id: gm.data.id });
check('グループ：自分の発言を削除できる', !gDel2.error, gDel2.error?.message ?? '');
const grow = sql1(`select (deleted_at is not null) as deleted from public.kl_group_messages where id = '${gm.data.id}'`);
check('グループ：deleted_at が立つ', grow.deleted === true);

console.log(`\n=== ${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} ===`);
process.exit(failures === 0 ? 0 : 1);
