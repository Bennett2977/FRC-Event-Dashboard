#!/usr/bin/env node
'use strict';

const http  = require('http');
const https = require('https');

const TBA_KEY    = process.env.TBA_API_KEY || '';
const TBA_BASE   = 'https://www.thebluealliance.com/api/v3';
const PORT       = 3001;
const IDLE_MS    = 10 * 60 * 1000; // evict after 10 min of no requests

// path → { data: object, etag: string|null, lastAccessed: number }
const cache = new Map();

setInterval(() => {
  const cutoff = Date.now() - IDLE_MS;
  for (const [key, entry] of cache) {
    if (entry.lastAccessed < cutoff) {
      cache.delete(key);
      console.log(`[cache] evicted ${key}`);
    }
  }
}, 60_000).unref();

function fetchFromTBA(path) {
  return new Promise((resolve, reject) => {
    const entry   = cache.get(path);
    const headers = { 'X-TBA-Auth-Key': TBA_KEY, Accept: 'application/json' };
    if (entry?.etag) headers['If-None-Match'] = entry.etag;

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

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/api/tba/')) {
    res.writeHead(404);
    res.end();
    return;
  }

  const tbaPath = req.url.slice('/api/tba'.length); // e.g. /events/2026/simple
  try {
    const data = await fetchFromTBA(tbaPath);
    const body = JSON.stringify(data);
    res.writeHead(200, {
      'Content-Type':  'application/json',
      'Cache-Control': 'no-cache',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  } catch (err) {
    console.error(`[error] ${tbaPath}: ${err.message}`);
    const body = JSON.stringify({ error: err.message });
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(body);
  }
});

server.listen(PORT, () => console.log(`TBA cache proxy listening on :${PORT}`));
