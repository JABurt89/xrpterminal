# XRP Terminal v4

A precision real-time **XRP market, Morpho Blue DeFi loan, macro FX/commodities, and Chiang Mai environment terminal** engineered specifically for **TV (strict zero-scroll 10-foot wall display)**, **PC workstation**, and **Phone (thumb-first mobile app)**.

Runs natively as zero-build static files on **GitHub Pages** (`https://jaburt89.github.io/xrpterminal/`) and automatically upgrades to single-roundtrip `/api/bootstrap` hydration and stale-while-revalidate (SWR) server-side caching when served via the zero-dependency Node.js backend (`server.js`).

## Display Modes

| Mode | Trigger | Layout & Ergonomics |
| --- | --- | --- |
| **TV** | `?mode=tv` or `?tv=1` or Smart TV UA | Strict `100dvh` zero-scroll 4-band grid scaled proportionally (`min(1vw, 1.7778dvh)`) across 720p, 1080p, ultrawide, and 4K UHD. Boosted 10-foot sofa typography, remote D-pad timeframe & currency controls with 10-foot HUD toast, auto-dimming idle chrome, optional HDMI overscan safe-margin (`?overscan=1`), and OLED pixel-shift protection. |
| **PC** | `?mode=pc` or desktop browsers | High-density zero-scroll workstation on standard monitors (`≥ 1040×640`) with graceful split-pane scroll fallback, live candle close countdown, `EMA 20` + `EMA 50` + `VOL` overlays, `VWAP` & Bid/Ask telemetry, interactive crosshair OHLCV readout, and 1-key hotkeys. |
| **Phone** | `?mode=phone` or `?mobile=1` or viewports `≤ 720px` | Full data parity in a native-app thumb flow: scroll-aware sticky live XRP ticker bar, interactive candlestick chart with 7 timeframes + `EMA 20` / `EMA 50` / `VOL` + touch-crosshair OHLC readout, customizable XRP portfolio & 13W T-Bill yield, Morpho loan monitor, 2-column macro grid, and swipeable 8-hour Chiang Mai forecast. |

## Core Capabilities

- **Live Market & Orderflow Telemetry**: Binance WebSocket (`XRP/USDT`, `BTC/USDT`, `XRP/BTC`, live klines) with multi-host failover, 24H `VWAP` badge + 24H range `VWAP` tick marker, Best Bid/Ask spread tooltip, and REST fallback.
- **Interactive Charting Engine**: TradingView Lightweight Charts v4.1.3 (`1M / 3M / 5M / 15M / 1H / 4H / 1D`) with live bar close countdown, volume histogram, toggleable `EMA 20` & `EMA 50`, smart intraday/date X-axis formatting, right-axis-safe floating `HIGH` / `LOW` wick callout pins, and HiDPI HTML5 Canvas fallback.
- **Multi-Currency Portfolio & 13-Week US T-Bill Yield**: Customizable XRP holdings (default `1,000,000 XRP`) auto-cycling across `THB`, `TWD`, `USD`, and `CAD` with click-to-pin, live 24h P&L, and live US Treasury Fiscal Data 13-week bill auction passive income breakdown.
- **Morpho Blue On-Chain Loan Monitor (`FXRP / RLUSD`)**: Direct Ethereum Mainnet JSON-RPC contract reads (collateral `FXRP`, compounded `RLUSD` debt, live variable IRM borrow APY, oracle price, LTV vs `77%` LLTV health gauge, liquidation drop buffer %, accrued interest, and borrow-vs-sell XRP/USD savings) with instant cached boot paint and Morpho GraphQL fallback.
- **Live Intraday Macro Telemetry**: Real-time 5-minute `USD/JPY` (with session `%` delta & NY FX open/close countdown), `XRP/JPY`, `NYMEX Brent Futures (BZ=F)` in `USD` & `JPY` with live `%` delta, `24H Volume`, `XRP Market Cap`, `RLUSD Market Cap`, and `XRP / Sats`.
- **Chiang Mai Environment (Vector SVG)**: Live `Asia/Bangkok` (ICT) clock, bespoke vector weather iconography, Open-Meteo temperature/feels-like/humidity/wind/daily H-L, adaptive 8-hour precipitation strip, and US AQI + `PM2.5` badge.

## Running Locally (Zero-Dependency Cached Backend)

Requires Node.js 18+ with **zero external npm packages**:

```bash
npm start
# Optional: custom port or IQAir API key
PORT=8080 IQAIR_KEY=your_key node server.js
```

`server.js` serves static assets (with `ETag` `304` validation, HTTP Range streaming for `217379_medium.mp4`, and gzip compression) alongside singleflight-deduplicated, stale-while-revalidate `/api/bootstrap`, `/api/morpho`, `/api/macro`, `/api/binance/*`, `/api/rates`, `/api/treasury`, `/api/rlusd`, `/api/xrp-meta`, `/api/weather`, and `/api/aqi` endpoints.

## Keyboard & TV Remote Shortcuts

- `1`–`7`: Switch chart timeframe (`1M` through `1D`)
- `←` / `→` (TV mode): Cycle chart timeframes with 10-foot HUD toast
- `↑` / `↓` (TV mode): Cycle & pin portfolio display currency
- `R`: Reset chart zoom to latest candles
- `E` / `M`: Toggle `EMA 20` / `EMA 50` overlays
- `V`: Cycle `TV` / `PC` / `Phone` display modes
- `C`: Cycle portfolio currency
- `L`: Open Morpho Blue Loan Inspector
- `I`: Open 13-Week US T-Bill Yield Calculator
- `D`: Open Data Feeds & Terminal Settings
- `F`: Toggle fullscreen
- `?`: Open controls reference
