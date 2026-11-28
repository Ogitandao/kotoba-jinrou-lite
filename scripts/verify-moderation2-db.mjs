// テスト仕様書 §9（通報とモデレーション）・§7-8（グループ通報）の
// 未実装行を実 DB で検証するスイート。
// 実行: node scripts/verify-moderation2-db.mjs
//
// カバー範囲：
// §9-2 同じ投稿への二重通報／1日20件の上限
// §9-3 重み3.0での仮非表示＋重みの半減ルール
// §9-6 重大カテゴリは初回から無期限凍結
// §9-7 処分階段（警告→7日→30日→無期限）と90日窓
// §9-8 流れ判定（中間帯3件で違反1件に確定）
// §9-9 通報者への結果DM（対応しました／確認できませんでした）
// §9-10 虚偽通報で信頼スコア低下＋警告DM
// §9-11 却下されたら仮非表示が自動で戻る
// §7-8 グループ発言も通報でき、ケースは surface='group' で作られる
//
// ケースの作り方は verify-gameflows-db.mjs と同じ：
// moderation_cases へ直接 insert し、kl__finalize_case で確定させる。
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
const PW = String.fromCharCode(76, 105, 116, 101, 45, 77, 111, 100, 50, 45, 50, 48, 50, 54, 33);
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
  const email = `kl.lite.mod2.${tag}${stamp}@gmail.com`;
  const { data, error } = await sb.auth.signUp({
    email, password: PW,
    options: { data: { test_marker: 'test/lite', display_name: `モデ検証${tag}` } },
  });
  if (error || !data?.session) throw new Error(`signup ${tag} 失敗: ${error?.message ?? 'session なし'}`);
  await sb.rpc('kl_agree_rules');
  await sb.rpc('kl_set_birthdate', { p_birthdate: '1995-01-01' });
  return { sb, id: data.user.id, email };
}
async function befriend(a, b) {
  await rpc(a, 'kl_send_friend_request', { p_to: b.id });
  await rpc(b, 'kl_respond_friend_request', { p_from: a.id, p_accept: true });
}
async function sendDm(from, to, body) {
  const r = await rpc(from, 'kl_send_dm', { p_to: to.id, p_body: body });
  if (r.error) throw new Error(`DM送信失敗: ${r.code}`);
  return r.data.id;
}
function insertCase({ author, surface, ref, snapshot, weight = 1.0 }) {
  const row = sql1(`insert into public.moderation_cases
      (target_user_id, surface, target_ref, snapshot_text, report_weight)
    values ('${author}', '${surface}', '${ref}', '${snapshot}', ${weight})
    returning id`);
  return row.id;
}
function finalize(caseId, scores) {
  const row = sql1(`select public.kl__finalize_case('${caseId}',
    '{"scores": ${JSON.stringify(scores)}, "flagged": {}}'::jsonb) as decision`);
  return row.decision;
}
const sweep = () => sql('select public.kl__moderation_sweep() as swept');
const setTrust = (userId, score) => sql(`insert into public.reporter_stats (user_id, trust_score)
  values ('${userId}', ${score})
  on conflict (user_id) do update set trust_score = ${score}`);
const systemDmsTo = (userId, like) => sql(
  `select body from public.dm_messages
   where receiver_id = '${userId}' and sender_id is null and kind = 'system'
     and body like '%${like}%'`);

// ================= §9-2 二重通報・上限 =================
{
  const A = await signup('r2a');
  const R = await signup('r2r');
  await befriend(A, R);
  const m1 = await sendDm(A, R, '二重通報の検証メッセージ');
  const first = await rpc(R, 'kl_report', { p_kind: 'dm_message', p_target_id: m1, p_reason: 'その他' });
  check('§9-2 1回目の通報は受理される', !first.error, first.code ?? '');
  const second = await rpc(R, 'kl_report', { p_kind: 'dm_message', p_target_id: m1, p_reason: 'その他' });
  check('§9-2 同じ投稿への2回目は ALREADY_REPORTED', second.code === 'ALREADY_REPORTED', second.code ?? '');
  // 24時間の上限：既存1件＋ダミー19件で20件に到達させる
  for (let i = 0; i < 19; i++) {
    sql(`insert into public.reports (reporter_id, target_user_id, target_kind, target_ref, reason)
      values ('${R.id}', '${A.id}', 'dm_message', gen_random_uuid(), '検証')`);
  }
  const m2 = await sendDm(A, R, '上限検証メッセージ');
  const over = await rpc(R, 'kl_report', { p_kind: 'dm_message', p_target_id: m2, p_reason: 'その他' });
  check('§9-2 24時間で20件を超える通報は REPORT_LIMIT', over.code === 'REPORT_LIMIT', over.code ?? '');
}

// ================= §9-3 仮非表示と半減 =================
{
  const A = await signup('r3a');
  const R1 = await signup('r3x');
  const R2 = await signup('r3y');
  const R3 = await signup('r3z');
  await befriend(A, R1);
  const m = await sendDm(A, R1, '仮非表示の検証メッセージ');
  for (const r of [R1, R2, R3]) {
    setTrust(r.id, 1.0);
    const rep = await rpc(r, 'kl_report', { p_kind: 'dm_message', p_target_id: m, p_reason: '暴言・ハラスメント' });
    if (rep.error) throw new Error(`§9-3 通報失敗: ${rep.code}`);
  }
  sweep();
  const kase = sql1(`select report_weight from public.moderation_cases where target_ref = '${m}'`);
  check('§9-3 通報3人×信頼1.0でケースの重みは3.0', Number(kase.report_weight) === 3.0,
    JSON.stringify(kase));
  const msg = sql1(`select hidden_at from public.dm_messages where id = '${m}'`);
  check('§9-3 重み3.0でメッセージは仮非表示になる', !!msg.hidden_at);
  const notice = systemDmsTo(A.id, '非表示');
  check('§9-3 投稿者へ仮非表示のシステムDMが届く', notice.length >= 1);

  // 半減ルール：同じルームのメンバー2人からの通報は重み半分
  const H = await signup('r3h');
  const M1 = await signup('r3m');
  const M2 = await signup('r3n');
  const room = await rpc(H, 'ww_create_room', {
    p_title: '半減検証ルーム', p_is_private: false,
    p_beginner_welcome: false, p_reversal_enabled: true, p_capacity: 4, p_genre: null,
  });
  if (room.error) throw new Error(`§9-3 ルーム作成失敗: ${room.code}`);
  await rpc(M1, 'ww_join_room', { p_room: room.data.id });
  await rpc(M2, 'ww_join_room', { p_room: room.data.id });
  const rm = sql1(`insert into public.ww_room_messages (room_id, sender_id, body)
    values ('${room.data.id}', '${H.id}', '半減検証の発言') returning id`);
  for (const r of [M1, M2]) {
    setTrust(r.id, 1.0);
    const rep = await rpc(r, 'kl_report', { p_kind: 'room_message', p_target_id: rm.id, p_reason: '暴言・ハラスメント' });
    if (rep.error) throw new Error(`§9-3 ルーム通報失敗: ${rep.code}`);
  }
  sweep();
  const rcase = sql1(`select report_weight from public.moderation_cases where target_ref = '${rm.id}'`);
  check('§9-3 同じルームのメンバー2人の通報は重みが半分（2.0→1.0）',
    Number(rcase.report_weight) === 1.0, JSON.stringify(rcase));
}

// ================= §9-6 重大カテゴリは初回から無期限 =================
{
  const A = await signup('r6a');
  const R = await signup('r6r');
  await befriend(A, R);
  const m = await sendDm(A, R, '重大検証メッセージ');
  const caseId = insertCase({ author: A.id, surface: 'dm', ref: m, snapshot: '重大検証メッセージ' });
  const decision = finalize(caseId, { 'sexual/minors': 0.5 });
  check('§9-6 未成年が絡む性的表現は初回でも penalized（凍結）', decision === 'penalized', decision);
  const ev = sql1(`select minutes from public.penalty_events
    where user_id = '${A.id}' and track = 'harassment' order by created_at desc limit 1`);
  check('§9-6 ペナルティは無期限（minutes=-1）', Number(ev.minutes) === -1, JSON.stringify(ev));
  const prof = sql1(`select penalty_until from public.profiles where id = '${A.id}'`);
  check('§9-6 プロフィールの penalty_until は infinity', String(prof.penalty_until).includes('infinity'),
    String(prof.penalty_until));
}

// ================= §9-7 処分階段と90日窓 =================
{
  const A = await signup('r7a');
  const R = await signup('r7r');
  await befriend(A, R);
  const expected = [
    { decision: 'warned', kind: 'warning', minutes: 0 },
    { decision: 'penalized', kind: 'violation', minutes: 10080 },
    { decision: 'penalized', kind: 'violation', minutes: 43200 },
    { decision: 'penalized', kind: 'violation', minutes: -1 },
  ];
  for (let i = 0; i < expected.length; i++) {
    const m = await sendDm(A, R, `階段検証メッセージ${i + 1}`);
    const caseId = insertCase({ author: A.id, surface: 'dm', ref: m, snapshot: `階段検証${i + 1}` });
    const decision = finalize(caseId, { harassment: 0.9 });
    const ev = sql1(`select kind, minutes from public.penalty_events
      where user_id = '${A.id}' and track = 'harassment' order by created_at desc limit 1`);
    check(`§9-7 ${i + 1}件目：${expected[i].decision}／${expected[i].minutes}分`,
      decision === expected[i].decision && ev.kind === expected[i].kind
      && Number(ev.minutes) === expected[i].minutes,
      `${decision} / ${JSON.stringify(ev)}`);
    // 同一エピソード上限（24h）に触れないよう、確定時刻を25時間前へずらす
    sql(`update public.moderation_cases set decided_at = now() - interval '25 hours' where id = '${caseId}'`);
  }
  // 90日窓：100日前の違反は数えない
  const B = await signup('r7b');
  const RB = await signup('r7s');
  await befriend(B, RB);
  sql(`insert into public.penalty_events (user_id, track, kind, step, minutes, created_at)
    values ('${B.id}', 'harassment', 'violation', 2, 43200, now() - interval '100 days')`);
  const m = await sendDm(B, RB, '90日窓の検証メッセージ');
  const caseId = insertCase({ author: B.id, surface: 'dm', ref: m, snapshot: '90日窓検証' });
  const decision = finalize(caseId, { harassment: 0.9 });
  const ev = sql1(`select kind, minutes from public.penalty_events
    where user_id = '${B.id}' and track = 'harassment' and created_at > now() - interval '1 day'
    order by created_at desc limit 1`);
  check('§9-7 90日より前の違反は数えず、初回扱いで警告に戻る',
    decision === 'warned' && ev.kind === 'warning' && Number(ev.minutes) === 0,
    `${decision} / ${JSON.stringify(ev)}`);
}

// ================= §9-8 流れ判定 =================
{
  const A = await signup('r8a');
  const R = await signup('r8r');
  await befriend(A, R);
  const decisions = [];
  let caseIds = [];
  for (let i = 0; i < 3; i++) {
    const m = await sendDm(A, R, `流れ判定メッセージ${i + 1}`);
    const caseId = insertCase({ author: A.id, surface: 'dm', ref: m, snapshot: `流れ判定${i + 1}` });
    caseIds.push(caseId);
    decisions.push(finalize(caseId, { harassment: 0.7 }));
  }
  check('§9-8 中間帯（DM 0.7）が3件溜まると3件目で違反確定（warned）',
    decisions[0] === 'dismissed' && decisions[1] === 'dismissed' && decisions[2] === 'warned',
    decisions.join(','));
  const reasons = sql(`select decision_reason from public.moderation_cases
    where id in ('${caseIds[0]}', '${caseIds[1]}') order by created_at`);
  check('§9-8 数えられた過去ケースは flow_counted になり二重に数えない',
    reasons.length === 2 && reasons.every((r) => r.decision_reason === 'flow_counted'),
    JSON.stringify(reasons));
  const third = sql1(`select decision_reason from public.moderation_cases where id = '${caseIds[2]}'`);
  check('§9-8 確定したケースの理由は flow:accumulated',
    third.decision_reason === 'flow:accumulated', third.decision_reason ?? '');
}

// ================= §9-9 通報者への結果DM =================
{
  const A = await signup('r9a');
  const R = await signup('r9r');
  await befriend(A, R);
  const m1 = await sendDm(A, R, '結果通知（対応）メッセージ');
  await rpc(R, 'kl_report', { p_kind: 'dm_message', p_target_id: m1, p_reason: '暴言・ハラスメント' });
  sweep();
  const c1 = sql1(`select id from public.moderation_cases where target_ref = '${m1}'`);
  finalize(c1.id, { harassment: 0.95 });
  const upheld = systemDmsTo(R.id, '対応しました');
  check('§9-9 対応した場合は通報者へ「対応しました」のDMが届く', upheld.length >= 1);

  const A2 = await signup('r9b');
  const R2 = await signup('r9s');
  await befriend(A2, R2);
  const m2 = await sendDm(A2, R2, '結果通知（却下）メッセージ');
  await rpc(R2, 'kl_report', { p_kind: 'dm_message', p_target_id: m2, p_reason: 'その他' });
  sweep();
  const c2 = sql1(`select id from public.moderation_cases where target_ref = '${m2}'`);
  const d2 = finalize(c2.id, { harassment: 0.05 });
  const dismissed = systemDmsTo(R2.id, '違反は確認できませんでした');
  check('§9-9 却下の場合は通報者へ「確認できませんでした」のDMが届く',
    d2 === 'dismissed' && dismissed.length >= 1, d2);
}

// ================= §9-10 虚偽通報の積み重ね =================
{
  const A = await signup('r0a');
  const R = await signup('r0r');
  await befriend(A, R);
  for (let i = 0; i < 5; i++) {
    const m = await sendDm(A, R, `虚偽通報検証メッセージ${i + 1}`);
    await rpc(R, 'kl_report', { p_kind: 'dm_message', p_target_id: m, p_reason: 'その他' });
    sweep();
    const c = sql1(`select id from public.moderation_cases where target_ref = '${m}'`);
    finalize(c.id, { harassment: 0.05 });
  }
  const stats = sql1(`select reports_dismissed, trust_score from public.reporter_stats where user_id = '${R.id}'`);
  check('§9-10 却下が積み重なると信頼スコアが下がる（下限0.2）',
    Number(stats.reports_dismissed) === 5 && Number(stats.trust_score) <= 0.3,
    JSON.stringify(stats));
  const warn = systemDmsTo(R.id, '通報機能の利用を制限');
  check('§9-10 閾値を超えると虚偽通報への警告DMが届く', warn.length >= 1);
}

// ================= §9-11 却下で仮非表示が戻る =================
{
  const A = await signup('r1a');
  const R = await signup('r1r');
  await befriend(A, R);
  const m = await sendDm(A, R, '非表示復旧の検証メッセージ');
  sql(`update public.dm_messages set hidden_at = now() where id = '${m}'`);
  const caseId = insertCase({ author: A.id, surface: 'dm', ref: m, snapshot: '非表示復旧検証' });
  const decision = finalize(caseId, { harassment: 0.05 });
  const msg = sql1(`select hidden_at from public.dm_messages where id = '${m}'`);
  check('§9-11 却下されると仮非表示は自動で戻る（hidden_at が消える）',
    decision === 'dismissed' && !msg.hidden_at, decision);
}

// ================= §7-8 グループ発言の通報 =================
{
  const O = await signup('g8o');
  const F = await signup('g8f');
  await befriend(O, F);
  const g = await rpc(O, 'kl_create_group', { p_name: '通報検証グループ', p_member_ids: [F.id] });
  if (g.error) throw new Error(`§7-8 グループ作成失敗: ${g.code}`);
  const sent = await rpc(F, 'kl_send_group_message', { p_group: g.data.id, p_body: 'グループ通報の検証発言' });
  if (sent.error) throw new Error(`§7-8 グループ送信失敗: ${sent.code}`);
  const rep = await rpc(O, 'kl_report', { p_kind: 'group_message', p_target_id: sent.data.id, p_reason: '暴言・ハラスメント' });
  check('§7-8 グループ発言を通報できる', !rep.error, rep.code ?? '');
  sweep();
  const kase = sql1(`select surface from public.moderation_cases where target_ref = '${sent.data.id}'`);
  check('§7-8 ケースは surface=group で作られる', kase.surface === 'group', JSON.stringify(kase));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
process.exit(failed.length ? 1 : 0);
