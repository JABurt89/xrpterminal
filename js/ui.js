/* ═══════════════════════════════════════════════════════════════
   XRP TERMINAL v4 — UI PAINTER, MODE CONTROLLER & INTERACTIONS
   ═══════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  const XRP = (root.XRP = root.XRP || {});
  const { CFG, cache, fmt, state, bus, api, chart, market, macro, morpho } = XRP;

  const $ = (id) => document.getElementById(id);

  let renderQueued = false;
  let lastFeedSig = '';
  let idleTimer = null;
  let oledTimer = null;
  let toastTimer = null;
  let oledStep = 0;
  let wakeLock = null;
  const flashTimers = new WeakMap();

  /* ── 10-Foot Remote / Hotkey HUD Toast ── */
  function showToast(text) {
    const el = $('hudToast');
    if (!el || !text) return;
    el.textContent = text;
    el.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('visible'), 1600);
  }

  /* ── Mode Detection & Switching (TV / PC / Phone) ── */
  function detectAutoMode() {
    const ua = navigator.userAgent || '';
    const tvUa = /Web0S|Tizen|SmartTV|SMART-TV|AppleTV|BRAVIA|AFT[A-Z]|CrKey|Xbox|PlayStation|GoogleTV|Android TV|HbbTV/i.test(ua);
    const phoneUa = /iPhone|iPod|Android.*Mobile|Mobile.*Firefox|IEMobile|Opera Mini/i.test(ua);
    const small = Math.min(root.innerWidth, root.innerHeight) < 600;
    const coarse = root.matchMedia?.('(pointer: coarse)').matches && root.matchMedia?.('(hover: none)').matches;
    if (tvUa) return 'tv';
    if (phoneUa || root.innerWidth <= 720 || (small && coarse)) return 'phone';
    return 'pc';
  }

  function applyMode(nextMode, savePref = null) {
    if (savePref !== null) {
      state.modePref = savePref;
      cache.write('mode', savePref === 'auto' ? null : savePref);
    }
    const resolved = nextMode === 'auto' ? detectAutoMode() : nextMode;
    state.activeMode = resolved;
    document.body.dataset.mode = resolved;
    document.body.classList.remove('scrolled-past-hero', 'oled-shift-1', 'oled-shift-2', 'oled-shift-3', 'oled-shift-4');

    document.querySelectorAll('[data-set-mode]').forEach((btn) => {
      const active = btn.dataset.setMode === resolved;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });

    document.querySelectorAll('[data-pref-mode]').forEach((btn) => {
      const active = btn.dataset.prefMode === state.modePref;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });

    syncTvOverscan();
    syncOledShift();
    paintPortfolio();
    chart.onModeChange();
    scheduleRender();
  }

  /* ── Subtle Price Tick Flash ── */
  function flash(el, dir) {
    if (!el || document.hidden) return;
    clearTimeout(flashTimers.get(el));
    const cls = dir === 'up' ? 'flash-up' : 'flash-dn';
    el.classList.remove('flash-up', 'flash-dn');
    void el.offsetWidth;
    el.classList.add(cls);
    flashTimers.set(el, setTimeout(() => el.classList.remove(cls), 460));
  }

  /* ── Portfolio & Currency Cycling ── */
  function ccyRate(code) {
    const r = state.rates[code];
    return Number.isFinite(r) && r > 0 ? r : null;
  }

  function activeCcy() {
    const chosen = CFG.PORTFOLIO_CCY[state.ccyIndex];
    return ccyRate(chosen.code) ? chosen : CFG.PORTFOLIO_CCY[XRP.USD_INDEX];
  }

  function updateCcyTabs() {
    const active = activeCcy().code;
    document.querySelectorAll('#ccyTabs [data-ccy]').forEach((btn) => {
      const code = btn.dataset.ccy;
      const isAct = code === active;
      const pinned = state.ccyPinned && code === CFG.PORTFOLIO_CCY[state.ccyIndex].code;
      btn.classList.toggle('active', isAct);
      btn.classList.toggle('pinned', pinned);
      btn.disabled = !ccyRate(code);
      btn.setAttribute('aria-pressed', String(pinned));
      btn.title = pinned ? 'Click to resume auto-cycling' : 'Pin ' + btn.textContent;
    });
  }

  function paintPortfolio() {
    const heading = $('portfolioHeading');
    if (heading) {
      const shortQty = fmt.fmtHoldingsShort(state.holdings);
      heading.textContent =
        state.activeMode === 'phone' ? `${shortQty} XRP · 24H` : `${shortQty} XRP Portfolio · 24H`;
    }

    const p = state.portfolio;
    if (!p) {
      updateCcyTabs();
      return;
    }

    const ccy = activeCcy();
    const rate = ccyRate(ccy.code) || 1;
    const value = p.usdValue * rate;
    const pnl = p.usdPnl * rate;
    const tRate = state.treasuryRate;

    const valEl = $('portfolioVal');
    const ccyEl = $('portfolioCcy');
    const pnlEl = $('portfolioPnl');
    const incEl = $('portfolioIncome');
    const yldEl = $('treasuryYieldTag');

    if (valEl) valEl.textContent = fmt.money(value, ccy.sym);
    if (ccyEl) ccyEl.textContent = ccy.label;
    if (pnlEl) {
      pnlEl.textContent = fmt.signMoney(pnl, ccy.sym);
      pnlEl.className = 'delta-pill portfolio-pnl ' + p.cls;
    }
    if (incEl) {
      incEl.textContent = tRate ? fmt.money((value * tRate.annualYield) / 12, ccy.sym) + '/MO' : '—/MO';
    }
    if (yldEl) {
      yldEl.textContent = tRate ? `· ${(tRate.annualYield * 100).toFixed(2)}%` : '';
    }

    updateCcyTabs();
    if ($('treasuryDialog')?.open) paintTreasuryModal();
  }

  function stepCurrency(dir = 1, pin = false) {
    if (!state.portfolio) return;
    let next = state.ccyIndex;
    const len = CFG.PORTFOLIO_CCY.length;
    for (let step = 1; step <= len; step++) {
      const idx = (state.ccyIndex + dir * step + len * 4) % len;
      if (ccyRate(CFG.PORTFOLIO_CCY[idx].code)) {
        next = idx;
        break;
      }
    }
    if (next === state.ccyIndex && !pin) return;
    state.ccyIndex = next;
    if (pin) {
      state.ccyPinned = true;
      cache.write('pinnedCurrency', CFG.PORTFOLIO_CCY[next].code);
    }
    const els = [$('portfolioVal'), $('portfolioPnl'), $('portfolioCcy'), $('portfolioIncome')].filter(Boolean);
    els.forEach((el) => el.classList.add('ccy-fade'));
    setTimeout(() => {
      paintPortfolio();
      els.forEach((el) => el.classList.remove('ccy-fade'));
    }, 160);
  }

  function cycleCurrency() {
    if (document.hidden || !state.portfolio || state.ccyPinned) return;
    stepCurrency(1, false);
  }

  function paintTreasuryModal() {
    const tRate = state.treasuryRate;
    const summaryEls = document.querySelectorAll('[data-treasury-summary]');
    const statusEls = document.querySelectorAll('[data-treasury-status]');

    if (!tRate) {
      summaryEls.forEach((el) => (el.textContent = '13-week US Treasury bill yield unavailable'));
      statusEls.forEach(
        (el) =>
          (el.textContent =
            state.treasuryStatus === 'checking'
              ? 'Querying US Treasury Fiscal Data API…'
              : 'Waiting for a verified 13-week Treasury auction rate.')
      );
    } else {
      const stale = Date.now() - Date.parse(tRate.date) > 10 * XRP.DAY_MS;
      const tag = state.treasuryStatus === 'live' ? (stale ? 'latest published auction' : 'latest auction') : state.treasuryStatus === 'checking' ? 'refreshing' : 'cached';
      const pct = (tRate.annualYield * 100).toFixed(3);
      summaryEls.forEach((el) => (el.textContent = `13-Week US T-Bill · ${pct}% Annual Yield (${tag})`));
      statusEls.forEach(
        (el) =>
          (el.textContent = `Auction Date: ${tRate.date}. ${
            state.treasuryStatus === 'live'
              ? `Verified ${new Date(tRate.checkedAt).toLocaleTimeString('en-GB', { timeZone: CFG.TZ })} ICT.`
              : 'Using last verified auction rate.'
          } Based on high investment rate for 13-week bills.`)
      );
    }

    const tbody = $('treasuryRows');
    if (!tbody) return;
    tbody.replaceChildren();
    const baseUsd = state.portfolio?.usdValue;
    for (const c of CFG.PORTFOLIO_CCY) {
      const rate = ccyRate(c.code);
      const row = tbody.insertRow();
      row.insertCell().textContent = c.label;
      const valCell = row.insertCell();
      valCell.className = 'num';
      const moCell = row.insertCell();
      moCell.className = 'num s-up';
      const yrCell = row.insertCell();
      yrCell.className = 'num';

      if (baseUsd != null && rate) {
        const val = baseUsd * rate;
        valCell.textContent = fmt.money(val, c.sym);
        if (tRate) {
          moCell.textContent = fmt.money((val * tRate.annualYield) / 12, c.sym) + '/mo';
          yrCell.textContent = fmt.money(val * tRate.annualYield, c.sym) + '/yr';
        } else {
          moCell.textContent = '—';
          yrCell.textContent = '—';
        }
      } else {
        valCell.textContent = '—';
        moCell.textContent = '—';
        yrCell.textContent = '—';
      }
    }
  }

  function paintMicroDelta(id, pct) {
    const el = $(id);
    if (!el) return;
    if (pct == null || !Number.isFinite(pct)) {
      el.textContent = '';
      el.className = 'micro-chg s-fl';
      return;
    }
    const cls = fmt.stateClass(pct);
    el.className = 'micro-chg s-' + cls;
    el.textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
  }

  /* ── Main Reactive Paint Pass (rAF coalesced) ── */
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      renderNow();
    });
  }

  function renderNow() {
    /* XRP Spot Hero */
    if (state.xrpUsd != null) {
      const priceStr = fmt.num(state.xrpUsd, 4);
      const xrpPriceEl = $('xrpPrice');
      if (xrpPriceEl && xrpPriceEl.textContent !== priceStr) xrpPriceEl.textContent = priceStr;

      const pct = state.xrp24hPct;
      const cls = fmt.stateClass(pct);
      const arrow = pct > 0 ? '▲' : pct < 0 ? '▼' : '·';
      const sign = pct >= 0 ? '+' : '';
      const pctStr = pct == null ? '·' : `${arrow} ${sign}${pct.toFixed(2)}%`;

      const chgEl = $('xrpChg');
      if (chgEl) {
        chgEl.textContent = pctStr;
        chgEl.className = 'delta-pill spot-chg-pill ' + cls;
      }

      const absEl = $('xrpAbsChg');
      if (absEl && pct != null) {
        const prev = state.xrpUsd / (1 + pct / 100);
        const diff = state.xrpUsd - prev;
        absEl.textContent = `24H ${diff >= 0 ? '+' : '−'}$${fmt.num(Math.abs(diff), 4)}`;
        if (state.xrpBid && state.xrpAsk) {
          absEl.title = `Best Bid $${fmt.num(state.xrpBid, 4)} · Best Ask $${fmt.num(state.xrpAsk, 4)}`;
        }
      }

      /* 24H VWAP pill */
      const vwapEl = $('xrpVwap');
      if (vwapEl && state.xrpVwap != null) {
        vwapEl.textContent = `VWAP $${fmt.num(state.xrpVwap, 4)}`;
        vwapEl.hidden = false;
      }

      /* Chart header mini quote */
      const mini = $('xrpUsdtMini');
      if (mini) {
        mini.innerHTML =
          `${priceStr}<span class="unit">USDT</span>` +
          (pct != null ? `<span class="delta s-${cls}">${sign}${pct.toFixed(2)}%</span>` : '');
      }

      /* Phone sticky mini quote */
      const sp = $('stickySpotPrice');
      const sc = $('stickySpotChg');
      if (sp) sp.textContent = '$' + priceStr;
      if (sc && pct != null) {
        sc.textContent = `${sign}${pct.toFixed(2)}%`;
        sc.className = 's-' + cls;
      }

      document.title = `${arrow} $${state.xrpUsd.toFixed(4)} XRP · Terminal`;
    }

    /* XRP 24h Range + VWAP Tick */
    if (state.xrpUsd != null && state.xrp24hLo != null && state.xrp24hHi != null) {
      const lo = state.xrp24hLo;
      const hi = state.xrp24hHi;
      const span = hi - lo;
      const pos = span > 0 ? Math.max(0, Math.min(1, (state.xrpUsd - lo) / span)) : 0.5;
      const spreadPct = lo > 0 ? (span / lo) * 100 : 0;
      const pctStr = (pos * 100).toFixed(1) + '%';

      $('rangeLo').textContent = '$' + fmt.num(lo, 4);
      $('rangeHi').textContent = '$' + fmt.num(hi, 4);
      $('rangeDot').style.left = pctStr;
      $('rangeFill').style.width = pctStr;
      $('rangePos').textContent = `${Math.round(pos * 100)}% OF RANGE · ${spreadPct.toFixed(1)}% SPREAD`;

      const vTick = $('rangeVwapTick');
      if (vTick) {
        if (state.xrpVwap != null && span > 0 && state.xrpVwap >= lo && state.xrpVwap <= hi) {
          const vPos = ((state.xrpVwap - lo) / span) * 100;
          vTick.style.left = vPos.toFixed(1) + '%';
          vTick.title = `24H VWAP $${fmt.num(state.xrpVwap, 4)}`;
          vTick.hidden = false;
        } else {
          vTick.hidden = true;
        }
      }
    }

    /* ATH Distance */
    if (state.xrpAth && state.xrpUsd) {
      const dist = (state.xrpUsd / state.xrpAth - 1) * 100;
      const athEl = $('xrpAth');
      if (athEl) {
        athEl.title = `All-Time High: $${fmt.num(state.xrpAth, 2)}`;
        const strong = athEl.querySelector('strong');
        if (strong) {
          strong.textContent = (dist >= 0 ? '+' : '') + dist.toFixed(1) + '%';
          strong.className = dist >= 0 ? 's-up' : '';
        }
      }
    }

    /* BTC / USDT */
    if (state.btcUsd != null) {
      const btcEl = $('btcPrice');
      btcEl.textContent = fmt.fmtBtcK(state.btcUsd);
      btcEl.title = '$' + fmt.num(state.btcUsd, 2);
      if (state.btc24hPct != null) {
        const cls = fmt.stateClass(state.btc24hPct);
        const el = $('btcChg');
        el.className = 'cross-chg s-' + cls;
        el.textContent = `${state.btc24hPct >= 0 ? '+' : ''}${state.btc24hPct.toFixed(2)}%`;
      }
      if (state.btc24hLo != null && state.btc24hHi != null) {
        $('btcLoCap').textContent = fmt.fmtBtcK(state.btc24hLo);
        $('btcHiCap').textContent = fmt.fmtBtcK(state.btc24hHi);
        const span = state.btc24hHi - state.btc24hLo;
        const pos = span > 0 ? Math.max(0, Math.min(1, (state.btcUsd - state.btc24hLo) / span)) : 0.5;
        $('btcMiniFill').style.width = (pos * 100).toFixed(1) + '%';
      }
    }

    /* XRP / BTC */
    if (state.xrpBtc != null) {
      const el = $('xrpBtcPrice');
      el.textContent = fmt.num(state.xrpBtc, 8);
      if (state.xrpBtc24hPct != null) {
        const cls = fmt.stateClass(state.xrpBtc24hPct);
        const chg = $('xrpBtcChg');
        chg.className = 'cross-chg s-' + cls;
        chg.textContent = `${state.xrpBtc24hPct >= 0 ? '+' : ''}${state.xrpBtc24hPct.toFixed(2)}%`;
      }
      if (state.xrpBtc24hLo != null && state.xrpBtc24hHi != null) {
        $('xrpBtcLoCap').textContent = Math.round(state.xrpBtc24hLo * 1e8) + 's';
        $('xrpBtcHiCap').textContent = Math.round(state.xrpBtc24hHi * 1e8) + 's';
        const span = state.xrpBtc24hHi - state.xrpBtc24hLo;
        const pos = span > 0 ? Math.max(0, Math.min(1, (state.xrpBtc - state.xrpBtc24hLo) / span)) : 0.5;
        $('xrpBtcMiniFill').style.width = (pos * 100).toFixed(1) + '%';
      }
    }

    /* Macro Ribbon */
    if (state.usdJpy != null) {
      $('usdJpy').textContent = '¥' + fmt.num(state.usdJpy, 2);
      paintMicroDelta('usdJpyChg', state.usdJpyChgPct);
      const jpyRec = state.macro.jpy;
      if (jpyRec && $('macroCellJpy')) {
        $('macroCellJpy').title = `${jpyRec.source} (${jpyRec.kind}) · As of ${fmt.fmtFeedTime(jpyRec.asOf * 1000)} ICT`;
      }
    }
    if (state.usdJpy != null && state.xrpUsd != null) {
      $('xrpJpy').textContent = '¥' + fmt.num(state.xrpUsd * state.usdJpy, 2);
      if (state.xrp24hPct != null) {
        const combPct = ((1 + state.xrp24hPct / 100) * (1 + (state.usdJpyChgPct || 0) / 100) - 1) * 100;
        paintMicroDelta('xrpJpyChg', combPct);
      }
    }
    if (state.brentUsd != null) {
      $('brentUsd').textContent = '$' + fmt.num(state.brentUsd, 2);
      paintMicroDelta('brentUsdChg', state.brentChgPct);
      const bRec = state.macro.brent;
      if (bRec) {
        if ($('brentTag')) $('brentTag').textContent = bRec.instrument || 'BZ=F';
        if ($('macroCellBrent')) {
          $('macroCellBrent').title = `${bRec.instrument} · ${bRec.source} · As of ${fmt.fmtFeedTime(bRec.asOf * 1000)} ICT`;
        }
      }
    }
    if (state.brentUsd != null && state.usdJpy != null) {
      $('brentJpy').textContent = '¥' + fmt.num(state.brentUsd * state.usdJpy, 0);
    }
    if (state.xrp24hVol != null) $('vol24').textContent = '$' + fmt.compact(state.xrp24hVol);
    if (state.xrpUsd != null && state.xrpSupply != null) $('mcap').textContent = '$' + fmt.compact(state.xrpUsd * state.xrpSupply);
    if (state.rlusdMcap != null) $('rlusdCap').textContent = '$' + fmt.compact(state.rlusdMcap);
    if (state.xrpBtc != null) $('xrpSats').textContent = Math.round(state.xrpBtc * 1e8).toLocaleString('en-US') + ' sat';
  }

  /* ── Market Connection & Staleness ── */
  function paintStatusAndStaleness() {
    const conn = market.getConnectionSummary();
    const dot = $('wsDot');
    const lbl = $('wsLabel');
    const chartDot = $('chartLiveDot');

    if (dot) {
      dot.classList.toggle('off', !conn.ok);
      dot.classList.toggle('warn', conn.ok && !conn.live);
    }
    if (chartDot) {
      chartDot.classList.toggle('off', !conn.ok);
    }
    if (lbl) lbl.textContent = conn.label;

    const now = Date.now();
    const tickerStaleMap = {
      'xrpusdt@ticker': ['xrpPrice', 'portfolioVal', 'portfolioPnl', 'xrpUsdtMini'],
      'btcusdt@ticker': ['btcPrice'],
      'xrpbtc@ticker': ['xrpBtcPrice', 'xrpSats'],
    };
    for (const [stream, ids] of Object.entries(tickerStaleMap)) {
      const ts = state.tickerTimes[stream];
      const isStale = !!ts && now - ts > 45_000;
      ids.forEach((id) => $(id)?.classList.toggle('stale', isStale));
    }

    const jpyExp = !!state.macro.jpy && macro.macroExpired(state.macro.jpy);
    const brentExp = !!state.macro.brent && macro.macroExpired(state.macro.brent);
    ['usdJpy', 'xrpJpy'].forEach((id) => $(id)?.classList.toggle('stale', jpyExp));
    $('brentUsd')?.classList.toggle('stale', brentExp);
    $('brentJpy')?.classList.toggle('stale', jpyExp || brentExp);

    for (const [key, ids] of [
      ['weather', ['wxIcon', 'wxTemp', 'wxHiLo', 'wxHum', 'hourly']],
      ['aqi', ['aqiBadge']],
      ['rlusd', ['rlusdCap']],
    ]) {
      const last = state.lastUpdate[key];
      if (!last) continue;
      const stale = now - last > CFG.STALE[key];
      ids.forEach((id) => $(id)?.classList.toggle('stale', stale));
    }

    market.checkCandleDelay();
  }

  /* ── Clock, Candle Countdown & FX Session Badge ── */
  const pad2 = (n) => String(n).padStart(2, '0');
  const fmtDurShort = (s) => Math.floor(s / 3600) + ':' + pad2(Math.floor((s % 3600) / 60));

  function tickClock() {
    const now = new Date();
    const t = fmt.timeFmtClock.format(now);
    const d = fmt.timeFmtDate.format(now);
    if ($('clk')) $('clk').textContent = state.activeMode === 'phone' ? t.slice(0, 5) : t;
    if ($('clkDate')) $('clkDate').textContent = d;
    if ($('envPhoneUpdated')) $('envPhoneUpdated').textContent = t.slice(0, 5) + ' ICT';

    chart.paintCountdown();

    const fx = macro.fxSessionState();
    const badge = $('fxBadge');
    if (badge) {
      badge.className = 'fx-badge ' + fx.st;
      const txt = fx.st === 'open' ? 'OPEN' : fx.st === 'soon' ? 'CLS ' + fmtDurShort(fx.sec) : 'OPN ' + fmtDurShort(fx.sec);
      badge.innerHTML = `<span class="fdot"></span>${txt}`;
      badge.title =
        fx.st === 'open'
          ? 'Global FX market open'
          : fx.st === 'soon'
            ? 'FX market closes in ' + fmtDurShort(fx.sec)
            : 'FX market opens in ' + fmtDurShort(fx.sec);
    }

    paintStatusAndStaleness();
    if ($('feedDialog')?.open) paintFeedModal();
  }

  /* ── Data Feeds & Settings Modal ── */
  function paintFeedModal() {
    const tbody = $('feedRows');
    if (!tbody) return;
    const now = Date.now();

    const rows = [
      ['XRP / USDT', state.tickerSources['xrpusdt@ticker'] || 'Binance', state.tickerTimes['xrpusdt@ticker'], 45_000],
      ['BTC / USDT', state.tickerSources['btcusdt@ticker'] || 'Binance', state.tickerTimes['btcusdt@ticker'], 45_000],
      ['XRP / BTC', state.tickerSources['xrpbtc@ticker'] || 'Binance', state.tickerTimes['xrpbtc@ticker'], 45_000],
      ['USD / JPY', state.macro.jpy ? `${state.macro.jpy.source} (${state.macro.jpy.kind})` : '—', state.macro.jpy ? state.macro.jpy.asOf * 1000 : 0, null, state.macro.jpy && !macro.macroExpired(state.macro.jpy)],
      ['Brent Futures', state.macro.brent ? `${state.macro.brent.source} (${state.macro.brent.instrument})` : '—', state.macro.brent ? state.macro.brent.asOf * 1000 : 0, null, state.macro.brent && !macro.macroExpired(state.macro.brent)],
      ['FX Rates (THB/TWD/CAD)', state.sources.rates, state.lastUpdate.rates, 3_600_000],
      ['13W US T-Bill', state.treasuryRate ? 'US Treasury' : '—', state.treasuryRate?.date || '—', null, !!state.treasuryRate],
      ['RLUSD Market Cap', state.sources.rlusd, state.lastUpdate.rlusd, CFG.STALE.rlusd],
      ['Chiang Mai Weather', state.sources.weather, state.lastUpdate.weather, CFG.STALE.weather],
      ['Chiang Mai US AQI', state.sources.aqi, state.lastUpdate.aqi, CFG.STALE.aqi],
      [
        'Morpho Loan',
        state.morpho.latest ? (state.morpho.latest.source === 'CHAIN' ? 'Ethereum RPC' : 'Morpho GraphQL') : '—',
        state.morpho.latest?.timestamp || 0,
        600_000,
      ],
    ];

    const normalized = rows.map(([name, source, time, maxAge, forceOk]) => {
      let status = 'err';
      if (typeof forceOk === 'boolean') status = forceOk ? 'ok' : time ? 'warn' : 'err';
      else if (time && maxAge) status = now - time <= maxAge ? 'ok' : 'warn';
      const timeTxt = typeof time === 'string' ? time : fmt.fmtFeedTime(time);
      return [name, source, timeTxt, status];
    });

    const sig = JSON.stringify(normalized);
    if (sig === lastFeedSig) return;
    lastFeedSig = sig;
    tbody.replaceChildren();

    for (const [name, source, timeTxt, status] of normalized) {
      const tr = tbody.insertRow();
      const c0 = tr.insertCell();
      c0.innerHTML = `<span class="feed-dot ${status}"></span>${name}`;
      const c1 = tr.insertCell();
      c1.className = 'dim';
      c1.textContent = source;
      const c2 = tr.insertCell();
      c2.className = 'num';
      c2.textContent = timeTxt;
    }
  }

  /* ── Ambient Rain Video, TV Overscan & OLED Shift ── */
  function syncRain() {
    const wrap = $('bgRainWrap');
    const video = $('bgVideo');
    const cb = $('ambientRain');
    if (cb) cb.checked = state.rainEnabled;
    document.body.classList.toggle('rain-on', state.rainEnabled);
    if (wrap) wrap.hidden = !state.rainEnabled;
    if (!video) return;
    if (state.rainEnabled && !document.hidden) {
      if (!video.hasAttribute('src')) video.src = '217379_medium.mp4';
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }

  function syncTvOverscan() {
    const cb = $('tvOverscanToggle');
    if (cb) cb.checked = state.tvOverscan;
    document.body.classList.toggle('tv-overscan', state.tvOverscan && state.activeMode === 'tv');
  }

  function syncOledShift() {
    clearInterval(oledTimer);
    document.body.classList.remove('oled-shift-1', 'oled-shift-2', 'oled-shift-3', 'oled-shift-4');
    const cb = $('oledShiftToggle');
    if (cb) cb.checked = state.oledShift;
    if (state.activeMode === 'tv' && state.oledShift) {
      oledTimer = setInterval(() => {
        if (document.hidden || state.activeMode !== 'tv') return;
        document.body.classList.remove('oled-shift-1', 'oled-shift-2', 'oled-shift-3', 'oled-shift-4');
        oledStep = (oledStep + 1) % 5;
        if (oledStep > 0) document.body.classList.add('oled-shift-' + oledStep);
      }, 300_000);
    }
  }

  /* ── WakeLock & Idle Cursor ── */
  async function acquireWakeLock() {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    } catch (_) {}
  }

  function resetIdle() {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (state.activeMode === 'tv') document.body.classList.add('idle');
    }, CFG.IDLE_MS);
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  }

  function syncChartControlsUI() {
    const tfLbl = $('mainIntervalLabel');
    if (tfLbl) tfLbl.textContent = state.klineInterval.toUpperCase();
    document.querySelectorAll('#tfGroup [data-tf]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tf === state.klineInterval);
    });
    $('btnToggleEma')?.classList.toggle('is-on', state.showEma);
    $('btnToggleEma50')?.classList.toggle('is-on', state.showEma50);
    $('btnToggleVol')?.classList.toggle('is-on', state.showVol);
  }

  /* ── Wire Up All DOM Event Handlers ── */
  function bindEvents(refreshAllFn) {
    /* Top mode switch */
    $('modeSwitch')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-set-mode]');
      if (!btn) return;
      applyMode(btn.dataset.setMode, btn.dataset.setMode);
      showToast(`DISPLAY · ${btn.dataset.setMode.toUpperCase()}`);
    });

    /* Dialog mode preference switch (includes Auto) */
    $('dialogModeGroup')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-pref-mode]');
      if (!btn) return;
      applyMode(btn.dataset.prefMode, btn.dataset.prefMode);
    });

    /* Responsive auto-resize ONLY when modePref is strictly 'auto' */
    let resizeDebounce = null;
    root.addEventListener('resize', () => {
      clearTimeout(resizeDebounce);
      resizeDebounce = setTimeout(() => {
        if (state.modePref === 'auto') {
          const detected = detectAutoMode();
          if (detected !== state.activeMode) applyMode(detected);
        }
      }, 180);
    });

    /* Phone sticky spot observer */
    const spotCard = $('cardSpot');
    if (spotCard && 'IntersectionObserver' in root) {
      new IntersectionObserver(
        ([entry]) => {
          if (state.activeMode === 'phone') {
            document.body.classList.toggle('scrolled-past-hero', !entry.isIntersecting);
          }
        },
        { threshold: 0.1 }
      ).observe(spotCard);
    }

    /* Portfolio Currency Tabs */
    $('ccyTabs')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-ccy]');
      if (!btn) return;
      const code = btn.dataset.ccy;
      const idx = CFG.PORTFOLIO_CCY.findIndex((c) => c.code === code);
      if (idx === -1 || !ccyRate(code)) return;
      if (state.ccyIndex === idx && state.ccyPinned) state.ccyPinned = false;
      else {
        state.ccyIndex = idx;
        state.ccyPinned = true;
      }
      cache.write('pinnedCurrency', state.ccyPinned ? code : null);
      paintPortfolio();
    });

    /* Chart Timeframes */
    $('tfGroup')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tf]');
      if (!btn) return;
      chart.switchTimeframe(btn.dataset.tf);
      syncChartControlsUI();
    });

    /* Chart overlays & reset */
    $('btnToggleEma')?.addEventListener('click', () => {
      state.showEma = !state.showEma;
      cache.write('showEma', state.showEma);
      syncChartControlsUI();
      chart.applyOverlays();
    });

    $('btnToggleEma50')?.addEventListener('click', () => {
      state.showEma50 = !state.showEma50;
      cache.write('showEma50', state.showEma50);
      syncChartControlsUI();
      chart.applyOverlays();
    });

    $('btnToggleVol')?.addEventListener('click', () => {
      state.showVol = !state.showVol;
      cache.write('showVol', state.showVol);
      syncChartControlsUI();
      chart.applyOverlays();
    });

    $('resetChart')?.addEventListener('click', () => chart.focusRecent());

    /* Modals */
    const openDialog = (id, onOpen) => {
      const dlg = $(id);
      if (!dlg) return;
      if (onOpen) onOpen();
      if (!dlg.open) dlg.showModal();
    };

    $('btnFeeds')?.addEventListener('click', () => openDialog('feedDialog', paintFeedModal));
    $('btnTreasuryModal')?.addEventListener('click', () => openDialog('treasuryDialog', paintTreasuryModal));
    $('btnShortcuts')?.addEventListener('click', () => openDialog('shortcutsDialog'));
    $('btnFullscreen')?.addEventListener('click', toggleFullscreen);

    const morphoCard = $('cardMorpho');
    morphoCard?.addEventListener('click', () => openDialog('loanDialog', () => morpho.paint()));
    morphoCard?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openDialog('loanDialog', () => morpho.paint());
      }
    });

    /* Close dialogs via button or backdrop click */
    document.querySelectorAll('dialog.modal').forEach((dlg) => {
      dlg.addEventListener('click', (e) => {
        if (e.target === dlg || e.target.closest('[data-close-dialog]')) dlg.close();
      });
    });

    /* Copy Morpho wallet */
    $('btnCopyWallet')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      try {
        await navigator.clipboard.writeText(CFG.MORPHO.WALLET);
        btn.textContent = 'Copied wallet address';
        setTimeout(() => (btn.textContent = 'Copy Wallet 0x8A44…f246'), 1800);
      } catch (_) {}
    });

    /* Holdings customization */
    const holdingInput = $('holdingInput');
    if (holdingInput) {
      holdingInput.value = String(state.holdings);
      const applyHolding = () => {
        const val = Number(holdingInput.value);
        if (Number.isFinite(val) && val > 0) {
          state.holdings = val;
          cache.write('holdings', val);
          market.recomputePortfolio();
        }
      };
      holdingInput.addEventListener('change', applyHolding);
      holdingInput.addEventListener('input', applyHolding);
    }

    $('btnResetHolding')?.addEventListener('click', () => {
      state.holdings = CFG.DEFAULT_HOLDINGS;
      if (holdingInput) holdingInput.value = String(CFG.DEFAULT_HOLDINGS);
      cache.write('holdings', CFG.DEFAULT_HOLDINGS);
      market.recomputePortfolio();
    });

    /* Rain, OLED & Overscan settings */
    $('ambientRain')?.addEventListener('change', (e) => {
      state.rainEnabled = e.target.checked;
      cache.write('rain', state.rainEnabled);
      syncRain();
    });

    $('bgVideo')?.addEventListener('error', () => {
      state.rainEnabled = false;
      cache.write('rain', false);
      const cb = $('ambientRain');
      if (cb) {
        cb.checked = false;
        cb.disabled = true;
      }
      syncRain();
    });

    $('oledShiftToggle')?.addEventListener('change', (e) => {
      state.oledShift = e.target.checked;
      cache.write('oledShift', state.oledShift);
      syncOledShift();
    });

    $('tvOverscanToggle')?.addEventListener('change', (e) => {
      state.tvOverscan = e.target.checked;
      cache.write('tvOverscan', state.tvOverscan);
      syncTvOverscan();
      chart.onModeChange();
    });

    /* Manual Refresh All */
    $('refreshFeeds')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = 'Refreshing…';
      try {
        await refreshAllFn();
        lastFeedSig = '';
        paintFeedModal();
      } finally {
        btn.disabled = false;
        btn.textContent = 'Refresh All Feeds';
      }
    });

    /* Keyboard & Smart TV Remote Navigation */
    document.addEventListener('keydown', (e) => {
      if (e.defaultPrevented || e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.target.closest?.('input, textarea, select')) return;

      const openModal = document.querySelector('dialog.modal[open]');
      if (openModal) return;

      const key = e.key.toLowerCase();
      if (key === 'f') {
        toggleFullscreen();
      } else if (key === 'r') {
        chart.focusRecent();
        showToast('CHART · RESET ZOOM');
      } else if (key === 'e') {
        state.showEma = !state.showEma;
        cache.write('showEma', state.showEma);
        syncChartControlsUI();
        chart.applyOverlays();
        showToast(`EMA 20 · ${state.showEma ? 'ON' : 'OFF'}`);
      } else if (key === 'm') {
        state.showEma50 = !state.showEma50;
        cache.write('showEma50', state.showEma50);
        syncChartControlsUI();
        chart.applyOverlays();
        showToast(`EMA 50 · ${state.showEma50 ? 'ON' : 'OFF'}`);
      } else if (key === 'v') {
        const order = ['tv', 'pc', 'phone'];
        const next = order[(order.indexOf(state.activeMode) + 1) % order.length];
        applyMode(next, next);
        showToast(`DISPLAY · ${next.toUpperCase()}`);
      } else if (key === 'c') {
        state.ccyPinned = false;
        stepCurrency(1, false);
        showToast(`PORTFOLIO · ${activeCcy().label}`);
      } else if (key === 'l') {
        openDialog('loanDialog', () => morpho.paint());
      } else if (key === 'i') {
        openDialog('treasuryDialog', paintTreasuryModal);
      } else if (key === 'd') {
        openDialog('feedDialog', paintFeedModal);
      } else if (e.key === '?') {
        openDialog('shortcutsDialog');
      } else if (/^[1-7]$/.test(key)) {
        const tf = CFG.TIMEFRAMES[Number(key) - 1];
        if (tf) {
          chart.switchTimeframe(tf);
          syncChartControlsUI();
          showToast(`TIMEFRAME · ${tf.toUpperCase()}`);
        }
      } else if (state.activeMode === 'tv' && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
        e.preventDefault();
        const idx = CFG.TIMEFRAMES.indexOf(state.klineInterval);
        const dir = e.key === 'ArrowRight' ? 1 : -1;
        const nextTf = CFG.TIMEFRAMES[(idx + dir + CFG.TIMEFRAMES.length) % CFG.TIMEFRAMES.length];
        chart.switchTimeframe(nextTf);
        syncChartControlsUI();
        showToast(`TIMEFRAME · ${nextTf.toUpperCase()}`);
      } else if (state.activeMode === 'tv' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        stepCurrency(e.key === 'ArrowDown' ? 1 : -1, true);
        showToast(`PORTFOLIO · ${activeCcy().label} PINNED`);
      }
    });

    /* Idle & visibility */
    document.addEventListener('mousemove', resetIdle, { passive: true });
    document.addEventListener('keydown', resetIdle, { passive: true });
    document.addEventListener('touchstart', resetIdle, { passive: true });
    document.addEventListener('visibilitychange', syncRain);

    /* Bus subscriptions */
    bus.on('ticker:xrp', ({ price, prev }) => {
      if (prev != null && prev !== price) {
        flash($('xrpPrice'), price > prev ? 'up' : 'down');
      }
      scheduleRender();
    });
    bus.on('ticker:btc', scheduleRender);
    bus.on('ticker:xrpbtc', scheduleRender);
    bus.on('macro:update', scheduleRender);
    bus.on('portfolio:update', paintPortfolio);
    bus.on('treasury:update', () => {
      paintPortfolio();
      paintTreasuryModal();
    });
    bus.on('market:status', paintStatusAndStaleness);

    /* Show backend status in Settings dialog */
    api.hasBackend().then((ok) => {
      const line = $('backendStatusLine');
      if (line) {
        line.textContent = ok
          ? 'Connected to XRP Terminal v4 server (/api/bootstrap + SWR cache)'
          : 'Direct browser telemetry (GitHub Pages / standalone mode)';
      }
    });
  }

  XRP.ui = {
    applyMode,
    bindEvents,
    syncChartControlsUI,
    syncRain,
    syncTvOverscan,
    syncOledShift,
    acquireWakeLock,
    resetIdle,
    tickClock,
    cycleCurrency,
    paintPortfolio,
    paintTreasuryModal,
    scheduleRender,
    showToast,
  };
})(window);
