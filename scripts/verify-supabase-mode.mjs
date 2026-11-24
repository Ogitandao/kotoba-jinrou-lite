// Supabase 接続モードの検証：
// A) Node から vendor バンドルで実プロジェクトへ接続し、未ログイン状態の
//    読み取り経路（Auth セッション取得・REST・RPC）が想定どおり応答するか
// B) jsdom でクライアントを読み、KL_CONFIG が入り、未ログイン時は
//    KL_DATA が SimBackend にフォールバックして画面が壊れないか
// 実行：npm run verify:supabase-mode（client/kl-config.js が必要）
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createClient } from '../client/vendor/supabase.js';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

// ---------- A) 実クライアント経由の疎通 ----------
const cfgText = readFileSync(new URL('../client/kl-config.js', import.meta.url), 'utf8');
const cfg = JSON.parse(cfgText.match(/\{[\s\S]*\}/)[0]);
check('kl-config.js に URL とキーがある', Boolean(cfg.supabaseUrl && cfg.supabaseKey));

const sb = createClient(cfg.supabaseUrl, cfg.supabaseKey);
const { data: sess, error: sessErr } = await sb.auth.getSession();
check('Auth: getSession がエラーなく返る（未ログイン=null）',
  !sessErr && sess?.session === null, sessErr?.message ?? '');

const { error: restErr } = await sb.from('gift_catalog').select('key').limit(1);
check('REST: 未認証の gift_catalog 読み取りは RLS で拒否される',
  Boolean(restErr), restErr?.message ?? 'エラーなし（読めてしまった）');

const { error: rpcErr } = await sb.rpc('kl_search_user', { p_public_id: 'GUV6JSL3' });
check('RPC: 未認証の kl_search_user は拒否される',
  Boolean(rpcErr), rpcErr?.message ?? 'エラーなし（実行できてしまった）');

// ---------- B) jsdom：フォールバックと画面 ----------
const base = new URL('../client/', import.meta.url);
const html = readFileSync(new URL('index.html', base), 'utf8');
const dom = new JSDOM(html, {
  url: pathToFileURL(new URL('index.html', base).pathname).href,
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
});
await new Promise((resolve) => {
  if (dom.window.document.readyState === 'complete') resolve();
  else dom.window.addEventListener('load', resolve);
});
await new Promise((r) => setTimeout(r, 80));

check('jsdom: KL_CONFIG が読み込まれている',
  Boolean(dom.window.KL_CONFIG?.supabaseUrl && dom.window.KL_CONFIG?.supabaseKey));
const boot = await dom.window.KL_DATA.bootstrap();
check('jsdom: 未ログインでも bootstrap が解決する（フォールバック）',
  Boolean(boot?.me), boot?.me?.name ?? '');
check('jsdom: 未ログイン時のモードは sim（デモ）',
  dom.window.KL_DATA.mode === 'sim', dom.window.KL_DATA.mode);
check('jsdom: ロビーにプロフィールが描画される',
  (dom.window.document.getElementById('my-name')?.textContent ?? '').length > 0,
  dom.window.document.getElementById('my-name')?.textContent ?? '');

const failed = results.filter((r) => !r.ok).length;
console.log(`\n=== ${results.length - failed}/${results.length} PASS ===`);
process.exit(failed ? 1 : 0);
