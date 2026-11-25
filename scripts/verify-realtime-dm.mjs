// DM Realtime の実 DB 検証（2026-11-25 導入分）。
// - ユーザーAでログインし、dm_messages の自分宛て INSERT を
//   Postgres Changes で購読する
// - SQL API 経由で B→A の DM を1件 INSERT し、イベントが
//   制限時間内に届くことを確認する（クライアントの subscribeDm と同じ経路）
// 実行：node scripts/verify-realtime-dm.mjs（client/kl-config.js が必要）
// 注意：実行のたびにテストユーザーが増える。パスワードは文字コードから組む。
// 注意2：むぜたんのVMからは WebSocket がプロキシに弾かれて購読が
// CHANNEL_ERROR（transport failure）になる（2026-11-25 確認）。
// 実地の最終確認は、実機2台＋実アカウントでの認証フェーズ時に行う。
// （dm_messages の publication 登録自体は SQL で確認済み）
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
const pw = String.fromCharCode(76, 105, 116, 101, 45, 82, 84, 45, 50, 48, 50, 54, 33); // Lite-RT-2026!
const stamp = Date.now();
const emailA = `kl.lite.rt.a.${stamp}@gmail.com`;
const emailB = `kl.lite.rt.b.${stamp}@gmail.com`;

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const anon = createClient(URL_, KEY);
const { data: suA, error: eA } = await anon.auth.signUp({ email: emailA, password: pw });
const { data: suB, error: eB } = await anon.auth.signUp({ email: emailB, password: pw });
check('テストユーザーA/Bを作成できる', !eA && !eB && !!suA?.user && !!suB?.user,
  (eA?.message ?? '') + (eB?.message ?? ''));
const idA = suA.user.id;
const idB = suB.user.id;

const { error: eS } = await anon.auth.signInWithPassword({ email: emailA, password: pw });
check('Aでログインできる', !eS, eS?.message ?? '');

let got = null;
let subscribed = false;
const ch = anon.channel('kl-dm-inbox-test')
  .on('postgres_changes',
    { event: 'INSERT', schema: 'public', table: 'dm_messages', filter: `recipient_id=eq.${idA}` },
    (payload) => { got = payload.new; })
  .subscribe((status) => { if (status === 'SUBSCRIBED') subscribed = true; });

for (let i = 0; i < 40 && !subscribed; i++) await new Promise((r) => setTimeout(r, 500));
check('Realtime チャンネルを購読できる', subscribed);

const body = 'リアルタイム検証メッセージ';
sql(`insert into public.dm_messages (sender_id, recipient_id, kind, body)
     values ('${idB}', '${idA}', 'text', '${body}')`);

for (let i = 0; i < 40 && !got; i++) await new Promise((r) => setTimeout(r, 500));
check('B→A の DM INSERT が A に即時配信される', !!got && got.body === body && got.sender_id === idB,
  got ? `from=${got.sender_id}` : 'イベント未着（20秒）');

sql(`delete from public.dm_messages where recipient_id = '${idA}' and sender_id = '${idB}' and body = '${body}'`);
await anon.removeChannel(ch);
console.log(failures === 0 ? '=== ALL PASS ===' : `=== ${failures} FAIL ===`);
process.exit(failures === 0 ? 0 : 1);
