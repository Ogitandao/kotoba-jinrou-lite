// 実セッション E2E 検証：
// 通常サインアップ（mailer_autoconfirm=true 前提）で実 JWT を取得し、
// そのセッションで REST/RPC を実利用する。
//   Part 1: サインアップ→即セッション、プロフィール自動作成、財布
//   Part 2: 公開ID検索・フレンド申請/承認・DM・ログインボーナス・
//           ギフト・台帳整合（全て実 JWT 経由）
//   Part 3: クライアントのデータアダプタ（SupabaseBackend）を実
//           セッションのクライアントで駆動し、実データが引けるか
// 実行：npm run verify:e2e-session（client/kl-config.js が必要）
// 注意：実行のたびにテストユーザー2名が増える（test_marker 付き）。
import { readFileSync } from 'node:fs';
import { createClient } from '../client/vendor/supabase.js';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const cfgText = readFileSync(new URL('../client/kl-config.js', import.meta.url), 'utf8');
const cfg = JSON.parse(cfgText.match(/\{[\s\S]*\}/)[0]);
const URL_ = cfg.supabaseUrl;
const KEY = cfg.supabaseKey;
const PASSWORD = 'Lite-E2E-2026-Pass!';
const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
const mkClient = () => createClient(URL_, KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const rpcErr = (error) => {
  const m = /([A-Z_]+):/.exec(error?.message ?? '');
  return m ? m[1] : (error?.message ?? 'unknown');
};

// ---------- Part 1: サインアップと即セッション ----------
async function signup(tag, displayName) {
  const sb = mkClient();
  const email = `kl.lite.e2e.${tag}${stamp}@gmail.com`;
  const { data, error } = await sb.auth.signUp({
    email,
    password: PASSWORD,
    options: { data: { test_marker: 'test/lite', display_name: displayName } },
  });
  if (data?.session) {
    await sb.rpc('kl_agree_rules');
    await sb.rpc('kl_set_birthdate', { p_birthdate: '1995-01-01' });
  }
  return { sb, email, data, error };
}

const F = await signup('f', 'E2Eフレンド1');
check('F: サインアップがエラーなく返る', !F.error, F.error?.message ?? '');
check('F: 確認メールなしで即セッション（実JWT）が返る',
  Boolean(F.data?.session?.access_token),
  F.data?.session ? 'access_token あり' : 'session=null（autoconfirm 未適用の疑い）');
check('F: test_marker がメタデータに入っている',
  F.data?.user?.user_metadata?.test_marker === 'test/lite');

const G = await signup('g', 'E2Eフレンド2');
check('G: サインアップ＋即セッション', !G.error && Boolean(G.data?.session?.access_token),
  G.error?.message ?? '');

const fId = F.data.user.id;
const gId = G.data.user.id;
// プロフィール作成トリガは同期だが、念のため少し待つ
await new Promise((r) => setTimeout(r, 500));

const { data: fProfile, error: fProfErr } = await F.sb
  .from('profiles').select('*').eq('id', fId).single();
check('F: プロフィールが自動作成され REST で読める', !fProfErr && Boolean(fProfile?.public_id),
  fProfErr?.message ?? `公開ID=${fProfile?.public_id}`);
check('F: display_name がメタデータから反映された',
  fProfile?.display_name === 'E2Eフレンド1', fProfile?.display_name ?? '');
const { data: gProfile } = await G.sb
  .from('profiles').select('*').eq('id', gId).single();
check('G: プロフィール自動作成＋公開ID付与', Boolean(gProfile?.public_id), gProfile?.public_id ?? '');

const { data: fWallet } = await F.sb
  .from('coin_wallets').select('*').eq('user_id', fId).single();
check('F: 財布が無料100／課金0で作られた',
  fWallet?.free_balance === 100 && fWallet?.paid_balance === 0,
  `free=${fWallet?.free_balance} paid=${fWallet?.paid_balance}`);

// ---------- Part 2: 実 JWT でのソーシャル実利用 ----------
const A_PUBLIC_ID = 'GUV6JSL3'; // 既存テストA（SQL作成、handover 参照）
const { data: searchA, error: searchAErr } = await F.sb.rpc('kl_search_user', { p_public_id: A_PUBLIC_ID });
check('F: 公開ID検索で既存テストAが見つかる（relation=none）',
  !searchAErr && searchA?.[0]?.public_id === A_PUBLIC_ID && searchA?.[0]?.relation === 'none',
  searchAErr?.message ?? JSON.stringify(searchA?.[0] ?? null));
const aId = searchA?.[0]?.id;

const { data: reqA, error: reqAErr } = await F.sb.rpc('kl_send_friend_request', { p_to: aId });
check('F: 既存テストAへフレンド申請できる', !reqAErr && reqA === 'requested',
  reqAErr ? rpcErr(reqAErr) : String(reqA));

const { data: reqG, error: reqGErr } = await F.sb.rpc('kl_send_friend_request', { p_to: gId });
check('F: Gへフレンド申請できる', !reqGErr && reqG === 'requested',
  reqGErr ? rpcErr(reqGErr) : String(reqG));

const { error: dmEarlyErr } = await F.sb.rpc('kl_send_dm', { p_to: gId, p_body: '早すぎるDM' });
check('F: 承認前のDMは NOT_FRIENDS で拒否される',
  rpcErr(dmEarlyErr) === 'NOT_FRIENDS', dmEarlyErr ? rpcErr(dmEarlyErr) : '送信できてしまった');

const { data: respG, error: respGErr } = await G.sb.rpc('kl_respond_friend_request', { p_from: fId, p_accept: true });
check('G: 実JWTで申請を承認できる', !respGErr && respG === 'accepted',
  respGErr ? rpcErr(respGErr) : String(respG));

const { data: fFriends } = await F.sb.from('friendships').select('user_a, user_b');
check('F: フレンドシップが REST で確認できる',
  (fFriends ?? []).some((r) => r.user_a === gId || r.user_b === gId),
  `${(fFriends ?? []).length}件`);

const DM_BODY = 'E2E実セッションDMテスト';
const { data: dmRow, error: dmErr } = await F.sb.rpc('kl_send_dm', { p_to: gId, p_body: DM_BODY });
check('F: フレンド成立後にDMを送信できる', !dmErr && dmRow?.body === DM_BODY,
  dmErr ? rpcErr(dmErr) : dmRow?.id ?? '');

const { data: gInbox } = await G.sb
  .from('dm_messages').select('*').eq('sender_id', fId).eq('recipient_id', gId);
check('G: 受信DMが未読（read_at=null）で見える',
  (gInbox ?? []).some((m) => m.body === DM_BODY && m.read_at === null),
  `${(gInbox ?? []).length}件`);

const { data: readCount, error: readErr } = await G.sb.rpc('kl_mark_dm_read', { p_other: fId });
check('G: 既読化できる', !readErr && Number(readCount) >= 1,
  readErr ? rpcErr(readErr) : `既読化 ${readCount}件`);
const { data: fView } = await F.sb
  .from('dm_messages').select('read_at').eq('id', dmRow.id).single();
check('F: 相手の既読が反映される', Boolean(fView?.read_at));

const { data: bonus1, error: bonusErr } = await F.sb.rpc('kl_claim_login_bonus');
check('F: ログインボーナスを受け取れる（+10）',
  !bonusErr && bonus1?.claimed === true && bonus1?.amount === 10 && bonus1?.freeBalance === 160,
  bonusErr ? rpcErr(bonusErr) : JSON.stringify(bonus1));
const { data: bonus2 } = await F.sb.rpc('kl_claim_login_bonus');
check('F: 同日の二重受取は claimed=false', bonus2?.claimed === false);

const { data: giftRes, error: giftErr } = await F.sb.rpc('kl_send_gift', { p_to: gId, p_gift_key: 'heart' });
check('F: ギフト heart(30) を送信でき無料残高が130になる',
  !giftErr && giftRes?.freeBalance === 130,
  giftErr ? rpcErr(giftErr) : JSON.stringify(giftRes));
const { data: gProfileAfter } = await F.sb
  .from('profiles').select('popularity').eq('id', gId).single();
check('G: 人気度が +30 された', gProfileAfter?.popularity === 30,
  `popularity=${gProfileAfter?.popularity}`);

const { data: fLedger } = await F.sb
  .from('coin_ledger').select('delta_free, delta_paid, reason').eq('user_id', fId);
const sumFree = (fLedger ?? []).reduce((s, r) => s + r.delta_free, 0);
const sumPaid = (fLedger ?? []).reduce((s, r) => s + r.delta_paid, 0);
const { data: fWalletAfter } = await F.sb
  .from('coin_wallets').select('*').eq('user_id', fId).single();
check('F: 台帳合計と財布残高が一致する（REST・実JWT）',
  sumFree === fWalletAfter?.free_balance && sumPaid === fWalletAfter?.paid_balance,
  `台帳 free=${sumFree} paid=${sumPaid} / 財布 free=${fWalletAfter?.free_balance} paid=${fWalletAfter?.paid_balance}`);

// ---------- Part 3: データアダプタ（SupabaseBackend）の実データ確認 ----------
// data-adapter.js は window を参照する IIFE。Node では最小の window を
// 用意し、window.supabase.createClient が「F の実セッションを持つ
// クライアント」を返すよう差し込む（index.html の module 橋渡し相当）。
const fakeWindow = {
  KL_CONFIG: { supabaseUrl: URL_, supabaseKey: KEY },
  supabase: { createClient: () => F.sb },
};
new Function('window', readFileSync(new URL('../client/js/dummy-data.js', import.meta.url), 'utf8'))(fakeWindow);
new Function('window', readFileSync(new URL('../client/js/data-adapter.js', import.meta.url), 'utf8'))(fakeWindow);
const KL = fakeWindow.KL_DATA;
const boot = await KL.bootstrap();
check('アダプタ: Supabase モードで bootstrap できる', KL.mode === 'supabase', `mode=${KL.mode}`);
check('アダプタ: 自プロフィールが実データ（公開ID・残高130）',
  boot?.me?.publicId === fProfile?.public_id && boot?.me?.coins === 130,
  `publicId=${boot?.me?.publicId} coins=${boot?.me?.coins}`);
const adapterFriends = await KL.listFriends();
check('アダプタ: フレンド一覧に G がいる',
  (adapterFriends ?? []).some((u) => u.id === gId), `${(adapterFriends ?? []).length}人`);
const adapterSearchA = await KL.searchUser(A_PUBLIC_ID);
check('アダプタ: A の検索結果が requested_out になる',
  adapterSearchA?.relation === 'requested_out', adapterSearchA?.relation ?? 'null');
const adapterMsgs = await KL.listMessages(gId);
check('アダプタ: DM履歴に送信メッセージが含まれる',
  (adapterMsgs ?? []).some((m) => m.body === DM_BODY), `${(adapterMsgs ?? []).length}件`);
const adapterCatalog = await KL.giftCatalog();
check('アダプタ: ギフトカタログが実DBから11種返る',
  (adapterCatalog ?? []).length === 11, `${(adapterCatalog ?? []).length}種`);

console.log(`\nテストユーザー: F=${F.email} (id=${fId}, 公開ID=${fProfile?.public_id}) / G=${G.email} (id=${gId}, 公開ID=${gProfile?.public_id})`);
const failed = results.filter((r) => !r.ok).length;
console.log(`=== ${results.length - failed}/${results.length} PASS ===`);
process.exit(failed ? 1 : 0);
