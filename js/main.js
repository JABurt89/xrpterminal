/* ═══════════════════════════════════════════════════════════════
   XRP TERMINAL v3 — APPLICATION BOOTSTRAP ORCHESTRATOR
   ═══════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  const XRP = (root.XRP = root.XRP || {});
  const { CFG, state, api, chart, market, macro, weather, morpho, ui } = XRP;

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

  async function refreshAllFeeds() {
    chart.init();
    if (!market.isLiveSocket()) market.forceReconnect();
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

  /* Boot chart engine (loads TradingView Lightweight Charts asynchronously with canvas fallback) */
  chart.init();

  /* Start live WebSocket stream + staggered polling jobs + Morpho loan monitor */
  market.connectWs();
  jobs.forEach(([fn, interval]) => api.scheduleJob(fn, interval));
  morpho.refreshAll();

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
