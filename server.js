// server.js — MVG Engine Backend
// Deploy ke Railway: https://railway.app
// Fungsi:
//   1. Serve static HTML (public/index.html)
//   2. /proxy?url=... → fetch situs, strip X-Frame-Options, return HTML
//   3. /fetch?url=... → fetch situs, return JSON {html, status, contentType}

import express from 'express';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

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

// ── STATIC FILES (serve the HTML app) ──
app.use(express.static(join(__dirname, 'public')));

// ── HEADERS TO STRIP ──
const STRIP = [
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'cross-origin-embedder-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'permissions-policy',
];

const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36';

// ── /proxy?url= ──
// Used by iframe src — returns the actual page with blocking headers stripped
app.get('/proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing url');

  let target;
  try {
    target = new URL(url);
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error('bad protocol');
  } catch {
    return res.status(400).send('Invalid URL');
  }

  try {
    const resp = await fetch(target.toString(), {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
        'Referer': target.origin + '/',
        'Cache-Control': 'no-cache',
      },
      redirect: 'follow',
      timeout: 15000,
    });

    const contentType = resp.headers.get('content-type') || 'text/html';

    // Forward headers, skip blocked ones
    resp.headers.forEach((val, key) => {
      if (!STRIP.includes(key.toLowerCase())) {
        try { res.setHeader(key, val); } catch {}
      }
    });

    // Override with permissive values
    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');

    if (contentType.includes('text/html')) {
      let html = await resp.text();

      // Inject base tag so relative URLs resolve to origin
      const baseTag = `<base href="${target.origin}/">`;
      if (/<head/i.test(html)) {
        html = html.replace(/<head([^>]*)>/i, `<head$1>\n${baseTag}`);
      } else {
        html = baseTag + html;
      }

      // Inject script to intercept network requests inside iframe
      // and postMessage video URLs back to parent
      const injected = `
<script>
(function(){
  const PARENT = window.parent;
  const VIDEO_RE = /\\.(mp4|webm|m3u8|mpd|ts|m4s|mov|flv|m4v|avi|mkv|ogg|ogv)(\\?|#|$)/i;
  function isVideo(u){ return u && VIDEO_RE.test(u) || /\\/hls\\//i.test(u) || /manifest\\.m3u8/i.test(u) || /\\.m3u8(\\?|$)/i.test(u); }
  function send(url, src){ try{ PARENT.postMessage({type:'MVG_VIDEO',url,src},'*'); }catch{} }

  // Intercept fetch
  const OF = window.fetch.bind(window);
  window.fetch = function(input, init){
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if(isVideo(url)) send(url, 'FETCH');
    return OF(input, init);
  };

  // Intercept XHR
  const OX = window.XMLHttpRequest;
  window.XMLHttpRequest = function(){
    const xhr = new OX();
    const oo = xhr.open.bind(xhr);
    xhr.open = function(m, url, ...r){ if(isVideo(url)) send(url,'XHR'); return oo(m,url,...r); };
    return xhr;
  };
  window.XMLHttpRequest.prototype = OX.prototype;

  // Watch video elements
  new MutationObserver(ms => {
    ms.forEach(m => {
      m.addedNodes.forEach(n => {
        if(!n.tagName) return;
        const tag = n.tagName.toUpperCase();
        if(tag==='VIDEO'||tag==='SOURCE'){
          const s = n.src||n.currentSrc||n.getAttribute('src')||'';
          if(s) send(s,'DOM');
        }
        if(n.querySelectorAll){
          n.querySelectorAll('video,source').forEach(el=>{
            const s=el.src||el.getAttribute('src')||'';
            if(s) send(s,'DOM');
          });
        }
      });
    });
  }).observe(document.documentElement||document.body, {childList:true,subtree:true});

  // Scan existing DOM
  setTimeout(()=>{
    document.querySelectorAll('video,source').forEach(el=>{
      const s=el.src||el.currentSrc||el.getAttribute('src')||'';
      if(s) send(s,'DOM-INIT');
    });
  }, 1000);
})();
</script>`;

      html = html.replace('</head>', injected + '</head>');
      res.status(resp.status).send(html);
    } else {
      const buf = await resp.arrayBuffer();
      res.status(resp.status).send(Buffer.from(buf));
    }

  } catch (err) {
    console.error('[PROXY ERR]', err.message);
    res.status(500).send(`
      <html><body style="background:#0a0d18;color:#ff3355;font-family:monospace;padding:20px">
        <h2>⚠️ Proxy Error</h2>
        <p>${err.message}</p>
        <p>URL: ${target.toString()}</p>
      </body></html>
    `);
  }
});

// ── /fetch?url= ──
// Used by the app for direct HTML analysis (returns JSON)
app.get('/fetch', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url' });

  let target;
  try { target = new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }

  try {
    const resp = await fetch(target.toString(), {
      headers: { 'User-Agent': UA, 'Accept': '*/*', 'Cache-Control': 'no-cache' },
      redirect: 'follow', timeout: 15000,
    });
    const contentType = resp.headers.get('content-type') || '';
    const html = await resp.text();
    res.json({ html, status: resp.status, contentType, finalUrl: resp.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── HEALTH ──
app.get('/health', (_, res) => res.json({ status: 'ok', version: '4.1' }));

app.listen(PORT, () => {
  console.log(`MVG Engine running on port ${PORT}`);
});
