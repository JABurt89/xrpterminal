#!/usr/bin/env node
'use strict';

/**
 * XRP Terminal v3 — Optional Zero-Dependency Backend & API Aggregator
 *
 * Capabilities:
 * - Serves the static terminal frontend (HTML/CSS/JS + HTTP Range streaming for video)
 * - Provides CORS-free, singleflight-deduplicated, stale-while-revalidate (SWR)
 *   endpoints for Binance REST, Yahoo Finance (USD/JPY & Brent Futures), AmericasOilWatch,
 *   Frankfurter ECB, Currency API, US Treasury Fiscal Data, CoinGecko / DeFiLlama,
 *   Open-Meteo Weather & Air Quality, and Ethereum/Morpho loan snapshots.
 * - Strict input allow-listing (no open proxy / SSRF surface).
 *
 * Usage:
 *   PORT=3000 HOST=0.0.0.0 node server.js
 *   IQAIR_KEY=... node server.js
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = path.resolve(__dirname);
const IQAIR_KEY = process.env.IQAIR_KEY || '';
const START_TIME = Date.now();

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const ALLOWED_SYMBOLS = new Set(['XRPUSDT', 'BTCUSDT', 'XRPBTC']);
const ALLOWED_INTERVALS = new Set(['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1d']);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.woff2': 'font/woff2',
};

const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.json', '.svg']);

/* ══════════ SWR CACHE + SINGLEFLIGHT DEDUPLICATION ══════════ */

const cache = new Map();    // key -> { data, fetchedAt, expiresAt, staleUntil }
const inflight = new Map(); // key -> Promise

async function cachedFetch(key, ttlMs, staleMs, loader) {
  const now = Date.now();
  const entry = cache.get(key);

  if (entry && now < entry.expiresAt) {
    return { data: entry.data, cacheState: 'HIT', fetchedAt: entry.fetchedAt };
  }

  const refresh = () => {
    if (inflight.has(key)) return inflight.get(key);
    const task = Promise.resolve()
      .then(loader)
      .then((data) => {
        if (data != null) {
          const t = Date.now();
          cache.set(key, {
            data,
            fetchedAt: t,
            expiresAt: t + ttlMs,
            staleUntil: t + staleMs,
          });
        }
        return data;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, task);
    return task;
  };

  // Serve stale immediately while refreshing in background
  if (entry && now < entry.staleUntil) {
    refresh().catch(() => {});
    return { data: entry.data, cacheState: 'STALE', fetchedAt: entry.fetchedAt };
  }

  try {
    const data = await refresh();
    if (data != null) {
      return { data, cacheState: 'MISS', fetchedAt: Date.now() };
    }
  } catch (err) {
    if (entry) {
      return { data: entry.data, cacheState: 'FALLBACK_STALE', fetchedAt: entry.fetchedAt };
    }
    throw err;
  }

  if (entry) {
    return { data: entry.data, cacheState: 'FALLBACK_STALE', fetchedAt: entry.fetchedAt };
  }
  return { data: null, cacheState: 'EMPTY', fetchedAt: 0 };
}

async function fetchJson(url, opts = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...opts,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        ...(opts.headers || {}),
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ══════════ DATA PROVIDERS ══════════ */

function numeric(v) {
  return (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isFinite(Number(v));
}

function dayTime(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return NaN;
  const ms = Date.parse(day + 'T00:00:00Z');
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === day ? ms / 1000 : NaN;
}

function uniquePoints(points) {
  const map = new Map();
  const maxTime = Date.now() + 60_000;
  for (const p of points) {
    if (numeric(p.time) && numeric(p.value) && +p.time > 0 && +p.value > 0 && +p.time * 1000 <= maxTime) {
      map.set(+p.time, { time: +p.time, value: +p.value });
    }
  }
  return [...map.values()].sort((a, b) => a.time - b.time).slice(-2000);
}

function parseYahooRecord(json, asset) {
  const r = json?.chart?.result?.[0];
  const meta = r?.meta;
  if (!meta) return null;
  const expectedSym = asset === 'jpy' ? 'JPY=X' : 'BZ=F';
  const expectedCcy = asset === 'jpy' ? 'JPY' : 'USD';
  if (meta.symbol !== expectedSym || (meta.currency && meta.currency !== expectedCcy)) return null;

  if (asset === 'brent') {
    if (meta.currency !== 'USD' || meta.instrumentType !== 'FUTURE') return null;
    const price = Number(meta.regularMarketPrice);
    const asOf = Number(meta.regularMarketTime);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(asOf) || asOf <= 0) return null;
    return {
      asset: 'brent',
      source: 'Yahoo Finance',
      instrument: 'BZ=F',
      kind: 'futures',
      unit: 'USD/barrel',
      price,
      asOf,
      fetchedAt: Date.now(),
    };
  }

  let points = uniquePoints(
    (r.timestamp || []).map((time, i) => ({ time, value: r.indicators?.quote?.[0]?.close?.[i] }))
  );
  if (points.length < 2) return null;
  const last = points[points.length - 1];
  points = points.filter((p) => p.time >= last.time - 86400);
  return {
    asset: 'jpy',
    source: 'Yahoo Finance',
    instrument: 'USD/JPY',
    kind: 'intraday',
    unit: 'JPY/USD',
    price: last.value,
    asOf: last.time,
    points,
    fetchedAt: Date.now(),
  };
}

function parseOilWatchRecord(json) {
  if (!json || !numeric(json.priceUsd) || +json.priceUsd <= 0) return null;
  const provider = String(json.dataSource || json.provider || '');
  if (/spot|EIA|FRED/i.test(provider)) return null;
  let instrument;
  let source;
  if (/^BZ[FGHJKMNQUVXZ]\d{2}\.NYM$/.test(json.contract || '') && /Yahoo/i.test(provider)) {
    instrument = json.contract;
    source = 'AmericasOilWatch / Yahoo';
  } else if (/Stooq/i.test(provider) && /cb\.f/i.test(provider + ' ' + (json.contract || ''))) {
    instrument = 'CB.F';
    source = 'AmericasOilWatch / Stooq';
  } else {
    return null;
  }
  if (typeof json.observedAt !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(json.observedAt)) return null;
  const asOf = Date.parse(json.observedAt) / 1000;
  if (!Number.isFinite(asOf)) return null;
  return {
    asset: 'brent',
    source,
    instrument,
    kind: 'futures',
    unit: 'USD/barrel',
    price: +json.priceUsd,
    asOf,
    fetchedAt: Date.now(),
    providerStale: /stale|error|unavailable/i.test(String(json.quoteStatus || '')),
    contractLabel: json.contractLabel || instrument,
  };
}

async function loadMacro(asset) {
  const symbol = asset === 'jpy' ? 'JPY=X' : 'BZ=F';
  const qs = asset === 'brent' ? '?interval=1d&range=5d' : '?interval=5m&range=5d';

  for (const host of ['query1', 'query2']) {
    const raw = await fetchJson(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}${qs}`, {}, 7000);
    const rec = parseYahooRecord(raw, asset);
    if (rec) return rec;
  }

  if (asset === 'brent') {
    const ow = await fetchJson('https://americasoilwatch.com/api/v1/brent', {}, 7000);
    const rec = parseOilWatchRecord(ow);
    if (rec) return rec;
    return null;
  }

  // JPY fallbacks: Frankfurter ECB + Currency API
  const start = new Date(Date.now() - 35 * 86400000).toISOString().slice(0, 10);
  const ff = await fetchJson(`https://api.frankfurter.dev/v2/rates?base=USD&quotes=JPY&providers=ecb&from=${start}`, {}, 7000);
  if (Array.isArray(ff)) {
    const pts = uniquePoints(ff.filter((r) => r.base === 'USD' && r.quote === 'JPY').map((r) => ({ time: dayTime(r.date), value: r.rate })));
    if (pts.length) {
      const last = pts[pts.length - 1];
      return {
        asset: 'jpy',
        source: 'ECB / Frankfurter',
        instrument: 'USD/JPY',
        kind: 'daily',
        unit: 'JPY/USD',
        price: last.value,
        asOf: last.time,
        points: pts,
        fetchedAt: Date.now(),
      };
    }
  }

  const cApi = await fetchJson('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json', {}, 7000);
  const val = cApi?.usd?.jpy;
  const time = dayTime(cApi?.date);
  if (numeric(val) && +val > 0 && Number.isFinite(time)) {
    return {
      asset: 'jpy',
      source: 'Currency API',
      instrument: 'USD/JPY',
      kind: 'daily',
      unit: 'JPY/USD',
      price: +val,
      asOf: time,
      points: [{ time, value: +val }],
      fetchedAt: Date.now(),
    };
  }
  return null;
}

async function loadBinance(apiPath) {
  for (const host of ['https://data-api.binance.vision', 'https://api.binance.com']) {
    const data = await fetchJson(host + '/api/v3' + apiPath, {}, 7000);
    if (data != null) return data;
  }
  return null;
}

async function loadRates() {
  const urls = [
    'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
    'https://latest.currency-api.pages.dev/v1/currencies/usd.json',
    'https://open.er-api.com/v6/latest/USD',
  ];
  for (const url of urls) {
    const data = await fetchJson(url, {}, 7500);
    const payload = data?.usd || (data?.rates ? { thb: data.rates.THB, twd: data.rates.TWD, cad: data.rates.CAD, jpy: data.rates.JPY } : null);
    if (!payload) continue;
    const thb = Number(payload.thb);
    const twd = Number(payload.twd);
    const cad = Number(payload.cad);
    if (thb > 0 && twd > 0 && cad > 0) {
      return { usd: 1, thb, twd, cad, source: new URL(url).hostname, fetchedAt: Date.now() };
    }
  }
  return null;
}

async function loadTreasury() {
  const url =
    'https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/auctions_query' +
    '?filter=security_type:eq:Bill,security_term:eq:13-Week&fields=auction_date,security_type,security_term,high_investment_rate&sort=-auction_date&page%5Bsize%5D=10';
  const payload = await fetchJson(url, {}, 10_000);
  const candidates = (Array.isArray(payload?.data) ? payload.data : [])
    .filter((r) => r.security_type === 'Bill' && r.security_term === '13-Week' && numeric(r.high_investment_rate))
    .map((r) => ({ annualYield: Number(r.high_investment_rate) / 100, date: r.auction_date, checkedAt: Date.now() }))
    .filter((r) => r.annualYield >= 0 && r.annualYield <= 1 && /^\d{4}-\d{2}-\d{2}$/.test(r.date))
    .sort((a, b) => b.date.localeCompare(a.date));
  return candidates[0] || null;
}

async function loadRlusd() {
  const cg = await fetchJson('https://api.coingecko.com/api/v3/simple/price?ids=ripple-usd&vs_currencies=usd&include_market_cap=true', {}, 7000);
  let cap = cg?.['ripple-usd']?.usd_market_cap;
  let source = 'CoinGecko';
  if (!(cap > 0)) {
    const llama = await fetchJson('https://stablecoins.llama.fi/stablecoins?includePrices=false', {}, 8500);
    cap = (llama?.peggedAssets || []).find((a) => a.symbol === 'RLUSD' || a.gecko_id === 'ripple-usd')?.circulating?.peggedUSD;
    source = 'DeFiLlama';
  }
  return cap > 0 ? { marketCap: cap, source, fetchedAt: Date.now() } : null;
}

async function loadXrpMeta() {
  const cg = await fetchJson(
    'https://api.coingecko.com/api/v3/coins/ripple?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false',
    {},
    7500
  );
  if (cg?.market_data) {
    return {
      supply: cg.market_data.circulating_supply || null,
      ath: cg.market_data.ath?.usd || null,
      source: 'CoinGecko',
      fetchedAt: Date.now(),
    };
  }
  const cp = await fetchJson('https://api.coinpaprika.com/v1/tickers/xrp-xrp', {}, 7500);
  if (cp?.quotes?.USD) {
    return {
      supply: cp.circulating_supply || null,
      ath: cp.quotes.USD.ath_price || null,
      source: 'CoinPaprika',
      fetchedAt: Date.now(),
    };
  }
  return null;
}

async function loadWeather(lat, lon) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    '&current=temperature_2m,apparent_temperature,weather_code,relative_humidity_2m,wind_speed_10m' +
    '&daily=temperature_2m_max,temperature_2m_min,weather_code' +
    '&hourly=temperature_2m,precipitation_probability,weather_code' +
    '&timezone=Asia%2FBangkok&forecast_days=2';
  const d = await fetchJson(url, {}, 8000);
  return d?.current ? d : null;
}

async function loadAqi(lat, lon) {
  if (IQAIR_KEY) {
    const iq = await fetchJson(
      `https://api.airvisual.com/v2/nearest_city?lat=${lat}&lon=${lon}&key=${encodeURIComponent(IQAIR_KEY)}`,
      {},
      8000
    );
    if (iq?.status === 'success' && Number.isFinite(iq.data?.current?.pollution?.aqius)) {
      return { aqi: iq.data.current.pollution.aqius, src: 'IQAir Chiang Mai', fetchedAt: Date.now() };
    }
  }
  const om = await fetchJson(
    `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=us_aqi,pm2_5`,
    {},
    8000
  );
  if (Number.isFinite(om?.current?.us_aqi)) {
    return {
      aqi: om.current.us_aqi,
      pm25: Number.isFinite(om.current.pm2_5) ? om.current.pm2_5 : null,
      src: 'Open-Meteo US AQI',
      fetchedAt: Date.now(),
    };
  }
  return null;
}

/* ══════════ HTTP HELPERS ══════════ */

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function sendJson(req, res, status, payload, extraHeaders = {}) {
  setSecurityHeaders(res);
  const body = Buffer.from(JSON.stringify(payload));
  const acceptsGzip = /\bgzip\b/i.test(req.headers['accept-encoding'] || '');
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  };
  if (acceptsGzip && body.length > 512) {
    const gz = zlib.gzipSync(body);
    headers['Content-Encoding'] = 'gzip';
    headers['Content-Length'] = gz.length;
    res.writeHead(status, headers);
    res.end(gz);
  } else {
    headers['Content-Length'] = body.length;
    res.writeHead(status, headers);
    res.end(body);
  }
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  try {
    rel = decodeURIComponent(rel);
  } catch {
    res.writeHead(400);
    return res.end('Bad Request');
  }

  const fullPath = path.resolve(ROOT, '.' + rel);
  if (!fullPath.startsWith(ROOT + path.sep) && fullPath !== path.join(ROOT, 'index.html')) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  // Never expose server code or hidden files over HTTP
  const base = path.basename(fullPath);
  if (base.startsWith('.') || base === 'server.js' || base === 'package.json') {
    res.writeHead(404);
    return res.end('Not Found');
  }

  fs.stat(fullPath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }

    const ext = path.extname(fullPath).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    setSecurityHeaders(res);

    // HTTP Range support for video streaming
    if (req.headers.range && ext === '.mp4') {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!match) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        return res.end();
      }
      const start = match[1] ? parseInt(match[1], 10) : 0;
      const end = match[2] ? Math.min(parseInt(match[2], 10), stat.size - 1) : stat.size - 1;
      if (start > end || start >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        return res.end();
      }
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': mime,
        'Cache-Control': 'public, max-age=86400',
      });
      return fs.createReadStream(fullPath, { start, end }).pipe(res);
    }

    const cacheControl = ext === '.mp4' ? 'public, max-age=86400' : 'no-cache';
    const acceptsGzip = COMPRESSIBLE.has(ext) && /\bgzip\b/i.test(req.headers['accept-encoding'] || '');

    if (acceptsGzip) {
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Encoding': 'gzip',
        'Cache-Control': cacheControl,
      });
      return fs.createReadStream(fullPath).pipe(zlib.createGzip()).pipe(res);
    }

    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': cacheControl,
    });
    fs.createReadStream(fullPath).pipe(res);
  });
}

/* ══════════ ROUTER ══════════ */

async function handleApi(req, res, url) {
  const p = url.pathname;

  if (p === '/api/health') {
    return sendJson(req, res, 200, {
      service: 'xrp-terminal-v3',
      ok: true,
      uptimeSec: Math.floor((Date.now() - START_TIME) / 1000),
      cacheKeys: cache.size,
    });
  }

  if (p === '/api/binance/klines') {
    const symbol = (url.searchParams.get('symbol') || 'XRPUSDT').toUpperCase();
    const interval = url.searchParams.get('interval') || '15m';
    const limit = Math.max(1, Math.min(1000, parseInt(url.searchParams.get('limit') || '500', 10) || 500));
    const startTime = url.searchParams.get('startTime');
    if (!ALLOWED_SYMBOLS.has(symbol) || !ALLOWED_INTERVALS.has(interval)) {
      return sendJson(req, res, 400, { error: 'Invalid symbol or interval' });
    }
    const qs = new URLSearchParams({ symbol, interval, limit: String(limit) });
    if (startTime && /^\d+$/.test(startTime)) qs.set('startTime', startTime);
    const cacheKey = `binance:klines:${qs.toString()}`;
    const ttl = startTime ? 86_400_000 : 8_000;
    const { data, cacheState } = await cachedFetch(cacheKey, ttl, ttl * 10, () => loadBinance('/klines?' + qs.toString()));
    if (!data) return sendJson(req, res, 502, { error: 'Upstream unavailable' });
    return sendJson(req, res, 200, data, { 'X-Cache': cacheState });
  }

  if (p === '/api/binance/ticker/24hr') {
    const rawSymbols = url.searchParams.get('symbols');
    let list = ['XRPUSDT', 'BTCUSDT', 'XRPBTC'];
    if (rawSymbols) {
      try {
        const parsed = JSON.parse(rawSymbols);
        if (Array.isArray(parsed) && parsed.length && parsed.every((s) => ALLOWED_SYMBOLS.has(s))) {
          list = parsed;
        }
      } catch {
        return sendJson(req, res, 400, { error: 'Invalid symbols list' });
      }
    }
    const key = 'binance:ticker:' + list.join(',');
    const { data, cacheState } = await cachedFetch(key, 4_000, 60_000, () =>
      loadBinance('/ticker/24hr?symbols=' + encodeURIComponent(JSON.stringify(list)))
    );
    if (!data) return sendJson(req, res, 502, { error: 'Upstream unavailable' });
    return sendJson(req, res, 200, data, { 'X-Cache': cacheState });
  }

  if (p === '/api/macro') {
    const asset = url.searchParams.get('asset');
    if (asset !== 'jpy' && asset !== 'brent') {
      return sendJson(req, res, 400, { error: 'asset must be jpy or brent' });
    }
    const ttl = asset === 'jpy' ? 45_000 : 90_000;
    const { data, cacheState } = await cachedFetch(`macro:${asset}`, ttl, 3_600_000, () => loadMacro(asset));
    if (!data) return sendJson(req, res, 502, { error: 'Macro feed unavailable' });
    return sendJson(req, res, 200, data, { 'X-Cache': cacheState });
  }

  if (p === '/api/rates') {
    const { data, cacheState } = await cachedFetch('rates:usd', 600_000, 86_400_000, loadRates);
    if (!data) return sendJson(req, res, 502, { error: 'Rates unavailable' });
    return sendJson(req, res, 200, data, { 'X-Cache': cacheState });
  }

  if (p === '/api/treasury') {
    const { data, cacheState } = await cachedFetch('treasury:13w', 900_000, 86_400_000, loadTreasury);
    if (!data) return sendJson(req, res, 502, { error: 'Treasury feed unavailable' });
    return sendJson(req, res, 200, data, { 'X-Cache': cacheState });
  }

  if (p === '/api/rlusd') {
    const { data, cacheState } = await cachedFetch('rlusd:cap', 300_000, 3_600_000, loadRlusd);
    if (!data) return sendJson(req, res, 502, { error: 'RLUSD feed unavailable' });
    return sendJson(req, res, 200, data, { 'X-Cache': cacheState });
  }

  if (p === '/api/xrp-meta') {
    const { data, cacheState } = await cachedFetch('xrp:meta', 1_800_000, 86_400_000, loadXrpMeta);
    if (!data) return sendJson(req, res, 502, { error: 'XRP metadata unavailable' });
    return sendJson(req, res, 200, data, { 'X-Cache': cacheState });
  }

  if (p === '/api/weather') {
    const lat = Number(url.searchParams.get('lat')) || 18.8088;
    const lon = Number(url.searchParams.get('lon')) || 98.9717;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return sendJson(req, res, 400, { error: 'Invalid coordinates' });
    const key = `weather:${lat.toFixed(3)},${lon.toFixed(3)}`;
    const { data, cacheState } = await cachedFetch(key, 300_000, 3_600_000, () => loadWeather(lat, lon));
    if (!data) return sendJson(req, res, 502, { error: 'Weather unavailable' });
    return sendJson(req, res, 200, data, { 'X-Cache': cacheState });
  }

  if (p === '/api/aqi') {
    const lat = Number(url.searchParams.get('lat')) || 18.8088;
    const lon = Number(url.searchParams.get('lon')) || 98.9717;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return sendJson(req, res, 400, { error: 'Invalid coordinates' });
    const key = `aqi:${lat.toFixed(3)},${lon.toFixed(3)}`;
    const { data, cacheState } = await cachedFetch(key, 600_000, 3_600_000, () => loadAqi(lat, lon));
    if (!data) return sendJson(req, res, 502, { error: 'AQI unavailable' });
    return sendJson(req, res, 200, data, { 'X-Cache': cacheState });
  }

  return sendJson(req, res, 404, { error: 'Unknown API endpoint' });
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end('Method Not Allowed');
  }
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    res.writeHead(400);
    return res.end('Bad Request');
  }

  if (url.pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, url);
    } catch (err) {
      sendJson(req, res, 500, { error: 'Internal server error' });
    }
    return;
  }

  serveStatic(req, res, url.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`XRP Terminal v3 server listening on http://${HOST}:${PORT}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
