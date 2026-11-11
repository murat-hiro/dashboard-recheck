// ログイン状態（storageState）を作るための小さなスクリプト
// 使い方（自分のPCで）:
//   1. このリポジトリを自分のPCに clone / ダウンロードする
//   2. npm install
//   3. npx playwright install chromium
//   4. 下の DASHBOARD_URL をダッシュボードのURLに書き換える
//      （?page=dashboard 付きのもの）
//   5. node save-storage-state.js を実行する
//   6. 開いたブラウザで Google アカウントにログインし、
//      ダッシュボードが開けたら、ターミナルで Enter を押す
//   7. storage-state.json が作られる
//   8. base64 化して GitHub の Secret GOOGLE_STORAGE_STATE_B64 に貼る
//      macOS:   base64 -i storage-state.json
//      Linux:   base64 -w0 storage-state.json
//      Windows (PowerShell):
//        [Convert]::ToBase64String([IO.File]::ReadAllBytes("storage-state.json"))
//
// 注意:
// - storage-state.json は絶対に Git に入れないこと。
//   このリポジトリの .gitignore に入っている。
// - base64 にした文字列や storage-state.json の中身を
//   チャットやリポジトリに貼らないこと。
// - セッションには有効期限がある。切れたら作り直すこと。

const { chromium } = require('playwright');

const DASHBOARD_URL = 'https://example.invalid/replace-with-dashboard-url';

async function main() {
  if (DASHBOARD_URL.includes('example.invalid')) {
    console.error('DASHBOARD_URL をダッシュボードのURLに書き換えてください。');
    process.exit(2);
  }
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('ブラウザでログインしてダッシュボードが開けたら、ここで Enter を押してください。');
  await new Promise((resolve) => process.stdin.once('data', resolve));
  await context.storageState({ path: 'storage-state.json' });
  console.log('storage-state.json を保存しました。');
  await browser.close();
}

main().catch((e) => {
  console.error(e.name || 'Error');
  process.exit(1);
});
