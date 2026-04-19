#!/usr/bin/env node
'use strict';

const http  = require('http');
const https = require('https');

const TBA_KEY    = process.env.TBA_API_KEY    || '';
const YT_KEY     = process.env.YOUTUBE_API_KEY || '';
const FRC_USER   = process.env.FRC_API_USERNAME || '';
const FRC_TOKEN  = process.env.FRC_API_TOKEN    || '';
const TBA_BASE   = 'https://www.thebluealliance.com/api/v3';
const FRC_BASE   = 'https://frc-api.firstinspires.org/v3.0';
const PORT       = 3001;
const DIAG_PORT  = 3002;
const IDLE_MS    = 10 * 60 * 1000;         // TBA: evict after 10 min idle
const FRC_TTL    = 4 * 24 * 60 * 60 * 1000; // FRC: keep for 4 days

// ip → { firstSeen: number, lastSeen: number }
const userActivity = new Map();

// path → { data: object, etag: string|null, lastAccessed: number }
const cache = new Map();

// path → { data: object, etag: string|null, cachedAt: number }
const frcCache = new Map();

// streamUrl → { live: bool, ts: number }
const ytCache  = new Map();
const YT_TTL   = 2 * 60 * 1000; // re-check every 2 minutes

// Outbound API call timestamps (trimmed to 8 days in eviction loop)
const apiLog = { tba: [], frc: [], yt: [] };
// Incoming request timestamps per endpoint (same retention)
const reqLog = { tba: [], frc: [], yt: [] };

setInterval(() => {
  const tbaCutoff = Date.now() - IDLE_MS;
  for (const [key, entry] of cache) {
    if (entry.lastAccessed < tbaCutoff) { cache.delete(key); console.log(`[cache] evicted tba:${key}`); }
  }
  const frcCutoff = Date.now() - FRC_TTL;
  for (const [key, entry] of frcCache) {
    if (entry.cachedAt < frcCutoff) { frcCache.delete(key); console.log(`[cache] evicted frc:${key}`); }
  }
  const ytCutoff = Date.now() - YT_TTL * 5;
  for (const [key, entry] of ytCache) {
    if (entry.ts < ytCutoff) ytCache.delete(key);
  }
  // drop user records older than 8 days (beyond all reporting windows)
  const cutoff8d = Date.now() - 8 * 24 * 60 * 60 * 1000;
  for (const [uid, u] of userActivity) {
    if (u.lastSeen < cutoff8d) userActivity.delete(uid);
  }
  for (const key of Object.keys(apiLog)) {
    apiLog[key] = apiLog[key].filter(t => t > cutoff8d);
    reqLog[key] = reqLog[key].filter(t => t > cutoff8d);
  }
}, 60_000).unref();

function fetchFromTBA(path) {
  return new Promise((resolve, reject) => {
    const entry   = cache.get(path);
    const headers = { 'X-TBA-Auth-Key': TBA_KEY, Accept: 'application/json' };
    if (entry?.etag) headers['If-None-Match'] = entry.etag;

    apiLog.tba.push(Date.now());
    const req = https.get(TBA_BASE + path, { headers }, res => {
      if (res.statusCode === 304 && entry) {
        entry.lastAccessed = Date.now();
        res.resume();
        resolve(entry.data);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`TBA ${res.statusCode}`));
        return;
      }
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const data = JSON.parse(raw);
          cache.set(path, { data, etag: res.headers['etag'] ?? null, lastAccessed: Date.now() });
          resolve(data);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20_000, () => { req.destroy(new Error('TBA request timed out')); });
  });
}

function fetchFromFRC(path) {
  return new Promise((resolve, reject) => {
    const entry = frcCache.get(path);
    // Serve straight from cache if within 4-day TTL — no network call needed
    if (entry && Date.now() - entry.cachedAt < FRC_TTL) {
      resolve(entry.data);
      return;
    }

    const creds   = Buffer.from(`${FRC_USER}:${FRC_TOKEN}`).toString('base64');
    const headers = { Authorization: `Basic ${creds}`, Accept: 'application/json' };
    if (entry?.etag) headers['If-None-Match'] = entry.etag;

    apiLog.frc.push(Date.now());
    const req = https.get(FRC_BASE + path, { headers }, res => {
      if (res.statusCode === 304 && entry) {
        // Remote says unchanged — reset TTL clock
        frcCache.set(path, { ...entry, cachedAt: Date.now() });
        res.resume();
        resolve(entry.data);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`FRC API ${res.statusCode}`));
        return;
      }
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const data = JSON.parse(raw);
          frcCache.set(path, { data, etag: res.headers['etag'] ?? null, cachedAt: Date.now() });
          resolve(data);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20_000, () => { req.destroy(new Error('FRC request timed out')); });
  });
}

function checkYouTubeVideoLive(videoId) {
  const hit = ytCache.get(videoId);
  if (hit && Date.now() - hit.ts < YT_TTL) return Promise.resolve(hit.live);

  return new Promise(resolve => {
    apiLog.yt.push(Date.now());
    const apiUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${encodeURIComponent(videoId)}&key=${YT_KEY}`;
    const req = https.get(apiUrl, { headers: { Accept: 'application/json' } }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const data = JSON.parse(raw);
          const live = data.items?.[0]?.snippet?.liveBroadcastContent === 'live';
          ytCache.set(videoId, { live, ts: Date.now() });
          console.log(`[yt-live] ${videoId} → ${live ? 'LIVE' : 'offline'}`);
          resolve(live);
        } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(5000, () => { req.destroy(); resolve(false); });
  });
}

const server = http.createServer(async (req, res) => {
  console.log(`[req] ${req.method} ${req.url}`);

  const uid = req.headers['x-session-id'] || req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const existing = userActivity.get(uid);
  if (existing) existing.lastSeen = now;
  else userActivity.set(uid, { firstSeen: now, lastSeen: now });

  if (req.url.startsWith('/api/yt-live')) {
    reqLog.yt.push(Date.now());
    const qs  = req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '';
    const vid = new URLSearchParams(qs).get('vid');
    if (!vid || !YT_KEY) {
      const body = JSON.stringify({ live: false });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }
    const live = await checkYouTubeVideoLive(vid);
    const body = JSON.stringify({ live });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }

  if (req.url.startsWith('/api/frc/')) {
    reqLog.frc.push(Date.now());
    const frcPath = req.url.slice('/api/frc'.length); // e.g. /2026/events?eventCode=WASPO
    try {
      const data = await fetchFromFRC(frcPath);
      const body = JSON.stringify(data);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
      console.log(`[ok]  frc:${frcPath} (cache size: ${frcCache.size})`);
    } catch (err) {
      console.error(`[error] frc:${frcPath}: ${err.message}`);
      const body = JSON.stringify({ error: err.message });
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(body);
    }
    return;
  }

  if (!req.url.startsWith('/api/tba/')) {
    res.writeHead(404);
    res.end();
    return;
  }

  reqLog.tba.push(Date.now());
  const tbaPath = req.url.slice('/api/tba'.length);
  try {
    const data = await fetchFromTBA(tbaPath);
    const body = JSON.stringify(data);
    res.writeHead(200, {
      'Content-Type':  'application/json',
      'Cache-Control': 'no-cache',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
    console.log(`[ok]  ${tbaPath} (cache size: ${cache.size})`);
  } catch (err) {
    console.error(`[error] ${tbaPath}: ${err.message}`);
    const body = JSON.stringify({ error: err.message });
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(body);
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`TBA cache proxy listening on 0.0.0.0:${PORT}`));

// ── Diagnostic server ────────────────────────────────────────────────────────
const diagServer = http.createServer((req, res) => {
  if (req.url !== '/' && req.url !== '/diag') { res.writeHead(404); res.end(); return; }

  const now   = Date.now();
  const users = [...userActivity.values()];
  const active  = users.filter(u => now - u.lastSeen <          5 * 60 * 1000).length;
  const hour    = users.filter(u => now - u.lastSeen <         60 * 60 * 1000).length;
  const day     = users.filter(u => now - u.lastSeen <     24 * 60 * 60 * 1000).length;
  const week    = users.filter(u => now - u.lastSeen < 7 * 24 * 60 * 60 * 1000).length;

  const day24 = now - 24 * 60 * 60 * 1000;
  const tbaCalls   = apiLog.tba.filter(t => t > day24).length;
  const frcCalls   = apiLog.frc.filter(t => t > day24).length;
  const ytCalls    = apiLog.yt.filter(t => t > day24).length;
  const tbaReqs    = reqLog.tba.filter(t => t > day24).length;
  const frcReqs    = reqLog.frc.filter(t => t > day24).length;
  const ytReqs     = reqLog.yt.filter(t => t > day24).length;
  const avoided    = (tbaReqs - tbaCalls) + (frcReqs - frcCalls) + (ytReqs - ytCalls);
  const totalReqs  = tbaReqs + frcReqs + ytReqs;
  const avoidedPct = totalReqs > 0 ? ((avoided / totalReqs) * 100).toFixed(1) : '—';

  // Most-recently-accessed TBA paths
  const topTba = [...cache.entries()]
    .sort((a, b) => b[1].lastAccessed - a[1].lastAccessed)
    .slice(0, 10)
    .map(([k, v]) => `<tr><td>${k}</td><td>${new Date(v.lastAccessed).toISOString()}</td></tr>`)
    .join('');

  // Most-recently-cached FRC paths
  const topFrc = [...frcCache.entries()]
    .sort((a, b) => b[1].cachedAt - a[1].cachedAt)
    .slice(0, 10)
    .map(([k, v]) => `<tr><td>${k}</td><td>${new Date(v.cachedAt).toISOString()}</td></tr>`)
    .join('');

  const uptime = process.uptime();
  const uptimeStr = `${Math.floor(uptime/3600)}h ${Math.floor((uptime%3600)/60)}m ${Math.floor(uptime%60)}s`;
  const mem = process.memoryUsage();
  const mb = v => (v / 1024 / 1024).toFixed(1) + ' MB';

  const html = `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cache Server Diagnostics</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:monospace;background:#0f1117;color:#c9d1d9;padding:2rem;font-size:14px}
  h1{font-size:1.3rem;color:#e6edf3;margin-bottom:1.5rem}
  h2{font-size:0.95rem;color:#8b949e;text-transform:uppercase;letter-spacing:.08em;margin:1.5rem 0 0.6rem}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:1rem;margin-bottom:1rem}
  .card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1rem}
  .card .val{font-size:2rem;font-weight:700;color:#58a6ff;line-height:1}
  .card .lbl{font-size:0.75rem;color:#8b949e;margin-top:4px}
  table{width:100%;border-collapse:collapse;font-size:0.8rem}
  th{text-align:left;color:#8b949e;padding:4px 8px;border-bottom:1px solid #30363d}
  td{padding:4px 8px;border-bottom:1px solid #21262d;color:#c9d1d9;word-break:break-all}
  tr:last-child td{border-bottom:none}
  .section{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1rem;margin-bottom:1rem}
  .ts{color:#8b949e;font-size:0.75rem;margin-top:1.5rem}
</style>
</head><body>
<div style="display:flex;align-items:center;gap:1rem;margin-bottom:1.5rem">
  <h1 style="margin:0">Cache Server Diagnostics</h1>
  <button onclick="location.reload()" style="background:#21262d;border:1px solid #30363d;color:#c9d1d9;font-family:monospace;font-size:0.8rem;padding:4px 12px;border-radius:6px;cursor:pointer">↻ Refresh</button>
  <select id="ar" onchange="setAutoRefresh(this.value)" style="background:#21262d;border:1px solid #30363d;color:#c9d1d9;font-family:monospace;font-size:0.8rem;padding:4px 8px;border-radius:6px;cursor:pointer">
    <option value="0">Auto-refresh: Off</option>
    <option value="1000">1s</option>
    <option value="30000">30s</option>
    <option value="60000">1m</option>
    <option value="300000">5m</option>
  </select>
</div>
<script>
  let _timer;
  function setAutoRefresh(ms) {
    clearInterval(_timer);
    if (+ms > 0) _timer = setInterval(() => location.reload(), +ms);
    localStorage.setItem('diagAR', ms);
  }
  const saved = localStorage.getItem('diagAR');
  if (saved && saved !== '0') {
    document.getElementById('ar').value = saved;
    setAutoRefresh(saved);
  }
</script>

<h2>Users</h2>
<div class="grid">
  <div class="card"><div class="val">${active}</div><div class="lbl">Active (last 5 min)</div></div>
  <div class="card"><div class="val">${hour}</div><div class="lbl">Past Hour</div></div>
  <div class="card"><div class="val">${day}</div><div class="lbl">Past 24 Hours</div></div>
  <div class="card"><div class="val">${week}</div><div class="lbl">Past 7 Days</div></div>
</div>

<h2>Cache</h2>
<div class="grid">
  <div class="card"><div class="val">${cache.size}</div><div class="lbl">TBA Entries</div></div>
  <div class="card"><div class="val">${frcCache.size}</div><div class="lbl">FRC Entries (4-day TTL)</div></div>
  <div class="card"><div class="val">${ytCache.size}</div><div class="lbl">YT Live Entries</div></div>
</div>

<h2>Outbound API Calls (past 24 h)</h2>
<div class="grid">
  <div class="card"><div class="val">${tbaCalls}</div><div class="lbl">The Blue Alliance</div></div>
  <div class="card"><div class="val">${frcCalls}</div><div class="lbl">FRC Events API</div></div>
  <div class="card"><div class="val">${ytCalls}</div><div class="lbl">YouTube Data API</div></div>
</div>

<h2>Cache Efficiency (past 24 h)</h2>
<div class="grid">
  <div class="card"><div class="val">${avoided}</div><div class="lbl">Calls Avoided by Cache</div></div>
  <div class="card"><div class="val">${avoidedPct}%</div><div class="lbl">Cache Hit Rate</div></div>
  <div class="card"><div class="val">${totalReqs}</div><div class="lbl">Total Incoming Requests</div></div>
</div>

<h2>Process</h2>
<div class="grid">
  <div class="card"><div class="val" style="font-size:1.2rem">${uptimeStr}</div><div class="lbl">Uptime</div></div>
  <div class="card"><div class="val" style="font-size:1.2rem">${mb(mem.heapUsed)}</div><div class="lbl">Heap Used</div></div>
  <div class="card"><div class="val" style="font-size:1.2rem">${mb(mem.rss)}</div><div class="lbl">RSS</div></div>
</div>

<h2>Recent TBA Cache Entries</h2>
<div class="section"><table>
  <tr><th>Path</th><th>Last Accessed</th></tr>
  ${topTba || '<tr><td colspan="2" style="color:#8b949e">empty</td></tr>'}
</table></div>

<h2>Recent FRC Cache Entries</h2>
<div class="section"><table>
  <tr><th>Path</th><th>Cached At</th></tr>
  ${topFrc || '<tr><td colspan="2" style="color:#8b949e">empty</td></tr>'}
</table></div>

<p class="ts">Generated ${new Date().toISOString()}</p>
</body></html>`;

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
  res.end(html);
});

diagServer.listen(DIAG_PORT, '0.0.0.0', () => console.log(`Diagnostic server listening on 0.0.0.0:${DIAG_PORT}`));
