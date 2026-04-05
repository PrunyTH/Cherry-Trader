from __future__ import annotations

import asyncio
import json
import time
import logging
import threading
import subprocess
from datetime import datetime, timezone
from contextlib import asynccontextmanager
from pathlib import Path

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
    get_top_backtest_evaluations,
    get_strategy_setting,
    init_db,
    insert_trades,
    insert_backtest_bundle,
    insert_backtest_evaluations,
    insert_strategy_version,
    set_strategy_setting,
    upsert_candle,
)
from .schemas import BacktestBundleRequest, BacktestRequest, StrategyParams
from .services.binance import SUPPORTED_INTERVALS, fetch_klines_history, stream_kline
from .services.binance import fetch_klines_range
from .services.market_data import MarketDataHub, StrategyRuntime
from .strategy.backtest import run_trend_pullback_backtest


hub = MarketDataHub()
logger = logging.getLogger(__name__)
repair_jobs_lock = threading.Lock()
repair_jobs: set[tuple[str, str]] = set()
REPO_ROOT = Path(__file__).resolve().parents[2]
STRATEGY_NAME = "trend_pullback_v2"
STRATEGY_LABEL = "Trend Pullback v2"
STRATEGY_VERSION_PARAMS = {
    "entry_ema_period": 20,
    "trend_ema_period": 50,
    "filter_ema_period": 200,
    "atr_period": 14,
    "direction": "long_only",
    "entry_confirmation": [
        "bullish_reclaim_candle",
        "volume_above_recent_average",
        "hammer_or_bullish_engulfing",
    ],
    "risk_model": {
        "stop_loss": "atr_multiple",
        "fee_model": "binance_taker_0.05_percent",
    },
}

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
            repair_market_data_cache(symbol, interval)
        finally:
            with repair_jobs_lock:
                repair_jobs.discard(key)

    threading.Thread(target=_runner, daemon=True).start()


def prepare_backtest_candles(candles: list[dict[str, object]], lookback_days: int) -> tuple[list[dict[str, object]], int | None]:
    if not candles:
        return [], None
    latest_close_time = int(candles[-1]["close_time"])
    evaluation_start_time = latest_close_time - lookback_days * 86_400_000
    warmup_bars = 250
    first_eval_index = next((index for index, candle in enumerate(candles) if int(candle["close_time"]) >= evaluation_start_time), len(candles))
    start_index = max(0, first_eval_index - warmup_bars)
    return candles[start_index:], evaluation_start_time


def history_range_for_days(days: int) -> str:
    if days <= 1:
        return "1D"
    if days <= 30:
        return "1M"
    if days <= 90:
        return "3M"
    if days <= 180:
        return "6M"
    if days <= 365:
        return "1Y"
    if days <= 730:
        return "2Y"
    return "ALL"


def history_days_for_range(range_label: str) -> int:
    lookup = {
        "1D": 1,
        "1M": 30,
        "3M": 90,
        "6M": 180,
        "1Y": 365,
        "2Y": 730,
        "ALL": HISTORY_CACHE_YEARS * 365,
    }
    return lookup.get(range_label, 365)


def backtest_stats(result) -> dict[str, float]:
    return {
        "total_return_pct": result.total_return_pct,
        "final_equity": result.final_equity,
        "total_trades": result.total_trades,
        "win_rate": result.win_rate,
        "pnl": result.pnl,
        "total_fees": result.total_fees,
        "max_drawdown": result.max_drawdown,
        "score": score_backtest_result(result),
    }


def score_backtest_result(result) -> float:
    if result.total_trades <= 0:
        return 0.0
    start_capital = max(result.start_capital, 1e-9)
    return_component = max(0.0, min(100.0, 50.0 + result.total_return_pct * 1.5))
    drawdown_component = max(0.0, min(100.0, 100.0 - (result.max_drawdown / start_capital) * 100.0))
    win_component = max(0.0, min(100.0, result.win_rate))
    fee_component = max(0.0, min(100.0, 100.0 - (result.total_fees / start_capital) * 100.0))
    trade_component = max(0.0, min(100.0, (result.total_trades / 30.0) * 100.0))
    score = (
        return_component * 0.35
        + drawdown_component * 0.35
        + win_component * 0.2
        + fee_component * 0.04
        + trade_component * 0.06
    )
    return round(score, 2)


def strategy_version_payload() -> str:
    return json.dumps(STRATEGY_VERSION_PARAMS, sort_keys=True)


def evaluation_payload(request_data: dict[str, object], history_range: str, stop_loss_atr_mult: float, run_kind: str) -> str:
    payload = dict(request_data)
    payload.update(
        {
            "strategy_name": STRATEGY_NAME,
            "strategy_label": STRATEGY_LABEL,
            "history_range": history_range,
            "stop_loss_atr_mult": stop_loss_atr_mult,
            "run_kind": run_kind,
        }
    )
    return json.dumps(payload, sort_keys=True)


def persist_strategy_version() -> tuple[int, str, int]:
    created_at = int(time.time() * 1000)
    git_commit = get_git_commit()
    version_id = insert_strategy_version(STRATEGY_NAME, STRATEGY_LABEL, git_commit, strategy_version_payload(), created_at)
    return version_id, git_commit, created_at


def persist_backtest_bundle(
    version_id: int,
    symbol: str,
    interval: str,
    lookback_days: int,
    capital: float,
    leverage: float,
    stop_loss_atr_mult: float,
    comparison_intervals: list[str],
    stop_multipliers: list[float],
    analysis_ranges: list[str],
) -> int:
    created_at = int(time.time() * 1000)
    return insert_backtest_bundle(
        version_id,
        symbol,
        interval,
        lookback_days,
        capital,
        leverage,
        stop_loss_atr_mult,
        json.dumps(comparison_intervals, sort_keys=True),
        json.dumps(stop_multipliers, sort_keys=True),
        json.dumps(analysis_ranges, sort_keys=True),
        created_at,
    )


def persist_backtest_evaluations(
    bundle_id: int,
    version_id: int,
    request_data: dict[str, object],
    entries: list[dict[str, object]],
) -> None:
    created_at = int(time.time() * 1000)
    rows = []
    for entry in entries:
        rows.append(
            {
                "bundle_id": bundle_id,
                "version_id": version_id,
                "symbol": request_data["symbol"],
                "interval": entry["interval"],
                "history_range": entry["history_range"],
                "stop_loss_atr_mult": entry["stop_loss_atr_mult"],
                "run_kind": entry["run_kind"],
                "total_return_pct": entry["stats"]["total_return_pct"],
                "final_equity": entry["stats"]["final_equity"],
                "total_trades": entry["stats"]["total_trades"],
                "win_rate": entry["stats"]["win_rate"],
                "pnl": entry["stats"]["pnl"],
                "total_fees": entry["stats"]["total_fees"],
                "max_drawdown": entry["stats"]["max_drawdown"],
                "score": entry["stats"]["score"],
                "params_json": evaluation_payload(
                    request_data,
                    entry["history_range"],
                    float(entry["stop_loss_atr_mult"]),
                    entry["run_kind"],
                ),
                "created_at": created_at,
            }
        )
    insert_backtest_evaluations(rows)


def get_git_commit() -> str:
    try:
        completed = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=REPO_ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        return completed.stdout.strip() or "unknown"
    except Exception:
        return "unknown"


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


@app.get("/api/admin/runs")
def api_admin_runs(limit: int = 5):
    return {
        "runs": get_top_backtest_evaluations(limit=max(1, min(limit, 25))),
    }


@app.put("/api/strategy")
def update_strategy(symbol: str = settings.default_symbol, interval: str = "1m", params: StrategyParams = StrategyParams()):
    set_strategy_setting(symbol, interval, "fast_ema", str(params.fast_ema))
    set_strategy_setting(symbol, interval, "slow_ema", str(params.slow_ema))
    return {"symbol": symbol, "interval": interval, "fast_ema": params.fast_ema, "slow_ema": params.slow_ema}


@app.post("/api/backtest")
def api_backtest(request: BacktestRequest):
    request_data = request.model_dump()
    history_range = history_range_for_days(request.lookback_days)
    version_id, git_commit, _ = persist_strategy_version()
    candles = get_all_closed_candles(request.symbol, request.interval)
    candles, evaluation_start_time = prepare_backtest_candles(candles, request.lookback_days)
    result = run_trend_pullback_backtest(
        candles,
        request.capital,
        request.leverage,
        request.stop_loss_atr_mult,
        evaluation_start_time,
    )
    bundle_id = persist_backtest_bundle(
        version_id,
        request.symbol,
        request.interval,
        request.lookback_days,
        request.capital,
        request.leverage,
        request.stop_loss_atr_mult,
        [],
        [request.stop_loss_atr_mult],
        [history_range],
    )
    persist_backtest_evaluations(
        bundle_id,
        version_id,
        request_data,
        [
            {
                "interval": request.interval,
                "history_range": history_range,
                "stop_loss_atr_mult": request.stop_loss_atr_mult,
                "run_kind": "single",
                "stats": backtest_stats(result),
            }
        ],
    )
    started_at = int(time.time() * 1000)
    run_id = create_run(
        request.symbol,
        request.interval,
        STRATEGY_NAME,
        json.dumps(
            {
                **request_data,
                "strategy_name": STRATEGY_NAME,
                "strategy_label": STRATEGY_LABEL,
                "strategy_version_id": version_id,
                "git_commit": git_commit,
                "history_range": history_range,
                "stop_loss_atr_mult": request.stop_loss_atr_mult,
            },
            sort_keys=True,
        ),
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
        "bundle_id": bundle_id,
        "strategy_version": {
            "id": version_id,
            "name": STRATEGY_NAME,
            "label": STRATEGY_LABEL,
            "git_commit": git_commit,
        },
        "stats": {
            "start_capital": result.start_capital,
            "final_equity": result.final_equity,
            "total_return_pct": result.total_return_pct,
            "total_trades": result.total_trades,
            "win_rate": result.win_rate,
            "pnl": result.pnl,
            "total_fees": result.total_fees,
            "max_drawdown": result.max_drawdown,
            "score": score_backtest_result(result),
        },
        "trades": result.trades,
        "markers": result.markers,
        "equity_curve": result.equity_curve,
    }


@app.post("/api/backtest/bundle")
def api_backtest_bundle(request: BacktestBundleRequest):
    request_data = request.model_dump()
    comparison_intervals = list(dict.fromkeys(request.comparison_intervals))
    stop_multipliers = list(dict.fromkeys(request.stop_multipliers))
    selected_range_label = history_range_for_days(request.lookback_days)
    analysis_ranges = list(dict.fromkeys([selected_range_label, *request.analysis_ranges]))
    intervals = list(dict.fromkeys([request.interval, *comparison_intervals]))
    result_cache: dict[tuple[str, str, float], Any] = {}
    selected_stop = float(request.stop_loss_atr_mult)
    stop_values = list(dict.fromkeys([selected_stop, *[float(multiplier) for multiplier in stop_multipliers]]))
    version_id, git_commit, _ = persist_strategy_version()

    for interval in intervals:
        candles = get_all_closed_candles(request.symbol, interval)
        selected_candles, selected_evaluation_start_time = prepare_backtest_candles(candles, request.lookback_days)
        for multiplier in stop_values:
            result_cache[(interval, selected_range_label, multiplier)] = run_trend_pullback_backtest(
                selected_candles,
                request.capital,
                request.leverage,
                multiplier,
                selected_evaluation_start_time,
            )

        for range_label in analysis_ranges:
            if range_label == selected_range_label:
                continue
            candles_for_range, evaluation_start_time = prepare_backtest_candles(candles, history_days_for_range(range_label))
            result_cache[(interval, range_label, selected_stop)] = run_trend_pullback_backtest(
                candles_for_range,
                request.capital,
                request.leverage,
                selected_stop,
                evaluation_start_time,
            )

    bundle_id = persist_backtest_bundle(
        version_id,
        request.symbol,
        request.interval,
        request.lookback_days,
        request.capital,
        request.leverage,
        request.stop_loss_atr_mult,
        comparison_intervals,
        stop_multipliers,
        analysis_ranges,
    )

    evaluation_entries: list[dict[str, object]] = []
    for interval in intervals:
        for multiplier in stop_values:
            stats = backtest_stats(result_cache[(interval, selected_range_label, multiplier)])
            if interval == request.interval and multiplier == selected_stop:
                run_kind = "base"
            elif interval == request.interval:
                run_kind = "stop"
            elif multiplier == selected_stop:
                run_kind = "comparison"
            else:
                run_kind = "heatmap"
            evaluation_entries.append(
                {
                    "interval": interval,
                    "history_range": selected_range_label,
                    "stop_loss_atr_mult": multiplier,
                    "run_kind": run_kind,
                    "stats": stats,
                }
            )

        for range_label in analysis_ranges:
            if range_label == selected_range_label:
                continue
            stats = backtest_stats(result_cache[(interval, range_label, selected_stop)])
            evaluation_entries.append(
                {
                    "interval": interval,
                    "history_range": range_label,
                    "stop_loss_atr_mult": selected_stop,
                    "run_kind": "analysis" if interval == request.interval else "analysis_heatmap",
                    "stats": stats,
                }
            )

    persist_backtest_evaluations(bundle_id, version_id, request_data, evaluation_entries)

    base_result = result_cache[(request.interval, selected_range_label, selected_stop)]
    started_at = int(time.time() * 1000)
    run_id = create_run(
        request.symbol,
        request.interval,
        STRATEGY_NAME,
        json.dumps(
            {
                **request_data,
                "strategy_name": STRATEGY_NAME,
                "strategy_label": STRATEGY_LABEL,
                "strategy_version_id": version_id,
                "git_commit": git_commit,
                "history_range": selected_range_label,
                "stop_loss_atr_mult": request.stop_loss_atr_mult,
            },
            sort_keys=True,
        ),
        started_at,
    )
    insert_trades(run_id, request.symbol, request.interval, base_result.trades)
    finish_run(
        run_id,
        base_result.total_trades,
        base_result.win_rate,
        base_result.pnl,
        base_result.max_drawdown,
        int(time.time() * 1000),
    )

    comparison_rows = [
        {
            "interval": interval,
            "stats": backtest_stats(result_cache[(interval, selected_range_label, selected_stop)]),
        }
        for interval in comparison_intervals
        if (interval, selected_range_label, selected_stop) in result_cache
    ]
    stop_rows = [
        {
            "stopLossAtrMult": multiplier,
            "stats": backtest_stats(result_cache[(request.interval, selected_range_label, float(multiplier))]),
        }
        for multiplier in stop_multipliers
        if (request.interval, selected_range_label, float(multiplier)) in result_cache
    ]
    heatmap_cells = [
        {
            "interval": interval,
            "stopLossAtrMult": multiplier,
            "stats": backtest_stats(result_cache[(interval, selected_range_label, float(multiplier))]),
        }
        for interval in intervals
        for multiplier in stop_multipliers
        if (interval, selected_range_label, float(multiplier)) in result_cache
    ]
    analysis_heatmap_cells = [
        {
            "interval": interval,
            "historyRange": range_label,
            "stats": backtest_stats(result_cache[(interval, range_label, selected_stop)]),
        }
        for interval in intervals
        for range_label in analysis_ranges
        if (interval, range_label, selected_stop) in result_cache
    ]

    return {
        "run_id": run_id,
        "bundle_id": bundle_id,
        "strategy_version": {
            "id": version_id,
            "name": STRATEGY_NAME,
            "label": STRATEGY_LABEL,
            "git_commit": git_commit,
        },
        "base": {
            "stats": backtest_stats(base_result),
            "trades": base_result.trades,
            "markers": base_result.markers,
            "equity_curve": base_result.equity_curve,
        },
        "comparison_rows": comparison_rows,
        "stop_rows": stop_rows,
        "heatmap_cells": heatmap_cells,
        "analysis_heatmap_cells": analysis_heatmap_cells,
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
