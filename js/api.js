/* ═══════════════════════════════════════════════════════════════
   XRP TERMINAL v3 — MULTI-PROVIDER NETWORK & BACKEND LAYER
   ═══════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  const XRP = (root.XRP = root.XRP || {});
  const { CFG } = XRP;

  const pendingRequests = new Map();
  const runningJobs = new Map();

  async function requestBody(url, timeout = 8000, mode = 'json', fetchOpts = null) {
    const key = fetchOpts ? null : mode + ':' + url;
    if (key && pendingRequests.has(key)) return pendingRequests.get(key);

    const task = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const immutable =
          /currency-api@\d{4}-\d{2}-\d{2}\//.test(url) ||
          /^https:\/\/\d{4}-\d{2}-\d{2}\.currency-api\.pages\.dev\//.test(url);
        const res = await fetch(url, {
          ...(fetchOpts || {}),
          signal: controller.signal,
          cache: immutable ? 'force-cache' : 'no-store',
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res[mode]();
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    })();

    if (!key) return task;
    pendingRequests.set(key, task);
    try {
      return await task;
    } finally {
      pendingRequests.delete(key);
    }
  }

  function safeJson(url, timeout = 7500) {
    return requestBody(url, timeout, 'json');
  }

  async function safeJsonWithCorsFallback(targetUrl, timeout = 9000) {
    const direct = await safeJson(targetUrl, 4500);
    if (direct) return direct;
    const cp = await safeJson(CFG.PROXY_CP + encodeURIComponent(targetUrl), timeout);
    if (cp) return cp;
    const ao = await safeJson(CFG.PROXY_AO + encodeURIComponent(targetUrl), timeout);
    if (ao?.contents) {
      try {
        return JSON.parse(ao.contents);
      } catch (_) {}
    }
    return null;
  }

  /* Detect optional self-hosted Node.js backend cleanly without 404 noise on GitHub Pages */
  const backendCheck = (async () => {
    if (!/^https?:$/.test(location.protocol)) return false;
    const qs = new URLSearchParams(location.search);
    if (/\.github\.io$/i.test(location.hostname) && qs.get('backend') !== '1') {
      return false;
    }
    const health = await safeJson('/api/health', 1500);
    return health?.service === 'xrp-terminal-v3' || health?.service === 'xrp-terminal-v2';
  })();

  async function hasBackend() {
    return backendCheck;
  }

  async function marketJson(path, valid) {
    if (await hasBackend()) {
      const res = await safeJson('/api/binance' + path, 9500);
      if (valid(res)) return res;
    }
    for (const host of ['https://data-api.binance.vision', 'https://api.binance.com']) {
      const res = await safeJson(host + '/api/v3' + path, 6500);
      if (valid(res)) return res;
    }
    return null;
  }

  /* Singleflight job runner to prevent duplicate overlapping polls */
  function runJob(fn, customKey) {
    const key = customKey || fn;
    if (runningJobs.has(key)) return runningJobs.get(key);
    const task = Promise.resolve()
      .then(fn)
      .catch((err) => console.warn('[XRP Terminal]', fn.name || key, err))
      .finally(() => runningJobs.delete(key));
    runningJobs.set(key, task);
    return task;
  }

  function scheduleJob(fn, interval) {
    const tick = async () => {
      if (navigator.onLine !== false && !document.hidden) {
        await runJob(fn);
      }
      setTimeout(tick, interval);
    };
    tick();
  }

  /* Dynamic TradingView Lightweight Charts loader with multi-CDN failover */
  let chartLibPending = false;
  function loadChartLibrary() {
    if (root.LightweightCharts || chartLibPending) return;
    chartLibPending = true;
    const sources = [
      'https://cdn.jsdelivr.net/npm/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js',
      'https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js',
    ];
    function next() {
      const url = sources.shift();
      if (!url) {
        chartLibPending = false;
        root.dispatchEvent(new Event('xrp-charts-failed'));
        return;
      }
      const script = document.createElement('script');
      script.src = url;
      script.async = true;
      script.onload = () => {
        if (!root.LightweightCharts) {
          next();
          return;
        }
        chartLibPending = false;
        root.dispatchEvent(new Event('xrp-charts-ready'));
      };
      script.onerror = next;
      document.head.append(script);
    }
    next();
  }

  XRP.api = {
    requestBody,
    safeJson,
    safeJsonWithCorsFallback,
    hasBackend,
    marketJson,
    runJob,
    scheduleJob,
    loadChartLibrary,
  };
})(window);
