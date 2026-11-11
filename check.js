// 公開リポジトリ用 — 対象行のみ再解放する Playwright スクリプト
//
// 公開用設計:
// - ダッシュボードURL・対象担当名はコードに書かない。環境変数で渡す。
//   DASHBOARD_URL, TARGET_WORKER は必須（Secrets から渡す）。
// - ログ・JSON出力には件数だけを出す。企業名・担当名・着手日時・行ID・
//   URL・ページ内容は一切出さない。
// - スクリーンショット・トレース・動画は撮らない。アーティファクトも上げない。
// - このスクリプトはログインを試みない。セッションがなければ
//   サインイン画面に到達したことを件数なしで報告して終了する。
//
// 使い方:
//   DRY_RUN=true  node check.js   # 既定。クリックなし
//   DRY_RUN=false node check.js   # ライブ。storageState が必要
//   STORAGE_STATE=./storage-state.json DRY_RUN=true node check.js

const { chromium } = require('playwright');
const fs = require('fs');

const DASHBOARD_URL = process.env.DASHBOARD_URL || '';
const TARGET_WORKER = process.env.TARGET_WORKER || '';
const DRY_RUN = process.env.DRY_RUN !== 'false'; // 既定 true
const STORAGE_STATE = process.env.STORAGE_STATE || undefined;
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || undefined;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// 全フレームを走査してスタック中一覧の行を集める（内部用のみ）。
// 行の詳細はログに出さない。返り値は照合のためだけに使う。
async function scanStuckRows(page) {
  const rows = [];
  for (const frame of page.frames()) {
    let trCount = 0;
    try {
      trCount = await frame.locator('table tbody tr').count();
    } catch {
      continue;
    }
    if (trCount === 0) continue;
    for (let i = 0; i < trCount; i++) {
      const tr = frame.locator('table tbody tr').nth(i);
      let cells = [];
      try {
        cells = await tr.locator('td').allTextContents();
      } catch {
        continue;
      }
      cells = cells.map((c) => (c || '').trim());
      if (cells.length < 3 || !cells[1]) continue;
      const [company, worker, since] = cells;
      let hasReopenButton = false;
      try {
        hasReopenButton =
          (await tr.locator('button:has-text("再開放")').count()) > 0;
      } catch {
        hasReopenButton = false;
      }
      rows.push({ company, worker, since, hasReopenButton, frameUrl: frame.url(), rowIndex: i });
    }
  }
  return rows;
}

async function pressUpdate(page) {
  for (const frame of page.frames()) {
    try {
      const btn = frame.locator('button:has-text("更新")').first();
      if ((await btn.count()) > 0) {
        await btn.click({ timeout: 5000 });
        return true;
      }
    } catch {
      // 次のフレームへ
    }
  }
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  return false;
}

async function detectSignIn(page) {
  const url = page.url();
  if (/accounts\.google\.com/.test(url)) return true;
  try {
    const text = (await page.content()).slice(0, 20000);
    if (/Google アカウントにログイン|Sign in with Google|メールアドレスまたは電話番号/.test(text)) return true;
  } catch {
    // 無視
  }
  return false;
}

async function main() {
  const checkedAt = new Date().toISOString();
  if (!DASHBOARD_URL || !TARGET_WORKER) {
    // 値は出さない。どちらが欠けているかだけ出す。
    console.error('error: DASHBOARD_URL or TARGET_WORKER is missing');
    process.exit(2);
  }
  log(`start dry_run=${DRY_RUN}`);

  const launchOpts = { headless: true };
  if (CHROMIUM_PATH) launchOpts.executablePath = CHROMIUM_PATH;
  const proxyServer = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (proxyServer) {
    const u = new URL(proxyServer);
    const server = `${u.protocol}//${u.host}`;
    launchOpts.proxy = { server };
    if (u.username) launchOpts.proxy.username = decodeURIComponent(u.username);
    if (u.password) launchOpts.proxy.password = decodeURIComponent(u.password);
  }
  const browser = await chromium.launch(launchOpts);
  const contextOpts = {};
  if (process.env.PLAYWRIGHT_IGNORE_HTTPS_ERRORS === 'true') {
    contextOpts.ignoreHTTPSErrors = true;
  }
  if (STORAGE_STATE) {
    if (!fs.existsSync(STORAGE_STATE)) {
      console.error('error: storageState file not found');
      await browser.close();
      process.exit(2);
    }
    contextOpts.storageState = STORAGE_STATE;
  }
  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();

  try {
    await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    if (await detectSignIn(page)) {
      log('status=sign-in-required');
      console.log(JSON.stringify({ checkedAt, status: 'sign-in-required', foundCount: 0, releasedCount: 0, untouchedCount: 0 }));
      return;
    }

    await page.waitForTimeout(25000);

    if (await detectSignIn(page)) {
      log('status=sign-in-required');
      console.log(JSON.stringify({ checkedAt, status: 'sign-in-required', foundCount: 0, releasedCount: 0, untouchedCount: 0 }));
      return;
    }

    try {
      await pressUpdate(page);
      await page.waitForTimeout(20000);
    } catch {
      log('note=update-retry');
    }

    let rows = await scanStuckRows(page);
    const matching = rows.filter((r) => r.worker === TARGET_WORKER);
    const untouchedCount = rows.filter((r) => r.worker !== TARGET_WORKER).length;
    log(`stuck=${rows.length} matched=${matching.length} untouched=${untouchedCount}`);

    if (DRY_RUN) {
      log('status=dry-run released=0');
      console.log(JSON.stringify({ checkedAt, status: 'dry-run', foundCount: matching.length, releasedCount: 0, untouchedCount }));
      return;
    }

    // ライブモード: 一致する行を1件ずつ処理する。
    // 行を消すたびに一覧が変わるため、毎回スキャンし直す。
    let releasedCount = 0;
    const maxIterations = 20;
    for (let iter = 0; iter < maxIterations; iter++) {
      rows = await scanStuckRows(page);
      const next = rows.find((r) => r.worker === TARGET_WORKER && r.hasReopenButton);
      if (!next) break;

      let clicked = false;
      for (const frame of page.frames()) {
        if (frame.url() !== next.frameUrl) continue;
        const tr = frame.locator('table tbody tr').nth(next.rowIndex);
        const btn = tr.locator('button:has-text("再開放")').first();
        if ((await btn.count()) > 0) {
          await btn.click({ timeout: 10000 });
          clicked = true;
          break;
        }
      }
      if (!clicked) {
        log('note=click-failed');
        break;
      }
      await page.waitForTimeout(5000);
      await pressUpdate(page);
      await page.waitForTimeout(15000);

      const after = await scanStuckRows(page);
      const stillThere = after.some(
        (r) => r.worker === TARGET_WORKER && r.company === next.company && r.since === next.since,
      );
      if (stillThere) {
        log('note=still-present-after-release');
      } else {
        releasedCount += 1;
        log(`released=${releasedCount}`);
      }
    }

    const finalRows = await scanStuckRows(page);
    const finalUntouched = finalRows.filter((r) => r.worker !== TARGET_WORKER).length;
    log(`status=live found=${matching.length} released=${releasedCount} untouched=${finalUntouched}`);
    console.log(JSON.stringify({ checkedAt, status: 'live', foundCount: matching.length, releasedCount, untouchedCount: finalUntouched }));
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  // エラーメッセージには URL やページ内容が含まれることがあるため出さない。
  // 種類だけ出す。
  console.error(`error: ${e && e.name ? e.name : 'Error'}`);
  process.exit(1);
});
