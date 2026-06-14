const { chromium } = require('@playwright/test');
const path = require('path');

(async () => {
  const extensionPath = path.join(__dirname, '..', 'dist');

  const context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      `--headless=new`
    ]
  });

  const page = await context.newPage();

  // Find extension ID
  let [background] = context.serviceWorkers();
  if (!background) {
    background = await context.waitForEvent('serviceworker');
  }
  const extensionId = background.url().split('/')[2];

  const popupUrl = `chrome-extension://${extensionId}/popup.html`;

  await page.goto(popupUrl);
  await page.waitForTimeout(2500);

  await page.screenshot({ path: path.join(__dirname, 'screenshot-real-models.png'), fullPage: true });

  await context.close();
})();
