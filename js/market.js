/* ═══════════════════════════════════════════════════════════════
   XRP TERMINAL v3 — BINANCE WEBSOCKET & REST MARKET ENGINE
   ═══════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  const XRP = (root.XRP = root.XRP || {});
  const { CFG, cache, state, bus, api, chart } = XRP;

  const WS_BACKOFF_MIN = 1000;
  const WS_BACKOFF_MAX = 12000;
  const WS_SILENT_MS = 15000;

  let wsBackoff = WS_BACKOFF_MIN;
  let wsWatchdog = null;
  let currentWs = null;
  let wsReconnectTimer = null;
  let connectTimer = null;
  let wsHost = 0;

  function getStreams() {
    return `xrpusdt@ticker/xrpusdt@kline_${state.klineInterval}/btcusdt@ticker/xrpbtc@ticker`;
  }

  function recomputePortfolio() {
    if (state.xrpUsd == null) return;
    const pct = state.xrp24hPct || 0;
    const prevPrice = state.xrpUsd / (1 + pct / 100);
    const qty = state.holdings;
    state.portfolio = {
      usdValue: qty * state.xrpUsd,
      usdPnl: (state.xrpUsd - prevPrice) * qty,
      cls: XRP.fmt.stateClass(pct),
    };
    bus.emit('portfolio:update');
  }

  function acceptMessage(msg, source) {
    const d = msg?.data;
    const s = msg?.stream;
    if (!d || typeof s !== 'string') return false;

    if (s.endsWith('@ticker')) {
      if (![d.c, d.P, d.h, d.l, d.q].every((v) => v != null && v !== '' && Number.isFinite(+v))) return false;
      if (+d.c <= 0 || +d.l <= 0 || +d.h < +d.l || +d.P <= -100 || +d.q < 0) return false;
      if (!Number.isFinite(+d.E) || +d.E <= 0 || +d.E > Date.now() + 60_000 || +d.E < (state.tickerTimes[s] || 0)) {
        return false;
      }
      if (source === 'REST' && +d.E === state.tickerTimes[s]) return false;
      state.tickerTimes[s] = +d.E;
      state.tickerSources[s] = source;
    }

    if (s === 'xrpusdt@ticker') {
      state.xrpPrev = state.xrpUsd;
      state.xrpUsd = +d.c;
      state.xrp24hPct = +d.P;
      state.xrp24hHi = +d.h;
      state.xrp24hLo = +d.l;
      state.xrp24hVol = +d.q;
      recomputePortfolio();
      bus.emit('ticker:xrp', { price: state.xrpUsd, prev: state.xrpPrev, timestamp: +d.E });
      return true;
    }

    if (s === 'xrpusdt@kline_' + state.klineInterval) {
      chart.applyKline(d.k);
      return true;
    }

    if (s === 'btcusdt@ticker') {
      state.btcPrev = state.btcUsd;
      state.btcUsd = +d.c;
      state.btc24hPct = +d.P;
      state.btc24hHi = +d.h;
      state.btc24hLo = +d.l;
      bus.emit('ticker:btc');
      return true;
    }

    if (s === 'xrpbtc@ticker') {
      state.xrpBtcPrev = state.xrpBtc;
      state.xrpBtc = +d.c;
      state.xrpBtc24hPct = +d.P;
      state.xrpBtc24hHi = +d.h;
      state.xrpBtc24hLo = +d.l;
      bus.emit('ticker:xrpbtc');
      return true;
    }

    return false;
  }

  async function refreshCandles() {
    const tf = state.klineInterval;
    const version = chart.getVersion();
    const generation = chart.getGeneration();
    const rows = await api.marketJson(`/klines?symbol=XRPUSDT&interval=${tf}&limit=500`, (r) => chart.normalizeRows(r).length > 0);
    if (generation !== chart.getGeneration()) return;
    if (!rows) {
      chart.setStatus(state.candles.length ? '' : 'Candle feed unavailable · Retrying…');
      return;
    }
    chart.commitRows(rows, true, version);
    cache.write('candles:' + tf, chart.rowsFromMemory());
    chart.setStatus('');
    bus.emit('market:status');
  }

  async function refreshTickers() {
    if (['xrpusdt@ticker', 'btcusdt@ticker', 'xrpbtc@ticker'].every((s) => Date.now() - (state.tickerTimes[s] || 0) < 10_000)) {
      return;
    }
    const symbols = encodeURIComponent(JSON.stringify(['XRPUSDT', 'BTCUSDT', 'XRPBTC']));
    const rows = await api.marketJson('/ticker/24hr?symbols=' + symbols, (r) =>
      Array.isArray(r) && r.length === 3 && r.every((t) => Number.isFinite(+t.lastPrice) && +t.lastPrice > 0)
    );
    if (!rows) return;
    for (const t of rows) {
      acceptMessage(
        {
          stream: t.symbol.toLowerCase() + '@ticker',
          data: {
            c: t.lastPrice,
            P: t.priceChangePercent,
            h: t.highPrice,
            l: t.lowPrice,
            q: t.quoteVolume,
            E: t.closeTime,
          },
        },
        'REST'
      );
    }
    bus.emit('market:status');
  }

  function closeSocket() {
    clearTimeout(connectTimer);
    clearInterval(wsWatchdog);
    if (currentWs) {
      currentWs.onopen = currentWs.onmessage = currentWs.onerror = currentWs.onclose = null;
      try {
        currentWs.close();
      } catch (_) {}
    }
    currentWs = null;
  }

  function scheduleReconnect() {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = setTimeout(connectWs, wsBackoff + Math.random() * 400);
    wsBackoff = Math.min(Math.round(wsBackoff * 1.7), WS_BACKOFF_MAX);
  }

  function connectWs() {
    clearTimeout(wsReconnectTimer);
    closeSocket();
    if (navigator.onLine === false || document.hidden) return;

    let ws;
    try {
      ws = new WebSocket(CFG.WS_HOSTS[wsHost % CFG.WS_HOSTS.length] + '/stream?streams=' + getStreams());
    } catch {
      wsHost = (wsHost + 1) % CFG.WS_HOSTS.length;
      scheduleReconnect();
      return;
    }

    currentWs = ws;
    const failed = () => {
      if (currentWs !== ws) return;
      closeSocket();
      state.lastWsMsg = 0;
      wsHost = (wsHost + 1) % CFG.WS_HOSTS.length;
      bus.emit('market:status');
      scheduleReconnect();
    };

    connectTimer = setTimeout(failed, 10_000);
    ws.onopen = () => {
      clearTimeout(connectTimer);
      api.runJob(refreshCandles, 'candles:' + chart.getGeneration());
    };
    ws.onclose = ws.onerror = failed;
    ws.onmessage = (evt) => {
      if (currentWs !== ws) return;
      try {
        const parsed = JSON.parse(evt.data);
        if (!parsed?.data || typeof parsed.stream !== 'string') return;
        if (acceptMessage(parsed, 'Stream') && parsed.stream.endsWith('@ticker') && Math.abs(Date.now() - parsed.data.E) < WS_SILENT_MS) {
          state.lastWsMsg = Date.now();
          wsBackoff = WS_BACKOFF_MIN;
        }
        bus.emit('market:status');
      } catch (_) {}
    };

    const started = Date.now();
    wsWatchdog = setInterval(() => {
      if (Date.now() - Math.max(started, state.lastWsMsg) > WS_SILENT_MS) failed();
    }, 3000);
  }

  function forceReconnect() {
    wsBackoff = WS_BACKOFF_MIN;
    connectWs();
  }

  function isLiveSocket() {
    if (!currentWs) return false;
    if (currentWs.readyState === 0) return true; // CONNECTING
    return currentWs.readyState === 1 && (!state.lastWsMsg || Date.now() - state.lastWsMsg <= 10_000);
  }

  function getConnectionSummary() {
    const streams = ['xrpusdt@ticker', 'btcusdt@ticker', 'xrpbtc@ticker'];
    const age = (s) => Date.now() - (state.tickerTimes[s] || 0);
    const live = !!state.lastWsMsg && streams.every((s) => state.tickerSources[s] === 'Stream' && age(s) < WS_SILENT_MS);
    const polled = streams.every((s) => age(s) < 45_000);
    const online = navigator.onLine !== false;
    const status = !online ? 'OFFLINE' : live ? 'LIVE' : polled ? 'POLLING' : Object.keys(state.tickerTimes).length ? 'DELAYED' : 'SYNCING';
    return { live, polled, online, ok: online && (live || polled), label: status };
  }

  function checkCandleDelay() {
    if (!state.candles.length) {
      chart.setStatus('Waiting for candle data…');
      return;
    }
    const last = state.candles[state.candles.length - 1];
    const tf = state.klineInterval;
    const unitMs = tf.endsWith('d') ? 86_400_000 : tf.endsWith('h') ? 3_600_000 : 60_000;
    const period = parseInt(tf, 10) * unitMs;
    const lastMs = (last.time - CFG.TZ_OFFSET_SEC) * 1000;
    chart.setStatus(Date.now() > lastMs + period + 60_000 ? 'Delayed candle data' : '');
  }

  bus.on('chart:tf-changed', () => {
    api.runJob(refreshCandles, 'candles:' + chart.getGeneration());
    forceReconnect();
  });

  bus.on('chart:ready', () => {
    api.runJob(refreshCandles, 'candles:' + chart.getGeneration());
  });

  XRP.market = {
    connectWs,
    closeSocket,
    forceReconnect,
    isLiveSocket,
    refreshCandles,
    refreshTickers,
    recomputePortfolio,
    getConnectionSummary,
    checkCandleDelay,
  };
})(window);
