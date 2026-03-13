// server.js — MVG Engine v4.4
// Uses system Chromium (via nixpacks) — works on Railway

import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createGunzip, createInflate, createBrotliDecompress } from 'zlib';
import https from 'https';
import http from 'http';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// ── Find system Chromium path ──
function findChromium() {
  // Environment variable override
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  
  const candidates = [
    '/run/current-system/sw/bin/chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/nix/var/nix/profiles/default/bin/chromium',
  ];
  
  for (const p of candidates) {
    try { execSync(`test -f ${p}`); return p; } catch {}
  }
  
  // Try which
  try { return execSync('which chromium 2>/dev/null || which chromium-browser 2>/dev/null').toString().trim(); } catch {}
  
  return null;
}

const CHROMIUM_PATH = findChromium();
console.log(`[INIT] Chromium path: ${CHROMIUM_PATH || 'NOT FOUND — will use puppeteer bundled'}`);

// ── CORS ──
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.static(join(__dirname, 'public')));

// ── STRIP HEADERS ──
const STRIP = new Set([
  'x-frame-options','content-security-policy','content-security-policy-report-only',
  'cross-origin-embedder-policy','cross-origin-opener-policy','cross-origin-resource-policy',
  'permissions-policy','content-encoding','transfer-encoding','connection','keep-alive',
]);

// ── USER AGENTS ──
const UAS = [
  'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.119 Mobile Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
];
const getUA = () => UAS[Math.floor(Math.random() * UAS.length)];

// ── BROWSER POOL ──
let browser = null;
let browserLaunchTime = null;
const BROWSER_TTL = 8 * 60 * 1000;

async function getBrowser() {
  const now = Date.now();
  if (browser && browserLaunchTime && (now - browserLaunchTime) > BROWSER_TTL) {
    console.log('[BROWSER] Recycling...');
    try { await browser.close(); } catch {}
    browser = null;
  }
  if (!browser) {
    const puppeteer = (await import('puppeteer')).default;
    const launchOpts = {
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--window-size=1366,768',
        '--user-agent=' + getUA(),
      ],
    };
    // Use system Chromium if available
    if (CHROMIUM_PATH) {
      launchOpts.executablePath = CHROMIUM_PATH;
      launchOpts.channel = undefined;
    }
    console.log('[BROWSER] Launching...');
    browser = await puppeteer.launch(launchOpts);
    browserLaunchTime = now;
    console.log('[BROWSER] Ready');
  }
  return browser;
}

// ── PUPPETEER FETCH ──
async function puppeteerFetch(urlStr) {
  const b = await getBrowser();
  const page = await b.newPage();
  const videoURLs = [];

  try {
    await page.setUserAgent(getUA());
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    // Intercept network requests to capture video URLs
    await page.setRequestInterception(true);
    page.on('request', req => {
      const u = req.url();
      if (isVideoURL(u)) {
        videoURLs.push({ url: u, src: 'NET' });
        console.log('[PUP-VIDEO]', u.slice(0, 80));
      }
      // Block images/fonts to speed up
      const rt = req.resourceType();
      if (['image','font','stylesheet'].includes(rt)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    page.on('response', resp => {
      const u = resp.url();
      if (isVideoURL(u)) videoURLs.push({ url: u, src: 'RESP' });
    });

    await page.goto(urlStr, { waitUntil: 'networkidle2', timeout: 30000 });
    
    // Wait extra for CF challenge
    await new Promise(r => setTimeout(r, 2500));

    const html = await page.content();
    return { html, videoURLs, finalUrl: page.url() };

  } finally {
    try { await page.close(); } catch {}
  }
}

// ── NATIVE FETCH ──
function nativeFetch(urlStr, depth = 0) {
  if (depth > 5) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlStr); } catch(e) { return reject(e); }

    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      timeout: 15000,
      rejectUnauthorized: false,
      headers: {
        'User-Agent': getUA(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
        'Referer': url.origin + '/',
      },
    }, (resp) => {
      if ([301,302,303,307,308].includes(resp.statusCode) && resp.headers.location) {
        let loc = resp.headers.location;
        if (loc.startsWith('/')) loc = url.origin + loc;
        else if (!loc.startsWith('http')) loc = url.origin + '/' + loc;
        resp.resume();
        return nativeFetch(loc, depth + 1).then(resolve).catch(reject);
      }
      const enc = (resp.headers['content-encoding'] || '').toLowerCase();
      let stream = resp;
      try {
        if (enc.includes('br'))           stream = resp.pipe(createBrotliDecompress());
        else if (enc.includes('gzip'))    stream = resp.pipe(createGunzip());
        else if (enc.includes('deflate')) stream = resp.pipe(createInflate());
      } catch { stream = resp; }
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => resolve({ status: resp.statusCode, headers: resp.headers, body: Buffer.concat(chunks) }));
      stream.on('error', () => resolve({ status: resp.statusCode, headers: resp.headers, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
    req.end();
  });
}

function isVideoURL(u) {
  if (!u || typeof u !== 'string' || u.length < 8) return false;
  return /\.(mp4|webm|m3u8|mpd|ts|m4s|mov|flv|m4v|avi|mkv|ogg)(\?|#|$)/i.test(u)
    || /\/hls\//i.test(u) || /\.m3u8(\?|$)/i.test(u)
    || /manifest\.m3u8/i.test(u) || /chunklist/i.test(u)
    || /videoplayback/i.test(u);
}

function isCFBlocked(status, body) {
  if (status === 403 || status === 429 || status === 503) return true;
  const html = Buffer.isBuffer(body) ? body.toString('utf8') : (body || '');
  return html.includes('__cf_chl') || html.includes('cf_clearance')
    || html.includes('Just a moment') || html.includes('Checking your browser')
    || html.includes('Enable JavaScript and cookies')
    || html.includes('cf-browser-verification');
}

// ── INJECT SCRIPT ──
const INJECT = `<script>
(function(){
  const P=window.parent;
  function isV(u){
    if(!u||typeof u!=='string'||u.length<8) return false;
    return /\\.(mp4|webm|m3u8|mpd|ts|m4s|mov|flv|m4v|avi|mkv|ogg)(\\?|#|$)/i.test(u)
      ||/\\/hls\\//i.test(u)||/\\.m3u8(\\?|$)/i.test(u)||/manifest\\.m3u8/i.test(u)
      ||/chunklist/i.test(u)||/videoplayback/i.test(u);
  }
  function send(url,src){try{P.postMessage({type:'MVG_VIDEO',url,src},'*');}catch{}}

  // Fix SecurityError: patch history
  try{
    const _ps=history.pushState.bind(history);
    const _rs=history.replaceState.bind(history);
    history.pushState=function(s,t,u){try{_ps(s,t,u);}catch{}};
    history.replaceState=function(s,t,u){try{_rs(s,t,u);}catch{}};
  }catch{}

  // Intercept fetch
  const _f=window.fetch.bind(window);
  window.fetch=function(i,o){const u=typeof i==='string'?i:(i&&i.url)||'';if(isV(u))send(u,'FETCH');return _f(i,o);};

  // Intercept XHR
  const _X=window.XMLHttpRequest;
  window.XMLHttpRequest=function(){const x=new _X();const _o=x.open.bind(x);x.open=function(m,u,...r){if(isV(u))send(u,'XHR');return _o(m,u,...r);};return x;};
  window.XMLHttpRequest.prototype=_X.prototype;

  // Watch DOM
  new MutationObserver(ms=>ms.forEach(m=>m.addedNodes.forEach(n=>{
    if(!n.tagName)return;
    if(/^(VIDEO|SOURCE)$/.test(n.tagName)){const s=n.src||n.getAttribute&&n.getAttribute('src')||'';if(s)send(s,'DOM');}
    if(n.querySelectorAll)n.querySelectorAll('video,source').forEach(e=>{const s=e.src||e.getAttribute('src')||'';if(s)send(s,'DOM');});
  }))).observe(document.documentElement,{childList:true,subtree:true});

  // Initial scan
  setTimeout(()=>{
    document.querySelectorAll('video,source').forEach(e=>{
      const s=e.src||e.currentSrc||e.getAttribute('src')||'';if(s)send(s,'INIT');
    });
    ['data-src','data-hls','data-video','data-stream','data-mp4'].forEach(a=>{
      document.querySelectorAll('['+a+']').forEach(e=>{const v=e.getAttribute(a)||'';if(v&&isV(v))send(v,'ATTR');});
    });
  },1500);
})();
</script>`;

function injectHTML(html, origin, videoURLs = []) {
  const base = `<base href="${origin}/">`;
  html = /<head/i.test(html)
    ? html.replace(/<head([^>]*)>/i, `<head$1>\n${base}`)
    : `<head>${base}</head>` + html;

  html = html.includes('</head>')
    ? html.replace('</head>', INJECT + '</head>')
    : INJECT + html;

  if (videoURLs.length > 0) {
    const push = `<script>setTimeout(function(){${
      videoURLs.map(v=>`window.parent.postMessage({type:'MVG_VIDEO',url:${JSON.stringify(v.url)},src:${JSON.stringify(v.src)}},'*');`).join('')
    }},800);</script>`;
    html = html.includes('</body>') ? html.replace('</body>', push + '</body>') : html + push;
  }
  return html;
}

// ── /proxy ──
app.get('/proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing url');

  let target;
  try {
    target = new URL(url);
    if (!['http:','https:'].includes(target.protocol)) throw new Error('Invalid protocol');
  } catch { return res.status(400).send('Invalid URL'); }

  console.log(`[PROXY] ${target.toString()}`);
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  try {
    // Try native first
    let usePuppeteer = false;
    let nativeResult = null;

    try {
      nativeResult = await nativeFetch(target.toString());
      if (isCFBlocked(nativeResult.status, nativeResult.body)) {
        console.log(`[PROXY] CF detected (${nativeResult.status}), switching to Puppeteer`);
        usePuppeteer = true;
      }
    } catch (e) {
      console.log(`[PROXY] Native failed: ${e.message}, switching to Puppeteer`);
      usePuppeteer = true;
    }

    if (!usePuppeteer && nativeResult) {
      // Native worked
      const ct = nativeResult.headers['content-type'] || 'text/html; charset=utf-8';
      Object.entries(nativeResult.headers).forEach(([k,v]) => {
        if (!STRIP.has(k.toLowerCase())) try { res.setHeader(k, v); } catch {}
      });
      res.setHeader('Content-Type', ct);
      res.setHeader('X-Proxy-Method', 'native');

      if (ct.includes('text/html')) {
        return res.status(nativeResult.status).send(injectHTML(nativeResult.body.toString('utf8'), target.origin));
      }
      return res.status(nativeResult.status).send(nativeResult.body);
    }

    // Puppeteer fallback
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Proxy-Method', 'puppeteer');
    const result = await puppeteerFetch(target.toString());
    return res.status(200).send(injectHTML(result.html, target.origin, result.videoURLs));

  } catch (err) {
    console.error('[PROXY ERR]', err.message);
    if (browser) { try { await browser.close(); } catch {} browser = null; }
    res.status(500).send(`
      <html><body style="background:#060911;color:#ff3355;font-family:monospace;padding:24px;line-height:1.8">
        <h2>⚠️ Proxy Error</h2>
        <p>${err.message}</p>
        <p style="color:#7b8ab8">
          Coba lagi — atau situs ini aktifkan CF Bot Fight Mode yang tidak bisa di-bypass.<br>
          Cek Railway logs untuk detail error.
        </p>
        <p><a href="/health" style="color:#00d4ff">Check /health</a></p>
      </body></html>
    `);
  }
});

app.get('/fetch', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  let target;
  try { target = new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
  try {
    const r = await nativeFetch(target.toString());
    res.json({ html: r.body.toString('utf8'), status: r.status, contentType: r.headers['content-type'] || '' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/health', (_, res) => res.json({
  status: 'ok', version: '4.4',
  chromium: CHROMIUM_PATH || 'bundled',
  browser: browser ? 'alive' : 'idle',
}));

process.on('SIGTERM', async () => {
  if (browser) try { await browser.close(); } catch {}
  process.exit(0);
});

app.listen(PORT, () => console.log(`MVG Engine v4.4 on port ${PORT}`));
