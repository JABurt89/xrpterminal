# XRP Terminal v3

A real-time XRP market, DeFi loan, macro telemetry, and Chiang Mai environment terminal engineered for **TV (strict zero-scroll 10-foot display)**, **PC workstation**, and **Phone (thumb-first mobile app)**.

Runs natively as zero-build static files on **GitHub Pages** (`https://jaburt89.github.io/xrpterminal/`) and automatically upgrades to cached, CORS-free server-side aggregation when run via the included zero-dependency Node.js backend (`server.js`).

## Display Modes

| Mode | Trigger | Layout |
| --- | --- | --- |
| **TV** | `?mode=tv` or `?tv=1` or Smart TV UA | Strict `100dvh` zero-scroll 4-band grid scaled proportionally (`min(1vw, 1.7778dvh)`) from 720p to 4K UHD. Includes auto-hiding cursor, subtle chrome dimming on idle, optional OLED pixel-shift protection, and remote arrow-key timeframe cycling. |
| **PC** | `?mode=pc` or desktop browsers | Interactive zero-scroll workstation on standard displays (`≥ 1024×640`) with graceful scroll fallback in narrow split-screen panes, EMA 20 & Volume chart overlays, crosshair OHLCV, and keyboard hotkeys. |
| **Phone** | `?mode=phone` or `?mobile=1` or viewports `≤ 720px` | Full data parity in a thumb-first flow: sticky live price bar, interactive candlestick chart with all 7 timeframes, 1M portfolio & T-Bill income, Morpho loan health, 2-column macro grid, and Chiang Mai weather & swipeable 8-hour forecast. |

## Features

- **Live Market Feeds**: Binance WebSocket (`XRP/USDT`, `BTC/USDT`, `XRP/BTC`, live klines) with multi-host failover and REST fallback.
- **Interactive Charting**: TradingView Lightweight Charts v4.1.3 with `1M / 3M / 5M / 15M / 1H / 4H / 1D` timeframes, volume histogram, toggleable EMA 20, HI/LO/MID reference lines, non-overlapping wick callout pins, and a HiDPI Canvas fallback.
- **Portfolio & 13-Week US T-Bill Yield**: Customizable XRP holdings (default `1,000,000 XRP`) auto-cycling across `THB`, `TWD`, `USD`, and `CAD` with click-to-pin, live 24h P&L, and live US Treasury Fiscal Data 13-week bill auction income breakdown across all four currencies.
- **Morpho Blue On-Chain Loan Monitor (`FXRP / RLUSD`)**: Direct Ethereum Mainnet JSON-RPC contract reads (compounded debt, live IRM borrow APY, oracle price, LTV vs `77%` LLTV health gauge, liquidation drop buffer %, accrued interest, and borrow-vs-sell XRP/USD savings) with Morpho GraphQL fallback.
- **Macro Telemetry**: `USD/JPY` (with live NY FX session open/close countdown), `XRP/JPY`, `Brent Futures / USD & JPY`, `24H Volume`, `XRP Market Cap`, `RLUSD Market Cap`, and `XRP / Sats`.
- **Chiang Mai Environment**: Live `Asia/Bangkok` (ICT) clock, Open-Meteo temperature/humidity/daily H-L, adaptive 8-hour precipitation forecast, and US AQI badge (optional IQAir key or Open-Meteo AQI).

## Running Locally (Optional Cached Backend)

Requires Node.js 18+ with **zero external npm dependencies**:

```bash
npm start
# Optional: custom port or IQAir API key
PORT=8080 IQAIR_KEY=your_key node server.js
```

`server.js` serves the static frontend (with HTTP Range streaming for `217379_medium.mp4` and gzip compression) alongside singleflight-deduplicated, stale-while-revalidate `/api/*` endpoints for Binance, Yahoo Finance (`USD/JPY` & `BZ=F` Brent), AmericasOilWatch, Frankfurter ECB, Currency API, US Treasury, CoinGecko/DeFiLlama, and Open-Meteo.

## Keyboard & TV Remote Shortcuts

- `1`–`7`: Switch chart timeframe (`1M` through `1D`)
- `←` / `→` (TV mode): Cycle chart timeframes
- `R`: Reset chart zoom
- `E`: Toggle EMA 20 overlay
- `V`: Cycle TV / PC / Phone mode
- `C`: Cycle portfolio currency
- `L`: Open Morpho Loan Inspector
- `I`: Open 13W T-Bill Calculator
- `D`: Open Data Feeds & Settings
- `F`: Toggle fullscreen
- `?`: Open shortcuts help
