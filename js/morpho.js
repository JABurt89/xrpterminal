/* ═══════════════════════════════════════════════════════════════
   XRP TERMINAL v3 — MORPHO BLUE (FXRP / RLUSD) ON-CHAIN MONITOR
   ═══════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  const XRP = (root.XRP = root.XRP || {});
  const { CFG, cache, fmt, state, bus } = XRP;

  const M = CFG.MORPHO;
  const WAD = 10n ** 18n;
  const SECONDS_PER_YEAR = 31_536_000;

  const GRAPHQL_POS_QUERY = `{ marketPositions(first:100, where:{userAddress_in:["${M.WALLET}"],chainId_in:[1]}) { items { market { marketId lltv collateralAsset {symbol decimals address} loanAsset {symbol decimals address price {usd timestamp}} state {price borrowApy timestamp} } state {borrowAssets collateral borrowShares} } } }`;
  const GRAPHQL_TX_QUERY = `{ marketTransactions(first:1000,orderBy:Timestamp,orderDirection:Asc,where:{chainId_in:[1],userAddress_in:["${M.WALLET}"],marketUniqueKey_in:["${M.MARKET}"],type_in:[Borrow,Repay,Liquidation]}) { items {txHash timestamp logIndex type data {... on MarketTransactionTransferData {assets shares}}} } }`;

  let busy = false;
  let interestBusy = false;
  let savingsBusy = false;
  let rpcPreferred = 0;

  /* Persistent immutable historical 1m candle entry prices */
  const entryPrices = new Map([
    [1792372440000, 1.3096],
    [1792380300000, 1.3116],
  ]);
  const savedEntryPrices = cache.read('morphoEntryPrices', Infinity)?.value;
  if (savedEntryPrices && typeof savedEntryPrices === 'object') {
    for (const [k, v] of Object.entries(savedEntryPrices)) {
      if (Number.isFinite(+k) && Number.isFinite(+v) && +v > 0) entryPrices.set(+k, +v);
    }
  }
  function persistEntryPrices() {
    cache.write('morphoEntryPrices', Object.fromEntries(entryPrices.entries()));
  }

  const word = (v) => BigInt(v).toString(16).padStart(64, '0');
  const address = (v) => '0x' + v.toString(16).padStart(40, '0');

  function words(hex, count) {
    if (typeof hex !== 'string' || !/^0x[0-9a-f]+$/i.test(hex) || hex.length !== 2 + count * 64) {
      throw new Error('Invalid contract response');
    }
    return Array.from({ length: count }, (_, i) => BigInt('0x' + hex.slice(2 + i * 64, 66 + i * 64)));
  }

  async function rpc(url, method, params) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!res.ok) throw new Error('RPC HTTP ' + res.status);
      const json = await res.json();
      if (json.error || json.result == null) throw new Error('RPC response error');
      return json.result;
    } finally {
      clearTimeout(timer);
    }
  }

  function accruedDebt(m, position, rate, now) {
    const elapsed = now - m[4];
    if (elapsed < 0n) throw new Error('Invalid accrual time');
    const first = rate * elapsed;
    const second = (first * first) / (2n * WAD);
    const third = (second * first) / (3n * WAD);
    const total = m[2] + (m[2] * (first + second + third)) / WAD;
    return (position[1] * (total + 1n) + m[3] + 1_000_000n - 1n) / (m[3] + 1_000_000n);
  }

  function calculatePosition(p) {
    const m = p.market;
    const st = p.state;
    if (
      m.marketId !== M.MARKET ||
      m.collateralAsset.address.toLowerCase() !== M.COLL_TOKEN ||
      m.loanAsset.address.toLowerCase() !== M.LOAN_TOKEN ||
      m.collateralAsset.decimals !== 6 ||
      m.loanAsset.decimals !== 18 ||
      m.lltv !== M.LLTV_WAD.toString()
    ) {
      throw new Error('Market settings mismatch');
    }
    for (const v of [st.borrowAssets, st.collateral, m.state.price]) {
      if (!/^\d+$/.test(String(v))) throw new Error('Invalid numeric amount');
    }
    const debt = Number(st.borrowAssets) / 1e18;
    const collateral = Number(st.collateral) / 1e6;
    const oracle = Number(m.state.price) / 1e48;
    const threshold = Number(m.lltv) / 1e18;
    const timestamp = Number(m.state.timestamp) * 1000;
    if (![debt, collateral, oracle, timestamp].every(Number.isFinite) || oracle <= 0 || timestamp <= 0 || timestamp > Date.now() + 60_000) {
      throw new Error('Invalid market data');
    }
    const usd = Number(m.loanAsset.price?.usd);
    const usdTime = Number(m.loanAsset.price?.timestamp) * 1000;
    const usdFresh = usd > 0 && Number.isFinite(usd) && usdTime > 0 && Date.now() - usdTime < 3_600_000 && usdTime < Date.now() + 60_000;
    const ltv = collateral > 0 ? debt / (collateral * oracle) : debt > 0 ? Infinity : 0;
    const trigger = collateral > 0 ? debt / (collateral * threshold) : null;
    const bufferPct = trigger != null && oracle > 0 && debt > 0 ? ((oracle - trigger) / oracle) * 100 : null;

    return {
      borrowShares: String(st.borrowShares),
      debt,
      collateral,
      oracle,
      threshold,
      timestamp,
      usdFresh,
      usdTime,
      usd,
      apy: typeof m.state.borrowApy === 'number' && Number.isFinite(m.state.borrowApy) ? m.state.borrowApy : null,
      ltv,
      trigger,
      bufferPct,
    };
  }

  async function updateUsdQuote() {
    const q = state.morpho.usdQuote;
    if (document.hidden || (q && Date.now() - Number(q.timestamp) * 1000 < 240_000)) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    try {
      const res = await fetch(`https://api.morpho.org/v0/tokens/1:${M.LOAN_TOKEN}/price`, {
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!res.ok) return;
      const d = (await res.json())?.data;
      if (d && Number(d.price) > 0 && Number(d.timestamp) > 0) {
        state.morpho.usdQuote = { usd: Number(d.price), timestamp: Number(d.timestamp) };
      }
    } catch (_) {
    } finally {
      clearTimeout(timer);
    }
  }

  async function readChain(url) {
    const [chain, block] = await Promise.all([rpc(url, 'eth_chainId', []), rpc(url, 'eth_getBlockByNumber', ['latest', false])]);
    if (BigInt(chain) !== 1n || !block.number || !block.timestamp) throw new Error('Wrong network');
    const timestamp = Number(BigInt(block.timestamp)) * 1000;
    if (Date.now() - timestamp > 180_000 || timestamp > Date.now() + 60_000) throw new Error('RPC block stale');

    const call = (to, data) => rpc(url, 'eth_call', [{ to, data }, block.number]);
    const [ph, mh, uh] = await Promise.all([
      call(M.CONTRACT, '0x2c3c9157' + M.MARKET.slice(2)),
      call(M.CONTRACT, '0x5c60e39a' + M.MARKET.slice(2)),
      call(M.CONTRACT, '0x93c52062' + M.MARKET.slice(2) + M.WALLET.slice(2).toLowerCase().padStart(64, '0')),
    ]);

    const params = words(ph, 5);
    const m = words(mh, 6);
    const position = words(uh, 3);
    if (address(params[0]) !== M.LOAN_TOKEN || address(params[1]) !== M.COLL_TOKEN || params[4] !== M.LLTV_WAD) {
      throw new Error('Unexpected market');
    }

    const [oh, rh] = await Promise.all([
      call(address(params[2]), '0xa035b1fe'),
      call(address(params[3]), '0x8c00bf6b' + params.map(word).join('') + m.map(word).join('')),
    ]);

    const rate = words(rh, 1)[0];
    const oracleRaw = words(oh, 1)[0];
    if (oracleRaw <= 0n) throw new Error('Invalid oracle');

    const debtRaw = accruedDebt(m, position, rate, BigInt(block.timestamp));
    // Live on-chain continuous-compounded APY from IRM per-second borrow rate
    const borrowApy = Math.expm1((Number(rate) / 1e18) * SECONDS_PER_YEAR);

    const rec = calculatePosition({
      market: {
        marketId: M.MARKET,
        lltv: params[4].toString(),
        collateralAsset: { address: address(params[1]), decimals: 6 },
        loanAsset: { address: address(params[0]), decimals: 18, price: state.morpho.usdQuote },
        state: { price: oracleRaw.toString(), timestamp: timestamp / 1000, borrowApy },
      },
      state: {
        borrowAssets: debtRaw.toString(),
        collateral: position[2].toString(),
        borrowShares: position[1].toString(),
      },
    });
    rec.source = 'CHAIN';
    rec.block = BigInt(block.number).toString();
    rec.receivedAt = Date.now();
    return rec;
  }

  async function refreshPosition() {
    if (busy || document.hidden) return;
    busy = true;
    try {
      // Await RLUSD/USD quote first on initial boot so first chain paint uses live USD rate
      if (!state.morpho.usdQuote) await updateUsdQuote();

      const attempts = M.RPC_URLS.map((_, i) => (rpcPreferred + i) % M.RPC_URLS.length);
      for (const i of attempts) {
        try {
          state.morpho.latest = await readChain(M.RPC_URLS[i]);
          rpcPreferred = i;
          state.morpho.failed = false;
          return;
        } catch (err) {
          console.warn('[Morpho RPC]', err.message);
        }
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 11_000);
      try {
        const res = await fetch('https://api.morpho.org/graphql', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: GRAPHQL_POS_QUERY }),
          signal: controller.signal,
          cache: 'no-store',
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        if (json.errors) throw new Error('Morpho GraphQL error');
        const items = json.data?.marketPositions?.items;
        if (!Array.isArray(items)) throw new Error('Missing positions');
        const pos = items.find((item) => item.market?.marketId === M.MARKET);
        if (!pos) throw new Error('Loan position not returned');
        const candidate = calculatePosition(pos);
        candidate.source = 'API';
        candidate.receivedAt = Date.now();
        if (!state.morpho.latest || candidate.timestamp >= state.morpho.latest.timestamp) {
          state.morpho.latest = candidate;
        }
        if (pos.market.loanAsset.price) state.morpho.usdQuote = pos.market.loanAsset.price;
        state.morpho.failed = false;
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      state.morpho.failed = true;
      console.warn('[Morpho Loan]', err.message);
    } finally {
      busy = false;
      paint();
    }
  }

  async function refreshInterest() {
    if (interestBusy || document.hidden) return;
    interestBusy = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 14_000);
    try {
      const res = await fetch(
        `https://api.morpho.org/v0/blue/markets/1:${M.MARKET}/users/${M.WALLET}/position/performance`,
        { signal: controller.signal, cache: 'no-store' }
      );
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const d = (await res.json())?.data;
      if (
        !d ||
        d.chain_id !== 1 ||
        d.market_id !== M.MARKET ||
        d.user_address.toLowerCase() !== M.WALLET.toLowerCase() ||
        d.accounting_method !== 'average_cost' ||
        !/^\d+$/.test(d.borrow_net_cost_assets) ||
        !/^\d+$/.test(d.last_indexed_block)
      ) {
        throw new Error('Invalid interest payload');
      }
      const amount = Number(d.borrow_net_cost_assets) / 1e18;
      if (!Number.isFinite(amount)) throw new Error('Invalid interest amount');
      state.morpho.interest = { amount, block: d.last_indexed_block, receivedAt: Date.now() };
      state.morpho.interestFailed = false;
    } catch (err) {
      state.morpho.interestFailed = true;
      console.warn('[Morpho Interest]', err.message);
    } finally {
      clearTimeout(timer);
      interestBusy = false;
      paint();
    }
  }

  async function historicalXrp(timestampSec) {
    const minute = Math.floor(timestampSec / 60) * 60_000;
    if (entryPrices.has(minute)) return entryPrices.get(minute);

    const urls = [
      `https://data-api.binance.vision/api/v3/klines?symbol=XRPUSDT&interval=1m&startTime=${minute}&limit=1`,
      `https://api.binance.com/api/v3/klines?symbol=XRPUSDT&interval=1m&startTime=${minute}&limit=1`,
    ];
    for (const url of urls) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) continue;
        const rows = await res.json();
        const row = rows?.[0];
        if (Array.isArray(row) && Number(row[0]) === minute && Number(row[1]) > 0 && Number.isFinite(Number(row[1]))) {
          const price = Number(row[1]);
          entryPrices.set(minute, price);
          persistEntryPrices();
          return price;
        }
      } catch (_) {
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error('Historical XRP price unavailable');
  }

  async function refreshSavings() {
    if (savingsBusy || document.hidden) return;
    savingsBusy = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch('https://api.morpho.org/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: GRAPHQL_TX_QUERY }),
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!res.ok) throw new Error('Borrow history unavailable');
      const json = await res.json();
      if (json.errors) throw new Error('Borrow history unavailable');
      const items = json.data?.marketTransactions?.items;
      if (!Array.isArray(items) || !items.length || items.length >= 1000) {
        throw new Error('Complete borrow history unavailable');
      }

      const h = { borrowedXrp: 0, repaidXrp: 0, netShares: 0n, count: 0, checkedAt: Date.now(), liquidated: false };
      const seen = new Set();
      for (const t of items) {
        const key = t.txHash + ':' + t.logIndex;
        if (seen.has(key)) throw new Error('Duplicate transaction');
        seen.add(key);
        if (t.type === 'Liquidation') {
          h.liquidated = true;
          continue;
        }
        if (
          !['Borrow', 'Repay'].includes(t.type) ||
          !/^\d+$/.test(t.data?.assets) ||
          !/^\d+$/.test(t.data?.shares) ||
          !(Number(t.timestamp) > 0)
        ) {
          throw new Error('Invalid transaction');
        }
        const amount = Number(t.data.assets) / 1e18;
        if (!Number.isFinite(amount)) throw new Error('Invalid amount');
        const price = await historicalXrp(Number(t.timestamp));
        if (t.type === 'Borrow') {
          h.borrowedXrp += amount / price;
          h.netShares += BigInt(t.data.shares);
          h.count++;
        } else {
          h.repaidXrp += amount / price;
          h.netShares -= BigInt(t.data.shares);
        }
      }
      state.morpho.savings = h;
      state.morpho.savingsError = '';
    } catch (err) {
      state.morpho.savingsError = err.message;
    } finally {
      clearTimeout(timer);
      savingsBusy = false;
      paint();
    }
  }

  function put(key, value) {
    document.querySelectorAll(`[data-loan="${key}"]`).forEach((el) => {
      if (el.textContent !== value) el.textContent = value;
    });
  }

  function setText(id, value) {
    const el = document.getElementById(id);
    if (el && el.textContent !== value) el.textContent = value;
  }

  function paint() {
    const { latest, failed, interest, interestFailed, savings, savingsError } = state.morpho;
    const xrpPrice = state.xrpUsd;
    const xrpTs = state.tickerTimes['xrpusdt@ticker'] || 0;

    /* 1. Interest */
    const interestOld = interestFailed || (interest && Date.now() - interest.receivedAt > 120_000);
    const interestTxt = interest ? fmt.num(interest.amount, 2) : '—';
    put('interest', interestTxt);
    document.querySelectorAll('[data-loan="interest"]').forEach((el) => (el.style.opacity = interestOld ? '0.5' : ''));
    setText('ldInterest', interest ? interestTxt + ' RLUSD' : '—');
    setText(
      'ldInterestDetail',
      interest
        ? `Total accrued interest: ${interestTxt} RLUSD (paid + unpaid for this wallet and market; not an extra fee on top of debt). Morpho indexed block #${interest.block}.${interestOld ? ' Data may be delayed.' : ''}`
        : interestFailed
          ? 'Accrued interest data unavailable — retrying…'
          : 'Loading accrued interest…'
    );

    /* 2. Savings (Borrow vs Sell) */
    let savedSummary = '—';
    if (!savings || !latest || !xrpPrice) {
      put('saved-xrp', '—');
      put('saved-usd', '—');
      setText('ldSavedDetail', savingsError || 'Loading borrow history and live XRP price…');
    } else if (savings.liquidated || !/^\d+$/.test(String(latest.borrowShares)) || savings.netShares !== BigInt(latest.borrowShares)) {
      put('saved-xrp', '—');
      put('saved-usd', '—');
      setText(
        'ldSavedDetail',
        savings.liquidated
          ? 'XRP saved is unavailable after a liquidation.'
          : 'Matching borrow transaction history to current on-chain shares…'
      );
    } else {
      const quoteGood = latest.usdFresh && Date.now() - latest.usdTime < 3_600_000;
      const rlusdUsd = quoteGood ? latest.usd : 1;
      const repaymentXrp = (latest.debt * rlusdUsd) / xrpPrice;
      const savedXrp = savings.borrowedXrp - savings.repaidXrp - repaymentXrp;
      const savedUsd = savedXrp * xrpPrice;
      const xrpStr = (savedXrp >= 0 ? '+' : '−') + fmt.num(Math.abs(savedXrp), 2);
      const usdStr = (savedUsd >= 0 ? '+$' : '−$') + fmt.num(Math.abs(savedUsd), 2);
      savedSummary = `${xrpStr} XRP (${usdStr})`;
      put('saved-xrp', xrpStr);
      put('saved-usd', usdStr);

      const old =
        !!savingsError ||
        Date.now() - savings.checkedAt > 120_000 ||
        (xrpTs && Date.now() - xrpTs > 45_000) ||
        failed ||
        Date.now() - latest.timestamp > 600_000;

      for (const key of ['saved-xrp', 'saved-usd']) {
        document.querySelectorAll(`[data-loan="${key}"]`).forEach((el) => {
          el.className = savedXrp >= 0 ? 'positive' : 'negative';
          el.style.opacity = old ? '0.5' : '';
        });
      }
      setText(
        'ldSavedDetail',
        `${fmt.num(savings.borrowedXrp, 2)} XRP sale avoided − ${fmt.num(savings.repaidXrp, 2)} XRP earlier repayments − ${fmt.num(repaymentXrp, 2)} XRP needed to repay today across ${savings.count} borrow tx(s). Entry prices use each transaction minute's opening XRP/USDT candle; current spot $${fmt.num(xrpPrice, 4)}.${!quoteGood ? ' RLUSD estimated at $1.' : ''} Excludes gas, fees & slippage.`
      );
    }
    setText('ldSaved', savedSummary);

    /* 3. Core On-Chain Position */
    const card = document.getElementById('cardMorpho');
    const riskBadge = document.getElementById('loanRiskBadge');
    const ltvFill = document.getElementById('loanLtvFill');

    if (!latest) {
      put('status', failed ? 'Unavailable' : 'Checking');
      if (riskBadge) {
        riskBadge.className = 'risk-badge unknown';
        riskBadge.textContent = failed ? 'ERR' : 'SYNC';
      }
      if (failed) setText('ldDetail', 'Loan telemetry unavailable. Retrying automatically…');
      return;
    }

    const r = latest;
    const old = failed || Date.now() - r.timestamp > 600_000;
    const usdFresh = r.usdFresh && Date.now() - r.usdTime < 3_600_000;
    const timeStr = new Date(r.timestamp).toLocaleTimeString('en-GB', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      timeZone: CFG.TZ,
    });

    const risk = r.ltv >= r.threshold ? 'danger' : r.ltv >= r.threshold * 0.88 ? 'warning' : 'normal';
    const riskLabel = risk === 'danger' ? 'AT RISK' : risk === 'warning' ? 'CAUTION' : 'SAFE';

    const liqTxt =
      r.debt === 0
        ? 'None'
        : r.trigger !== null
          ? (usdFresh ? '$' : '≈$') + fmt.num(r.trigger * (usdFresh ? r.usd : 1), 4)
          : '—';
    const ltvPct = Number.isFinite(r.ltv) ? r.ltv * 100 : 100;
    const ltvTxt = Number.isFinite(r.ltv) ? fmt.num(ltvPct, 2) + '%' : '≥77%';
    const apyTxt = r.apy != null ? fmt.num(r.apy * 100, 2) + '%' : '—';
    const bufferTxt =
      r.bufferPct != null
        ? `${r.bufferPct >= 0 ? fmt.num(r.bufferPct, 1) + '% buffer' : 'BELOW LIQ'}${r.apy != null ? ' · ' + apyTxt + ' APY' : ''}`
        : r.debt === 0
          ? 'Debt-free'
          : '—';

    put('status', (old ? 'OLD · ' : '') + (r.source || 'API') + ' · ' + timeStr);
    put('debt', fmt.num(r.debt, 2));
    put('liquidation', liqTxt);
    put('ltv', ltvTxt);

    setText('loanLtvSummary', `LTV ${ltvTxt} / 77.0% LLTV`);
    setText('loanBuffer', bufferTxt);
    if (ltvFill) ltvFill.style.width = Math.max(0, Math.min(100, ltvPct)).toFixed(1) + '%';
    if (card) {
      card.classList.toggle('loan-old', old);
      card.dataset.risk = risk;
    }
    if (riskBadge) {
      riskBadge.className = 'risk-badge ' + risk;
      riskBadge.textContent = riskLabel;
    }

    /* Inspector modal fields */
    setText('loanDialogSub', `${r.source === 'CHAIN' ? 'Ethereum Block #' + r.block : 'Morpho GraphQL API'} · Updated ${timeStr} ICT`);
    setText('ldCollateral', fmt.num(r.collateral, 2) + ' FXRP');
    setText('ldDebt', fmt.num(r.debt, 2) + ' RLUSD');
    setText('ldApy', apyTxt);
    setText('ldOracle', fmt.num(r.oracle, 4) + ' RLUSD/FXRP');
    setText('ldLiq', liqTxt + (r.bufferPct != null ? ` (${fmt.num(r.bufferPct, 1)}% drop)` : ''));
    setText('ldLtv', `${ltvTxt} / 77.00%`);
    setText(
      'ldDetail',
      `Position holds ${fmt.num(r.collateral, 2)} FXRP against ${fmt.num(r.debt, 2)} RLUSD debt. Oracle rate ${fmt.num(r.oracle, 4)} RLUSD/FXRP.${r.trigger != null && r.debt > 0 ? ` Oracle liquidation trigger: ${fmt.num(r.trigger, 6)} RLUSD/FXRP.` : ''}${!usdFresh ? ' Live RLUSD/USD quote unavailable; assuming $1.' : ''}${failed ? ' Latest refresh failed; showing cached reading.' : ''}`
    );

    bus.emit('morpho:update');
  }

  function refreshAll() {
    if (document.hidden || navigator.onLine === false) return Promise.resolve();
    return Promise.allSettled([updateUsdQuote().then(refreshPosition), refreshInterest(), refreshSavings()]);
  }

  bus.on('ticker:xrp', paint);

  XRP.morpho = {
    refreshAll,
    paint,
  };
})(window);
