// クライアント設定（ことば人狼 Lite）。
// 本家（人狼NIGHT）の設定注入パターンをコピーして独立させたもの。
// 配信時（Cloudflare Pages のビルド）は scripts/build-pages-config.mjs が
// 環境変数から client/kl-config.js を生成し、window.__KL_CONFIG__ として
// 注入する。ローカルでは kl-config.js が存在せず 404 になるが無害で、
// その場合は下のプレースホルダ（空）に落ちて「ダミーモード」で動く。
// 実値（Supabase の URL / publishable key）はリポジトリにコミットしない。
window.KL_CONFIG = {
  supabaseUrl: window.__KL_CONFIG__?.supabaseUrl ?? '',
  supabaseKey: window.__KL_CONFIG__?.supabaseKey ?? '',
};
