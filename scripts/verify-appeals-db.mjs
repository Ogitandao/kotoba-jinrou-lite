// 異議申し立て（0047）の実 DB 検証
// - 対象は harassment の7日以上（無期限含む）のみ、1処分1回、30日期限
// - 送信で受付DM、Apps Script 用 RPC（トークン必須）で一覧と判定反映
// - 解除：penalty_until 再計算＋記録行＋結果DM／維持：記録行＋結果DM
// - 保持期間の掃除は、申立て保留中のケースを消さない
// 実行：node scripts/verify-appeals-db.mjs
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
const pw = String.fromCharCode(76, 105, 116, 101, 45, 65, 112, 45, 50, 48, 50, 54, 33);
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
    email: `kl.lite.ap.${tag}${stamp}@gmail.com`, password: pw,
    options: { data: { test_marker: 'test/lite', display_name: `申立検証${tag}` } },
  });
  if (error || !data?.session) throw new Error(`signup ${tag}: ${error?.message ?? 'session なし'}`);
  await sleepMs(300);
  return { sb, id: data.user.id };
}
function makePenalty(userId, { track = 'harassment', minutes = 10080, until = null, ageDays = 0 } = {}) {
  const untilSql = until === 'infinity' ? `'infinity'::timestamptz`
    : `(now() + interval '${minutes} minutes')`;
  const rows = sql(
    `insert into public.penalty_events (user_id, track, kind, minutes, penalty_until, created_at)
     values ('${userId}', '${track}', 'violation', ${minutes}, ${untilSql},
             now() - interval '${ageDays} days')
     returning id`);
  sql(`update public.profiles set penalty_until = ${untilSql} where id = '${userId}'`);
  return rows[0].id;
}
const sysDms = (userId) => sql(
  `select body from public.dm_messages where sender_id is null and recipient_id = '${userId}' and kind = 'system' order by created_at`);
const TOKEN = sql1(`select value from public.kl_config where key = 'appeal_token'`).value;
check('申立てトークンが発行されている', typeof TOKEN === 'string' && TOKEN.length >= 32);
const anon = mkClient();

// ---------- X：7日制限 → 申立て → 解除 ----------
const X = await signup('x');
const evX = makePenalty(X.id);
{
  const list = await rpc(X.sb, 'kl_my_appealable_penalties');
  const item = (list.data ?? []).find((i) => i.penaltyEventId === evX);
  check('対象の処分が申立て可能一覧に出る', !!item && item.alreadyAppealed === false,
    JSON.stringify(list.data));
  const empty = await rpc(X.sb, 'kl_submit_appeal', { p_penalty_event_id: evX, p_reason: '  ' });
  check('理由が空なら REASON_EMPTY', empty.code === 'REASON_EMPTY', empty.code ?? 'no error');
  const ok = await rpc(X.sb, 'kl_submit_appeal', {
    p_penalty_event_id: evX, p_reason: 'その時間は寝ていて、発言していません',
  });
  check('申立てが送信できる', !ok.error && !!ok.data?.appealId, ok.error?.message ?? '');
  var appealX = ok.data?.appealId;
  check('受付のシステムDMが届く',
    sysDms(X.id).some((m) => m.body.includes('受け付けました')));
  const dup = await rpc(X.sb, 'kl_submit_appeal', { p_penalty_event_id: evX, p_reason: 'もう一度' });
  check('二重申立ては ALREADY_APPEALED', dup.code === 'ALREADY_APPEALED', dup.code ?? 'no error');
}
{
  const badList = await rpc(anon, 'kl_list_appeals_for_sheet', { p_token: 'wrong-token' });
  check('シート一覧：トークン違いは INVALID_TOKEN', badList.code === 'INVALID_TOKEN', badList.code ?? 'no error');
  const list = await rpc(anon, 'kl_list_appeals_for_sheet', { p_token: TOKEN });
  const item = (list.data ?? []).find((i) => i.appealId === appealX);
  check('シート一覧：未処理の申立てが段階ラベル付きで出る',
    !!item && item.stepLabel === '7日（1段目）', JSON.stringify(item ?? list.data));
  const badResolve = await rpc(anon, 'kl_resolve_appeal', {
    p_appeal_id: appealX, p_accept: true, p_token: 'wrong-token',
  });
  check('判定反映：トークン違いは INVALID_TOKEN', badResolve.code === 'INVALID_TOKEN', badResolve.code ?? 'no error');
  const resolved = await rpc(anon, 'kl_resolve_appeal', {
    p_appeal_id: appealX, p_accept: true, p_token: TOKEN,
  });
  check('判定反映：解除できる', !resolved.error && resolved.data?.status === 'accepted',
    resolved.error?.message ?? JSON.stringify(resolved.data));
  const prof = sql1(`select penalty_until from public.profiles where id = '${X.id}'`);
  check('解除で penalty_until が消える', !prof.penalty_until, `until=${prof.penalty_until}`);
  const lifted = sql(
    `select count(*)::int as n from public.penalty_events where user_id = '${X.id}' and kind = 'appeal_lifted'`);
  check('解除の記録行（appeal_lifted）が残る', lifted[0].n === 1);
  check('解除の結果DMが届く', sysDms(X.id).some((m) => m.body.includes('利用制限を解除しました')));
  const again = await rpc(anon, 'kl_resolve_appeal', {
    p_appeal_id: appealX, p_accept: false, p_token: TOKEN,
  });
  check('再反映は冪等（skipped）', again.data?.skipped === true, JSON.stringify(again.data));
}

// ---------- 対象外と期限 ----------
{
  const evAfk = makePenalty(X.id, { track: 'afk', minutes: 10080 });
  const r = await rpc(X.sb, 'kl_submit_appeal', { p_penalty_event_id: evAfk, p_reason: 'テスト' });
  check('afk 処分は対象外（NOT_APPEALABLE）', r.code === 'NOT_APPEALABLE', r.code ?? 'no error');
  const evOld = makePenalty(X.id, { ageDays: 31 });
  const r2 = await rpc(X.sb, 'kl_submit_appeal', { p_penalty_event_id: evOld, p_reason: 'テスト' });
  check('30日を過ぎた処分は APPEAL_DEADLINE_PASSED', r2.code === 'APPEAL_DEADLINE_PASSED', r2.code ?? 'no error');
}

// ---------- Y：無期限 → 申立て（期限なし） → 維持 ----------
const Y = await signup('y');
const evY = makePenalty(Y.id, { minutes: -1, until: 'infinity', ageDays: 60 });
{
  const ok = await rpc(Y.sb, 'kl_submit_appeal', {
    p_penalty_event_id: evY, p_reason: '心当たりがありません',
  });
  check('無期限処分は60日後でも申立てできる（期限なし）', !ok.error && !!ok.data?.appealId,
    ok.error?.message ?? '');
  const resolved = await rpc(anon, 'kl_resolve_appeal', {
    p_appeal_id: ok.data.appealId, p_accept: false, p_token: TOKEN,
  });
  check('判定反映：維持できる', resolved.data?.status === 'rejected', JSON.stringify(resolved.data));
  const prof = sql1(`select penalty_until from public.profiles where id = '${Y.id}'`);
  check('維持なら penalty_until は無期限のまま', String(prof.penalty_until).startsWith('infinity'));
  check('維持の結果DM（無期限表記）が届く',
    sysDms(Y.id).some((m) => m.body.includes('解除はできません') && m.body.includes('無期限')));
}

// ---------- 保持期間の掃除と申立て保留中の保護 ----------
const Z = await signup('z');
const evZ = makePenalty(Z.id);
{
  const ok = await rpc(Z.sb, 'kl_submit_appeal', { p_penalty_event_id: evZ, p_reason: '確認中です' });
  const caseKept = sql(
    `insert into public.moderation_cases (target_user_id, surface, decision, penalty_event_id, retention_until)
     values ('${Z.id}', 'dm', 'penalized', '${evZ}', now() - interval '1 day') returning id`);
  const caseGone = sql(
    `insert into public.moderation_cases (target_user_id, surface, decision, retention_until)
     values ('${Z.id}', 'dm', 'dismissed', now() - interval '1 day') returning id`);
  sql('select public.kl__retention_cleanup()');
  const kept = sql(`select count(*)::int as n from public.moderation_cases where id = '${caseKept[0].id}'`);
  const gone = sql(`select count(*)::int as n from public.moderation_cases where id = '${caseGone[0].id}'`);
  check('掃除：申立て保留中のケースは消えない', kept[0].n === 1);
  check('掃除：期限を過ぎた通常ケースは消える', gone[0].n === 0);
  await rpc(anon, 'kl_resolve_appeal', { p_appeal_id: ok.data.appealId, p_accept: false, p_token: TOKEN });
  sql('select public.kl__retention_cleanup()');
  const kept2 = sql(`select count(*)::int as n from public.moderation_cases where id = '${caseKept[0].id}'`);
  check('掃除：申立てが終わればケースも消える', kept2[0].n === 0);
}

console.log(`\n=== ${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} ===`);
process.exit(failures ? 1 : 0);
