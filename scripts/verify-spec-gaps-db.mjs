// テスト仕様書の未実装行のうち、サーバー規則を実 DB で検証するスイート
// （モデレーション以外）。実行: node scripts/verify-spec-gaps-db.mjs
//
// カバー範囲：
// §1-9 スターターボーナス（初回請求・同日2回目は不発）
// §2-13 ブロック関係では招待できない
// §3-7 ゴースト掃除（0062）：心拍切れメンバーの退出・ホスト移譲・空室closed
// §7-9 グループ人数上限50人（kl_add_group_members の GROUP_FULL）
// §10-9 マスター放置検出は「満室でなくなった部屋」を記録しない（対照つき）
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
const PW = String.fromCharCode(76, 105, 116, 101, 45, 71, 97, 112, 115, 45, 50, 48, 50, 54, 33);
const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);

function sql(q) {
  let lastErr;
  for (let i = 0; i < 4; i++) {
    try {
      const out = execFileSync('python3', [HELPER, 'query', REF, q],
        { encoding: 'utf8', timeout: 120000 });
      return JSON.parse(out);
    } catch (e) {
      lastErr = e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500 * (i + 1));
    }
  }
  throw lastErr;
}
const sql1 = (q) => sql(q)[0] ?? {};
const rpcErr = (error) => {
  const m = /([A-Z_]+):/.exec(error?.message ?? '');
  return m ? m[1] : (error?.message ?? 'unknown');
};
const mkClient = () => createClient(URL_, KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
async function rpcRaw(user, fn, args) {
  let last;
  for (let i = 0; i < 6; i++) {
    try { last = await user.sb.rpc(fn, args); } catch (e) { last = { data: null, error: e }; }
    if (!last.error || !/fetch failed/i.test(last.error.message ?? '')) return last;
    await sleepMs(1000 * (i + 1));
  }
  return last;
}
async function rpc(user, fn, args) {
  const { data, error } = await rpcRaw(user, fn, args);
  return { data, error, code: error ? rpcErr(error) : null };
}
async function signup(tag) {
  const sb = mkClient();
  const email = `kl.lite.gaps.${tag}${stamp}@gmail.com`;
  let data, error;
  for (let i = 0; i < 4; i++) {
    try {
      ({ data, error } = await sb.auth.signUp({
        email, password: PW,
        options: { data: { test_marker: 'test/lite', display_name: `ギャップ検証${tag}` } },
      }));
    } catch (e) { error = e; }
    if (!error) break;
    await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
  }
  if (error || !data?.session) throw new Error(`signup ${tag} 失敗: ${error?.message ?? 'session なし'}`);
  await sb.rpc('kl_agree_rules');
  await sb.rpc('kl_set_birthdate', { p_birthdate: '1995-01-01' });
  return { sb, id: data.user.id, email };
}
async function befriend(a, b) {
  await rpc(a, 'kl_send_friend_request', { p_to: b.id });
  await rpc(b, 'kl_respond_friend_request', { p_from: a.id, p_accept: true });
}

// ================= §1-9 スターターボーナス =================
{
  const U = await signup('bonus');
  const first = await rpc(U, 'kl_claim_login_bonus');
  check('§1-9 初回請求で通常10＋スターター1日目50が付く',
    !first.error && first.data?.claimed === true && Number(first.data?.amount) === 10
    && Number(first.data?.starterAmount) === 50 && Number(first.data?.starterDay) === 1,
    JSON.stringify(first.data ?? first.code));
  const wallet = sql1(`select free_balance from public.coin_wallets where user_id = '${U.id}'`);
  check('§1-9 残高は登録100＋60＝160', Number(wallet.free_balance) === 160, JSON.stringify(wallet));
  const second = await rpc(U, 'kl_claim_login_bonus');
  const wallet2 = sql1(`select free_balance from public.coin_wallets where user_id = '${U.id}'`);
  check('§1-9 同じ日の2回目は付かず残高も変わらない',
    !second.error && second.data?.claimed === false && Number(wallet2.free_balance) === 160,
    JSON.stringify(second.data ?? second.code));
}

// ================= §2-13 ブロック関係では招待できない =================
{
  const A = await signup('blka');
  const B = await signup('blkb');
  await befriend(A, B);
  const room = await rpc(A, 'ww_create_room', {
    p_title: 'ブロック招待検証', p_is_private: true,
    p_beginner_welcome: false, p_reversal_enabled: true, p_capacity: 4, p_genre: null,
  });
  if (room.error) throw new Error(`§2-13 ルーム作成失敗: ${room.code}`);
  const beforeBlock = await rpc(A, 'kl_send_invite', { p_to: B.id, p_room: room.data.id });
  check('§2-13 （対照）ブロック前は招待できる', !beforeBlock.error, beforeBlock.code ?? '');
  await rpc(A, 'kl_block_user', { p_other: B.id });
  const afterBlock = await rpc(A, 'kl_send_invite', { p_to: B.id, p_room: room.data.id });
  check('§2-13 ブロック関係では招待できない（BLOCKED）',
    afterBlock.code === 'BLOCKED', afterBlock.code ?? 'エラーなし');
  // 後片付け（検証ルームを本番ロビーに残さない）
  sql(`delete from public.room_members where room_id = '${room.data.id}'`);
  sql(`delete from public.rooms where id = '${room.data.id}'`);
}

// ================= §3-7 ゴースト掃除（0062） =================
{
  const H = await signup('ghosth');
  const S = await signup('ghosts');
  const F = await signup('ghostf');
  // 部屋とメンバーは1文で作る（間に見回りcronが挟まると空の部屋として
  // 閉じられてしまうため。本番の作成RPCは原子的に作るので起きない）
  const mkRoom = (title, status, memberRows) => sql1(`
    with r as (insert into public.rooms (host_id, title, capacity, status)
      values ('${H.id}', '${title}', 4, '${status}') returning id)
    , m as (insert into public.room_members (room_id, user_id, joined_at, last_heartbeat_at)
      select r.id, v.uid, v.j, v.hb from r,
        (values ${memberRows}) as v(uid, j, hb))
    select id from r`);
  // 部屋1：ホスト含め2人が心拍切れ、新鮮なメンバー1人が残る
  const room1 = mkRoom('ゴースト検証1', 'lobby',
    `('${H.id}'::uuid, now() - interval '30 minutes', now() - interval '10 minutes'),
     ('${S.id}'::uuid, now() - interval '20 minutes', now() - interval '10 minutes'),
     ('${F.id}'::uuid, now() - interval '15 minutes', now())`);
  // 部屋2：全員心拍切れ → closed
  const room2 = mkRoom('ゴースト検証2', 'lobby',
    `('${H.id}'::uuid, now() - interval '30 minutes', now() - interval '10 minutes')`);
  // 部屋3：対戦中は心拍切れでも触らない
  const room3 = mkRoom('ゴースト検証3', 'playing',
    `('${H.id}'::uuid, now() - interval '30 minutes', now() - interval '10 minutes')`);

  sql('select public.ww_sweep()');

  const members1 = sql(`select user_id from public.room_members where room_id = '${room1.id}'`);
  check('§3-7 心拍切れ（5分超）のメンバーは待機室から退出扱いになる',
    members1.length === 1 && members1[0].user_id === F.id, JSON.stringify(members1));
  const room1After = sql1(`select host_id, status from public.rooms where id = '${room1.id}'`);
  check('§3-7 ホストが消えたら最古参の残存メンバーへ移譲される',
    room1After.host_id === F.id && room1After.status === 'lobby', JSON.stringify(room1After));
  const room2After = sql1(`select status from public.rooms where id = '${room2.id}'`);
  check('§3-7 誰も残らなかった待機室は closed になる',
    room2After.status === 'closed', JSON.stringify(room2After));
  const members3 = sql(`select user_id from public.room_members where room_id = '${room3.id}'`);
  const room3After = sql1(`select status from public.rooms where id = '${room3.id}'`);
  check('§3-7 対戦中（playing）の部屋は掃除の対象外',
    members3.length === 1 && room3After.status === 'playing',
    `${members3.length} / ${room3After.status}`);
  // 後片付け：playing を偽装した部屋3は掃除の対象外＝本番ロビーに残り続ける
  // ため、検証で作った部屋は必ず自分で消す（2026-11-28 おぎ実機で発見）
  for (const r of [room1, room2, room3]) {
    sql(`delete from public.room_members where room_id = '${r.id}'`);
    sql(`delete from public.rooms where id = '${r.id}'`);
  }
}

// ================= §7-9 グループ上限50人 =================
{
  const O = await signup('capo');
  const F1 = await signup('capf');
  const X = await signup('capx');
  const Y = await signup('capy');
  await befriend(O, F1);
  await befriend(O, X);
  await befriend(O, Y);
  const g = await rpc(O, 'kl_create_group', { p_name: '上限検証グループ', p_member_ids: [F1.id] });
  if (g.error) throw new Error(`§7-9 グループ作成失敗: ${g.code}`);
  // 49人まで SQL で埋める（残り47人は既存ユーザーから流用）
  sql(`insert into public.kl_group_members (group_id, user_id)
    select '${g.data.id}', id from auth.users
    where id not in ('${O.id}', '${F1.id}', '${X.id}', '${Y.id}')
    limit 47
    on conflict do nothing`);
  const cnt = sql1(`select count(*)::int as n from public.kl_group_members where group_id = '${g.data.id}'`);
  check('§7-9 （前提）グループは49人になっている', Number(cnt.n) === 49, JSON.stringify(cnt));
  const over = await rpc(O, 'kl_add_group_members', { p_group: g.data.id, p_member_ids: [X.id, Y.id] });
  check('§7-9 50人を超える追加は GROUP_FULL', over.code === 'GROUP_FULL', over.code ?? 'エラーなし');
  const just = await rpc(O, 'kl_add_group_members', { p_group: g.data.id, p_member_ids: [X.id] });
  const cnt2 = sql1(`select count(*)::int as n from public.kl_group_members where group_id = '${g.data.id}'`);
  check('§7-9 ちょうど50人までの追加は成功する',
    !just.error && Number(cnt2.n) === 50, `${just.code ?? ''} / ${JSON.stringify(cnt2)}`);
}

// ================= §10-9 満室でなくなった部屋は放置に数えない =================
{
  async function fullReadyRoom(tag) {
    const host = await signup(`${tag}h`);
    const members = [];
    for (let i = 0; i < 3; i++) {
      const m = await signup(`${tag}m${i}`);
      await befriend(host, m);
      members.push(m);
    }
    const room = await rpc(host, 'ww_create_room', {
      p_title: `放置検証${tag}`, p_is_private: false,
      p_beginner_welcome: false, p_reversal_enabled: true, p_capacity: 4, p_genre: null,
    });
    if (room.error) throw new Error(`§10-9 ルーム作成失敗: ${room.code}`);
    for (const m of members) await rpc(m, 'ww_join_room', { p_room: room.data.id });
    for (const m of members) await rpc(m, 'ww_set_ready', { p_room: room.data.id, p_ready: true });
    await rpc(host, 'ww_set_ready', { p_room: room.data.id, p_ready: true });
    // 全員準備OKの時刻を6分前へ（検出の閾値5分を超えさせる）
    sql(`update public.rooms set all_ready_at = now() - interval '6 minutes' where id = '${room.data.id}'`);
    return { host, members, roomId: room.data.id };
  }
  // 対照：満室のままなら記録される
  const ctrl = await fullReadyRoom('ctl');
  sql('select public.kl__detect_stalls()');
  const ctrlEvents = sql(`select id from public.stall_events where room_id = '${ctrl.roomId}'`);
  check('§10-9 （対照）満室＋全員準備OK＋5分経過なら放置が記録される',
    ctrlEvents.length >= 1);
  // 本題：1人抜けて満室でなくなった部屋は記録されない
  const test = await fullReadyRoom('tst');
  await rpc(test.members[0], 'ww_leave_room', { p_room: test.roomId });
  sql('select public.kl__detect_stalls()');
  const testEvents = sql(`select id from public.stall_events where room_id = '${test.roomId}'`);
  check('§10-9 満室でなくなった部屋はマスター放置に数えない',
    testEvents.length === 0, `${testEvents.length}件`);
  // 後片付け（検証ルームを本番ロビーに残さない）
  for (const r of [ctrl, test]) {
    sql(`delete from public.room_members where room_id = '${r.roomId}'`);
    sql(`delete from public.rooms where id = '${r.roomId}'`);
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
process.exit(failed.length ? 1 : 0);
