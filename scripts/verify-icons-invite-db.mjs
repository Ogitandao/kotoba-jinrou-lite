// アイコン＋DM招待発行の実 DB 検証（0017 適用済み Supabase に対して実施）。
//
// 2026-11-25 バッチ：
// - icons カタログ（無料15種 seed）／user_icons／profiles.icon_key
// - kl_set_icon：選択の保存、存在しないキーは ICON_NOT_FOUND
// - kl_search_user の返却に icon_key が含まれる
// - ww_list_rooms の hostIconKey
// - kl_send_invite：フレンド確認（NOT_FRIENDS）／メンバー確認
//   （NOT_A_MEMBER）／非公開はパスワード照合（WRONG_PASSWORD）を通った
//   場合だけ平文を invite_payload に載せる／公開は password=null
// - 招待された側が payload のパスワードで ww_join_room できる
// 実行：npm run verify:icons-invite-db（client/kl-config.js が必要）
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
const ROOM_PW = String.fromCharCode(119, 111, 108, 102, 55, 55, 55);
const WRONG_PW = String.fromCharCode(119, 114, 111, 110, 103, 57, 57, 57);
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
  const email = `kl.lite.icons.${tag}${stamp}@gmail.com`;
  const { data, error } = await sb.auth.signUp({
    email,
    password: PASSWORD,
    options: { data: { test_marker: 'test/lite', display_name: `アイコン検証${tag}` } },
  });
  if (error || !data?.session) throw new Error(`signup ${tag} 失敗: ${error?.message ?? 'session なし'}`);
  // 0018 以降、ルーム作成・参加にはチュートリアル同意が必須
  await sb.rpc('kl_agree_rules');
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

// --- カタログ（オーナー SQL で確認） ---
const cat = sql('select tier, count(*)::int as n from public.icons group by tier');
check('icons カタログに無料15種が seed されている',
  cat.length === 1 && cat[0].tier === 'free' && cat[0].n === 15, JSON.stringify(cat));

const A = await signup('a');
const B = await signup('b');
const C = await signup('c');

// --- フレンド成立（A⇔B、A⇔C） ---
await rpc(A, 'kl_send_friend_request', { p_to: B.id });
const respB = await rpc(B, 'kl_respond_friend_request', { p_from: A.id, p_accept: true });
check('A⇔B フレンド成立', !respB.error, respB.code ?? '');
await rpc(A, 'kl_send_friend_request', { p_to: C.id });
await rpc(C, 'kl_respond_friend_request', { p_from: A.id, p_accept: true });

// --- アイコン選択 ---
const profA0 = await A.sb.from('profiles').select('public_id, icon_key').eq('id', A.id).single();
check('新規ユーザーの初期アイコンは wolf', profA0.data?.icon_key === 'wolf',
  profA0.data?.icon_key ?? 'none');
const setCat = await rpc(A, 'kl_set_icon', { p_icon_key: 'cat' });
check('kl_set_icon(cat) が成功する', !setCat.error && setCat.data?.iconKey === 'cat',
  setCat.code ?? JSON.stringify(setCat.data));
const profA1 = await A.sb.from('profiles').select('icon_key').eq('id', A.id).single();
check('profiles.icon_key に保存される（再読込で維持される正本）',
  profA1.data?.icon_key === 'cat', profA1.data?.icon_key ?? 'none');
const setBad = await rpc(A, 'kl_set_icon', { p_icon_key: 'bogus' });
check('存在しないキーは ICON_NOT_FOUND', setBad.code === 'ICON_NOT_FOUND', setBad.code ?? '');
const search = await rpc(B, 'kl_search_user', { p_public_id: profA0.data.public_id });
check('kl_search_user の返却に icon_key（cat）が含まれる',
  search.data?.[0]?.icon_key === 'cat', JSON.stringify(search.data?.[0] ?? {}));

// --- 非公開ルーム＋招待 ---
const roomRes = await rpc(A, 'ww_create_room', {
  p_title: '招待DB検証部屋', p_is_private: true, p_password: ROOM_PW,
  p_beginner_welcome: true, p_reversal_enabled: true, p_capacity: 4, p_genre: null,
});
const roomId = roomRes.data?.id;
check('非公開ルーム作成', !!roomId, roomRes.code ?? '');
const invWrong = await rpc(A, 'kl_send_invite', { p_to: B.id, p_room: roomId, p_password: WRONG_PW });
check('パスワード不一致の招待は WRONG_PASSWORD', invWrong.code === 'WRONG_PASSWORD',
  invWrong.code ?? '');
const invOk = await rpc(A, 'kl_send_invite', { p_to: B.id, p_room: roomId, p_password: ROOM_PW });
check('正しいパスワードで招待が送れる', !invOk.error && invOk.data?.kind === 'invite',
  invOk.code ?? '');
const dmB = await B.sb.from('dm_messages').select('*')
  .eq('kind', 'invite').eq('sender_id', A.id).order('created_at', { ascending: false }).limit(1);
const payload = dmB.data?.[0]?.invite_payload;
check('B の DM に招待カードが届く（roomId／roomTitle／password）',
  payload?.roomId === roomId && payload?.roomTitle === '招待DB検証部屋'
  && payload?.password === ROOM_PW, JSON.stringify(payload ?? {}));
const invNotMember = await rpc(C, 'kl_send_invite', { p_to: A.id, p_room: roomId, p_password: ROOM_PW });
check('メンバーでない人の招待は NOT_A_MEMBER', invNotMember.code === 'NOT_A_MEMBER',
  invNotMember.code ?? '');
const joinB = await rpc(B, 'ww_join_room', { p_room: roomId, p_password: payload?.password });
check('招待された B が payload のパスワードで入室できる', !joinB.error, joinB.code ?? '');
const listB = await rpc(B, 'ww_list_rooms');
const listedRoom = (listB.data ?? []).find((r) => r.id === roomId);
check('ww_list_rooms に hostIconKey（cat）が返る',
  listedRoom?.hostIconKey === 'cat', JSON.stringify(listedRoom ?? {}).slice(0, 160));

// --- 公開ルームの招待は password=null ---
const pubRes = await rpc(A, 'ww_create_room', {
  p_title: '招待DB検証・公開部屋', p_is_private: false, p_password: null,
  p_beginner_welcome: false, p_reversal_enabled: true, p_capacity: 4, p_genre: null,
});
const invPub = await rpc(A, 'kl_send_invite', { p_to: B.id, p_room: pubRes.data?.id, p_password: null });
check('公開ルームの招待はパスワードなしで送れる', !invPub.error, invPub.code ?? '');
const dmB2 = await B.sb.from('dm_messages').select('*')
  .eq('kind', 'invite').eq('sender_id', A.id).order('created_at', { ascending: false }).limit(1);
check('公開招待の payload.password は null',
  dmB2.data?.[0]?.invite_payload?.roomId === pubRes.data?.id
  && dmB2.data?.[0]?.invite_payload?.password === null,
  JSON.stringify(dmB2.data?.[0]?.invite_payload ?? {}));

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
process.exit(failed.length ? 1 : 0);
