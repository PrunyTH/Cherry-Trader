from __future__ import annotations

import asyncio
import json
from typing import Any

from ..db import get_candles, insert_signal
from ..strategy.trend_pullback import TrendPullbackStrategy


class MarketDataHub:
    def __init__(self) -> None:
        self.subscribers: set[asyncio.Queue[str]] = set()

    async def publish(self, event: dict[str, Any]) -> None:
        message = json.dumps(event)
        dead: list[asyncio.Queue[str]] = []
        for queue in self.subscribers:
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:
                dead.append(queue)
        for queue in dead:
            self.subscribers.discard(queue)

    async def subscribe(self) -> asyncio.Queue[str]:
        queue: asyncio.Queue[str] = asyncio.Queue(maxsize=100)
        self.subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[str]) -> None:
        self.subscribers.discard(queue)


class StrategyRuntime:
    def __init__(self, symbol: str, interval: str) -> None:
        self.symbol = symbol
        self.interval = interval
        self.strategy = TrendPullbackStrategy()

    def evaluate(self, candle: dict[str, Any]) -> dict[str, Any] | None:
        if not candle["is_closed"]:
            return None
        candles = get_candles(self.symbol, self.interval, 500)
        event = self.strategy.step(candles)
        if event is None:
            return None
        signal = {
            "symbol": self.symbol,
            "interval": self.interval,
            "ts": candle["close_time"],
            "side": event.action,
            "price": float(candle["close"]),
            "fast_ema": event.entry_ema,
            "slow_ema": event.trend_ema,
            "reason": event.reason,
        }
        insert_signal(signal)
        return signal
