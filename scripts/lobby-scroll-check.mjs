import puppeteer from 'puppeteer-core';
const CHROME = process.env.HOME + '/.cache/puppeteer/chrome/linux-158.0.8127.88/chrome-linux64/chrome';
const URL = 'file:///home/hatch/workspace/kotoba-jinrou-lite/client/index.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.emulate({
  viewport: { width: 420, height: 900, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36',
});
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.evaluateOnNewDocument(() => { try { localStorage.setItem('kl_rules_agreed', '1'); } catch {} });
await page.goto(URL, { waitUntil: 'load' });
await sleep(1200);
await page.evaluate(() => document.getElementById('btn-login-google').click());
await sleep(1800);

async function swipe(x, y0, dx, dy) {
  const cdp = await page.createCDPSession();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0, id: 1 }] });
  for (let i = 1; i <= 8; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x + Math.round(dx * (i / 8)), y: y0 + Math.round(dy * (i / 8)), id: 1 }],
    });
    await sleep(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
  await sleep(600);
}
async function center(sel) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }, sel);
}
async function scrollTop() { return page.evaluate(() => document.getElementById('scroll').scrollTop); }
async function resetScroll() { await page.evaluate(() => { document.getElementById('scroll').scrollTop = 0; }); await sleep(250); }

let c = await center('.ticker');
await swipe(c.x, c.y, 0, -300);
console.log('ティッカー上から縦:', await scrollTop()); await resetScroll();

c = await center('#gift-strip');
await swipe(c.x, c.y, 0, -300);
console.log('ギフト帯上から縦:', await scrollTop()); await resetScroll();

c = await center('#bonus-banner');
await swipe(c.x, c.y, 0, -300);
console.log('ボーナスバナー上から縦:', await scrollTop()); await resetScroll();

const stripInfo = await page.evaluate(() => {
  const g = document.getElementById('gift-strip');
  return { sw: g.scrollWidth, cw: g.clientWidth };
});
console.log('ギフト帯 scrollWidth/clientWidth:', JSON.stringify(stripInfo));
if (stripInfo.sw > stripInfo.cw) {
  c = await center('#gift-strip');
  await swipe(c.x, c.y, -240, 0);
  const sl = await page.evaluate(() => document.getElementById('gift-strip').scrollLeft);
  console.log('ギフト帯 横スワイプで帯が動く:', sl);
}

c = await center('#online-friends');
await swipe(c.x, c.y, 0, -300);
console.log('友達帯上から縦:', await scrollTop()); await resetScroll();

// 友達帯のタップでメニューが開くか
c = await center('#online-friends .friend-item');
if (c) {
  const cdp = await page.createCDPSession();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c.x, y: c.y, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
  await sleep(700);
  const menuOpen = await page.evaluate(() => {
    const m = document.getElementById('modal-friend-menu');
    return m ? getComputedStyle(m).display !== 'none' : 'no-modal-el';
  });
  console.log('友達タップでメニュー:', menuOpen);
}
await browser.close();
