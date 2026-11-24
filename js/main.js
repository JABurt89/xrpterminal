/* ═══════════════════════════════════════════════════════════════
   XRP TERMINAL v4 — APPLICATION BOOTSTRAP ORCHESTRATOR
   ═══════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  const XRP = (root.XRP = root.XRP || {});
  const { CFG, cache, state, api, chart, market, macro, weather, morpho, ui } = XRP;

  if (root.__xrpTerminalBooted) return;
  root.__xrpTerminalBooted = true;

  const jobs = [
    [market.refreshTickers, CFG.POLL.tickers],
    [() => api.runJob(market.refreshCandles, 'candles:' + chart.getGeneration()), CFG.POLL.candles],
    [macro.refreshJpy, CFG.POLL.jpy],
    [macro.refreshBrent, CFG.POLL.brent],
    [weather.fetchWeather, CFG.POLL.weather],
    [weather.fetchAqi, CFG.POLL.aqi],
    [macro.fetchRlusd, CFG.POLL.rlusd],
    [macro.fetchRates, CFG.POLL.rates],
    [macro.fetchTreasuryRate, CFG.POLL.treasury],
    [macro.fetchXrpMeta, CFG.POLL.meta],
  ];

  function applyBootstrapPayload(b) {
    if (!b || typeof b !== 'object') return false;
    if (Array.isArray(b.tickers)) market.ingestTickerRows(b.tickers, 'REST');
    if (Array.isArray(b.klines) && b.tf === state.klineInterval) {
      chart.commitRows(b.klines, true, chart.getVersion());
      cache.write('candles:' + state.klineInterval, chart.rowsFromMemory());
      chart.setStatus('');
    }
    if (b.jpy) macro.acceptMacro(b.jpy);
    if (b.brent) macro.acceptMacro(b.brent);
    if (b.rates) macro.applyRates(b.rates, b.rates.source || 'Backend FX', true);
    if (b.treasury) macro.acceptTreasury(b.treasury);
    if (b.rlusd?.marketCap > 0) macro.acceptRlusd(b.rlusd.marketCap, b.rlusd.source || 'Backend');
    if (b.meta) macro.acceptMeta(b.meta);
    if (b.weather?.current) weather.applyWeather(b.weather, true);
    if (Number.isFinite(b.aqi?.aqi)) weather.applyAqi(b.aqi.aqi, b.aqi.src || 'US AQI', true, b.aqi.pm25);
    if (b.morpho) morpho.ingestBundle(b.morpho);
    ui.scheduleRender();
    return true;
  }

  async function refreshAllFeeds() {
    chart.init();
    if (!market.isLiveSocket()) market.forceReconnect();
    const boot = await api.fetchBootstrap(state.klineInterval);
    if (applyBootstrapPayload(boot)) return;
    await Promise.allSettled([
      ...jobs.map(([fn]) => api.runJob(fn)),
      morpho.refreshAll(),
    ]);
  }

  /* Apply initial resolved mode & UI state */
  ui.applyMode(document.body.dataset.mode || state.modePref);
  ui.syncChartControlsUI();
  ui.syncRain();
  ui.bindEvents(refreshAllFeeds);
  ui.acquireWakeLock();
  ui.resetIdle();
  ui.tickClock();
  ui.paintPortfolio();
  morpho.paint();

  /* Boot chart engine + live Binance WebSocket stream immediately */
  chart.init();
  market.connectWs();

  /* Hydrate via single-roundtrip /api/bootstrap if backend present, else run staggered client jobs */
  (async function bootFeeds() {
    const boot = await api.fetchBootstrap(state.klineInterval);
    const hydrated = applyBootstrapPayload(boot);
    jobs.forEach(([fn, interval]) => api.scheduleJob(fn, interval, !hydrated));
    if (!hydrated) morpho.refreshAll();
  })();

  setInterval(() => {
    if (!document.hidden) ui.tickClock();
  }, 1000);

  setInterval(ui.cycleCurrency, CFG.CCY_CYCLE_MS);
  setInterval(() => {
    if (!document.hidden && navigator.onLine !== false) morpho.refreshAll();
  }, CFG.POLL.morpho);
  setInterval(() => {
    if (!document.hidden) morpho.paint();
  }, 10_000);

  /* Resume / visibility / network lifecycle */
  let lastResume = 0;
  function onResume() {
    if (document.hidden) return;
    ui.acquireWakeLock();
    if (market.isLiveSocket() && Date.now() - lastResume < 2000) return;
    lastResume = Date.now();
    if (!market.isLiveSocket()) market.forceReconnect();
    for (const fn of [
      market.refreshTickers,
      macro.refreshJpy,
      macro.refreshBrent,
      macro.fetchRates,
      macro.fetchTreasuryRate,
      morpho.refreshAll,
    ]) {
      api.runJob(fn);
    }
    api.runJob(market.refreshCandles, 'candles:' + chart.getGeneration());
  }

  function onVisibilityOrFocus() {
    if (!document.hidden) {
      onResume();
      return;
    }
    market.closeSocket();
    state.lastWsMsg = 0;
  }

  document.addEventListener('visibilitychange', onVisibilityOrFocus);
  root.addEventListener('focus', onVisibilityOrFocus);
  root.addEventListener('pageshow', onVisibilityOrFocus);
  root.addEventListener('online', onResume);
  root.addEventListener('offline', () => {
    market.closeSocket();
    state.lastWsMsg = 0;
    ui.tickClock();
  });
})(window);
