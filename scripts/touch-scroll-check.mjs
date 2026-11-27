import puppeteer from 'puppeteer-core';

const CHROME = process.env.HOME + '/.cache/puppeteer/chrome/linux-158.0.8127.88/chrome-linux64/chrome';
const URL = 'file:///home/hatch/workspace/kotoba-jinrou-lite/client/index.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox'],
});
const page = await browser.newPage();
await page.emulate({
  viewport: { width: 420, height: 900, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
});
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.evaluateOnNewDocument(() => { try { localStorage.setItem('kl_rules_agreed', '1'); } catch {} });
await page.goto(URL, { waitUntil: 'load' });
await sleep(1200);
await page.evaluate(() => document.getElementById('btn-login-google').click());
await sleep(1500);
await page.evaluate(() => document.getElementById('tabbtn-friends').click());
await sleep(700);
await page.evaluate(() => document.getElementById('subtab-friend').click());
await sleep(900);

async function swipeUp() {
  const cdp = await page.createCDPSession();
  const rect = await page.evaluate(() => {
    const r = document.querySelector('.phone').getBoundingClientRect();
    return { left: r.left, width: r.width };
  });
  const x = Math.round(rect.left + rect.width / 2), y0 = 700, y1 = 300;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0, id: 1 }] });
  for (let i = 1; i <= 10; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 + (y1 - y0) * (i / 10), id: 1 }] });
    await sleep(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

const before = await page.evaluate(() => document.getElementById('scroll').scrollTop);
await swipeUp();
await sleep(600);
const after1 = await page.evaluate(() => document.getElementById('scroll').scrollTop);
await swipeUp();
await sleep(600);
const after2 = await page.evaluate(() => document.getElementById('scroll').scrollTop);
console.log('friend subtab: scrollTop', before, '->', after1, '->', after2);

// トークサブタブでも試す
await page.evaluate(() => document.getElementById('subtab-talk').click());
await sleep(700);
await page.evaluate(() => { document.getElementById('scroll').scrollTop = 0; });
await swipeUp();
await sleep(400);
const talk1 = await page.evaluate(() => document.getElementById('scroll').scrollTop);
await swipeUp();
await sleep(600);
const talkAfter = await page.evaluate(() => document.getElementById('scroll').scrollTop);
console.log('talk subtab: scrollTop', talk1, '->', talkAfter);

// ロビーでも試す
await page.evaluate(() => document.getElementById('tabbtn-lobby').click());
await sleep(700);
await page.evaluate(() => { document.getElementById('scroll').scrollTop = 0; });
await swipeUp();
await sleep(400);
const lobby1 = await page.evaluate(() => document.getElementById('scroll').scrollTop);
await swipeUp();
await sleep(600);
const lobbyAfter = await page.evaluate(() => document.getElementById('scroll').scrollTop);
console.log('lobby: scrollTop', lobby1, '->', lobbyAfter);

await browser.close();
