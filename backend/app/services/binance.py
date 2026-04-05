from __future__ import annotations

import asyncio
import json
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, AsyncIterator

import websockets

from ..config import settings


SUPPORTED_INTERVALS = (
    "1m",
    "3m",
    "5m",
    "15m",
    "30m",
    "1h",
    "2h",
    "4h",
    "6h",
    "8h",
    "12h",
    "1d",
    "3d",
    "1w",
    "1M",
)


def _interval_ms(interval: str) -> int:
    return {
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
    }[interval]


def fetch_klines(symbol: str, interval: str, limit: int = 500) -> list[dict[str, Any]]:
    query = urllib.parse.urlencode({"symbol": symbol, "interval": interval, "limit": limit})
    url = f"{settings.binance_rest_base}/api/v3/klines?{query}"
    with urllib.request.urlopen(url, timeout=20) as response:
        payload = json.loads(response.read().decode("utf-8"))
    candles: list[dict[str, Any]] = []
    for row in payload:
        candles.append(
            {
                "symbol": symbol,
                "interval": interval,
                "open_time": int(row[0]),
                "close_time": int(row[6]),
                "open": float(row[1]),
                "high": float(row[2]),
                "low": float(row[3]),
                "close": float(row[4]),
                "volume": float(row[5]),
                "is_closed": True,
            }
        )
    return candles


def fetch_klines_history(
    symbol: str,
    interval: str,
    total_limit: int = 3000,
    end_time: int | None = None,
) -> list[dict[str, Any]]:
    collected: list[dict[str, Any]] = []

    while len(collected) < total_limit:
        limit = min(1000, total_limit - len(collected))
        query = {"symbol": symbol, "interval": interval, "limit": limit}
        if end_time is not None:
            query["endTime"] = str(end_time)
        url = f"{settings.binance_rest_base}/api/v3/klines?{urllib.parse.urlencode(query)}"
        with urllib.request.urlopen(url, timeout=20) as response:
            payload = json.loads(response.read().decode("utf-8"))
        if not payload:
            break

        batch: list[dict[str, Any]] = []
        for row in payload:
            batch.append(
                {
                    "symbol": symbol,
                    "interval": interval,
                    "open_time": int(row[0]),
                    "close_time": int(row[6]),
                    "open": float(row[1]),
                    "high": float(row[2]),
                    "low": float(row[3]),
                    "close": float(row[4]),
                    "volume": float(row[5]),
                    "is_closed": True,
                }
            )
        collected = batch + collected

        if len(payload) < limit:
            break
        end_time = int(payload[0][0]) - 1

    return collected[-total_limit:]


def fetch_klines_range(
    symbol: str,
    interval: str,
    start_time: int,
    end_time: int | None = None,
    total_limit: int = 1000,
) -> list[dict[str, Any]]:
    collected: list[dict[str, Any]] = []
    current_start = start_time
    interval_ms = _interval_ms(interval)

    while len(collected) < total_limit:
        limit = min(1000, total_limit - len(collected))
        query: dict[str, str] = {
            "symbol": symbol,
            "interval": interval,
            "limit": str(limit),
            "startTime": str(current_start),
        }
        if end_time is not None:
            query["endTime"] = str(end_time)
        url = f"{settings.binance_rest_base}/api/v3/klines?{urllib.parse.urlencode(query)}"
        with urllib.request.urlopen(url, timeout=20) as response:
            payload = json.loads(response.read().decode("utf-8"))
        if not payload:
            break

        batch: list[dict[str, Any]] = []
        for row in payload:
            batch.append(
                {
                    "symbol": symbol,
                    "interval": interval,
                    "open_time": int(row[0]),
                    "close_time": int(row[6]),
                    "open": float(row[1]),
                    "high": float(row[2]),
                    "low": float(row[3]),
                    "close": float(row[4]),
                    "volume": float(row[5]),
                    "is_closed": True,
                }
            )
        collected.extend(batch)

        if len(payload) < limit:
            break
        current_start = int(payload[-1][0]) + interval_ms
        if end_time is not None and current_start > end_time:
            break

    return collected[:total_limit]


def _ws_url(symbol: str, interval: str) -> str:
    return f"{settings.binance_ws_base}/ws/{symbol.lower()}@kline_{interval}"


def parse_kline_message(message: dict[str, Any], symbol: str, interval: str) -> dict[str, Any]:
    kline = message["k"]
    return {
        "symbol": symbol,
        "interval": interval,
        "open_time": int(kline["t"]),
        "close_time": int(kline["T"]),
        "open": float(kline["o"]),
        "high": float(kline["h"]),
        "low": float(kline["l"]),
        "close": float(kline["c"]),
        "volume": float(kline["v"]),
        "is_closed": bool(kline["x"]),
    }


async def stream_kline(symbol: str, interval: str) -> AsyncIterator[dict[str, Any]]:
    while True:
        try:
            async with websockets.connect(_ws_url(symbol, interval), ping_interval=20, ping_timeout=20) as ws:
                async for raw in ws:
                    message = json.loads(raw)
                    yield parse_kline_message(message, symbol, interval)
        except asyncio.CancelledError:
            raise
        except Exception:
            await asyncio.sleep(3)
