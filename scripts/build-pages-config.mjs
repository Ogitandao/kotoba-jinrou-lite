// Cloudflare Pages ビルド用：環境変数から client/kl-config.js を生成する。
// 本家（人狼NIGHT）の build-pages-config.mjs のパターンをコピーし、
// Lite 用に独立させたもの（環境変数は KL_ プレフィックス）。
// index.html がアプリ本体より先に kl-config.js を読み、client/config.js が
// window.__KL_CONFIG__ として拾う。実値はリポジトリにコミットしない
// （kl-config.js は .gitignore 済み）。
import { writeFileSync } from 'node:fs';

const cfg = {
  supabaseUrl: process.env.KL_SUPABASE_URL ?? '',
  supabaseKey: process.env.KL_SUPABASE_KEY ?? '',
};

if (!cfg.supabaseUrl || !cfg.supabaseKey) {
  console.warn(
    '[build-pages-config] KL_SUPABASE_URL / KL_SUPABASE_KEY が未設定です。' +
      'このままデプロイするとクライアントはダミーモードで動きます。',
  );
}

writeFileSync(
  new URL('../client/kl-config.js', import.meta.url),
  `window.__KL_CONFIG__ = ${JSON.stringify(cfg, null, 2)};\n`,
);
console.log('[build-pages-config] client/kl-config.js を生成しました');
