# OAuth（Google / Apple）有効化手順書（Lite）

Lite のログインは本家と同じ OAuth 方式（Google＋Apple ID の2つ。
メール＋パスワード方式は作らない：本家の教訓）。この手順は
**おぎが各ダッシュボードで実施**するもの。実施自体はむぜたんでは
できない（各プロバイダの管理者操作が必要なため）。

前提値（Lite プロジェクト）：
- Supabase プロジェクト URL：`https://dtdwkluanoaqiaruzbwe.supabase.co`
- OAuth コールバック URL（両プロバイダ共通で使う）：
  `https://dtdwkluanoaqiaruzbwe.supabase.co/auth/v1/callback`

現在の状態（2026-11-26 更新）：
- **Google：有効化済み・配線完了**。おぎが Google Cloud Console で
  OAuth クライアントを作成し、Supabase Providers → Google に登録して
  Enabled 化（`/auth/v1/settings` で `external.google = true` を確認）。
  同意画面は「公開（本番）」に切替済みで、アプリ名は「ことば人狼」。
  クライアント側の配線（ログイン画面→実 OAuth、実 signOut、初回の
  名前＋生年月日セットアップ）も完了（追補55）
- **Apple：未有効化のまま後回し**（ログインのみでも Apple Developer
  Program 年99ドルが前提のため。App Store 進出の判断とセットで再開）

## 共通：Supabase 側の URL 設定（実施済み）

1. ダッシュボード → **Authentication → URL Configuration**
2. **Site URL**：`https://kotoba-jinrou-lite.pages.dev`（設定済み）
3. **Redirect URLs**：`https://kotoba-jinrou-lite.pages.dev`（設定済み。
   クライアントは `redirectTo = location.origin` で戻す）

## Google（実施済み・2026-11-26）

以下は実施記録として残す（再設定時の参照用）。

1. [Google Cloud Console](https://console.cloud.google.com/) で
   プロジェクトを作成（本家と分けたい場合は新規。同じプロジェクト
   内に Lite 用の認証情報を追加してもよい）
2. **APIとサービス → 認証情報 → 認証情報を作成 → OAuth クライアント ID**
   - アプリケーションの種類：**ウェブ アプリケーション**
   - 承認済みのリダイレクト URI にコールバック URL を追加：
     `https://dtdwkluanoaqiaruzbwe.supabase.co/auth/v1/callback`
3. 発行された **クライアント ID** と **クライアント シークレット** を控える
4. Supabase ダッシュボード → **Authentication → Providers → Google**
   を開き、Enable を ON にして ID とシークレットを貼り、Save
5. 注意：OAuth 同意画面が「テスト」状態だとテストユーザーしか
   ログインできない。本番利用時は同意画面を「公開」にすること
   （本家で踏んだ手順と同じ）

## Apple

前提：Apple Developer Program（有料）への登録が済んでいること。
iOS 提出の直前まで後回しでもよい（Android 先行の方針）。

1. [Apple Developer](https://developer.apple.com/account/) →
   **Certificates, Identifiers & Profiles**
2. **Identifiers** で App ID を用意し、**Sign In with Apple** を有効化
3. **Services ID** を新規作成（Web 認証用の識別子）し、Sign In with
   Apple を有効化して、戻り URL にコールバック URL を登録：
   `https://dtdwkluanoaqiaruzbwe.supabase.co/auth/v1/callback`
4. **Keys** で Sign In with Apple 用のキーを作成し、.p8 ファイルを
   ダウンロード（再ダウンロード不可なので保管を忘れずに）。
   Key ID と Team ID も控える
5. Supabase ダッシュボード → **Authentication → Providers → Apple**
   を開き、Enable を ON にして、Services ID（Client ID）・Team ID・
   Key ID・.p8 の中身を貼り、Save
   （Supabase 側がこれらからクライアントシークレット（JWT）を生成する）

## 有効化の確認方法

どちらか一方でも有効化したら、むぜたんに連絡すれば
`/auth/v1/settings` の `external.google` / `external.apple` が
`true` になっているかを API で確認できる（疎通確認済みの方法）。

## ハマりどころメモ

- **User support email はユーザーに見える**：Google のログイン同意画面で
  アプリ情報として表示される。現在は個人の Gmail を設定済みのため、
  公開前に事業用の受け口（既存の屋号メール等）へ差し替えるのが
  検討事項（Developer contact information の方は Google からの通知専用で
  ユーザーには見えない）
- コールバック URL は **Supabase のプロジェクト URL** の方を使う
  （アプリの URL ではない）。プロバイダ側の登録と Supabase 側の
  設定はこの URL で一致させる
- Google のシークレットと Apple の .p8 は **チャットに貼らない**。
  入力はダッシュボード上でおぎ自身が行う（むぜたんは値を保持しない）
- Apple は「他のソーシャルログインを入れるなら Sign in with Apple
  も必須」という App Store 審査要件があるため、iOS 提出前に必ず
  有効化すること
