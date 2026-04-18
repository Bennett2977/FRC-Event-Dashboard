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
const IDLE_MS    = 10 * 60 * 1000;         // TBA: evict after 10 min idle
const FRC_TTL    = 4 * 24 * 60 * 60 * 1000; // FRC: keep for 4 days

// path → { data: object, etag: string|null, lastAccessed: number }
const cache = new Map();

// path → { data: object, etag: string|null, cachedAt: number }
const frcCache = new Map();

// streamUrl → { live: bool, ts: number }
const ytCache  = new Map();
const YT_TTL   = 2 * 60 * 1000; // re-check every 2 minutes

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

  if (req.url.startsWith('/api/yt-live')) {
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
