/* ═══════════════════════════════════════════════════════════════
   XRP TERMINAL v4 — MACRO, FX, BRENT, TREASURY & ECOSYSTEM FEEDS
   ═══════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  const XRP = (root.XRP = root.XRP || {});
  const { CFG, DAY_MS, cache, fmt, state, bus, api } = XRP;

  const BRENT_SYMBOL = 'BZ=F';
  const RATE_CODES = ['thb', 'twd', 'cad'];
  const providerMemory = new Map();
  const providerRetry = new Map();

  /* ── New York FX / Futures Market Session Clock ── */
  const NY_FMT = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const NY_DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const FX_OPEN_SEC = 17 * 3600;
  const FX_CLOSE_SEC = 5 * 86400 + 17 * 3600;
  const WEEK_SEC = 7 * 86400;

  function fxSessionState() {
    const p = {};
    NY_FMT.formatToParts(new Date()).forEach((x) => (p[x.type] = x.value));
    const t = NY_DOW[p.weekday] * 86400 + +p.hour * 3600 + +p.minute * 60 + +p.second;
    if (t >= FX_OPEN_SEC && t < FX_CLOSE_SEC) {
      const toClose = FX_CLOSE_SEC - t;
      return { st: toClose <= 2 * 3600 ? 'soon' : 'open', sec: toClose };
    }
    return { st: 'closed', sec: t < FX_OPEN_SEC ? FX_OPEN_SEC - t : WEEK_SEC - t + FX_OPEN_SEC };
  }

  /* ── Macro Record Validators & Parsers ── */
  function uniquePoints(points) {
    const maxMs = Date.now() + 60_000;
    const map = new Map();
    for (const p of points) {
      if (fmt.numeric(p.time) && fmt.numeric(p.value) && +p.time > 0 && +p.value > 0 && +p.time * 1000 <= maxMs) {
        map.set(+p.time, { time: +p.time, value: +p.value });
      }
    }
    return [...map.values()].sort((a, b) => a.time - b.time).slice(-2000);
  }

  function validMacro(r, asset) {
    if (
      !['jpy', 'brent'].includes(asset) ||
      !r ||
      r.asset !== asset ||
      !Number.isFinite(r.price) ||
      r.price <= 0 ||
      !Number.isFinite(r.asOf) ||
      r.asOf <= 0 ||
      r.asOf * 1000 > Date.now() + 60_000 ||
      Date.now() - r.asOf * 1000 > 14 * DAY_MS ||
      !Number.isFinite(r.fetchedAt) ||
      r.fetchedAt > Date.now() + 60_000 ||
      typeof r.source !== 'string'
    ) {
      return false;
    }
    if (asset === 'brent') {
      return (
        r.unit === 'USD/barrel' &&
        r.kind === 'futures' &&
        (r.instrument === BRENT_SYMBOL ||
          /^BZ[FGHJKMNQUVXZ]\d{2}\.NYM$/.test(r.instrument) ||
          (r.instrument === 'CB.F' && r.source === 'AmericasOilWatch / Stooq'))
      );
    }
    const minPoints = r.kind === 'daily' ? 1 : 2;
    return (
      r.unit === 'JPY/USD' &&
      ['intraday', 'daily'].includes(r.kind) &&
      Array.isArray(r.points) &&
      r.points.length >= minPoints &&
      r.points.every(
        (p, i) =>
          Number.isFinite(p.time) &&
          p.time > 0 &&
          p.time <= r.asOf &&
          Number.isFinite(p.value) &&
          p.value > 0 &&
          (!i || r.points[i - 1].time < p.time)
      ) &&
      r.asOf === r.points[r.points.length - 1].time &&
      r.price === r.points[r.points.length - 1].value
    );
  }

  function yahooRecord(json, asset) {
    const r = json?.chart?.result?.[0];
    const meta = r?.meta;
    if (!meta || meta.symbol !== (asset === 'jpy' ? 'JPY=X' : 'BZ=F') || (meta.currency && meta.currency !== (asset === 'jpy' ? 'JPY' : 'USD'))) {
      return null;
    }
    const prevClose = fmt.numeric(meta.previousClose)
      ? Number(meta.previousClose)
      : fmt.numeric(meta.chartPreviousClose)
        ? Number(meta.chartPreviousClose)
        : null;

    let points = uniquePoints((r.timestamp || []).map((time, i) => ({ time, value: r.indicators?.quote?.[0]?.close?.[i] })));

    if (asset === 'brent') {
      if (meta.currency !== 'USD' || meta.instrumentType !== 'FUTURE') return null;
      const price = Number(meta.regularMarketPrice);
      const asOf = Number(meta.regularMarketTime);
      const chgPct = prevClose && prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : null;
      return {
        asset,
        source: 'Yahoo Finance',
        instrument: 'BZ=F',
        kind: 'futures',
        unit: 'USD/barrel',
        price,
        prevClose,
        chgPct,
        asOf,
        fetchedAt: Date.now(),
      };
    }

    if (points.length < 2) return null;
    const last = points[points.length - 1];
    points = points.filter((p) => p.time >= last.time - 86400);
    const metaPrice = Number(meta.regularMarketPrice);
    const metaTime = Number(meta.regularMarketTime);
    const price = Number.isFinite(metaPrice) && metaPrice > 0 ? metaPrice : last.value;
    const asOf = Number.isFinite(metaTime) && metaTime >= last.time ? metaTime : last.time;
    if (asOf > last.time && price > 0) points.push({ time: asOf, value: price });
    const baseOpen = prevClose && prevClose > 0 ? prevClose : points[0]?.value;
    const chgPct = baseOpen && baseOpen > 0 ? ((price - baseOpen) / baseOpen) * 100 : null;

    return {
      asset,
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

  function oilWatchRecord(json) {
    if (!json || !fmt.numeric(json.priceUsd) || +json.priceUsd <= 0) return null;
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
    if (json.sessionDate && fmt.dayTime(json.sessionDate) > asOf) return null;
    return {
      asset: 'brent',
      source,
      instrument,
      kind: 'futures',
      unit: 'USD/barrel',
      price: +json.priceUsd,
      chgPct: fmt.numeric(json.changePercent) ? +json.changePercent : null,
      asOf,
      fetchedAt: Date.now(),
      providerStale: /stale|error|unavailable/i.test(String(json.quoteStatus || '')),
    };
  }

  function frankfurterRecord(json) {
    if (json?.base !== 'USD' || !json.rates) return null;
    const points = uniquePoints(Object.entries(json.rates).map(([day, r]) => ({ time: fmt.dayTime(day), value: r?.JPY })));
    if (points.length < 5) return null;
    const last = points[points.length - 1];
    const prev = points[points.length - 2]?.value;
    return {
      asset: 'jpy',
      source: 'ECB / Frankfurter',
      instrument: 'USD/JPY',
      kind: 'daily',
      unit: 'JPY/USD',
      price: last.value,
      prevClose: prev || null,
      chgPct: prev ? ((last.value - prev) / prev) * 100 : null,
      asOf: last.time,
      points,
      fetchedAt: Date.now(),
    };
  }

  function frankfurterV2Record(json) {
    if (!Array.isArray(json)) return null;
    const points = uniquePoints(json.filter((r) => r.base === 'USD' && r.quote === 'JPY').map((r) => ({ time: fmt.dayTime(r.date), value: r.rate })));
    if (!points.length) return null;
    const last = points[points.length - 1];
    const prev = points.length > 1 ? points[points.length - 2].value : null;
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
      points,
      fetchedAt: Date.now(),
    };
  }

  function currencyLatestRecord(json) {
    const value = json?.usd?.jpy;
    const time = fmt.dayTime(json?.date);
    if (!fmt.numeric(value) || +value <= 0 || !Number.isFinite(time)) return null;
    return { asset: 'jpy', source: 'Currency API', instrument: 'USD/JPY', unit: 'JPY/USD', kind: 'daily', price: +value, asOf: time, points: [{ time, value: +value }], fetchedAt: Date.now() };
  }

  function macroExpired(r, now = Date.now()) {
    if (!r || r.providerStale) return true;
    const age = now - r.asOf * 1000;
    if (r.kind === 'daily') return age > 4 * DAY_MS;

    // Weekend / FX & NYMEX daily maintenance pause awareness
    if (fxSessionState().st === 'closed') {
      return age > 3.5 * DAY_MS;
    }

    // NYMEX Brent futures pause 17:00-18:00 ET and Stooq/OilWatch may report session settlement
    if (r.asset === 'brent' && /OilWatch/i.test(r.source || '')) {
      return age > 28 * 3_600_000;
    }
    return age > 180 * 60_000;
  }

  function preferMacro(next, prev) {
    if (!prev || !validMacro(prev, next.asset)) return true;
    if (macroExpired(next) !== macroExpired(prev)) return !macroExpired(next);
    if (Math.abs(next.asOf - prev.asOf) > 2 * 86400) return next.asOf > prev.asOf;
    const rank = (r) => (['intraday', 'futures'].includes(r.kind) ? 2 : 1);
    if (rank(next) !== rank(prev)) return rank(next) > rank(prev);
    if (next.asOf !== prev.asOf) return next.asOf > prev.asOf;
    if (next.source !== prev.source && (next.source === 'Currency API' || prev.source === 'Currency API')) {
      return prev.source === 'Currency API';
    }
    return next.fetchedAt >= prev.fetchedAt;
  }

  async function providerRecord(id, asset, url, parse, ttl, useCors = false) {
    let cached = providerMemory.get(id) || cache.read('provider5:' + id, 14 * DAY_MS)?.value;
    if (!validMacro(cached, asset)) cached = null;
    if (cached && Date.now() - cached.fetchedAt < ttl) return cached;
    if (Date.now() < (providerRetry.get(id) || 0)) return cached ? { ...cached, saved: true } : null;
    try {
      const raw = useCors ? await api.safeJsonWithCorsFallback(url, 10_000) : await api.safeJson(url, 10_000);
      const rec = parse(raw);
      if (!validMacro(rec, asset)) throw new Error('Invalid ' + id);
      providerMemory.set(id, rec);
      cache.write('provider5:' + id, rec, rec.fetchedAt);
      providerRetry.delete(id);
      return rec;
    } catch {
      providerRetry.set(id, Date.now() + 120_000);
      return cached ? { ...cached, saved: true } : null;
    }
  }

  function acceptMacro(rec) {
    if (!validMacro(rec, rec?.asset) || !preferMacro(rec, state.macro[rec.asset])) return false;
    state.macro[rec.asset] = rec;
    cache.write('macro5:' + rec.asset, rec, rec.fetchedAt);
    if (rec.asset === 'jpy') {
      state.usdJpyPrev = state.usdJpy;
      state.usdJpy = rec.price;
      state.usdJpyChgPct = Number.isFinite(rec.chgPct) ? rec.chgPct : null;
      state.jpy24hHi = rec.kind === 'daily' ? null : Math.max(...rec.points.map((p) => p.value));
      state.jpy24hLo = rec.kind === 'daily' ? null : Math.min(...rec.points.map((p) => p.value));
      state.lastUpdate.jpy = state.lastUpdate.fx = rec.fetchedAt;
    } else {
      state.brentUsdPrev = state.brentUsd;
      state.brentUsd = rec.price;
      state.brentChgPct = Number.isFinite(rec.chgPct) ? rec.chgPct : null;
      state.lastUpdate.brent = rec.fetchedAt;
    }
    bus.emit('macro:update', rec.asset);
    return true;
  }

  async function refreshMacro(asset) {
    const old = state.macro[asset] || cache.read('macro5:' + asset, 14 * DAY_MS)?.value;
    if (validMacro(old, asset)) acceptMacro({ ...old, saved: true });

    if (await api.hasBackend()) {
      const backendRec = await api.safeJson('/api/macro?asset=' + asset, 10_000);
      if (validMacro(backendRec, asset)) {
        acceptMacro(backendRec);
        return;
      }
    }

    /* Static / GitHub Pages mode: query CORS-native providers first */
    const nativeTasks = [];
    if (asset === 'brent') {
      nativeTasks.push(
        providerRecord('brent-oilwatch-v1', asset, 'https://americasoilwatch.com/api/v1/brent', oilWatchRecord, 180_000)
      );
    } else {
      const start = new Date(Date.now() - 35 * DAY_MS).toISOString().slice(0, 10);
      nativeTasks.push(
        providerRecord('frankfurter-v2', asset, `https://api.frankfurter.dev/v2/rates?base=USD&quotes=JPY&providers=ecb&from=${start}`, frankfurterV2Record, 900_000),
        providerRecord('currency-latest', asset, 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json', currencyLatestRecord, 900_000),
        providerRecord('currency-pages', asset, 'https://latest.currency-api.pages.dev/v1/currencies/usd.json', currencyLatestRecord, 900_000),
        providerRecord('frankfurter-v1', asset, `https://api.frankfurter.dev/v1/${start}..?from=USD&to=JPY`, frankfurterRecord, 3_600_000)
      );
    }

    await Promise.allSettled(nativeTasks.map((t) => t.then((rec) => rec && acceptMacro(rec))));

    /* Also try intraday Yahoo via CORS proxy in static mode if current record is only daily or expired */
    if (!state.macro[asset] || state.macro[asset].kind === 'daily' || macroExpired(state.macro[asset])) {
      const symbol = asset === 'jpy' ? 'JPY=X' : BRENT_SYMBOL;
      const qs = '?interval=5m&range=5d';
      const proxyTasks = ['query1', 'query2'].map((host) =>
        providerRecord(
          'ao-' + host + ':' + asset,
          asset,
          CFG.PROXY_AO + encodeURIComponent(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}${qs}`),
          (payload) => {
            if (payload?.status?.http_code && +payload.status.http_code !== 200) return null;
            try {
              return yahooRecord(JSON.parse(payload?.contents), asset);
            } catch {
              return null;
            }
          },
          120_000
        )
      );
      await Promise.allSettled(proxyTasks.map((t) => t.then((rec) => rec && acceptMacro(rec))));
    }
  }

  /* ── FX Rates for Portfolio Currencies (THB / TWD / CAD) ── */
  function applyRates(rates, source, live) {
    let changed = false;
    for (const code of RATE_CODES) {
      const val = Number(rates?.[code]);
      if (Number.isFinite(val) && val > 0) {
        state.rates[code] = val;
        changed = true;
      }
    }
    if (!changed) return false;
    if (source) state.sources.rates = source;
    if (live) {
      state.lastUpdate.rates = Date.now();
      cache.write('rates2', { thb: state.rates.thb, twd: state.rates.twd, cad: state.rates.cad });
    }
    bus.emit('portfolio:update');
    return true;
  }

  async function fetchRates() {
    if (!state.lastUpdate.rates) {
      applyRates(cache.read('rates2', 14 * DAY_MS)?.value, 'Cached', false);
    }
    if (await api.hasBackend()) {
      const b = await api.safeJson('/api/rates', 8000);
      if (b && RATE_CODES.every((c) => Number(b[c]) > 0)) {
        applyRates(b, b.source || 'Backend FX', true);
        return;
      }
    }
    for (const url of [
      'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
      'https://latest.currency-api.pages.dev/v1/currencies/usd.json',
      'https://open.er-api.com/v6/latest/USD',
    ]) {
      const data = await api.safeJson(url, 8500);
      const payload = data?.usd || (data?.rates ? { thb: data.rates.THB, twd: data.rates.TWD, cad: data.rates.CAD } : null);
      if (!payload) continue;
      const rates = {};
      for (const code of RATE_CODES) {
        const v = Number(payload[code]);
        if (Number.isFinite(v) && v > 0) rates[code] = v;
      }
      if (RATE_CODES.every((c) => rates[c])) {
        applyRates(rates, new URL(url).hostname, true);
        return;
      }
    }
  }

  /* ── 13-Week US Treasury Bill Auction Rate ── */
  function validTreasuryRate(r) {
    return (
      r &&
      Number.isFinite(r.annualYield) &&
      r.annualYield >= 0 &&
      r.annualYield <= 1 &&
      /^\d{4}-\d{2}-\d{2}$/.test(r.date) &&
      Number.isFinite(Date.parse(r.date)) &&
      Date.parse(r.date) <= Date.now()
    );
  }

  function acceptTreasury(r) {
    if (!validTreasuryRate(r)) return false;
    state.treasuryRate = r;
    state.treasuryStatus = 'live';
    cache.write('treasury13week', r);
    bus.emit('treasury:update');
    bus.emit('portfolio:update');
    return true;
  }

  async function fetchTreasuryRate() {
    const cached = cache.read('treasury13week', 365 * DAY_MS)?.value;
    if (validTreasuryRate(cached) && (!state.treasuryRate || cached.date >= state.treasuryRate.date)) {
      state.treasuryRate = cached;
    }
    state.treasuryStatus = 'checking';
    bus.emit('treasury:update');

    let latest = null;
    if (await api.hasBackend()) {
      const b = await api.safeJson('/api/treasury', 10_000);
      if (validTreasuryRate(b)) latest = b;
    }

    if (!latest) {
      const url =
        'https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/auctions_query' +
        '?filter=security_type:eq:Bill,security_term:eq:13-Week&fields=auction_date,security_type,security_term,high_investment_rate&sort=-auction_date&page%5Bsize%5D=15';
      const payload = await api.safeJson(url, 11_000);
      const candidates = (Array.isArray(payload?.data) ? payload.data : [])
        .filter((r) => r.security_type === 'Bill' && r.security_term === '13-Week' && fmt.numeric(r.high_investment_rate))
        .map((r) => ({ annualYield: Number(r.high_investment_rate) / 100, date: r.auction_date, checkedAt: Date.now() }))
        .filter(validTreasuryRate)
        .sort((a, b) => b.date.localeCompare(a.date));
      latest = candidates[0] || null;
    }

    if (latest && (!state.treasuryRate || latest.date >= state.treasuryRate.date)) {
      acceptTreasury(latest);
    } else {
      state.treasuryStatus = state.treasuryRate ? 'cached' : 'offline';
      bus.emit('treasury:update');
      bus.emit('portfolio:update');
    }
  }

  /* ── RLUSD Circulating Market Cap ── */
  function acceptRlusd(cap, source) {
    if (!(cap > 0)) return false;
    state.rlusdMcap = cap;
    state.sources.rlusd = source || 'Live';
    state.lastUpdate.rlusd = Date.now();
    cache.write('rlusd', cap);
    bus.emit('macro:update', 'rlusd');
    return true;
  }

  async function fetchRlusd() {
    if (!state.rlusdMcap) {
      const cached = cache.read('rlusd', 7 * DAY_MS)?.value;
      if (cached > 0) {
        state.rlusdMcap = cached;
        state.sources.rlusd = 'Cached';
        bus.emit('macro:update', 'rlusd');
      }
    }
    if (await api.hasBackend()) {
      const b = await api.safeJson('/api/rlusd', 8000);
      if (b?.marketCap > 0) {
        acceptRlusd(b.marketCap, b.source || 'Backend');
        return;
      }
    }
    const cg = await api.safeJson('https://api.coingecko.com/api/v3/simple/price?ids=ripple-usd&vs_currencies=usd&include_market_cap=true', 7500);
    let cap = cg?.['ripple-usd']?.usd_market_cap;
    let src = 'CoinGecko';
    if (!(cap > 0)) {
      const llama = await api.safeJson('https://stablecoins.llama.fi/stablecoins?includePrices=false', 9000);
      cap = (llama?.peggedAssets || []).find((a) => a.symbol === 'RLUSD' || a.gecko_id === 'ripple-usd')?.circulating?.peggedUSD;
      src = 'DeFiLlama';
    }
    acceptRlusd(cap, src);
  }

  /* ── XRP Supply & ATH Metadata ── */
  function acceptMeta(meta) {
    if (!meta || (!meta.supply && !meta.ath)) return false;
    if (meta.supply) state.xrpSupply = meta.supply;
    if (meta.ath) state.xrpAth = meta.ath;
    state.sources.meta = meta.source || 'Live';
    state.lastUpdate.meta = Date.now();
    cache.write('xrpMeta', { supply: state.xrpSupply, ath: state.xrpAth });
    bus.emit('macro:update', 'meta');
    return true;
  }

  async function fetchXrpMeta() {
    const cached = cache.read('xrpMeta', 7 * DAY_MS)?.value;
    if (cached && (!state.xrpSupply || !state.xrpAth)) {
      if (cached.supply) state.xrpSupply = cached.supply;
      if (cached.ath) state.xrpAth = cached.ath;
      state.sources.meta = 'Cached';
      bus.emit('macro:update', 'meta');
    }

    if (await api.hasBackend()) {
      const b = await api.safeJson('/api/xrp-meta', 8000);
      if (acceptMeta(b)) return;
    }

    const cg = await api.safeJson(
      'https://api.coingecko.com/api/v3/coins/ripple?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false',
      8000
    );
    if (cg?.market_data) {
      acceptMeta({
        supply: cg.market_data.circulating_supply,
        ath: cg.market_data.ath?.usd,
        source: 'CoinGecko',
      });
      return;
    }

    const cp = await api.safeJson('https://api.coinpaprika.com/v1/tickers/xrp-xrp', 8000);
    if (cp?.quotes?.USD) {
      acceptMeta({
        supply: cp.circulating_supply,
        ath: cp.quotes.USD.ath_price,
        source: 'CoinPaprika',
      });
    }
  }

  XRP.macro = {
    refreshJpy: () => refreshMacro('jpy'),
    refreshBrent: () => refreshMacro('brent'),
    acceptMacro,
    applyRates,
    acceptTreasury,
    acceptRlusd,
    acceptMeta,
    fetchRates,
    fetchTreasuryRate,
    fetchRlusd,
    fetchXrpMeta,
    fxSessionState,
    macroExpired,
  };
})(window);
