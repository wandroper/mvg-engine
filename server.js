// server.js — MVG Engine Backend v4.2
// Fix: ERR_CONTENT_DECODING_FAILED + 403 blocked

import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createGunzip, createInflate, createBrotliDecompress } from 'zlib';
import https from 'https';
import http from 'http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.static(join(__dirname, 'public')));

const STRIP = new Set([
  'x-frame-options','content-security-policy','content-security-policy-report-only',
  'cross-origin-embedder-policy','cross-origin-opener-policy','cross-origin-resource-policy',
  'permissions-policy','content-encoding','transfer-encoding','connection','keep-alive',
]);

const UAS = [
  'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.119 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.119 Mobile Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
];
const getUA = () => UAS[Math.floor(Math.random() * UAS.length)];

// Native fetch with manual decompression — fixes ERR_CONTENT_DECODING_FAILED
function fetchURL(urlStr, depth = 0) {
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
      timeout: 20000,
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
      // Follow redirects
      if ([301,302,303,307,308].includes(resp.statusCode) && resp.headers.location) {
        let loc = resp.headers.location;
        if (loc.startsWith('/')) loc = url.origin + loc;
        else if (!loc.startsWith('http')) loc = url.origin + '/' + loc;
        resp.resume();
        return fetchURL(loc, depth + 1).then(resolve).catch(reject);
      }

      // Decompress
      const enc = (resp.headers['content-encoding'] || '').toLowerCase();
      let stream = resp;
      try {
        if (enc.includes('br'))      stream = resp.pipe(createBrotliDecompress());
        else if (enc.includes('gzip')) stream = resp.pipe(createGunzip());
        else if (enc.includes('deflate')) stream = resp.pipe(createInflate());
      } catch(e) {
        stream = resp; // fallback — use raw if decompressor fails
      }

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

app.get('/proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing url');

  let target;
  try {
    target = new URL(url);
    if (!['http:','https:'].includes(target.protocol)) throw new Error('bad protocol');
  } catch { return res.status(400).send('Invalid URL'); }

  console.log(`[PROXY] ${target.toString()}`);

  try {
    const r = await fetchURL(target.toString());
    const ct = r.headers['content-type'] || 'text/html; charset=utf-8';

    Object.entries(r.headers).forEach(([k,v]) => {
      if (!STRIP.has(k.toLowerCase())) try { res.setHeader(k, v); } catch {}
    });
    res.setHeader('Content-Type', ct);
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');

    if (ct.includes('text/html')) {
      let html = r.body.toString('utf8');
      const base = `<base href="${target.origin}/">`;
      html = /<head/i.test(html) ? html.replace(/<head([^>]*)>/i, `<head$1>\n${base}`) : base + html;
      html = html.includes('</head>') ? html.replace('</head>', INJECT + '</head>') : INJECT + html;
      res.status(r.status).send(html);
    } else {
      res.status(r.status).send(r.body);
    }
  } catch (err) {
    console.error('[PROXY ERR]', err.message);
    res.status(500).send(`<html><body style="background:#060911;color:#ff3355;font-family:monospace;padding:20px">
      <h2>Proxy Error</h2><p>${err.message}</p><p>URL: ${target}</p>
      <p style="color:#7b8ab8">Kemungkinan: situs block server, offline, atau timeout</p>
    </body></html>`);
  }
});

app.get('/fetch', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  let target;
  try { target = new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
  try {
    const r = await fetchURL(target.toString());
    res.json({ html: r.body.toString('utf8'), status: r.status, contentType: r.headers['content-type'] || '' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/health', (_, res) => res.json({ status: 'ok', version: '4.2' }));

app.listen(PORT, () => console.log(`MVG Engine v4.2 on port ${PORT}`));
