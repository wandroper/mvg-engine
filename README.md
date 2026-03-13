# MVG Engine v4.1 — Railway Deploy

## Deploy ke Railway (5 menit)

### 1. Push ke GitHub
```bash
git init
git add .
git commit -m "MVG Engine v4.1"
git remote add origin https://github.com/USERNAME/mvg-engine.git
git push -u origin main
```

### 2. Deploy ke Railway
1. Buka https://railway.app
2. Klik **New Project** → **Deploy from GitHub repo**
3. Pilih repo `mvg-engine`
4. Railway auto-detect Node.js, langsung deploy
5. Klik **Generate Domain** → dapat URL gratis

### 3. Buka di HP
Buka URL Railway di browser manapun (Brave, Chrome, Firefox)
— langsung bisa dipakai, tidak perlu setup apapun.

## Cara Kerja
```
HP Browser
  → buka https://your-app.up.railway.app
  → masukkan URL situs video → GO
  → iframe src = /proxy?url=https://target-site.com
  → Railway server fetch situs, strip X-Frame-Options
  → iframe tampil normal ✅
  → postMessage inject deteksi video ke iframe
  → URL video muncul di panel kanan ✅
```

## File Structure
```
mvg-railway/
├── server.js          # Express proxy server
├── package.json       # Dependencies
├── public/
│   └── index.html     # Frontend app
└── README.md
```

## API Endpoints
- `GET /` — Frontend app
- `GET /proxy?url=URL` — Proxy any URL (strips X-Frame-Options)
- `GET /fetch?url=URL` — Fetch URL, return JSON {html, status, contentType}
- `GET /health` — Health check
