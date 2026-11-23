/* ═══════════════════════════════════════════════════════════════
   XRP TERMINAL v3 — CONFIG, FORMATTERS & RESILIENT CACHE
   ═══════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  const XRP = (root.XRP = root.XRP || {});

  const DAY_MS = 86_400_000;

  const CFG = {
    TZ: 'Asia/Bangkok',
    TZ_OFFSET_SEC: 7 * 3600,
    LAT: 18.8088,
    LON: 98.9717,
    IQAIR_KEY: root.XRP_TERMINAL_IQAIR_KEY || '',
    PROXY_CP: 'https://corsproxy.io/?',
    PROXY_AO: 'https://api.allorigins.win/get?url=',
    MAX_CANDLES: 1500,
    VISIBLE_CANDLES_DESK: 68,
    VISIBLE_CANDLES_PHONE: 38,
    IDLE_MS: 4000,
    DEFAULT_HOLDINGS: 1_000_000,
    CCY_CYCLE_MS: 5000,
    TIMEFRAMES: ['1m', '3m', '5m', '15m', '1h', '4h', '1d'],
    WS_HOSTS: ['wss://data-stream.binance.vision:443', 'wss://stream.binance.com:443'],
    POLL: {
      tickers: 15_000,
      candles: 30_000,
      jpy: 60_000,
      brent: 120_000,
      weather: 300_000,
      aqi: 600_000,
      rlusd: 300_000,
      rates: 900_000,
      treasury: 900_000,
      meta: 3_600_000,
      morpho: 30_000,
    },
    STALE: {
      fx: 120_000,
      brent: 300_000,
      weather: 900_000,
      aqi: 1_500_000,
      rlusd: 1_200_000,
    },
    MORPHO: {
      WALLET: '0x8A449393Ce741a3CeaBd9373008be53dB12Bf246',
      MARKET: '0x4fa31e3f8ba345227d44e1cf48559eea53a90dd5311dc006984c060f2f311d96',
      CONTRACT: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',
      LOAN_TOKEN: '0x8292bb45bf1ee4d140127049757c2e0ff06317ed',
      COLL_TOKEN: '0xce6170ea245dc8d1f275a710a062b70f125f0110',
      LLTV_WAD: 770000000000000000n,
      RPC_URLS: [
        'https://ethereum-rpc.publicnode.com',
        'https://eth.llamarpc.com',
        'https://eth.drpc.org',
      ],
    },
    PORTFOLIO_CCY: [
      { code: 'thb', sym: '฿', label: 'THB' },
      { code: 'twd', sym: 'NT$', label: 'TWD' },
      { code: 'usd', sym: '$', label: 'USD' },
      { code: 'cad', sym: 'C$', label: 'CAD' },
    ],
  };

  /* ── Cache (with graceful v2 migration) ── */
  const CACHE_PREFIX = 'xrp-terminal-v3:';
  const LEGACY_PREFIX = 'xrp-terminal-v2:';

  function readCache(key, maxAge = 7 * DAY_MS) {
    for (const prefix of [CACHE_PREFIX, LEGACY_PREFIX]) {
      try {
        const raw = localStorage.getItem(prefix + key);
        if (!raw) continue;
        const item = JSON.parse(raw);
        if (item && Number.isFinite(item.at) && Date.now() - item.at < maxAge) {
          return item;
        }
      } catch (_) {}
    }
    return null;
  }

  function writeCache(key, value, at = Date.now()) {
    try {
      localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ value, at }));
    } catch (_) {}
  }

  /* ── Number & Time Formatters ── */
  const numberFormats = new Map();

  function num(value, digits = 2) {
    if (value == null || !Number.isFinite(+value)) return '—';
    if (!numberFormats.has(digits)) {
      numberFormats.set(
        digits,
        new Intl.NumberFormat('en-US', {
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
        })
      );
    }
    return numberFormats.get(digits).format(+value);
  }

  function compact(value) {
    if (value == null || !Number.isFinite(+value)) return '—';
    const n = +value;
    if (n >= 1e12) return (n / 1e12).toFixed(2) + 'T';
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return n.toFixed(0);
  }

  function fmtBtcK(v) {
    if (v == null || !Number.isFinite(+v)) return '···';
    return '$' + (+v / 1000).toFixed(1) + 'K';
  }

  function money(v, sym) {
    if (v == null || !Number.isFinite(+v)) return '—';
    return sym + num(Math.abs(v), 0);
  }

  function signMoney(v, sym) {
    if (v == null || !Number.isFinite(+v)) return '—';
    return (v >= 0 ? '+' : '−') + money(v, sym);
  }

  function fmtHoldingsShort(n) {
    if (n >= 1e6 && n % 1e6 === 0) return n / 1e6 + 'M';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3 && n % 1e3 === 0) return n / 1e3 + 'K';
    return num(n, 0);
  }

  function stateClass(pct) {
    if (pct == null || !Number.isFinite(+pct)) return 'fl';
    return +pct > 0 ? 'up' : +pct < 0 ? 'dn' : 'fl';
  }

  const timeFmtHm = new Intl.DateTimeFormat('en-GB', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    timeZone: CFG.TZ,
  });

  const timeFmtFull = new Intl.DateTimeFormat('en-GB', {
    hour12: false,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: CFG.TZ,
  });

  const timeFmtClock = new Intl.DateTimeFormat('en-GB', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: CFG.TZ,
  });

  const timeFmtDate = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: CFG.TZ,
  });

  function fmtTime(sec) {
    return timeFmtHm.format(new Date(sec * 1000));
  }

  function fmtFull(sec) {
    return timeFmtFull.format(new Date(sec * 1000));
  }

  function fmtFeedTime(ms) {
    if (!ms || !Number.isFinite(+ms)) return '—';
    return timeFmtFull.format(new Date(+ms));
  }

  function toTzSec(ms) {
    return Math.floor(Number(ms) / 1000) + CFG.TZ_OFFSET_SEC;
  }

  function numeric(v) {
    return (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isFinite(Number(v));
  }

  function dayTime(day) {
    if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return NaN;
    const ms = Date.parse(day + 'T00:00:00Z');
    return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === day ? ms / 1000 : NaN;
  }

  XRP.CFG = CFG;
  XRP.DAY_MS = DAY_MS;
  XRP.cache = { read: readCache, write: writeCache };
  XRP.fmt = {
    num,
    compact,
    fmtBtcK,
    money,
    signMoney,
    fmtHoldingsShort,
    stateClass,
    fmtTime,
    fmtFull,
    fmtFeedTime,
    timeFmtClock,
    timeFmtDate,
    toTzSec,
    numeric,
    dayTime,
  };
})(window);
