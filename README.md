# ことば人狼（人狼NIGHT Lite）

本家「人狼NIGHT」から「ワードウルフ（テキストのみ）＋個人チャット」を
抽出した独立アプリ。ボイスなし・常駐サーバーなしで、Supabase だけで
回す設計（計画の正本は本家リポジトリの `docs/lite-plan-draft.md`）。

本家とはコードを共有しない独立プロジェクト。流用部品はコピーして
取り込んでいる（出所は docs/handover.md に記録）。

## 現在の状態（基盤フェーズ）

- ロビー画面（タブ1）を基準モックv1準拠で実装済み。データはダミー
  （`client/js/dummy-data.js`）で、Supabase 未接続時はダミーモードで動く
- フレンドタブ（タブ2）は枠のみ（トーク／フレンドのサブタブ切り替え可）
- 検証：`npm run verify`（jsdom、25項目）

## ローカルで開く

`client/index.html` をブラウザで開くか、任意の静的サーバーで
`client/` を配信する（例：`npx serve client`）。
`client/kl-config.js` が無い状態ではダミーモードになる（正常）。

## 配信時設定

Cloudflare Pages のビルドで環境変数 `KL_SUPABASE_URL` /
`KL_SUPABASE_KEY` から `client/kl-config.js` を生成する：

```
npm run build:pages-config
```

実値はリポジトリにコミットしない（`kl-config.js` は .gitignore 済み）。

## 構成

- `client/` — クライアント本体（index.html / styles.css / config.js /
  js/app.js / js/dummy-data.js / vendor/supabase.js）
- `scripts/` — build-pages-config.mjs（設定生成）、verify-lobby.mjs（検証）
- `docs/handover.md` — 構成の詳細と次フェーズへの引き継ぎ
