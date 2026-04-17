'use strict';
const http = require('http');
const fs   = require('fs');

const DATA_FILE = '/data/visits.json';
const PORT      = 3001;

let visits = [];
try {
  if (fs.existsSync(DATA_FILE)) visits = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch {}

function persist() {
  try {
    fs.mkdirSync('/data', { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(visits));
  } catch {}
}

const PERIODS = {
  minute: 60e3,
  hour:   3_600e3,
  day:    86_400e3,
  week:   604_800e3,
  year:   31_536_000e3,
};

function getStats(periodKey) {
  const windowMs = PERIODS[periodKey] ?? PERIODS.day;
  const cutoff   = Date.now() - windowMs;
  const activeMs = Date.now() - 5 * 60e3;   // "active" = seen in last 5 min

  const inWindow = visits.filter(v => v.ts > cutoff);
  return {
    visits:    inWindow.length,
    activeNow: new Set(visits.filter(v => v.ts > activeMs).map(v => v.ip)).size,
    uniqueIPs: new Set(inWindow.map(v => v.ip)).size,
  };
}

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, 'http://x');

  if (req.method === 'POST' && url.pathname === '/ping') {
    const ip = (req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '')
                 .split(',')[0].trim();
    visits.push({ ts: Date.now(), ip });

    // Discard entries older than one year to keep the file small
    const yearAgo = Date.now() - PERIODS.year;
    if (visits[0]?.ts < yearAgo) visits = visits.filter(v => v.ts > yearAgo);

    persist();
    res.writeHead(204); res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/stats') {
    const s = getStats(url.searchParams.get('period') || 'day');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(s));
    return;
  }

  res.writeHead(404); res.end();
}).listen(PORT, () => console.log(`[analytics] listening on :${PORT}`));
