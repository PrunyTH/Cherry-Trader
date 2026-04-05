# Cherry Trader

Local-only trading app for BTCUSDT with a minimal Next.js frontend and a FastAPI backend.

## Scope

- Fully local.
- SQLite for storage.
- No work credentials, no work repos, no work infrastructure.
- Open-source components only.
- Charting uses `lightweight-charts`, not TradingView Advanced Charts.
- Initial market data source is the public Binance API and websocket.

## Stack

- Frontend: Next.js + TypeScript
- Charting: `lightweight-charts`
- Backend: FastAPI + Python
- Realtime: WebSocket
- Database: SQLite

## Project Layout

- `backend/`: FastAPI app, Binance ingestion, strategy engine, SQLite storage
- `frontend/`: Next.js UI, live chart, strategy controls, backtest summary

## Local Setup

### 1. Backend

```bash
cd <repo>/backend
cp .env.example .env
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

### 2. Frontend

```bash
cd <repo>/frontend
cp .env.example .env
npm install
npm run dev
```

### 3. One-command dev mode

From the repo root, this starts backend and frontend locally and writes logs to `/tmp`:

```bash
cd <repo>
./scripts/dev.sh
```

To stop the running services:

```bash
./scripts/dev-stop.sh
```

### 3b. GitHub sync

Use this when you want to save the current state back to GitHub from the repo root:

```bash
./scripts/save.sh "short commit message"
```

That helper:

- pulls `origin/main` with rebase
- stages all changes
- commits if there is something to commit
- pushes to GitHub

Use it on every device so GitHub stays the source of truth.

### 4. Open the app

- Frontend: `http://127.0.0.1:3000`
- Backend API: `http://127.0.0.1:8000`

### Desktop launcher

There is also a Windows desktop launcher backed by [`Start-Cherry-Trader.ps1`](/home/richa/cherry-trader/Start-Cherry-Trader.ps1). It bootstraps Windows Python and Windows Node on first run, starts the backend/frontend, and opens the browser directly.

Launcher diagnostics are written to `%TEMP%\\cherry-trader-launch.log` on Windows, with backend/frontend logs in `%TEMP%\\cherry-trader-backend.log` and `%TEMP%\\cherry-trader-frontend.log`.

## Commands

- Backend dev server: `uvicorn app.main:app --reload --host 127.0.0.1 --port 8000`
- Frontend dev server: `npm run dev`
- Backend tests are not included yet; the MVP is focused on the live loop and backtest path.

## Data Model

SQLite stores:

- candles
- signals
- strategy settings
- backtest runs
- trades

## MVP Behavior

- The backend seeds BTCUSDT candles from Binance on startup.
- The backend subscribes to Binance websocket streams for the supported Binance intervals, including `1m`, `5m`, `1h`, `2h`, `4h`, `1d`, and `1w`.
- The frontend connects to the backend websocket and renders live updates.
- EMA crossover signals are generated on closed candles.
- The backtest runs against candles already stored in SQLite.
