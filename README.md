# 対象行の再解放チェック（Playwright）

管理ダッシュボードを5分ごとに確認し、スタック中の行のうち、
担当が Secrets の `TARGET_WORKER` と完全一致する行だけを
再解放するスクリプトです。

決定事項（2026-11-11）：公開リポジトリ、5分ごと。

## ルール（絶対）

- 対象は担当列が `TARGET_WORKER` と完全一致する行だけです。
- それ以外の行の「再開放」は絶対に押しません。
- `DRY_RUN=true`（既定）では何もクリックしません。

## 公開用設計 — 名前・会社名を出さないために

このリポジトリは公開を前提にしています。公開リポジトリでは
Actions のログが誰でも読めるため、次を徹底しています。

- **URL・担当名はコードに書かない。** すべて Secrets から環境変数で渡す。
  - `DASHBOARD_URL` — 管理ダッシュボードのURL（`?page=dashboard` 付きのもの）
  - `TARGET_WORKER` — 対象の担当名（完全一致で判定）
  - `GOOGLE_STORAGE_STATE_B64` — ログイン済みセッション（下記参照）
- **ログ・JSON出力は件数だけ。** 出るのは次の形だけです。
  ```
  stuck=5 matched=1 untouched=4
  status=live found=1 released=1 untouched=4
  ```
  企業名・担当名・着手日時・行ID・URL・ページ内容は一切出しません。
  エラー時も、URLやページ内容が含まれうるメッセージは出さず、種類だけ出します。
- **スクリーンショット・トレース・アーティファクトは上げません。**
- **セッションは使い捨て。** ワークフローは実行中にだけ
  `storage-state.json` を作り、終了時（失敗時も）に必ず削除します。
  `storage-state.json` は `.gitignore` 済みで、絶対に Git に入れません。
- **トリガーは schedule と workflow_dispatch のみ。**
  pull_request では動きません。第三者アクションも使いません。

## 仕組み

- ダッシュボードは Google Apps Script 製で、入れ子の iframe の中にあります。
- スタック中一覧の行は「企業名 / 担当 / 着手 / [再開放ボタン]」の形です。
- このスクリプトは画面の表を読み、担当が対象と一致する行だけを対象にします。
- ダッシュボードの描画には10〜20秒かかることがあるため、待ち時間を長めに取っています。

## 使い方（ローカル）

```bash
cd playwright-murata
npm install
npx playwright install chromium --with-deps

# ドライラン（既定。クリックなし）
DASHBOARD_URL="<ダッシュボードURL>" TARGET_WORKER="<対象の担当名>" \
  DRY_RUN=true node check.js

# ライブ（セッション必須）
DASHBOARD_URL="<ダッシュボードURL>" TARGET_WORKER="<対象の担当名>" \
  DRY_RUN=false STORAGE_STATE=./storage-state.json node check.js
```

`DASHBOARD_URL` と `TARGET_WORKER` がないと、スクリプトは
「どちらかが欠けている」とだけ出して終了します。値は出しません。

## 認証の仕組み（storageState）

ダッシュボードには Google Workspace のセッションが必要です。
このスクリプトはログインを試みません。代わりに、Playwright の
`storageState`（ログイン済みブラウザのセッション情報のJSON）を渡します。

storageState の作り方（ローカルで、自分のブラウザでログインする）:

1. `npx playwright codegen <ダッシュボードURL>` を開き、表示される
   ブラウザで Google アカウントにログインしてダッシュボードが
   開けることを確認します。
2. 別途、小さなスクリプトで `context.storageState({ path: 'storage-state.json' })`
   を使って保存します。
3. `storage-state.json` は絶対に Git に入れません（`.gitignore` 済み）。
   パスワードやトークンをこのリポジトリやチャットに貼らないでください。

セッションには有効期限があります。切れたら作り直してください。

## GitHub Actions での動かし方

1. GitHub に**公開**リポジトリを作り、このフォルダの内容を push します。
   `.github` は隠しフォルダです。`git add .` で一緒に上がることを確認してください。
   `node_modules/` は push しません（`.gitignore` 済み）。
2. リポジトリの Settings → Secrets and variables → Actions で、
   次の3件の Secret を作ります。
   - `DASHBOARD_URL`
   - `TARGET_WORKER`
   - `GOOGLE_STORAGE_STATE_B64` — `storage-state.json` を base64 化したもの:
     ```bash
     base64 -w0 storage-state.json   # macOS は base64 -i storage-state.json
     ```
     出力された文字列をそのまま Secret に貼ります。
     この文字列をログやチャットに出さないでください。
3. `.github/workflows/check.yml` が5分ごとに `DRY_RUN=false` で実行します。
   手動実行は Actions タブの workflow_dispatch からもできます。
4. 初回は必ず **DRY_RUN で確認**してください。ワークフローを一時的に
   `DRY_RUN=true` にするか、ローカルでドライランして、
   ログに件数だけが出て、対象行が正しく数えられることを確認します。
   その後でライブに切り替えてください。

## 費用（公開・5分ごと）

- 公開リポジトリの標準ランナーは無料で無制限のため、5分ごとでも
  無料枠の心配はありません。
- 1日288回、月約8,640回になります。実行が重なった場合は
  `concurrency` で直列化しているため、同じ行を2回押すことはありません。

## 現状と注意点

- GitHub リポジトリはまだ作っていません。Secret もまだ設定していません。
  費用はまだ発生していません。
- ローカルでのドライランは、この調査用VMでは実行できませんでした。
  Chromium のダウンロードが途中で切れ、VM のプロキシ経由では
  Chromium からの接続が失敗したためです。これは VM の制限によるもので、
  コードの不具合ではありません。GitHub Actions のランナーは
  直接インターネットに出られるため、同じ問題は起きない想定です。
  初回の実行は GitHub Actions 上で確認する必要があります。
- 旧ドライランログは、URLを含んでいたため削除しました。
- 切り替えの前に、まずドライランで「対象行が正しく数えられること」と
  「対象以外の行に触れないこと」を確認してください。
  Muse の5分ごとチェックは、こちらが並走で動くことが確認できるまで止めません。
- 公開前にやること：`actions/checkout` と `actions/setup-node` を
  SHA で固定し直すこと（今回は GitHub API のレート制限で取得できず、
  v4 タグのままです）。また、初回実行後に Actions のログを開き、
  人名・会社名・URL が出ていないことを目視で確認してください。
