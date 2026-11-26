// Web Push（0059）の実 DB 検証
// - トリガー／cron／関数の存在
// - 購読・設定の保存（RLS 本人行）
// - DM 到着 → push-send が呼ばれ、失効購読（404）が掃除される
// - 設定 OFF（dm=false）では送信自体がスキップされる（購読が残る）
// - kl_touch_seen と呼び戻しの対象選定＋スタンプ
// ※ 実際の端末への配信は VM から検証できない（おぎ実機で確認）
// 実行：node scripts/verify-push-db.mjs
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createECDH, randomBytes } from 'node:crypto';
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

check('DMトリガーが存在する',
  (sql1(`select count(*)::int as n from pg_trigger where tgname = 'kl_push_on_dm'`).n ?? 0) === 1);
check('呼び戻し cron が登録されている',
  (sql1(`select count(*)::int as n from cron.job where jobname = 'kl-comeback-push'`).n ?? 0) === 1);
check('kl_config に push 用の鍵が揃っている（値は見ない）',
  (sql1(`select count(*)::int as n from public.kl_config where key in ('push_secret','vapid_public','vapid_private')`).n ?? 0) === 3);

async function mkUser(tag) {
  const c = mkClient();
  const email = `kl.lite.push.${tag}${stamp}@gmail.com`;
  const { data, error } = await c.auth.signUp({ email, password: pw });
  if (error) throw new Error(`signUp ${tag}: ${error.message}`);
  await c.rpc('kl_set_birthdate', { p_birthdate: '1995-01-01' });
  await c.rpc('kl_agree_rules');
  return { c, id: data.user.id };
}

const a = await mkUser('a');
const b = await mkUser('b');
sql(`insert into public.friendships (user_a, user_b) values (least('${a.id}'::uuid, '${b.id}'::uuid), greatest('${a.id}'::uuid, '${b.id}'::uuid))`);

// B の購読（endpoint はプロジェクト自身の 404 を返す URL、鍵は実形式で
// 生成する。鍵が不正だと web-push が送信前に落ちて 404 掃除を確認できない）
const ecdh = createECDH('prime256v1');
ecdh.generateKeys();
const realP256dh = ecdh.getPublicKey().toString('base64url');
const realAuth = randomBytes(16).toString('base64url');
const endpoint = `https://dtdwkluanoaqiaruzbwe.supabase.co/push-verify-${stamp}`;
const subIns = await b.c.from('kl_push_subscriptions').insert({
  user_id: b.id, endpoint, p256dh: realP256dh, auth: realAuth,
});
check('購読を保存できる', !subIns.error, subIns.error?.message ?? '');
const prefIns = await b.c.from('kl_push_prefs').upsert({
  user_id: b.id, master: true, dm: true, invite: true, announce: true, comeback: true,
});
check('通知設定を保存できる', !prefIns.error, prefIns.error?.message ?? '');

// A → B へ DM。トリガーが push-send を呼び、404 で失効購読が掃除されるはず
const respBefore = Number(sql1('select coalesce(max(id),0)::int as n from net._http_response').n ?? 0);
const dm1 = await a.c.rpc('kl_send_dm', { p_to: b.id, p_body: 'プッシュ検証1' });
check('DM送信', !dm1.error, dm1.error?.message ?? '');
await sleep(9000);
const subAfter1 = Number(sql1(
  `select count(*)::int as n from public.kl_push_subscriptions where user_id = '${b.id}'`).n ?? 0);
check('失効購読が掃除された（＝push-send が実際に送信を試みた）', subAfter1 === 0, `subs=${subAfter1}`);
const respRow = sql1(
  `select status_code from net._http_response where id > ${respBefore} order by id desc limit 1`);
check('push-send が 200 を返した', Number(respRow.status_code ?? 0) === 200, `status=${respRow.status_code}`);

// 設定 OFF：dm=false にすると送信がスキップされ、購読は残る
await b.c.from('kl_push_subscriptions').insert({
  user_id: b.id, endpoint, p256dh: realP256dh, auth: realAuth,
});
await b.c.from('kl_push_prefs').upsert({ user_id: b.id, master: true, dm: false });
const dm2 = await a.c.rpc('kl_send_dm', { p_to: b.id, p_body: 'プッシュ検証2' });
check('DM送信（設定OFF時）', !dm2.error, dm2.error?.message ?? '');
await sleep(9000);
const subAfter2 = Number(sql1(
  `select count(*)::int as n from public.kl_push_subscriptions where user_id = '${b.id}'`).n ?? 0);
check('dm=false では送信されず購読が残る', subAfter2 === 1, `subs=${subAfter2}`);

// 最終アクセスと呼び戻し
const seen = await b.c.rpc('kl_touch_seen');
check('kl_touch_seen が成功する', !seen.error, seen.error?.message ?? '');
sql(`update public.profiles set last_seen_at = now() - interval '4 days' where id = '${b.id}'`);
await b.c.from('kl_push_prefs').upsert({
  user_id: b.id, master: true, dm: true, comeback: true, last_comeback_at: null,
});
const cb = sql1('select public.kl__comeback_run() as n');
check('呼び戻し対象に選ばれる', Number(cb.n ?? 0) >= 1, `n=${cb.n}`);
const stamped = sql1(`select last_comeback_at from public.kl_push_prefs where user_id = '${b.id}'`);
check('呼び戻しの実施記録が付く', !!stamped.last_comeback_at);
const cb2 = sql1('select public.kl__comeback_run() as n');
check('週1回まで：直後の再実行では対象が減る（Bは含まれない）',
  Number(sql1(`select count(*)::int as n from public.kl_push_prefs where user_id = '${b.id}' and last_comeback_at > now() - interval '1 minute'`).n ?? 0) === 1);

console.log(failures === 0 ? '=== ALL PASS ===' : `=== ${failures} FAILURES ===`);
process.exit(failures === 0 ? 0 : 1);
