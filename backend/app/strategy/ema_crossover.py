from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable


def _ema(values: list[float], period: int) -> list[float]:
    if not values:
        return []
    alpha = 2 / (period + 1)
    output = [values[0]]
    for value in values[1:]:
        output.append((value - output[-1]) * alpha + output[-1])
    return output


@dataclass
class StrategyDecision:
    side: str | None
    reason: str
    fast_ema: float
    slow_ema: float


class EMACrossoverStrategy:
    def __init__(self, fast_period: int = 12, slow_period: int = 26):
        if fast_period >= slow_period:
            raise ValueError("fast_period must be smaller than slow_period")
        self.fast_period = fast_period
        self.slow_period = slow_period

    def decide(self, candles: list[dict]) -> StrategyDecision:
        closes = [float(candle["close"]) for candle in candles if candle["is_closed"]]
        if len(closes) < self.slow_period + 2:
            return StrategyDecision(None, "insufficient_data", 0.0, 0.0)
        fast = _ema(closes, self.fast_period)
        slow = _ema(closes, self.slow_period)
        prev_fast, prev_slow = fast[-2], slow[-2]
        current_fast, current_slow = fast[-1], slow[-1]
        if prev_fast <= prev_slow and current_fast > current_slow:
            return StrategyDecision("buy", "fast_ema_crossed_above_slow_ema", current_fast, current_slow)
        if prev_fast >= prev_slow and current_fast < current_slow:
            return StrategyDecision("sell", "fast_ema_crossed_below_slow_ema", current_fast, current_slow)
        return StrategyDecision(None, "no_cross", current_fast, current_slow)

    def snapshot(self, candles: list[dict]) -> dict[str, float]:
        closes = [float(candle["close"]) for candle in candles if candle["is_closed"]]
        if not closes:
            return {"fast_ema": 0.0, "slow_ema": 0.0}
        fast = _ema(closes, self.fast_period)
        slow = _ema(closes, self.slow_period)
        return {"fast_ema": fast[-1], "slow_ema": slow[-1]}

