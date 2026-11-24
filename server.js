#!/usr/bin/env node
'use strict';

/**
 * XRP Terminal v4 — Zero-Dependency High-Performance Backend & Telemetry Aggregator
 *
 * Capabilities:
 * - Serves static frontend assets with ETag conditional 304s, gzip compression, and HTTP Range MP4 streaming
 * - Singleflight-deduplicated, Stale-While-Revalidate (SWR) endpoints:
 *   - GET /api/health            Service health, uptime, and cache telemetry
 *   - GET /api/bootstrap         Single-roundtrip parallel hydration snapshot for instant cold boot
 *   - GET /api/binance/klines    Multi-host Binance candlestick proxy
 *   - GET /api/binance/ticker/24hr Multi-symbol 24h spot ticker proxy
 *   - GET /api/macro?asset=jpy|brent Live 5m intraday Yahoo Finance FX & NYMEX Brent Futures + multi-provider fallbacks
 *   - GET /api/morpho            On-chain Ethereum Mainnet Morpho Blue (FXRP/RLUSD) position, IRM APY, interest & savings
 *   - GET /api/rates             Multi-provider THB / TWD / CAD / JPY FX rates
 *   - GET /api/treasury          Latest completed 13-week US Treasury Bill auction investment rate
 *   - GET /api/rlusd             RLUSD circulating market cap (CoinGecko + DeFiLlama)
 *   - GET /api/xrp-meta          XRP circulating supply & ATH metadata
 *   - GET /api/weather           Chiang Mai current weather, feels-like, wind & 48h forecast
 *   - GET /api/aqi               Chiang Mai US AQI & PM2.5 (IQAir optional + Open-Meteo AQI)
 * - Strict input allow-listing (zero open proxy / SSRF surface).
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

const DEFAULT_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
// Yahoo Finance v8 chart API rate-limits verbose Chrome UAs with Accept: application/json
const YAHOO_UA = 'Mozilla/5.0';

const ALLOWED_SYMBOLS = new Set(['XRPUSDT', 'BTCUSDT', 'XRPBTC', 'XRPJPY']);
const ALLOWED_INTERVALS = new Set(['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1d']);

const MORPHO = {
  WALLET: '0x8A449393Ce741a3CeaBd9373008be53dB12Bf246',
  MARKET: '0x4fa31e3f8ba345227d44e1cf48559eea53a90dd5311dc006984c060f2f311d96',
  CONTRACT: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',
  LOAN_TOKEN: '0x8292bb45bf1ee4d140127049757c2e0ff06317ed',
  COLL_TOKEN: '0xce6170ea245dc8d1f275a710a062b70f125f0110',
  LLTV_WAD: 770000000000000000n,
  RPC_URLS: [
    'https://ethereum-rpc.publicnode.com',
    'https://eth.drpc.org',
    'https://1rpc.io/eth',
  ],
};

const WAD = 10n ** 18n;
const SECONDS_PER_YEAR = 31_536_000;
const entryPriceMemo = new Map([
  [1792372440000, 1.3096],
  [1792380300000, 1.3116],
]);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.woff2': 'font/woff2',
};

const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.json', '.webmanifest', '.svg']);

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
    const headers = opts.rawHeaders
      ? opts.headers || {}
      : {
          'User-Agent': DEFAULT_UA,
          Accept: 'application/json',
          ...(opts.headers || {}),
        };
    const res = await fetch(url, {
      method: opts.method || 'GET',
      body: opts.body,
      headers,
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

  let points = uniquePoints(
    (r.timestamp || []).map((time, i) => ({ time, value: r.indicators?.quote?.[0]?.close?.[i] }))
  );

  const metaPrice = Number(meta.regularMarketPrice);
  const metaTime = Number(meta.regularMarketTime);
  const prevClose = numeric(meta.previousClose)
    ? Number(meta.previousClose)
    : numeric(meta.chartPreviousClose)
      ? Number(meta.chartPreviousClose)
      : null;

  if (asset === 'brent') {
    if (meta.currency !== 'USD' || meta.instrumentType !== 'FUTURE') return null;
    const price = Number.isFinite(metaPrice) && metaPrice > 0 ? metaPrice : points[points.length - 1]?.value;
    const asOf = Number.isFinite(metaTime) && metaTime > 0 ? metaTime : points[points.length - 1]?.time;
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(asOf) || asOf <= 0) return null;
    const recent = points.filter((p) => p.time >= asOf - 86400);
    const chgPct = prevClose && prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : null;
    return {
      asset: 'brent',
      source: 'Yahoo Finance',
      instrument: 'BZ=F',
      kind: 'futures',
      unit: 'USD/barrel',
      price,
      prevClose,
      chgPct,
      hi24: recent.length ? Math.max(price, ...recent.map((p) => p.value)) : null,
      lo24: recent.length ? Math.min(price, ...recent.map((p) => p.value)) : null,
      asOf,
      fetchedAt: Date.now(),
    };
  }

  if (points.length < 2) return null;
  const last = points[points.length - 1];
  points = points.filter((p) => p.time >= last.time - 86400);
  const price = Number.isFinite(metaPrice) && metaPrice > 0 ? metaPrice : last.value;
  const asOf = Number.isFinite(metaTime) && metaTime >= last.time ? metaTime : last.time;
  if (asOf > last.time && price > 0) {
    points.push({ time: asOf, value: price });
  }
  const baseOpen = prevClose && prevClose > 0 ? prevClose : points[0]?.value;
  const chgPct = baseOpen && baseOpen > 0 ? ((price - baseOpen) / baseOpen) * 100 : null;

  return {
    asset: 'jpy',
    source: 'Yahoo Finance',
    instrument: 'USD/JPY',
    kind: 'intraday',
    unit: 'JPY/USD',
    price,
    prevClose: baseOpen || null,
    chgPct,
    asOf,
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
    chgPct: numeric(json.changePercent) ? +json.changePercent : null,
    asOf,
    fetchedAt: Date.now(),
    providerStale: /stale|error|unavailable/i.test(String(json.quoteStatus || '')),
    contractLabel: json.contractLabel || instrument,
  };
}

async function loadMacro(asset) {
  const symbol = asset === 'jpy' ? 'JPY=X' : 'BZ=F';
  const queries = asset === 'brent' ? ['?interval=5m&range=5d', '?interval=1d&range=5d'] : ['?interval=5m&range=5d'];

  for (const qs of queries) {
    for (const host of ['query1', 'query2']) {
      const raw = await fetchJson(
        `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}${qs}`,
        { rawHeaders: true, headers: { 'User-Agent': YAHOO_UA } },
        6500
      );
      const rec = parseYahooRecord(raw, asset);
      if (rec) return rec;
    }
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
      const prev = pts.length > 1 ? pts[pts.length - 2].value : null;
      return {
        asset: 'jpy',
        source: 'ECB / Frankfurter',
        instrument: 'USD/JPY',
        kind: 'daily',
        unit: 'JPY/USD',
        price: last.value,
        prevClose: prev,
        chgPct: prev ? ((last.value - prev) / prev) * 100 : null,
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
    const data = await fetchJson(host + '/api/v3' + apiPath, {}, 6500);
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
    '?filter=security_type:eq:Bill,security_term:eq:13-Week&fields=auction_date,issue_date,security_type,security_term,high_investment_rate&sort=-auction_date&page%5Bsize%5D=15';
  const payload = await fetchJson(url, {}, 10_000);
  const candidates = (Array.isArray(payload?.data) ? payload.data : [])
    .filter((r) => r.security_type === 'Bill' && r.security_term === '13-Week' && numeric(r.high_investment_rate))
    .map((r) => ({
      annualYield: Number(r.high_investment_rate) / 100,
      date: r.auction_date,
      issueDate: r.issue_date || null,
      checkedAt: Date.now(),
    }))
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
      return { aqi: iq.data.current.pollution.aqius, pm25: null, src: 'IQAir Chiang Mai', fetchedAt: Date.now() };
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

/* ══════════ MORPHO BLUE ON-CHAIN + API AGGREGATOR ══════════ */

const hexWord = (v) => BigInt(v).toString(16).padStart(64, '0');
const hexAddr = (v) => '0x' + v.toString(16).padStart(40, '0');

function decodeWords(hex, count) {
  if (typeof hex !== 'string' || !/^0x[0-9a-f]+$/i.test(hex) || hex.length !== 2 + count * 64) {
    throw new Error('Invalid ABI word response');
  }
  return Array.from({ length: count }, (_, i) => BigInt('0x' + hex.slice(2 + i * 64, 66 + i * 64)));
}

async function ethRpc(url, method, params) {
  const json = await fetchJson(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    },
    6000
  );
  if (!json || json.error || json.result == null) throw new Error('RPC error');
  return json.result;
}

function computeAccruedDebt(m, pos, rate, nowSec) {
  const elapsed = nowSec - m[4];
  if (elapsed < 0n) throw new Error('Invalid accrual elapsed');
  const first = rate * elapsed;
  const second = (first * first) / (2n * WAD);
  const third = (second * first) / (3n * WAD);
  const total = m[2] + (m[2] * (first + second + third)) / WAD;
  return (pos[1] * (total + 1n) + m[3] + 1_000_000n - 1n) / (m[3] + 1_000_000n);
}

function buildPositionRecord({ borrowAssets, collateralRaw, borrowShares, oracleRaw, lltvRaw, timestampMs, borrowApy, usdQuote, source, block }) {
  const debt = Number(borrowAssets) / 1e18;
  const collateral = Number(collateralRaw) / 1e6;
  const oracle = Number(oracleRaw) / 1e48;
  const threshold = Number(lltvRaw) / 1e18;
  if (![debt, collateral, oracle, timestampMs].every(Number.isFinite) || oracle <= 0 || timestampMs <= 0) {
    throw new Error('Invalid Morpho position numbers');
  }
  const usd = Number(usdQuote?.usd);
  const usdTime = Number(usdQuote?.timestamp) * 1000;
  const usdFresh = usd > 0 && Number.isFinite(usd) && usdTime > 0 && Date.now() - usdTime < 3_600_000;
  const ltv = collateral > 0 ? debt / (collateral * oracle) : debt > 0 ? Infinity : 0;
  const trigger = collateral > 0 ? debt / (collateral * threshold) : null;
  const bufferPct = trigger != null && oracle > 0 && debt > 0 ? ((oracle - trigger) / oracle) * 100 : null;
  return {
    borrowShares: String(borrowShares),
    debt,
    collateral,
    oracle,
    threshold,
    timestamp: timestampMs,
    usdFresh,
    usdTime,
    usd: usdFresh ? usd : 1,
    apy: typeof borrowApy === 'number' && Number.isFinite(borrowApy) ? borrowApy : null,
    ltv,
    trigger,
    bufferPct,
    source,
    block: block || null,
    receivedAt: Date.now(),
  };
}

async function readMorphoChain(rpcUrl, usdQuote) {
  const [chain, block] = await Promise.all([
    ethRpc(rpcUrl, 'eth_chainId', []),
    ethRpc(rpcUrl, 'eth_getBlockByNumber', ['latest', false]),
  ]);
  if (BigInt(chain) !== 1n || !block?.number || !block?.timestamp) throw new Error('Invalid chain/block');
  const timestampMs = Number(BigInt(block.timestamp)) * 1000;
  if (Date.now() - timestampMs > 180_000 || timestampMs > Date.now() + 60_000) throw new Error('Stale block');

  const call = (to, data) => ethRpc(rpcUrl, 'eth_call', [{ to, data }, block.number]);
  const [ph, mh, uh] = await Promise.all([
    call(MORPHO.CONTRACT, '0x2c3c9157' + MORPHO.MARKET.slice(2)),
    call(MORPHO.CONTRACT, '0x5c60e39a' + MORPHO.MARKET.slice(2)),
    call(MORPHO.CONTRACT, '0x93c52062' + MORPHO.MARKET.slice(2) + MORPHO.WALLET.slice(2).toLowerCase().padStart(64, '0')),
  ]);

  const params = decodeWords(ph, 5);
  const m = decodeWords(mh, 6);
  const pos = decodeWords(uh, 3);
  if (hexAddr(params[0]) !== MORPHO.LOAN_TOKEN || hexAddr(params[1]) !== MORPHO.COLL_TOKEN || params[4] !== MORPHO.LLTV_WAD) {
    throw new Error('Market mismatch');
  }

  const [oh, rh] = await Promise.all([
    call(hexAddr(params[2]), '0xa035b1fe'),
    call(hexAddr(params[3]), '0x8c00bf6b' + params.map(hexWord).join('') + m.map(hexWord).join('')),
  ]);

  const rate = decodeWords(rh, 1)[0];
  const oracleRaw = decodeWords(oh, 1)[0];
  if (oracleRaw <= 0n) throw new Error('Invalid oracle');

  const debtRaw = computeAccruedDebt(m, pos, rate, BigInt(block.timestamp));
  const borrowApy = Math.expm1((Number(rate) / 1e18) * SECONDS_PER_YEAR);

  return buildPositionRecord({
    borrowAssets: debtRaw.toString(),
    collateralRaw: pos[2].toString(),
    borrowShares: pos[1].toString(),
    oracleRaw: oracleRaw.toString(),
    lltvRaw: params[4].toString(),
    timestampMs,
    borrowApy,
    usdQuote,
    source: 'CHAIN',
    block: BigInt(block.number).toString(),
  });
}

async function loadMorphoUsdQuote() {
  const { data } = await cachedFetch('morpho:rlusd-quote', 180_000, 3_600_000, async () => {
    const res = await fetchJson(`https://api.morpho.org/v0/tokens/1:${MORPHO.LOAN_TOKEN}/price`, {}, 7000);
    const d = res?.data;
    if (d && Number(d.price) > 0 && Number(d.timestamp) > 0) {
      return { usd: Number(d.price), timestamp: Number(d.timestamp) };
    }
    return null;
  });
  return data;
}

async function loadMorphoPosition() {
  const usdQuote = await loadMorphoUsdQuote();
  for (const rpcUrl of MORPHO.RPC_URLS) {
    try {
      return await readMorphoChain(rpcUrl, usdQuote);
    } catch {}
  }
  const gqlQuery = `{ marketPositions(first:50, where:{userAddress_in:["${MORPHO.WALLET}"],chainId_in:[1]}) { items { market { marketId lltv collateralAsset {decimals address} loanAsset {decimals address price {usd timestamp}} state {price borrowApy timestamp} } state {borrowAssets collateral borrowShares} } } }`;
  const gql = await fetchJson(
    'https://api.morpho.org/graphql',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: gqlQuery }) },
    9000
  );
  const pos = gql?.data?.marketPositions?.items?.find((x) => x.market?.marketId === MORPHO.MARKET);
  if (!pos) return null;
  return buildPositionRecord({
    borrowAssets: pos.state.borrowAssets,
    collateralRaw: pos.state.collateral,
    borrowShares: pos.state.borrowShares,
    oracleRaw: pos.market.state.price,
    lltvRaw: pos.market.lltv,
    timestampMs: Number(pos.market.state.timestamp) * 1000,
    borrowApy: pos.market.state.borrowApy,
    usdQuote: pos.market.loanAsset.price || usdQuote,
    source: 'API',
    block: null,
  });
}

async function loadMorphoInterest() {
  const res = await fetchJson(
    `https://api.morpho.org/v0/blue/markets/1:${MORPHO.MARKET}/users/${MORPHO.WALLET}/position/performance`,
    {},
    10_000
  );
  const d = res?.data;
  if (!d || d.chain_id !== 1 || d.market_id !== MORPHO.MARKET || !/^\d+$/.test(d.borrow_net_cost_assets)) return null;
  return {
    amount: Number(d.borrow_net_cost_assets) / 1e18,
    block: String(d.last_indexed_block),
    receivedAt: Date.now(),
  };
}

async function lookupHistoricalXrp(timestampSec) {
  const minute = Math.floor(timestampSec / 60) * 60_000;
  if (entryPriceMemo.has(minute)) return entryPriceMemo.get(minute);
  const rows = await loadBinance(`/klines?symbol=XRPUSDT&interval=1m&startTime=${minute}&limit=1`);
  const row = rows?.[0];
  if (Array.isArray(row) && Number(row[0]) === minute && Number(row[1]) > 0) {
    const price = Number(row[1]);
    entryPriceMemo.set(minute, price);
    return price;
  }
  throw new Error('Historical XRP entry price unavailable');
}

async function loadMorphoSavings() {
  const query = `{ marketTransactions(first:1000,orderBy:Timestamp,orderDirection:Asc,where:{chainId_in:[1],userAddress_in:["${MORPHO.WALLET}"],marketUniqueKey_in:["${MORPHO.MARKET}"],type_in:[Borrow,Repay,Liquidation]}) { items {txHash timestamp logIndex type data {... on MarketTransactionTransferData {assets shares}}} } }`;
  const gql = await fetchJson(
    'https://api.morpho.org/graphql',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) },
    12_000
  );
  const items = gql?.data?.marketTransactions?.items;
  if (!Array.isArray(items) || !items.length || items.length >= 1000) return null;

  let borrowedXrp = 0;
  let repaidXrp = 0;
  let netShares = 0n;
  let count = 0;
  let liquidated = false;
  const seen = new Set();

  for (const t of items) {
    const key = t.txHash + ':' + t.logIndex;
    if (seen.has(key)) return null;
    seen.add(key);
    if (t.type === 'Liquidation') {
      liquidated = true;
      continue;
    }
    if (!['Borrow', 'Repay'].includes(t.type) || !/^\d+$/.test(t.data?.assets) || !/^\d+$/.test(t.data?.shares)) {
      return null;
    }
    const amount = Number(t.data.assets) / 1e18;
    const price = await lookupHistoricalXrp(Number(t.timestamp));
    if (t.type === 'Borrow') {
      borrowedXrp += amount / price;
      netShares += BigInt(t.data.shares);
      count++;
    } else {
      repaidXrp += amount / price;
      netShares -= BigInt(t.data.shares);
    }
  }

  return {
    borrowedXrp,
    repaidXrp,
    netShares: netShares.toString(),
    count,
    liquidated,
    checkedAt: Date.now(),
  };
}

async function loadMorphoBundle() {
  const [posRes, intRes, savRes] = await Promise.allSettled([
    cachedFetch('morpho:pos', 18_000, 300_000, loadMorphoPosition),
    cachedFetch('morpho:interest', 60_000, 900_000, loadMorphoInterest),
    cachedFetch('morpho:savings', 180_000, 3_600_000, loadMorphoSavings),
  ]);
  const position = posRes.status === 'fulfilled' ? posRes.value.data : null;
  const interest = intRes.status === 'fulfilled' ? intRes.value.data : null;
  const savings = savRes.status === 'fulfilled' ? savRes.value.data : null;
  if (!position && !interest && !savings) return null;
  return { position, interest, savings, fetchedAt: Date.now() };
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
    res.end(req.method === 'HEAD' ? undefined : gz);
  } else {
    headers['Content-Length'] = body.length;
    res.writeHead(status, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
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
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    setSecurityHeaders(res);

    if (ext !== '.mp4' && req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
      return res.end();
    }

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
        ETag: etag,
      });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(fullPath).pipe(zlib.createGzip()).pipe(res);
    }

    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': cacheControl,
      ETag: etag,
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(fullPath).pipe(res);
  });
}

/* ══════════ ROUTER ══════════ */

async function handleApi(req, res, url) {
  const p = url.pathname;

  if (p === '/api/health') {
    return sendJson(req, res, 200, {
      service: 'xrp-terminal-v4',
      ok: true,
      uptimeSec: Math.floor((Date.now() - START_TIME) / 1000),
      cacheKeys: cache.size,
    });
  }

  if (p === '/api/bootstrap') {
    const tfRaw = url.searchParams.get('tf') || '15m';
    const tf = ALLOWED_INTERVALS.has(tfRaw) ? tfRaw : '15m';
    const lat = 18.8088;
    const lon = 98.9717;
    const tickerList = ['XRPUSDT', 'BTCUSDT', 'XRPBTC'];
    const klineQs = new URLSearchParams({ symbol: 'XRPUSDT', interval: tf, limit: '500' }).toString();

    const [tickers, klines, jpy, brent, rates, treasury, rlusd, meta, weather, aqi, morpho] = await Promise.allSettled([
      cachedFetch('binance:ticker:' + tickerList.join(','), 4_000, 60_000, () =>
        loadBinance('/ticker/24hr?symbols=' + encodeURIComponent(JSON.stringify(tickerList)))
      ),
      cachedFetch('binance:klines:' + klineQs, 8_000, 80_000, () => loadBinance('/klines?' + klineQs)),
      cachedFetch('macro:jpy', 45_000, 3_600_000, () => loadMacro('jpy')),
      cachedFetch('macro:brent', 60_000, 3_600_000, () => loadMacro('brent')),
      cachedFetch('rates:usd', 600_000, 86_400_000, loadRates),
      cachedFetch('treasury:13w', 900_000, 86_400_000, loadTreasury),
      cachedFetch('rlusd:cap', 300_000, 3_600_000, loadRlusd),
      cachedFetch('xrp:meta', 1_800_000, 86_400_000, loadXrpMeta),
      cachedFetch(`weather:${lat.toFixed(3)},${lon.toFixed(3)}`, 300_000, 3_600_000, () => loadWeather(lat, lon)),
      cachedFetch(`aqi:${lat.toFixed(3)},${lon.toFixed(3)}`, 600_000, 3_600_000, () => loadAqi(lat, lon)),
      loadMorphoBundle(),
    ]);

    const unwrap = (r) => (r.status === 'fulfilled' ? r.value?.data ?? r.value ?? null : null);
    return sendJson(req, res, 200, {
      tf,
      serverTime: Date.now(),
      tickers: unwrap(tickers),
      klines: unwrap(klines),
      jpy: unwrap(jpy),
      brent: unwrap(brent),
      rates: unwrap(rates),
      treasury: unwrap(treasury),
      rlusd: unwrap(rlusd),
      meta: unwrap(meta),
      weather: unwrap(weather),
      aqi: unwrap(aqi),
      morpho: morpho.status === 'fulfilled' ? morpho.value : null,
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
    const ttl = asset === 'jpy' ? 45_000 : 60_000;
    const { data, cacheState } = await cachedFetch(`macro:${asset}`, ttl, 3_600_000, () => loadMacro(asset));
    if (!data) return sendJson(req, res, 502, { error: 'Macro feed unavailable' });
    return sendJson(req, res, 200, data, { 'X-Cache': cacheState });
  }

  if (p === '/api/morpho') {
    const data = await loadMorphoBundle();
    if (!data) return sendJson(req, res, 502, { error: 'Morpho telemetry unavailable' });
    return sendJson(req, res, 200, data);
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
    } catch {
      sendJson(req, res, 500, { error: 'Internal server error' });
    }
    return;
  }

  serveStatic(req, res, url.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`XRP Terminal v4 server listening on http://${HOST}:${PORT}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
