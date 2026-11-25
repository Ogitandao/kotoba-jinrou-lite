// グループチャットの実 DB 検証（0036）
// - テストユーザー A/B/C/D を作り、フレンド関係は SQL で用意する
// - 実際の認証セッションで RPC と RLS を叩く（アダプタと同じ経路）
// 実行：node scripts/verify-group-db.mjs（client/kl-config.js が必要）
// 注意：実行のたびにテストユーザーが増える。パスワードは文字コードから組む。
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
const sql = (q) => execFileSync('python3', [HELPER, 'query', REF, q], { encoding: 'utf8' });
const pw = String.fromCharCode(76, 105, 116, 101, 45, 71, 114, 112, 45, 50, 48, 50, 54, 33); // Lite-Grp-2026!
const stamp = Date.now();

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

async function makeUser(tag, displayName) {
  const email = `kl.lite.grp.${tag}.${stamp}@gmail.com`;
  const anon = createClient(URL_, KEY);
  const { data, error } = await anon.auth.signUp({ email, password: pw });
  if (error || !data?.user) throw new Error(`signUp ${tag}: ${error?.message}`);
  const id = data.user.id;
  sql(`update public.profiles set display_name = '${displayName}' where id = '${id}'`);
  const client = createClient(URL_, KEY);
  const { error: e2 } = await client.auth.signInWithPassword({ email, password: pw });
  if (e2) throw new Error(`signIn ${tag}: ${e2.message}`);
  return { id, client };
}

const A = await makeUser('a', '検証A');
const B = await makeUser('b', '検証B');
const C = await makeUser('c', '検証C');
const D = await makeUser('d', '検証D');
check('テストユーザーA〜Dを作成', true);

// A-B、A-C、B-C をフレンドに（D は誰ともフレンドでない）
// friendships は ordered pair 制約があるため小さい方を user_a にする
for (const [x, y] of [[A, B], [A, C], [B, C]]) {
  const [a, b] = x.id < y.id ? [x.id, y.id] : [y.id, x.id];
  sql(`insert into public.friendships (user_a, user_b) values ('${a}', '${b}')`);
}

// 1) フレンドでない D を入れた作成は NOT_FRIENDS
{
  const { error } = await A.client.rpc('kl_create_group', { p_name: 'x', p_member_ids: [D.id] });
  check('非フレンド混在の作成は NOT_FRIENDS', !!error && error.message.includes('NOT_FRIENDS'), error?.message ?? '');
}

// 2) メンバー0人は GROUP_NO_MEMBERS
{
  const { error } = await A.client.rpc('kl_create_group', { p_name: 'x', p_member_ids: [] });
  check('メンバー0人の作成は GROUP_NO_MEMBERS', !!error && error.message.includes('GROUP_NO_MEMBERS'), error?.message ?? '');
}

// 3) 名前なしで作成 → 自動名（自分＋メンバー）
let groupId = null;
{
  const { data, error } = await A.client.rpc('kl_create_group', { p_name: '', p_member_ids: [B.id] });
  check('グループを作成できる', !error && !!data?.id, error?.message ?? '');
  groupId = data?.id;
  check('自動名は「検証A、検証B」', data?.name === '検証A、検証B', data?.name ?? '');
  check('memberIds は2人', Array.isArray(data?.memberIds) && data.memberIds.length === 2);
}

// 4) 作成時のシステムメッセージが流れている（B からも見える）
{
  const { data } = await B.client.from('kl_group_messages').select('*').eq('group_id', groupId);
  check('B からシステム通知が見える',
    data?.length === 1 && data[0].kind === 'system' && data[0].body === 'グループが作成されました',
    JSON.stringify(data?.map((m) => m.kind)));
}

// 5) A が発言 → B の未読が1（システム通知は数えない）
{
  const { error } = await A.client.rpc('kl_send_group_message', { p_group: groupId, p_body: 'こんにちは' });
  check('A が発言できる', !error, error?.message ?? '');
  const { data: rows } = await B.client.from('kl_group_members')
    .select('last_read_at, joined_at').eq('group_id', groupId).eq('user_id', B.id).single();
  const since = rows.last_read_at ?? rows.joined_at;
  const { data: msgs } = await B.client.from('kl_group_messages')
    .select('*').eq('group_id', groupId).gt('created_at', since)
    .not('sender_id', 'is', null).neq('sender_id', B.id);
  check('B の未読は1件', msgs?.length === 1, `count=${msgs?.length}`);
}

// 6) B が既読化 → 未読0。B も発言できる
{
  const { error } = await B.client.rpc('kl_mark_group_read', { p_group: groupId });
  check('B が既読化できる', !error, error?.message ?? '');
  const { error: e2 } = await B.client.rpc('kl_send_group_message', { p_group: groupId, p_body: 'やあ' });
  check('B が発言できる', !e2, e2?.message ?? '');
}

// 7) URL は URL_NOT_ALLOWED
{
  const { error } = await A.client.rpc('kl_send_group_message', { p_group: groupId, p_body: 'https://example.com 見て' });
  check('URL は送信できない', !!error && error.message.includes('URL_NOT_ALLOWED'), error?.message ?? '');
}

// 8) 非メンバーの C は読めない・書けない
{
  const { data } = await C.client.from('kl_group_messages').select('*').eq('group_id', groupId);
  check('非メンバーは発言を読めない（RLS）', (data?.length ?? -1) === 0, `rows=${data?.length}`);
  const { error } = await C.client.rpc('kl_send_group_message', { p_group: groupId, p_body: 'まぜて' });
  check('非メンバーの発言は NOT_MEMBER', !!error && error.message.includes('NOT_MEMBER'), error?.message ?? '');
}

// 9) A が C を追加 → 参加システム通知＋3人になる
{
  const { data, error } = await A.client.rpc('kl_add_group_members', { p_group: groupId, p_member_ids: [C.id] });
  check('C を追加できる', !error && data?.memberIds?.length === 3, error?.message ?? '');
  const { data: msgs } = await A.client.from('kl_group_messages')
    .select('*').eq('group_id', groupId).eq('kind', 'system').order('created_at');
  check('参加通知が流れる', msgs?.some((m) => m.body === '検証Cさんが参加しました'),
    JSON.stringify(msgs?.map((m) => m.body)));
}

// 10) B が名前を変更できる
{
  const { data, error } = await B.client.rpc('kl_rename_group', { p_group: groupId, p_name: '検証グループ改' });
  check('メンバーなら改名できる', !error && data?.name === '検証グループ改', error?.message ?? '');
}

// 11) C が脱退 → 2人に戻り、C からは読めなくなる
{
  const { error } = await C.client.rpc('kl_leave_group', { p_group: groupId });
  check('C が脱退できる', !error, error?.message ?? '');
  const { data: view } = await A.client.rpc('kl_rename_group', { p_group: groupId, p_name: '検証グループ改' });
  check('脱退後は2人', view?.memberIds?.length === 2, `n=${view?.memberIds?.length}`);
  const { data } = await C.client.from('kl_group_messages').select('*').eq('group_id', groupId);
  check('脱退後は発言を読めない', (data?.length ?? -1) === 0, `rows=${data?.length}`);
}

console.log(failures === 0 ? '=== ALL PASS ===' : `=== ${failures} FAILURES ===`);
process.exit(failures === 0 ? 0 : 1);
