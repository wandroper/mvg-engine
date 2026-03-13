// server.js — MVG Engine v4.3
// Smart proxy: native fetch first, Puppeteer fallback for CF-protected sites

import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createGunzip, createInflate, createBrotliDecompress } from 'zlib';
import https from 'https';
import http from 'http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// ── CORS ──
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.static(join(__dirname, 'public')));

// ── HEADERS TO STRIP ──
const STRIP = new Set([
  'x-frame-options','content-security-policy','content-security-policy-report-only',
  'cross-origin-embedder-policy','cross-origin-opener-policy','cross-origin-resource-policy',
  'permissions-policy','content-encoding','transfer-encoding','connection','keep-alive',
]);

// ── USER AGENTS ──
const UAS = [
  'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.119 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.119 Mobile Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
];
const getUA = () => UAS[Math.floor(Math.random() * UAS.length)];

// ── PUPPETEER INSTANCE (lazy init, reuse browser) ──
let browser = null;
let browserLaunchTime = null;
const BROWSER_TTL = 10 * 60 * 1000; // recycle browser every 10 min

async function getBrowser() {
  const now = Date.now();
  // Recycle browser periodically to avoid memory leaks
  if (browser && browserLaunchTime && (now - browserLaunchTime) > BROWSER_TTL) {
    console.log('[BROWSER] Recycling browser...');
    try { await browser.close(); } catch {}
    browser = null;
  }

  if (!browser) {
    const puppeteer = await import('puppeteer');
    console.log('[BROWSER] Launching Puppeteer...');
    browser = await puppeteer.default.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',       // important for Railway/containers
        '--disable-gpu',
        '--disable-web-security', // allow cross-origin in headless
        '--disable-features=IsolateOrigins,site-per-process',
        '--window-size=1280,900',
      ],
    });
    browserLaunchTime = now;
    console.log('[BROWSER] Puppeteer ready');
  }
  return browser;
}

// ── PUPPETEER FETCH — for CF-protected sites ──
async function puppeteerFetch(urlStr) {
  const b = await getBrowser();
  const page = await b.newPage();

  try {
    const ua = getUA();
    await page.setUserAgent(ua);
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    });

    // Intercept & collect video URLs from network requests
    const videoURLs = [];
    await page.setRequestInterception(true);
    page.on('request', req => {
      const u = req.url();
      if (isVideoURL(u)) videoURLs.push({ url: u, src: 'PUPPETEER-NET' });
      req.continue();
    });
    page.on('response', async resp => {
      const u = resp.url();
      if (isVideoURL(u)) videoURLs.push({ url: u, src: 'PUPPETEER-RESP' });
    });

    // Navigate, wait for CF challenge to solve (up to 15s)
    await page.goto(urlStr, {
      waitUntil: 'networkidle2',
      timeout: 25000,
    });

    // Extra wait for CF JS challenge
    await page.waitForTimeout(2000);

    // Get final HTML after JS execution
    const html = await page.content();
    const finalUrl = page.url();

    return { html, videoURLs, finalUrl, method: 'puppeteer' };
  } finally {
    await page.close();
  }
}

// ── NATIVE HTTP FETCH — fast, for non-CF sites ──
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
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
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
        if (enc.includes('br'))         stream = resp.pipe(createBrotliDecompress());
        else if (enc.includes('gzip'))  stream = resp.pipe(createGunzip());
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

// ── VIDEO URL DETECTOR ──
function isVideoURL(u) {
  if (!u || typeof u !== 'string' || u.length < 8) return false;
  return /\.(mp4|webm|m3u8|mpd|ts|m4s|mov|flv|m4v|avi|mkv|ogg)(\?|#|$)/i.test(u)
    || /\/hls\//i.test(u) || /\.m3u8(\?|$)/i.test(u)
    || /manifest\.m3u8/i.test(u) || /chunklist/i.test(u)
    || /videoplayback/i.test(u);
}

// ── IS CLOUDFLARE? ──
function isCFBlocked(status, body) {
  if (status === 403 || status === 429 || status === 503) return true;
  const html = typeof body === 'string' ? body : body?.toString('utf8') || '';
  return html.includes('cf-browser-verification')
    || html.includes('__cf_chl')
    || html.includes('cf_clearance')
    || html.includes('Checking your browser')
    || html.includes('Just a moment')
    || html.includes('Enable JavaScript and cookies');
}

// ── INJECTION SCRIPT ──
const INJECT = `<script>
(function(){
  const P=window.parent;
  function isV(u){
    if(!u||typeof u!=='string'||u.length<8) return false;
    return /\\.(mp4|webm|m3u8|mpd|ts|m4s|mov|flv|m4v|avi|mkv|ogg)(\\?|#|$)/i.test(u)
      ||/\\/hls\\//i.test(u)||/\\.m3u8(\\?|$)/i.test(u)||/manifest\\.m3u8/i.test(u)
      ||/chunklist/i.test(u)||/videoplayback/i.test(u);
  }
  function send(url,src){ try{P.postMessage({type:'MVG_VIDEO',url,src},'*');}catch{} }

  // Patch history to avoid SecurityError
  try {
    const _push = history.pushState.bind(history);
    const _rep  = history.replaceState.bind(history);
    history.pushState    = function(s,t,u){ try{_push(s,t,u);}catch{} };
    history.replaceState = function(s,t,u){ try{_rep(s,t,u);}catch{} };
  } catch{}

  const _f=window.fetch.bind(window);
  window.fetch=function(i,o){const u=typeof i==='string'?i:(i&&i.url)||'';if(isV(u))send(u,'FETCH');return _f(i,o);};

  const _X=window.XMLHttpRequest;
  window.XMLHttpRequest=function(){const x=new _X();const _o=x.open.bind(x);x.open=function(m,u,...r){if(isV(u))send(u,'XHR');return _o(m,u,...r);};return x;};
  window.XMLHttpRequest.prototype=_X.prototype;

  new MutationObserver(ms=>ms.forEach(m=>m.addedNodes.forEach(n=>{
    if(!n.tagName)return;
    if(/^(VIDEO|SOURCE)$/.test(n.tagName)){const s=n.src||n.getAttribute&&n.getAttribute('src')||'';if(s)send(s,'DOM');}
    if(n.querySelectorAll)n.querySelectorAll('video,source').forEach(e=>{const s=e.src||e.getAttribute('src')||'';if(s)send(s,'DOM');});
  }))).observe(document.documentElement,{childList:true,subtree:true});

  setTimeout(()=>{
    document.querySelectorAll('video,source').forEach(e=>{const s=e.src||e.currentSrc||e.getAttribute('src')||'';if(s)send(s,'INIT');});
    document.querySelectorAll('[data-src],[data-hls],[data-video],[data-stream],[data-mp4]').forEach(e=>{
      ['data-src','data-hls','data-video','data-stream','data-mp4'].forEach(a=>{const v=e.getAttribute(a)||'';if(v&&isV(v))send(v,'ATTR');});
    });
  },1500);
})();
</script>`;

function buildHTML(html, origin, videoURLs = []) {
  const base = `<base href="${origin}/">`;

  // Inject base tag
  if (/<head/i.test(html)) {
    html = html.replace(/<head([^>]*)>/i, `<head$1>\n${base}`);
  } else {
    html = `<head>${base}</head>` + html;
  }

  // Inject detection script
  html = html.includes('</head>')
    ? html.replace('</head>', INJECT + '</head>')
    : INJECT + html;

  // If Puppeteer found video URLs, inject them as postMessages
  if (videoURLs.length > 0) {
    const pushScript = `<script>
setTimeout(function(){
  ${videoURLs.map(v => `window.parent.postMessage({type:'MVG_VIDEO',url:${JSON.stringify(v.url)},src:${JSON.stringify(v.src)}},'*');`).join('\n  ')}
},500);
</script>`;
    html = html.replace('</body>', pushScript + '</body>') || html + pushScript;
  }

  return html;
}

// ── /proxy?url= ──
app.get('/proxy', async (req, res) => {
  const { url, force } = req.query;
  if (!url) return res.status(400).send('Missing url');

  let target;
  try {
    target = new URL(url);
    if (!['http:','https:'].includes(target.protocol)) throw new Error('bad protocol');
  } catch { return res.status(400).send('Invalid URL'); }

  console.log(`[PROXY] ${target.toString()}`);

  // Set permissive response headers
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const usePuppeteer = force === 'puppeteer';

  try {
    // ── STEP 1: Try native fetch first (fast) ──
    if (!usePuppeteer) {
      try {
        const r = await nativeFetch(target.toString());
        const ct = r.headers['content-type'] || 'text/html; charset=utf-8';
        const bodyStr = r.body.toString('utf8');

        // Check if CF blocked
        if (!isCFBlocked(r.status, r.body)) {
          // Native fetch worked!
          Object.entries(r.headers).forEach(([k,v]) => {
            if (!STRIP.has(k.toLowerCase())) try { res.setHeader(k, v); } catch {}
          });
          res.setHeader('Content-Type', ct);

          if (ct.includes('text/html')) {
            const html = buildHTML(bodyStr, target.origin);
            return res.status(r.status).send(html);
          } else {
            return res.status(r.status).send(r.body);
          }
        }

        console.log(`[PROXY] CF detected (${r.status}), falling back to Puppeteer...`);
      } catch (nativeErr) {
        console.log(`[PROXY] Native fetch failed: ${nativeErr.message}, trying Puppeteer...`);
      }
    }

    // ── STEP 2: Puppeteer fallback for CF-protected sites ──
    console.log(`[PROXY] Using Puppeteer for ${target.toString()}`);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Proxy-Method', 'puppeteer');

    const result = await puppeteerFetch(target.toString());
    const html = buildHTML(result.html, target.origin, result.videoURLs);
    return res.status(200).send(html);

  } catch (err) {
    console.error('[PROXY ERR]', err.message, target?.toString());

    // Kill browser instance on crash so it restarts fresh
    if (browser) {
      try { await browser.close(); } catch {}
      browser = null;
    }

    res.status(500).send(`
      <html>
      <body style="background:#060911;color:#ff3355;font-family:monospace;padding:24px;line-height:1.8">
        <h2>⚠️ Proxy Error</h2>
        <p><b>Error:</b> ${err.message}</p>
        <p><b>URL:</b> ${target}</p>
        <p style="color:#7b8ab8">Kemungkinan penyebab:<br>
        • Situs memblokir semua proxy/server<br>
        • CF Bot Fight Mode aktif (tidak bisa di-bypass)<br>
        • Situs offline / timeout</p>
      </body></html>
    `);
  }
});

// ── /fetch?url= ──
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

// ── HEALTH ──
app.get('/health', (_, res) => res.json({
  status: 'ok', version: '4.3',
  browser: browser ? 'alive' : 'not started',
}));

// ── GRACEFUL SHUTDOWN ──
process.on('SIGTERM', async () => {
  if (browser) { try { await browser.close(); } catch {} }
  process.exit(0);
});

app.listen(PORT, () => console.log(`MVG Engine v4.3 on port ${PORT}`));
