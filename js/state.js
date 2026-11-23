/* ═══════════════════════════════════════════════════════════════
   XRP TERMINAL v3 — CENTRAL REACTIVE STATE STORE
   ═══════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  const XRP = (root.XRP = root.XRP || {});
  const { CFG, cache } = XRP;

  const USD_INDEX = CFG.PORTFOLIO_CCY.findIndex((c) => c.code === 'usd');
  const savedCurrency = cache.read('pinnedCurrency', Infinity)?.value;
  const preferredCcyIdx = CFG.PORTFOLIO_CCY.findIndex((c) => c.code === savedCurrency);

  const savedHoldings = Number(cache.read('holdings', Infinity)?.value);
  const holdings = Number.isFinite(savedHoldings) && savedHoldings > 0 ? savedHoldings : CFG.DEFAULT_HOLDINGS;

  const savedTf = cache.read('timeframe', Infinity)?.value;
  const initialTf = CFG.TIMEFRAMES.includes(savedTf) ? savedTf : '15m';

  const savedModePref = cache.read('mode', Infinity)?.value;
  const modePref = ['auto', 'tv', 'pc', 'phone'].includes(savedModePref) ? savedModePref : 'auto';

  const state = {
    /* Display & UI preferences */
    modePref,
    activeMode: document.body?.dataset?.mode || 'pc',
    holdings,
    showEma: cache.read('showEma', Infinity)?.value === true,
    showVol: cache.read('showVol', Infinity)?.value !== false,
    oledShift: cache.read('oledShift', Infinity)?.value !== false,
    rainEnabled: cache.read('rain', Infinity)?.value === true,

    /* Market prices */
    xrpUsd: null,
    xrpPrev: null,
    xrp24hPct: null,
    xrp24hHi: null,
    xrp24hLo: null,
    xrp24hVol: null,

    btcUsd: null,
    btcPrev: null,
    btc24hPct: null,
    btc24hHi: null,
    btc24hLo: null,

    xrpBtc: null,
    xrpBtcPrev: null,
    xrpBtc24hPct: null,
    xrpBtc24hHi: null,
    xrpBtc24hLo: null,

    /* Macro & Ecosystem */
    usdJpy: null,
    usdJpyPrev: null,
    jpy24hHi: null,
    jpy24hLo: null,
    brentUsd: null,
    brentUsdPrev: null,
    xrpSupply: null,
    xrpAth: null,
    rlusdMcap: null,
    macro: { jpy: null, brent: null },

    /* Portfolio & Treasury */
    rates: { usd: 1, thb: null, twd: null, cad: null },
    ccyIndex: preferredCcyIdx >= 0 ? preferredCcyIdx : USD_INDEX,
    ccyPinned: preferredCcyIdx >= 0,
    portfolio: null,
    treasuryRate: null,
    treasuryStatus: 'checking',

    /* Candles & Chart */
    klineInterval: initialTf,
    candles: [],

    /* Feed telemetry */
    tickerTimes: {},
    tickerSources: {},
    lastWsMsg: 0,
    lastUpdate: {
      fx: 0,
      brent: 0,
      weather: 0,
      aqi: 0,
      rlusd: 0,
      jpy: 0,
      rates: 0,
      meta: 0,
    },
    sources: {
      rlusd: '—',
      meta: '—',
      rates: '—',
      weather: 'Open-Meteo',
      aqi: '—',
    },

    /* Morpho Loan */
    morpho: {
      latest: null,
      failed: false,
      interest: null,
      interestFailed: false,
      savings: null,
      savingsError: '',
      usdQuote: null,
    },
  };

  /* Lightweight pub/sub event bus */
  const listeners = new Map();

  function on(event, handler) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(handler);
    return () => listeners.get(event)?.delete(handler);
  }

  function emit(event, payload) {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(payload);
      } catch (err) {
        console.warn('[XRP bus]', event, err);
      }
    }
  }

  XRP.state = state;
  XRP.USD_INDEX = USD_INDEX;
  XRP.bus = { on, emit };
})(window);
