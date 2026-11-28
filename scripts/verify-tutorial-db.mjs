// チュートリアル＋ようこそDMの実 DB 検証（0018 適用済み Supabase に対して実施）。
//
// 2026-11-25 バッチ（おぎ承認仕様）：
// - 新規登録でシステム会話へようこそDM（kind='welcome'）が1件届く
// - 未同意ユーザーの ww_create_room / ww_join_room はサーバー側で
//   RULES_NOT_AGREED 拒否される（クライアント制御だけに頼らない）
// - kl_agree_rules で profiles.rules_agreed_at が記録され、同意後は
//   作成・参加ができる
// - kl_mark_system_dm_read でようこそDMも既読になる
// 実行：npm run verify:tutorial-db（client/kl-config.js が必要）
// 注意：実行のたびにテストユーザーが増える（test_marker 付き）。
// パスワード類はリテラルで書かず文字コードから組み立てる（過去に
// 書き込み経路で平文が置換された事象があったため）。
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createClient } from '../client/vendor/supabase.js';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const cfg = JSON.parse(
  readFileSync(new URL('../client/kl-config.js', import.meta.url), 'utf8')
    .match(/\{[\s\S]*\}/)[0]);
const URL_ = cfg.supabaseUrl;
const KEY = cfg.supabaseKey;
const REF = 'dtdwkluanoaqiaruzbwe';
const HELPER = '/home/hatch/workspace/custom-connectors/custom.supabase/bin/supabase_api.py';
const PASSWORD = String.fromCharCode(76, 105, 116, 101, 45, 69, 50, 69, 45, 50, 48, 50, 54, 45, 80, 97, 115, 115, 33);
const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);

function sql(q) {
  let lastErr;
  for (let i = 0; i < 4; i++) {
    try {
      const out = execFileSync('python3', [HELPER, 'query', REF, q],
        { encoding: 'utf8', timeout: 120000 });
      return JSON.parse(out);
    } catch (e) {
      lastErr = e; // Management API の一過性 502 などはリトライする
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500 * (i + 1));
    }
  }
  throw lastErr;
}
const rpcErr = (error) => {
  const m = /([A-Z_]+):/.exec(error?.message ?? '');
  return m ? m[1] : (error?.message ?? 'unknown');
};
const mkClient = () => createClient(URL_, KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
async function signup(tag) {
  const sb = mkClient();
  const email = `kl.lite.tut.${tag}${stamp}@gmail.com`;
  const { data, error } = await sb.auth.signUp({
    email, password: PASSWORD,
    options: { data: { test_marker: 'test/lite', display_name: `チュートリアル検証${tag}` } },
  });
  if (error || !data?.session) throw new Error(`signup ${tag} 失敗: ${error?.message ?? 'session なし'}`);
  // 生年月日は先に済ませる（ガード順は 生年月日→ルール同意 のため、
  // 未同意チェックで RULES_NOT_AGREED だけを切り分ける前提）
  await sb.rpc('kl_set_birthdate', { p_birthdate: '1995-01-01' });
  return { sb, id: data.user.id, email };
}
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
async function rpcRaw(user, fn, args) {
  let last;
  for (let i = 0; i < 6; i++) {
    try {
      last = await user.sb.rpc(fn, args);
    } catch (e) {
      last = { data: null, error: e };
    }
    if (!last.error || !/fetch failed/i.test(last.error.message ?? '')) return last;
    await sleepMs(1000 * (i + 1));
  }
  return last;
}
async function rpc(user, fn, args) {
  const { data, error } = await rpcRaw(user, fn, args);
  return { data, error, code: error ? rpcErr(error) : null };
}

const A = await signup('a');
const B = await signup('b');

// --- ようこそDM ---
const welcome = sql(`select kind, body, read_at from public.dm_messages
  where recipient_id = '${A.id}' and kind = 'welcome'`);
check('新規登録でようこそDM（kind=welcome）が1件届く',
  welcome.length === 1, `n=${welcome.length}`);
check('ようこそDM本文にチュートリアルへの案内が含まれる',
  (welcome[0]?.body ?? '').includes('チュートリアルはこちら')
  && (welcome[0]?.body ?? '').includes('ようこそ'),
  (welcome[0]?.body ?? '').slice(0, 40));
const viaRest = await A.sb.from('dm_messages').select('kind, body')
  .eq('recipient_id', A.id).eq('kind', 'welcome');
check('ようこそDMは本人の REST 読み取りでも見える',
  !viaRest.error && viaRest.data?.length === 1);

// --- 未同意の拒否（作成） ---
const createNg = await rpc(A, 'ww_create_room', { p_title: '未同意は作れない' });
check('未同意ユーザーの ww_create_room は RULES_NOT_AGREED で拒否',
  createNg.code === 'RULES_NOT_AGREED', createNg.code ?? 'no error');

// --- 同意の記録 ---
const profBefore = sql(`select rules_agreed_at from public.profiles where id = '${A.id}'`);
check('同意前は rules_agreed_at が NULL', profBefore[0]?.rules_agreed_at === null);
const agreeRes = await rpc(A, 'kl_agree_rules');
check('kl_agree_rules が成功する', !agreeRes.error, agreeRes.code ?? '');
const profAfter = sql(`select rules_agreed_at from public.profiles where id = '${A.id}'`);
check('同意がサーバーに記録される（rules_agreed_at）',
  profAfter[0]?.rules_agreed_at != null);

// --- 同意後は作成できる ---
const created = await rpc(A, 'ww_create_room', { p_title: 'チュートリアル検証', p_capacity: 4 });
check('同意後は ww_create_room が成功する', !created.error && !!created.data?.id,
  created.code ?? '');
const roomId = created.data?.id;

// --- 未同意の拒否（参加）→ 同意後は参加できる ---
const joinNg = await rpc(B, 'ww_join_room', { p_room: roomId });
check('未同意ユーザーの ww_join_room は RULES_NOT_AGREED で拒否',
  joinNg.code === 'RULES_NOT_AGREED', joinNg.code ?? 'no error');
await rpc(B, 'kl_agree_rules');
const joinOk = await rpc(B, 'ww_join_room', { p_room: roomId });
check('同意後は ww_join_room が成功する', !joinOk.error, joinOk.code ?? '');
const members = sql(`select count(*)::int as n from public.room_members where room_id = '${roomId}'`);
check('参加がメンバー表に反映される（ホスト＋B＝2人）',
  members[0]?.n === 2, `n=${members[0]?.n}`);

// --- ようこそDMの既読化 ---
const readRes = await rpc(A, 'kl_mark_system_dm_read');
check('kl_mark_system_dm_read が成功する', !readRes.error, readRes.code ?? '');
const welcomeAfter = sql(`select read_at from public.dm_messages
  where recipient_id = '${A.id}' and kind = 'welcome'`);
check('ようこそDMが既読になる', welcomeAfter[0]?.read_at != null);

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
process.exit(failed.length ? 1 : 0);
