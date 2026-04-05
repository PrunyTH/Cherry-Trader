from __future__ import annotations

import asyncio
import json
import time
import logging
import threading
from datetime import datetime, timezone
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .db import (
    create_run,
    get_candle_count,
    get_newest_closed_candle_time,
    get_oldest_closed_candle_time,
    finish_run,
    get_all_closed_candles,
    get_candles,
    get_signals,
    get_strategy_setting,
    init_db,
    insert_trades,
    set_strategy_setting,
    upsert_candle,
)
from .schemas import BacktestRequest, StrategyParams
from .services.binance import SUPPORTED_INTERVALS, fetch_klines_history, stream_kline
from .services.binance import fetch_klines_range
from .services.market_data import MarketDataHub, StrategyRuntime
from .strategy.backtest import run_trend_pullback_backtest


hub = MarketDataHub()
logger = logging.getLogger(__name__)
repair_jobs_lock = threading.Lock()
repair_jobs: set[tuple[str, str]] = set()

HISTORY_CACHE_YEARS = 6
HISTORY_REFRESH_LIMIT = 1000
CACHE_START_MS = int(datetime(2020, 1, 1, tzinfo=timezone.utc).timestamp() * 1000)
INTERVAL_TO_MS = {
    "1m": 60_000,
    "3m": 180_000,
    "5m": 300_000,
    "15m": 900_000,
    "30m": 1_800_000,
    "1h": 3_600_000,
    "2h": 7_200_000,
    "4h": 14_400_000,
    "6h": 21_600_000,
    "8h": 28_800_000,
    "12h": 43_200_000,
    "1d": 86_400_000,
    "3d": 259_200_000,
    "1w": 604_800_000,
    "1M": 2_592_000_000,
}


def history_target_bars(interval: str) -> int:
    interval_ms = INTERVAL_TO_MS.get(interval, 60_000)
    target = int((HISTORY_CACHE_YEARS * 365.25 * 24 * 60 * 60 * 1000) / interval_ms)
    if interval in {"1m", "3m", "5m", "30m"}:
        return min(target, 100_000)
    return target


def cache_is_stale(interval: str, newest_open_time: int | None) -> bool:
    if newest_open_time is None:
        return True
    interval_ms = INTERVAL_TO_MS.get(interval, 60_000)
    return (int(time.time() * 1000) - newest_open_time) > interval_ms * 2


def sync_market_data_cache(symbol: str, interval: str, target_bars: int | None = None) -> None:
    target_bars = target_bars or history_target_bars(interval)
    candle_count = get_candle_count(symbol, interval)
    newest_open_time = get_newest_closed_candle_time(symbol, interval)
    oldest_open_time = get_oldest_closed_candle_time(symbol, interval)

    try:
        should_seed_full_history = oldest_open_time is None or oldest_open_time > CACHE_START_MS or candle_count < target_bars
        if should_seed_full_history:
            interval_ms = INTERVAL_TO_MS.get(interval, 60_000)
            current_start = CACHE_START_MS
            latest_end = int(time.time() * 1000)
            while current_start <= latest_end:
                page = fetch_klines_range(symbol, interval, current_start, latest_end, 1000)
                if not page:
                    break
                for candle in page:
                    upsert_candle(candle)
                current_start = int(page[-1]["open_time"]) + interval_ms
                if len(page) < 1000:
                    break
            newest_open_time = get_newest_closed_candle_time(symbol, interval)
        elif cache_is_stale(interval, newest_open_time):
            for candle in fetch_klines_history(symbol, interval, HISTORY_REFRESH_LIMIT):
                upsert_candle(candle)
    except Exception as exc:
        logger.warning("Failed to sync %s %s cache: %s", symbol, interval, exc)


def warm_full_cache(symbol: str) -> None:
    for interval in SUPPORTED_INTERVALS:
        sync_market_data_cache(symbol, interval)


def repair_market_data_cache(symbol: str, interval: str) -> None:
    if interval == "1M":
        return
    interval_ms = INTERVAL_TO_MS.get(interval, 60_000)
    try:
        candles = get_all_closed_candles(symbol, interval)
        if len(candles) < 2:
            return

        gaps: list[tuple[int, int]] = []
        previous_open = candles[0]["open_time"]
        for candle in candles[1:]:
            expected_next = previous_open + interval_ms
            current_open = candle["open_time"]
            if current_open > expected_next:
                gaps.append((expected_next, current_open - interval_ms))
            previous_open = current_open

        for start_time, end_time in gaps:
            if end_time < start_time:
                continue
            expected_bars = int((end_time - start_time) / interval_ms) + 1
            for candle in fetch_klines_range(symbol, interval, start_time, end_time, expected_bars):
                upsert_candle(candle)
    except Exception as exc:
        logger.warning("Failed to repair %s %s cache: %s", symbol, interval, exc)


def schedule_cache_repair(symbol: str, interval: str) -> None:
    key = (symbol, interval)
    with repair_jobs_lock:
        if key in repair_jobs:
            return
        repair_jobs.add(key)

    def _runner() -> None:
        try:
            sync_market_data_cache(symbol, interval)
        finally:
            with repair_jobs_lock:
                repair_jobs.discard(key)

    threading.Thread(target=_runner, daemon=True).start()


async def ingest_stream(symbol: str, interval: str) -> None:
    runtime = StrategyRuntime(symbol, interval)
    async for candle in stream_kline(symbol, interval):
        upsert_candle(candle)
        await hub.publish({"type": "candle", "candle": candle})
        if candle["is_closed"]:
            signal = runtime.evaluate(candle)
            if signal:
                await hub.publish({"type": "signal", "signal": signal})


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    asyncio.create_task(asyncio.to_thread(warm_full_cache, settings.default_symbol))
    tasks = [asyncio.create_task(ingest_stream(settings.default_symbol, interval)) for interval in SUPPORTED_INTERVALS]
    try:
        yield
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


app = FastAPI(title=settings.app_name, lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_origin, settings.frontend_origin_alt],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/candles")
def api_candles(symbol: str = settings.default_symbol, interval: str = "1m", limit: int = 300):
    candle_count = get_candle_count(symbol, interval)
    if candle_count < limit:
        threading.Thread(
            target=sync_market_data_cache,
            args=(symbol, interval, limit),
            daemon=True,
        ).start()
    elif interval != "1M":
        schedule_cache_repair(symbol, interval)
    return {"candles": get_candles(symbol, interval, limit)}


@app.get("/api/signals")
def api_signals(symbol: str = settings.default_symbol, interval: str = "1m", limit: int = 200):
    return {"signals": get_signals(symbol, interval, limit)}


@app.get("/api/strategy")
def api_strategy(symbol: str = settings.default_symbol, interval: str = "1m"):
    return {
        "symbol": symbol,
        "interval": interval,
        "fast_ema": int(get_strategy_setting(symbol, interval, "fast_ema", "12")),
        "slow_ema": int(get_strategy_setting(symbol, interval, "slow_ema", "26")),
    }


@app.put("/api/strategy")
def update_strategy(symbol: str = settings.default_symbol, interval: str = "1m", params: StrategyParams = StrategyParams()):
    set_strategy_setting(symbol, interval, "fast_ema", str(params.fast_ema))
    set_strategy_setting(symbol, interval, "slow_ema", str(params.slow_ema))
    return {"symbol": symbol, "interval": interval, "fast_ema": params.fast_ema, "slow_ema": params.slow_ema}


@app.post("/api/backtest")
def api_backtest(request: BacktestRequest):
    interval_ms = INTERVAL_TO_MS.get(request.interval, 60_000)
    required_bars = int((request.lookback_days * 86_400_000) / interval_ms) + 250
    if get_candle_count(request.symbol, request.interval) < required_bars:
        sync_market_data_cache(request.symbol, request.interval, required_bars)
    candles = get_all_closed_candles(request.symbol, request.interval)
    evaluation_start_time = None
    if candles:
        latest_close_time = candles[-1]["close_time"]
        evaluation_start_time = latest_close_time - request.lookback_days * 86_400_000
        warmup_bars = 250
        first_eval_index = next((index for index, candle in enumerate(candles) if candle["close_time"] >= evaluation_start_time), len(candles))
        start_index = max(0, first_eval_index - warmup_bars)
        candles = candles[start_index:]

    result = run_trend_pullback_backtest(
        candles,
        request.capital,
        request.leverage,
        request.stop_loss_atr_mult,
        evaluation_start_time,
    )
    started_at = int(time.time() * 1000)
    run_id = create_run(
        request.symbol,
        request.interval,
        "trend_pullback_v1",
        request.model_dump_json(),
        started_at,
    )
    insert_trades(run_id, request.symbol, request.interval, result.trades)
    finish_run(
        run_id,
        result.total_trades,
        result.win_rate,
        result.pnl,
        result.max_drawdown,
        int(time.time() * 1000),
    )
    return {
        "run_id": run_id,
        "stats": {
            "start_capital": result.start_capital,
            "final_equity": result.final_equity,
            "total_return_pct": result.total_return_pct,
            "total_trades": result.total_trades,
            "win_rate": result.win_rate,
            "pnl": result.pnl,
            "total_fees": result.total_fees,
            "max_drawdown": result.max_drawdown,
        },
        "trades": result.trades,
        "markers": result.markers,
        "equity_curve": result.equity_curve,
    }


@app.websocket("/ws/stream")
async def ws_stream(websocket: WebSocket):
    await websocket.accept()
    queue = await hub.subscribe()
    try:
        await websocket.send_text(json.dumps({"type": "ready"}))
        while True:
            message = await queue.get()
            await websocket.send_text(message)
    except WebSocketDisconnect:
        pass
    finally:
        hub.unsubscribe(queue)
