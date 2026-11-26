// 認証フェーズ（0049 生年月日）の実 DB 検証
// - kl_set_birthdate：初回だけ設定可／設定済みは BIRTHDATE_ALREADY_SET
// - 13歳未満は UNDERAGE で拒否され、birthdate は NULL のまま
// - 空値は BIRTHDATE_REQUIRED
// - クライアントの直接 UPDATE は guard トリガで巻き戻される（変更不可）
// - kl_monthly_cap_yen：14歳→5000／18歳→20000／25歳→NULL（SQL で確認）
// - anon からは kl_set_birthdate を実行できない
// 実行：node scripts/verify-auth-db.mjs
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
const pw = String.fromCharCode(76, 105, 116, 101, 45, 65, 117, 45, 50, 48, 50, 54, 33);
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
    email: `kl.lite.auth.${tag}${stamp}@gmail.com`, password: pw,
    options: { data: { test_marker: 'test/lite', display_name: `認証検証${tag}` } },
  });
  if (error || !data?.session) throw new Error(`signup ${tag}: ${error?.message ?? 'session なし'}`);
  await sleepMs(300);
  return { sb, id: data.user.id };
}
const birthdateOf = (userId) =>
  sql1(`select birthdate from public.profiles where id = '${userId}'`).birthdate;
const isoYearsAgo = (years) => {
  const d = new Date(Date.now() + 9 * 3600 * 1000); // JST
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
};

// ---------- A：成人の登録→再登録拒否→直接 UPDATE の巻き戻し ----------
const A = await signup('a');
check('A: 登録直後の birthdate は NULL', birthdateOf(A.id) === null);
{
  const r = await rpc(A.sb, 'kl_set_birthdate', { p_birthdate: '2000-04-01' });
  check('A: 初回の登録が成功する', !r.error && r.data?.birthdate === '2000-04-01',
    r.error?.message ?? '');
  check('A: profiles.birthdate に保存された', birthdateOf(A.id) === '2000-04-01');
  const again = await rpc(A.sb, 'kl_set_birthdate', { p_birthdate: '1999-01-01' });
  check('A: 2回目は BIRTHDATE_ALREADY_SET', again.code === 'BIRTHDATE_ALREADY_SET',
    again.error?.message ?? 'エラーなし');
  check('A: 値は最初のまま', birthdateOf(A.id) === '2000-04-01');
  // 本人が REST で直接書き換えようとしても guard が巻き戻す
  const upd = await A.sb.from('profiles').update({ birthdate: '1990-01-01' }).eq('id', A.id);
  check('A: 直接 UPDATE のエラーは出ない（巻き戻し方式）', !upd.error, upd.error?.message ?? '');
  check('A: 直接 UPDATE しても birthdate は不変', birthdateOf(A.id) === '2000-04-01');
}

// ---------- B：13歳未満の拒否と境界 ----------
const B = await signup('b');
{
  const kid = await rpc(B.sb, 'kl_set_birthdate', { p_birthdate: isoYearsAgo(10) });
  check('B: 10歳は UNDERAGE で拒否', kid.code === 'UNDERAGE', kid.error?.message ?? 'エラーなし');
  check('B: 拒否後は NULL のまま', birthdateOf(B.id) === null);
  const just13 = await rpc(B.sb, 'kl_set_birthdate', { p_birthdate: isoYearsAgo(13) });
  check('B: ちょうど13歳は登録できる', !just13.error && just13.data?.birthdate === isoYearsAgo(13),
    just13.error?.message ?? '');
}

// ---------- C：空値・anon ----------
const C = await signup('c');
{
  const empty = await rpc(C.sb, 'kl_set_birthdate', { p_birthdate: null });
  check('C: NULL は BIRTHDATE_REQUIRED', empty.code === 'BIRTHDATE_REQUIRED',
    empty.error?.message ?? 'エラーなし');
  const anon = mkClient();
  const r = await rpc(anon, 'kl_set_birthdate', { p_birthdate: '2000-01-01' });
  check('C: anon は実行できない', Boolean(r.error), r.error?.message ?? '実行できてしまった');
}

// ---------- D：月額上限ヘルパー（JST 年齢） ----------
{
  const row = sql1(`select
    public.kl_monthly_cap_yen('${isoYearsAgo(14)}'::date) as cap14,
    public.kl_monthly_cap_yen('${isoYearsAgo(15)}'::date) as cap15,
    public.kl_monthly_cap_yen('${isoYearsAgo(16)}'::date) as cap16,
    public.kl_monthly_cap_yen('${isoYearsAgo(19)}'::date) as cap19,
    public.kl_monthly_cap_yen('${isoYearsAgo(20)}'::date) as cap20,
    public.kl_monthly_cap_yen(null) as capnull`);
  check('D: 14歳・15歳は 5000', row.cap14 === 5000 && row.cap15 === 5000, JSON.stringify(row));
  check('D: 16歳・19歳は 20000', row.cap16 === 20000 && row.cap19 === 20000, JSON.stringify(row));
  check('D: 20歳と NULL は無制限（NULL）', row.cap20 === null && row.capnull === null,
    JSON.stringify(row));
}

console.log(failures ? `\n${failures} FAIL` : '\nALL PASS');
process.exit(failures ? 1 : 0);
