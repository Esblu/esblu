// Mock-backend screenshot rig: real Esblu UI (next dev), synthetic demo data.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');
const MOCK = 'https://mock.supabase.test';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const UID = '0d3f6c1e-5a1b-4c2d-9e8f-000000000001';
const now = Math.floor(Date.now() / 1000);
const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: UID, role: 'authenticated', aud: 'authenticated', exp: now + 86400 * 30, iat: now, email: 'demo@esblu-demo.sk' })}.sig`;
const user = { id: UID, aud: 'authenticated', role: 'authenticated', email: 'demo@esblu-demo.sk', email_confirmed_at: '2026-11-01T08:00:00Z', app_metadata: { provider: 'email' }, user_metadata: {}, created_at: '2026-11-01T08:00:00Z' };
const session = { access_token: jwt, token_type: 'bearer', expires_in: 86400 * 30, expires_at: now + 86400 * 30, refresh_token: 'mock-refresh', user };
let handlers = {};
try { handlers = require('./handlers.js'); } catch (e) { console.error('no handlers', e.message); }
(async () => {
  const [, , path = '/', out = 'out.png', w = '1440', h = '900', logFile = 'requests.log'] = process.argv;
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ viewport: { width: +w, height: +h }, deviceScaleFactor: +w < 600 ? 2 : 1, locale: 'sk-SK', isMobile: +w < 600, hasTouch: +w < 600 });
  const log = [];
  await ctx.addInitScript(([s, nos]) => { try { if (!nos) localStorage.setItem('sb-mock-auth-token', s); localStorage.setItem('esblu_locale', 'sk'); } catch {} }, [JSON.stringify(session), !!process.env.NOSESSION]);
  await ctx.route(MOCK + '/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const key = `${req.method()} ${url.pathname}`;
    let body = req.postData();
    log.push(`${key}${url.search} ${body ? body.slice(0, 200) : ''}`);
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    let res = handlers.handle ? handlers.handle({ method: req.method(), path: url.pathname, search: url.searchParams, body, user, headers: req.headers() }) : undefined;
    if (url.pathname === '/auth/v1/user') res = user;
    if (url.pathname.startsWith('/auth/v1/token')) res = session;
    if (res === undefined) res = url.pathname.startsWith('/rest/v1/rpc/') ? null : [];
    const single = (req.headers()['accept'] || '').includes('vnd.pgrst.object');
    if (single && Array.isArray(res)) res = res[0] ?? null;
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'content-range': '0-0/*' }, body: JSON.stringify(res) });
  });
  await ctx.route(/realtime|websocket/, (r) => r.abort());
  const W = {Light:300, Regular:400, Medium:500, SemiBold:600, Bold:700, Black:900};
  const fontCss = Object.entries(W).map(([n, w]) => `@font-face{font-family:'GeistShot';src:url(data:font/woff2;base64,${fs.readFileSync((process.env.GEIST_DIR || 'node_modules/geist/dist/fonts/geist-sans') + '/Geist-' + n + '.woff2').toString('base64')}) format('woff2');font-weight:${w};font-display:block}`).join('') + `:root{--font-geist-sans:'GeistShot'!important}html,body,button,input,textarea,select{font-family:'GeistShot',Arial,sans-serif!important}`;
  await ctx.addInitScript(([css]) => { const add = () => { const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st); }; if (document.head) add(); else document.addEventListener('DOMContentLoaded', add); }, [fontCss]);
  const page = await ctx.newPage();
  const at = new Date(); at.setHours(9, 30, 0, 0); await page.clock.install({ time: at });
  page.on('pageerror', (e) => log.push('PAGEERROR ' + String(e).slice(0, 300)));
  await page.goto('http://localhost:3100' + path, { waitUntil: 'load', timeout: 120000 });
  await page.waitForTimeout(+process.env.WAIT || 6000);
  await page.addStyleTag({ content: 'nextjs-portal{display:none!important}' });
  await page.screenshot({ path: out, fullPage: !!process.env.FULL, animations: 'disabled', timeout: 60000 });
  fs.writeFileSync(logFile, log.join('\n'));
  console.log('ok', out, log.length);
  await browser.close();
})().catch((e) => { console.error(String(e).slice(0, 400)); process.exit(1); });
