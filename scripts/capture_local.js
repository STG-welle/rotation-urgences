const { chromium } = require('playwright');
const path = require('path');

(async () => {
  console.log('Starting Playwright with msedge channel...');
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    viewport: { width: 1300, height: 1600 },
    deviceScaleFactor: 2,
    timezoneId: 'Africa/Libreville',
    locale: 'fr-FR'
  });

  const page = await context.newPage();
  const filePath = path.resolve(__dirname, '../index.html').replace(/\\/g, '/');
  const targetUrl = `file://${filePath}?mode=capture&week=current`;
  console.log(`Navigating to: ${targetUrl}`);

  await page.goto(targetUrl, { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('#planning-screenshot-zone[data-loaded="true"]', { timeout: 30000 });
  await page.waitForTimeout(1200);

  const screenshotZone = await page.$('#planning-screenshot-zone');
  const outputPath = path.resolve(__dirname, '../planning-semaine.png');
  await screenshotZone.screenshot({ path: outputPath });
  console.log(`Updated screenshot saved to: ${outputPath}`);

  await browser.close();
  console.log('Capture complete!');
})();
