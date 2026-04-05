from __future__ import annotations

from dataclasses import dataclass
from typing import Any


def _ema(values: list[float], period: int) -> list[float]:
    if not values:
        return []
    alpha = 2 / (period + 1)
    output = [values[0]]
    for value in values[1:]:
        output.append((value - output[-1]) * alpha + output[-1])
    return output


def _atr(highs: list[float], lows: list[float], closes: list[float], period: int) -> list[float]:
    if not highs:
        return []
    true_ranges = [highs[0] - lows[0]]
    for i in range(1, len(highs)):
        true_ranges.append(
            max(
                highs[i] - lows[i],
                abs(highs[i] - closes[i - 1]),
                abs(lows[i] - closes[i - 1]),
            )
    )
    return _ema(true_ranges, period)


def _is_bullish_hammer(open_price: float, high_price: float, low_price: float, close_price: float) -> bool:
    body = abs(close_price - open_price)
    range_size = max(high_price - low_price, 1e-9)
    lower_wick = min(open_price, close_price) - low_price
    upper_wick = high_price - max(open_price, close_price)
    return close_price > open_price and lower_wick >= body * 2 and upper_wick <= range_size * 0.35


def _is_bullish_engulfing(prev_open: float, prev_close: float, open_price: float, close_price: float) -> bool:
    return close_price > open_price and prev_close < prev_open and close_price >= prev_open and open_price <= prev_close


def _volume_confirmed(volumes: list[float], lookback: int = 20, multiplier: float = 1.1) -> bool:
    if len(volumes) < lookback + 1:
        return False
    recent = volumes[-lookback - 1 : -1]
    average = sum(recent) / len(recent) if recent else 0.0
    return average > 0 and volumes[-1] >= average * multiplier


@dataclass
class TrendPullbackEvent:
    action: str
    reason: str
    price: float
    entry_ema: float
    trend_ema: float
    trend_filter: float
    atr: float


class TrendPullbackStrategy:
    def __init__(
        self,
        entry_period: int = 20,
        trend_period: int = 50,
        filter_period: int = 200,
        atr_period: int = 14,
    ) -> None:
        if entry_period >= trend_period:
            raise ValueError("entry_period must be smaller than trend_period")
        if trend_period >= filter_period:
            raise ValueError("trend_period must be smaller than filter_period")
        self.entry_period = entry_period
        self.trend_period = trend_period
        self.filter_period = filter_period
        self.atr_period = atr_period
        self.in_position = False
        self.setup_active = False

    def snapshot(self, candles: list[dict[str, Any]]) -> dict[str, float]:
        closes = [float(candle["close"]) for candle in candles if candle["is_closed"]]
        highs = [float(candle["high"]) for candle in candles if candle["is_closed"]]
        lows = [float(candle["low"]) for candle in candles if candle["is_closed"]]
        if not closes:
            return {"entry_ema": 0.0, "trend_ema": 0.0, "trend_filter": 0.0, "atr": 0.0}
        entry_ema = _ema(closes, self.entry_period)
        trend_ema = _ema(closes, self.trend_period)
        trend_filter = _ema(closes, self.filter_period)
        atr = _atr(highs, lows, closes, self.atr_period)
        return {
            "entry_ema": entry_ema[-1],
            "trend_ema": trend_ema[-1],
            "trend_filter": trend_filter[-1],
            "atr": atr[-1] if atr else 0.0,
        }

    def step(self, candles: list[dict[str, Any]]) -> TrendPullbackEvent | None:
        closes = [float(candle["close"]) for candle in candles if candle["is_closed"]]
        highs = [float(candle["high"]) for candle in candles if candle["is_closed"]]
        lows = [float(candle["low"]) for candle in candles if candle["is_closed"]]
        opens = [float(candle["open"]) for candle in candles if candle["is_closed"]]
        volumes = [float(candle["volume"]) for candle in candles if candle["is_closed"]]
        if len(closes) < self.filter_period + 2:
            return None

        entry_ema = _ema(closes, self.entry_period)
        trend_ema = _ema(closes, self.trend_period)
        trend_filter = _ema(closes, self.filter_period)
        atr = _atr(highs, lows, closes, self.atr_period)

        price = closes[-1]
        open_price = opens[-1]
        entry_line = entry_ema[-1]
        trend_line = trend_ema[-1]
        filter_line = trend_filter[-1]
        atr_value = atr[-1] if atr else 0.0

        trend_up = trend_line > filter_line and price > trend_line and trend_line >= trend_ema[-4]
        pullback_touched = lows[-1] <= entry_line * 1.002
        reclaim = price > entry_line and price > open_price
        volume_ok = _volume_confirmed(volumes)
        hammer_ok = _is_bullish_hammer(opens[-1], highs[-1], lows[-1], closes[-1]) or _is_bullish_engulfing(
            opens[-2],
            closes[-2],
            open_price,
            price,
        )
        exit_long = price < entry_line or price < trend_line or trend_line < filter_line

        if self.in_position:
            if exit_long:
                self.in_position = False
                self.setup_active = False
                return TrendPullbackEvent("sell", "trend_exit_long", price, entry_line, trend_line, filter_line, atr_value)
            return None

        if self.setup_active:
            if trend_up and reclaim and volume_ok and hammer_ok:
                self.setup_active = False
                self.in_position = True
                return TrendPullbackEvent("buy", "trend_entry_long", price, entry_line, trend_line, filter_line, atr_value)
            if not trend_up:
                self.setup_active = False
            return None

        if trend_up and pullback_touched and price < entry_line:
            self.setup_active = True
            return TrendPullbackEvent("buy", "pullback_setup_long", price, entry_line, trend_line, filter_line, atr_value)

        return None
