# デプロイ手順書（Cloudflare Pages／実機確認用）

2026-11-24 作成。本家（人狼NIGHT）の構成を踏襲する。
本家：Pages プロジェクト `werewolf-battle-revival`＋GitHub 接続、
build command＝`node scripts/build-pages-config.mjs`、output＝`client`、
production branch＝`master`、URL は https://werewolf-battle-revival.pages.dev

## むぜたん側で準備済み（2026-11-24）

- Lite リポジトリのローカルブランチを `main` → **`master`** に改名
  （本家の production branch に合わせた）
- リモート `origin` を登録済み：
  `ssh://git@ssh.github.com:443/Ogitandao/kotoba-jinrou-lite.git`
  （おぎの GitHub アカウント `Ogitandao`、本家と同じ SSH 形式）
- ビルドの動作確認済み：環境変数 `KL_SUPABASE_URL` / `KL_SUPABASE_KEY`
  から `client/kl-config.js` が生成され、URL・キーとも正しく入る
- ローカル配信テスト済み：index（タイトル「ことば人狼」）／
  kl-config.js／styles.css／vendor/supabase.js すべて HTTP 200
- `npm run verify:all` 全スイート PASS（デプロイ可能な状態）
- 直接アップロード用の zip を用意済み：
  `~/workspace/kotoba-jinrou-lite-client-upload.zip`
  （client の中身がルート。kl-config.js 生成済み入り。含まれるのは
  publishable key のみで、secret key は入っていない）

## 自動で完結できなかった理由（正直な記録）

- この VM の `gh` CLI は GitHub 未ログイン（`gh auth status` で確認）
- `wrangler`（4.168.0、npx 経由）も Cloudflare 未認証
  （`wrangler whoami` → not authenticated）
- GitHub への SSH 接続も現在プロキシ側でリセットされ
  （`kex_exchange_identification: read: Connection reset by peer`）、
  むぜたんからは push できない状態
- よって「GitHub リポジトリ作成」と「Cloudflare Pages プロジェクト
  作成＋GitHub 接続」はおぎの操作が必要。以下の手順どおりで迷わない

---

## 手順A（本命・本家と同じ GitHub 接続方式）

### A-1. GitHub で空のリポジトリを作る（おぎ）

1. https://github.com/new を開く（ログイン済みの `Ogitandao` で）
2. Repository name：**`kotoba-jinrou-lite`**
3. Public / Private は本家に合わせてどちらでも可
   （迷ったら Private でよい。Pages 接続時に読み取り許可を出す）
4. **「Add a README file」などの初期化チェックは全部オフ**
   （空のリポジトリにする。既にローカルに履歴があるため）
5. 「Create repository」を押す
6. 作ったら、むぜたんに「リポジトリ作った」と伝える
   → むぜたんが `git push -u origin master` を試行する
   （VM からの SSH が復旧していればそのまま完了。
   まだ塞がっている場合は、その時点で代替手段を案内する）

### A-2. Cloudflare Pages プロジェクトを作る（おぎ）

1. https://dash.cloudflare.com/ → 左メニュー「Workers & Pages」
2. 「Create」→「Pages」→「Connect to Git」
3. GitHub アカウントを連携し、リポジトリ **`kotoba-jinrou-lite`**
   を選択（初めての場合は Cloudflare の GitHub App にこの
   リポジトリへのアクセス許可を出す）
4. ビルド設定（本家と同形式）：
   - Project name：**`kotoba-jinrou-lite`**
     （公開 URL は https://kotoba-jinrou-lite.pages.dev になる）
   - Production branch：**`master`**
   - Framework preset：None
   - Build command：**`node scripts/build-pages-config.mjs`**
   - Build output directory：**`client`**
   - Root directory：空欄（リポジトリ直下）
5. 環境変数（「Environment variables」に2件追加。
   Production / Preview の両方に入れる）：
   - `KL_SUPABASE_URL` ＝ `https://dtdwkluanoaqiaruzbwe.supabase.co`
   - `KL_SUPABASE_KEY` ＝ Lite プロジェクトの **publishable key**
     - 値の確認場所：https://supabase.com/dashboard →
       プロジェクト `kotoba-jinrou-lite` → Settings → API Keys →
       **Publishable key**（`sb_publishable_` で始まるもの）
     - **Secret key（`sb_secret_`）は絶対に入れない**
     - 実値はこの手順書にもチャットにも書かない。ダッシュボードで
       コピーして直接貼る
6. 「Save and Deploy」を押す → 初回デプロイが走る

### A-3. デプロイ後の確認（むぜたん側でも確認する）

- https://kotoba-jinrou-lite.pages.dev が HTTP 200 で開き、
  タイトル「ことば人狼」のロビーが出ること
- 同 URL の `/kl-config.js` が開けて URL とキーが入っていること
  （これが空だとアプリがダミーモードで動く）

### A-4. （認証フェーズで実施）Supabase 側のリダイレクト許可

- Supabase ダッシュボード → `kotoba-jinrou-lite` →
  Authentication → URL Configuration → Redirect URLs に
  `https://kotoba-jinrou-lite.pages.dev/**` を追加する
- OAuth（Google/Apple）有効化と合わせて認証フェーズで行う。
  現時点（メールログイン＋自動確認ONの検証モード）では未追加でも
  実機確認は可能

---

## 手順B（近道・今日すぐ実機で触りたい場合の直接アップロード）

GitHub を経由せず、Cloudflare に直接 zip を上げて公開する方法。
ただし **この方式で作った Pages プロジェクトは後から Git 接続に
切り替えられない**（Git 方式にする時はプロジェクトを作り直す）。
「まず触ってみたい」用と割り切ること。

1. むぜたんから zip（`kotoba-jinrou-lite-client-upload.zip`）を
   受け取り、スマホに保存する
2. https://dash.cloudflare.com/ →「Workers & Pages」→「Create」→
   「Pages」→「Upload assets」
3. Project name：**`kotoba-jinrou-lite`**
4. zip をアップロード →「Deploy site」
5. https://kotoba-jinrou-lite.pages.dev で開けるようになる
   （環境変数の設定は不要。kl-config.js は zip に生成済み入り）

## 注意

- Cloudflare Pages は無料枠の範囲のみ使う（課金操作なし）
- 本家プロジェクト（werewolf-battle-revival）の GitHub / Cloudflare
  設定には一切触らない
- 今後の更新フロー（手順Aの場合）：むぜたんが master へ push →
  Pages が自動で再デプロイ（ビルド時に環境変数から kl-config.js
  を再生成するので、キーをコミットする必要は一切ない）
