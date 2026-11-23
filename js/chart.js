/* ═══════════════════════════════════════════════════════════════
   XRP TERMINAL v3 — LIVE CANDLESTICK, VOLUME & EMA 20 CHART ENGINE
   ═══════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  const XRP = (root.XRP = root.XRP || {});
  const { CFG, fmt, state, bus, api } = XRP;

  const TZ_OFFSET = CFG.TZ_OFFSET_SEC;

  let chart = null;
  let candleSeries = null;
  let volumeSeries = null;
  let emaSeries = null;
  let hiLine = null;
  let loLine = null;
  let midLine = null;
  let resizeObserver = null;
  let basicObserver = null;

  let visibleHi = -Infinity;
  let visibleLo = Infinity;
  let framed = false;
  let chartGeneration = 0;
  let candleVersion = 0;
  let isHovering = false;
  let extremaRaf = 0;
  const streamVersions = new Map();

  const el = {
    wrap: () => document.getElementById('chartMain'),
    basicCanvas: () => document.getElementById('basicChart'),
    basicLabel: () => document.getElementById('basicLabel'),
    resetBtn: () => document.getElementById('resetChart'),
    ohlcBar: () => document.getElementById('ohlcBar'),
    wickHi: () => document.getElementById('wickHi'),
    wickHiText: () => document.getElementById('wickHiText'),
    wickLo: () => document.getElementById('wickLo'),
    wickLoText: () => document.getElementById('wickLoText'),
  };

  function visibleBarCount() {
    return state.activeMode === 'phone' ? CFG.VISIBLE_CANDLES_PHONE : CFG.VISIBLE_CANDLES_DESK;
  }

  function setStatus(message) {
    const wrap = el.wrap();
    if (!wrap) return;
    let badge = wrap.querySelector('.chart-status-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'chart-status-badge';
      badge.setAttribute('role', 'status');
      wrap.appendChild(badge);
    }
    if (badge.textContent !== message) badge.textContent = message;
    badge.hidden = !message;
  }

  function computeEma(candles, period = 20) {
    if (!candles.length) return [];
    const k = 2 / (period + 1);
    const out = [];
    let ema = candles[0].close;
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      ema = i === 0 ? c.close : c.close * k + ema * (1 - k);
      if (i >= Math.min(period - 1, 4)) {
        out.push({ time: c.time, value: ema });
      }
    }
    return out;
  }

  function paintOhlc(bar) {
    const node = el.ohlcBar();
    if (!node) return;
    if (!bar) {
      node.textContent = '';
      return;
    }
    const up = bar.close >= bar.open;
    const cls = up ? 's-up' : 's-dn';
    const pct = bar.open > 0 ? ((bar.close - bar.open) / bar.open) * 100 : 0;
    const volHtml =
      bar.volume != null && Number.isFinite(bar.volume)
        ? `<span><em>V</em><b>${fmt.compact(bar.volume)}</b></span>`
        : '';
    node.innerHTML =
      `<span><em>O</em><b class="${cls}">${fmt.num(bar.open, 4)}</b></span>` +
      `<span><em>H</em><b class="${cls}">${fmt.num(bar.high, 4)}</b></span>` +
      `<span><em>L</em><b class="${cls}">${fmt.num(bar.low, 4)}</b></span>` +
      `<span><em>C</em><b class="${cls}">${fmt.num(bar.close, 4)}</b></span>` +
      `<span><b class="${cls}">${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</b></span>` +
      volHtml;
  }

  function focusRecent() {
    if (!chart || !state.candles.length) return;
    const total = state.candles.length;
    const vis = Math.min(visibleBarCount(), total);
    chart.priceScale('right').applyOptions({ autoScale: true });
    chart.timeScale().setVisibleLogicalRange({
      from: Math.max(0, total - vis),
      to: total + 1.5,
    });
    scheduleExtremaSync();
  }

  function scheduleExtremaSync() {
    if (extremaRaf) return;
    extremaRaf = requestAnimationFrame(() => {
      extremaRaf = requestAnimationFrame(() => {
        extremaRaf = 0;
        updateExtrema();
      });
    });
  }

  function updateExtrema() {
    const wrap = el.wrap();
    if (!chart || !candleSeries || !state.candles.length || !wrap) return;

    const candles = state.candles;
    const logical = chart.timeScale().getVisibleLogicalRange();
    let from = 0;
    let to = candles.length - 1;
    if (logical && Number.isFinite(logical.from) && Number.isFinite(logical.to)) {
      from = Math.max(0, Math.ceil(logical.from));
      to = Math.min(candles.length - 1, Math.floor(logical.to));
    }
    if (from > to || to - from < 2) {
      from = Math.max(0, candles.length - visibleBarCount());
      to = candles.length - 1;
    }

    let hiBar = candles[from];
    let loBar = candles[from];
    for (let i = from; i <= to; i++) {
      const c = candles[i];
      if (!c) continue;
      if (c.high >= hiBar.high) hiBar = c;
      if (c.low <= loBar.low) loBar = c;
    }
    if (!hiBar || !loBar) return;

    visibleHi = hiBar.high;
    visibleLo = loBar.low;

    const hiOpts = {
      price: hiBar.high,
      color: 'rgba(78, 242, 171, 0.36)',
      lineWidth: 1,
      lineStyle: root.LightweightCharts.LineStyle.Dashed,
      axisLabelVisible: true,
      title: 'HI',
      axisLabelColor: '#0e2d20',
      axisLabelTextColor: '#4ef2ab',
    };
    const loOpts = {
      price: loBar.low,
      color: 'rgba(255, 117, 138, 0.36)',
      lineWidth: 1,
      lineStyle: root.LightweightCharts.LineStyle.Dashed,
      axisLabelVisible: true,
      title: 'LO',
      axisLabelColor: '#35101a',
      axisLabelTextColor: '#ff758a',
    };
    const midOpts = {
      price: (hiBar.high + loBar.low) / 2,
      color: 'rgba(159, 176, 194, 0.14)',
      lineWidth: 1,
      lineStyle: root.LightweightCharts.LineStyle.SparseDotted,
      axisLabelVisible: true,
      title: 'MID',
      axisLabelColor: '#121926',
      axisLabelTextColor: '#9fb0c2',
    };

    if (!hiLine) hiLine = candleSeries.createPriceLine(hiOpts);
    else hiLine.applyOptions(hiOpts);
    if (!loLine) loLine = candleSeries.createPriceLine(loOpts);
    else loLine.applyOptions(loOpts);
    if (!midLine) midLine = candleSeries.createPriceLine(midOpts);
    else midLine.applyOptions(midOpts);

    const paneW = chart.timeScale().width() || Math.max(120, wrap.clientWidth - 72);
    const paneH = Math.max(60, (wrap.clientHeight || 240) - (chart.timeScale().height() || 26));

    const wickHi = el.wickHi();
    const wickLo = el.wickLo();
    const hiX = chart.timeScale().timeToCoordinate(hiBar.time);
    const hiY = candleSeries.priceToCoordinate(hiBar.high);
    const loX = chart.timeScale().timeToCoordinate(loBar.time);
    const loY = candleSeries.priceToCoordinate(loBar.low);

    let hiClampedY = null;
    let loClampedY = null;

    if (wickHi && Number.isFinite(hiX) && Number.isFinite(hiY) && hiX >= 0 && hiX <= paneW) {
      hiClampedY = Math.max(6, Math.min(paneH - 26, Math.round(hiY)));
    }
    if (wickLo && Number.isFinite(loX) && Number.isFinite(loY) && loX >= 0 && loX <= paneW) {
      loClampedY = Math.max(26, Math.min(paneH - 6, Math.round(loY)));
    }

    // Avoid vertical tag collision when high and low pins are horizontally close
    if (hiClampedY != null && loClampedY != null && Math.abs(hiX - loX) < 130 && Math.abs(loClampedY - hiClampedY) < 28) {
      hiClampedY = Math.max(6, hiClampedY - 10);
      loClampedY = Math.min(paneH - 6, loClampedY + 10);
    }

    if (wickHi) {
      if (hiClampedY != null) {
        const placeLeft = hiX > paneW * 0.64;
        wickHi.classList.toggle('side-l', placeLeft);
        wickHi.classList.toggle('side-r', !placeLeft);
        wickHi.style.transform = `translate3d(${Math.round(hiX)}px, ${hiClampedY}px, 0)`;
        el.wickHiText().textContent = placeLeft
          ? `HIGH $${fmt.num(hiBar.high, 4)} ▶`
          : `◀ HIGH $${fmt.num(hiBar.high, 4)}`;
        wickHi.hidden = false;
      } else {
        wickHi.hidden = true;
      }
    }

    if (wickLo) {
      if (loClampedY != null) {
        const placeLeft = loX > paneW * 0.64;
        wickLo.classList.toggle('side-l', placeLeft);
        wickLo.classList.toggle('side-r', !placeLeft);
        wickLo.style.transform = `translate3d(${Math.round(loX)}px, ${loClampedY}px, 0)`;
        el.wickLoText().textContent = placeLeft
          ? `LOW $${fmt.num(loBar.low, 4)} ▶`
          : `◀ LOW $${fmt.num(loBar.low, 4)}`;
        wickLo.hidden = false;
      } else {
        wickLo.hidden = true;
      }
    }
  }

  /* HiDPI HTML5 Canvas Fallback if TradingView CDN is unavailable */
  function drawBasicChart() {
    if (candleSeries || document.hidden) return;
    const wrap = el.wrap();
    const canvas = el.basicCanvas();
    if (!wrap || !canvas) return;
    const width = wrap.clientWidth;
    const height = wrap.clientHeight;
    if (width < 100 || height < 80) return;

    const ratio = Math.min(root.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    ctx.clearRect(0, 0, width, height);

    const bars = state.candles.slice(-Math.min(visibleBarCount(), Math.floor(width / 6)));
    if (!bars.length) return;

    const high = Math.max(...bars.map((c) => c.high));
    const low = Math.min(...bars.map((c) => c.low));
    const maxVol = Math.max(...bars.map((c) => c.volume || 0), 1);
    const span = high - low || high * 0.01;
    const plotW = width - 70;
    const plotH = height - 42;
    const y = (p) => 12 + (high === low ? 0.5 : (high - p) / span) * (plotH - 22);
    const step = plotW / bars.length;

    ctx.font = '11px "JetBrains Mono", monospace';
    for (let i = 0; i <= 4; i++) {
      const level = 12 + ((plotH - 22) * i) / 4;
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(0, level, plotW, 1);
      ctx.fillStyle = '#9fb0c2';
      const price = high === low ? high + (0.5 - i / 4) * span : high - (span * i) / 4;
      ctx.fillText(fmt.num(price, 4), plotW + 6, level + 4);
    }

    bars.forEach((bar, i) => {
      const x = (i + 0.5) * step;
      const bodyW = Math.max(1.5, Math.min(step * 0.68, 16));
      const up = bar.close >= bar.open;
      if (state.showVol && bar.volume > 0) {
        const vh = (bar.volume / maxVol) * (plotH * 0.18);
        ctx.fillStyle = up ? 'rgba(16, 217, 132, 0.18)' : 'rgba(244, 67, 93, 0.18)';
        ctx.fillRect(x - bodyW / 2, plotH - vh + 10, bodyW, vh);
      }
      ctx.fillStyle = up ? '#10d984' : '#f4435d';
      ctx.fillRect(x - 0.5, y(bar.high), 1, Math.max(1, y(bar.low) - y(bar.high)));
      ctx.fillRect(x - bodyW / 2, Math.min(y(bar.open), y(bar.close)), bodyW, Math.max(1.5, Math.abs(y(bar.open) - y(bar.close))));
    });

    ctx.fillStyle = '#6f8194';
    for (const idx of new Set([0, Math.floor(bars.length / 2), bars.length - 1])) {
      ctx.fillText(
        fmt.fmtTime(bars[idx].time - TZ_OFFSET),
        Math.max(4, Math.min(plotW - 38, idx * step)),
        height - 7
      );
    }
  }

  function applyOverlays() {
    if (volumeSeries) {
      volumeSeries.applyOptions({ visible: state.showVol });
    }
    if (emaSeries) {
      emaSeries.applyOptions({ visible: state.showEma });
      if (state.showEma && state.candles.length) {
        emaSeries.setData(computeEma(state.candles, 20));
      }
    }
    if (!candleSeries) drawBasicChart();
  }

  function syncSeriesData() {
    if (!candleSeries) {
      drawBasicChart();
      return;
    }
    const candles = state.candles;
    candleSeries.setData(candles);

    if (volumeSeries) {
      volumeSeries.setData(
        candles.map((c) => ({
          time: c.time,
          value: c.volume || 0,
          color: c.close >= c.open ? 'rgba(16, 217, 132, 0.22)' : 'rgba(244, 67, 93, 0.22)',
        }))
      );
    }

    if (emaSeries && state.showEma) {
      emaSeries.setData(computeEma(candles, 20));
    }

    chart.priceScale('right').applyOptions({ autoScale: true });
    if (!framed) {
      focusRecent();
      framed = true;
    } else {
      scheduleExtremaSync();
    }

    if (!isHovering && candles.length) {
      paintOhlc(candles[candles.length - 1]);
    }
  }

  function chartFontSize() {
    if (state.activeMode === 'tv') {
      return Math.round(Math.max(12, Math.min(20, root.innerWidth / 160)));
    }
    return state.activeMode === 'phone' ? 10 : 11;
  }

  function init() {
    const wrap = el.wrap();
    if (!wrap) return;

    if (!basicObserver) {
      basicObserver = new ResizeObserver(drawBasicChart);
      basicObserver.observe(wrap);
    }

    if (chart) return;

    if (!root.LightweightCharts) {
      if (el.basicLabel()) el.basicLabel().hidden = false;
      if (!state.candles.length) {
        const cached = XRP.cache.read('candles:' + state.klineInterval);
        if (cached) commitRows(cached.value, false);
      }
      api.loadChartLibrary();
      return;
    }

    try {
      const priceFormat = { type: 'price', precision: 4, minMove: 0.0001 };
      chart = root.LightweightCharts.createChart(wrap, {
        layout: {
          background: { type: 'solid', color: 'transparent' },
          textColor: '#8d9fb2',
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: chartFontSize(),
        },
        grid: {
          vertLines: { color: 'rgba(255, 255, 255, 0.032)' },
          horzLines: { color: 'rgba(255, 255, 255, 0.05)' },
        },
        crosshair: {
          mode: root.LightweightCharts.CrosshairMode.Normal,
          vertLine: {
            color: 'rgba(76, 184, 240, 0.42)',
            width: 1,
            style: 3,
            labelBackgroundColor: '#131d2c',
          },
          horzLine: {
            color: 'rgba(76, 184, 240, 0.42)',
            width: 1,
            style: 3,
            labelBackgroundColor: '#131d2c',
          },
        },
        rightPriceScale: {
          visible: true,
          autoScale: true,
          borderVisible: true,
          ticksVisible: false,
          alignLabels: true,
          borderColor: 'rgba(255, 255, 255, 0.09)',
          scaleMargins: { top: 0.07, bottom: 0.18 },
        },
        timeScale: {
          visible: true,
          borderVisible: true,
          ticksVisible: false,
          borderColor: 'rgba(255, 255, 255, 0.09)',
          timeVisible: true,
          secondsVisible: false,
          rightOffset: 2,
          barSpacing: state.activeMode === 'phone' ? 8 : 13,
          minBarSpacing: 3,
          tickMarkFormatter: (t) => fmt.fmtTime(t - TZ_OFFSET),
        },
        localization: {
          timeFormatter: (t) => fmt.fmtFull(t - TZ_OFFSET),
        },
        handleScroll: true,
        handleScale: true,
      });

      /* Add candlestick series FIRST so the right price scale inherits 4-decimal precision */
      candleSeries = chart.addCandlestickSeries({
        upColor: '#10d984',
        downColor: '#f4435d',
        borderUpColor: '#10d984',
        borderDownColor: '#f4435d',
        wickUpColor: '#4ef2ab',
        wickDownColor: '#ff758a',
        priceLineColor: 'rgba(16, 217, 132, 0.42)',
        priceLineWidth: 1,
        priceLineStyle: 2,
        lastValueVisible: true,
        priceFormat,
      });

      emaSeries = chart.addLineSeries({
        color: 'rgba(76, 184, 240, 0.85)',
        lineWidth: 1.5,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        visible: state.showEma,
        priceFormat,
      });

      volumeSeries = chart.addHistogramSeries({
        priceFormat: { type: 'volume' },
        priceScaleId: 'vol',
        lastValueVisible: false,
        priceLineVisible: false,
        visible: state.showVol,
      });
      chart.priceScale('vol').applyOptions({
        scaleMargins: { top: 0.84, bottom: 0 },
        visible: false,
      });

      if (el.basicCanvas()) el.basicCanvas().hidden = true;
      if (el.basicLabel()) el.basicLabel().hidden = true;
      if (el.resetBtn()) el.resetBtn().disabled = false;

      const fit = () => {
        if (!chart || !wrap) return;
        const rect = wrap.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          chart.applyOptions({
            width: Math.floor(rect.width),
            height: Math.floor(rect.height),
            layout: { fontSize: chartFontSize() },
          });
          scheduleExtremaSync();
        }
      };

      if (resizeObserver) resizeObserver.disconnect();
      resizeObserver = new ResizeObserver(fit);
      resizeObserver.observe(wrap);
      fit();

      wrap.addEventListener('dblclick', focusRecent);
      chart.timeScale().subscribeVisibleLogicalRangeChange(scheduleExtremaSync);

      chart.subscribeCrosshairMove((param) => {
        if (!param?.time || !param.seriesData?.get(candleSeries)) {
          isHovering = false;
          if (state.candles.length) paintOhlc(state.candles[state.candles.length - 1]);
          return;
        }
        isHovering = true;
        const c = param.seriesData.get(candleSeries);
        const v = volumeSeries ? param.seriesData.get(volumeSeries)?.value : null;
        paintOhlc({ open: c.open, high: c.high, low: c.low, close: c.close, volume: v });
      });

      setStatus('Loading candles…');
      const saved = XRP.cache.read('candles:' + state.klineInterval);
      if (state.candles.length) {
        syncSeriesData();
        setStatus('');
      } else if (saved) {
        commitRows(saved.value, false);
        setStatus('');
      }
      bus.emit('chart:ready');
    } catch (err) {
      console.error('[XRP Chart] init failed:', err);
      if (resizeObserver) resizeObserver.disconnect();
      chart?.remove();
      chart = candleSeries = volumeSeries = emaSeries = null;
      if (el.resetBtn()) el.resetBtn().disabled = true;
      if (el.basicCanvas()) el.basicCanvas().hidden = false;
      if (el.basicLabel()) el.basicLabel().hidden = false;
      drawBasicChart();
    }
  }

  function normalizeRows(rows) {
    if (!Array.isArray(rows)) return [];
    const unique = new Map();
    for (const k of rows) {
      if (!Array.isArray(k) || k.slice(0, 5).some((v) => v == null || v === '')) continue;
      const t = Number(k[0]);
      const o = Number(k[1]);
      const h = Number(k[2]);
      const l = Number(k[3]);
      const c = Number(k[4]);
      const v = k[5] != null && Number.isFinite(Number(k[5])) ? Number(k[5]) : 0;
      if (
        ![t, o, h, l, c].every(Number.isFinite) ||
        t <= 0 ||
        Math.floor(t) !== t ||
        Math.min(o, h, l, c) <= 0 ||
        h < Math.max(o, l, c) ||
        l > Math.min(o, h, c)
      ) {
        continue;
      }
      unique.set(t, [t, o, h, l, c, v]);
    }
    return [...unique.values()].sort((a, b) => a[0] - b[0]).slice(-CFG.MAX_CANDLES);
  }

  function rowsFromMemory() {
    return state.candles.map((c) => [(c.time - TZ_OFFSET) * 1000, c.open, c.high, c.low, c.close, c.volume || 0]);
  }

  function commitRows(rows, merge = true, version = candleVersion) {
    let result = normalizeRows(rows);
    if (merge) {
      const old = rowsFromMemory();
      const newer = old.filter((k) => (streamVersions.get(k[0]) || 0) > version);
      result = normalizeRows([...old, ...result, ...newer]);
    }
    if (!result.length) return;

    state.candles = result.map(([t, o, h, l, c, v]) => ({
      time: fmt.toTzSec(t),
      open: o,
      high: h,
      low: l,
      close: c,
      volume: v,
    }));

    for (const t of streamVersions.keys()) {
      if (t < result[0][0]) streamVersions.delete(t);
    }
    syncSeriesData();
  }

  function applyKline(k) {
    if (!k) return;
    const rows = normalizeRows([[k.t, k.o, k.h, k.l, k.c, k.v]]);
    if (!rows.length) return;
    const [ms, o, h, l, c, v] = rows[0];
    const t = fmt.toTzSec(ms);
    const arr = state.candles;
    const last = arr[arr.length - 1];
    if (last && t < last.time) return;

    const candle = { time: t, open: o, high: h, low: l, close: c, volume: v };
    const isNewBar = !last || last.time !== t;
    if (!isNewBar) arr[arr.length - 1] = candle;
    else arr.push(candle);

    streamVersions.set(ms, ++candleVersion);

    if (arr.length > CFG.MAX_CANDLES) {
      arr.splice(0, arr.length - CFG.MAX_CANDLES);
      const oldest = (arr[0].time - TZ_OFFSET) * 1000;
      for (const ts of streamVersions.keys()) {
        if (ts < oldest) streamVersions.delete(ts);
      }
      syncSeriesData();
      return;
    }

    if (!candleSeries) {
      drawBasicChart();
      return;
    }

    candleSeries.update(candle);
    if (volumeSeries) {
      volumeSeries.update({
        time: t,
        value: v,
        color: c >= o ? 'rgba(16, 217, 132, 0.22)' : 'rgba(244, 67, 93, 0.22)',
      });
    }
    if (emaSeries && state.showEma && arr.length >= 5) {
      const emaArr = computeEma(arr, 20);
      if (emaArr.length) emaSeries.update(emaArr[emaArr.length - 1]);
    }
    if (!isHovering) paintOhlc(candle);
    if (isNewBar || h >= visibleHi || l <= visibleLo) {
      chart.priceScale('right').applyOptions({ autoScale: true });
    }
    scheduleExtremaSync();
  }

  function switchTimeframe(tf) {
    if (!CFG.TIMEFRAMES.includes(tf) || tf === state.klineInterval) return;
    state.klineInterval = tf;
    XRP.cache.write('timeframe', tf);
    chartGeneration++;

    candleSeries?.setData([]);
    volumeSeries?.setData([]);
    emaSeries?.setData([]);
    if (el.basicCanvas()) el.basicCanvas().width = el.basicCanvas().width;

    for (const line of [hiLine, loLine, midLine]) {
      if (line && candleSeries) candleSeries.removePriceLine(line);
    }
    hiLine = loLine = midLine = null;
    if (el.wickHi()) el.wickHi().hidden = true;
    if (el.wickLo()) el.wickLo().hidden = true;
    paintOhlc(null);

    setStatus('Loading candles…');
    state.candles = [];
    streamVersions.clear();
    framed = false;
    visibleHi = -Infinity;
    visibleLo = Infinity;

    const saved = XRP.cache.read('candles:' + tf);
    if (saved) commitRows(saved.value, false);
    if (!candleSeries) init();

    bus.emit('chart:tf-changed', tf);
  }

  function onModeChange() {
    if (!chart) {
      drawBasicChart();
      return;
    }
    chart.applyOptions({
      layout: { fontSize: chartFontSize() },
      timeScale: { barSpacing: state.activeMode === 'phone' ? 8 : 13 },
    });
    requestAnimationFrame(() => {
      const wrap = el.wrap();
      if (chart && wrap && wrap.clientWidth > 0 && wrap.clientHeight > 0) {
        chart.applyOptions({
          width: Math.floor(wrap.clientWidth),
          height: Math.floor(wrap.clientHeight),
        });
        focusRecent();
      }
    });
  }

  function getGeneration() {
    return chartGeneration;
  }

  function getVersion() {
    return candleVersion;
  }

  root.addEventListener('xrp-charts-ready', init);
  root.addEventListener('xrp-charts-failed', () => {
    if (el.basicLabel()) el.basicLabel().hidden = false;
    drawBasicChart();
  });

  XRP.chart = {
    init,
    focusRecent,
    normalizeRows,
    rowsFromMemory,
    commitRows,
    applyKline,
    switchTimeframe,
    applyOverlays,
    setStatus,
    onModeChange,
    getGeneration,
    getVersion,
    drawBasicChart,
  };
})(window);
