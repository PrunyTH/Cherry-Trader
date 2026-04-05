from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

BINANCE_TAKER_FEE_RATE = 0.0005


def _ema(values: list[float], period: int) -> list[float]:
    if not values:
        return []
    alpha = 2 / (period + 1)
    output = [values[0]]
    for value in values[1:]:
        output.append((value - output[-1]) * alpha + output[-1])
    return output


def _sma(values: list[float], period: int) -> list[float]:
    if not values:
        return []
    output: list[float] = []
    rolling_sum = 0.0
    for index, value in enumerate(values):
        rolling_sum += value
        if index >= period:
            rolling_sum -= values[index - period]
        if index + 1 < period:
            output.append(value)
        else:
            output.append(rolling_sum / period)
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


def _bollinger_bands(values: list[float], period: int = 20, stddev_mult: float = 2.0) -> tuple[list[float], list[float], list[float]]:
    if not values:
        return [], [], []
    middle = _sma(values, period)
    upper: list[float] = []
    lower: list[float] = []
    for index, _ in enumerate(values):
        start = max(0, index - period + 1)
        window = values[start : index + 1]
        mean = middle[index]
        variance = sum((entry - mean) ** 2 for entry in window) / max(1, len(window))
        deviation = math.sqrt(variance)
        upper.append(mean + deviation * stddev_mult)
        lower.append(mean - deviation * stddev_mult)
    return middle, upper, lower


def _is_bullish_hammer(open_price: float, high_price: float, low_price: float, close_price: float) -> bool:
    body = abs(close_price - open_price)
    range_size = max(high_price - low_price, 1e-9)
    lower_wick = min(open_price, close_price) - low_price
    upper_wick = high_price - max(open_price, close_price)
    return close_price > open_price and lower_wick >= body * 2 and upper_wick <= range_size * 0.35


def _is_bullish_engulfing(prev_open: float, prev_close: float, open_price: float, close_price: float) -> bool:
    return close_price > open_price and prev_close < prev_open and close_price >= prev_open and open_price <= prev_close


def _volume_confirmed(volumes: list[float], index: int, lookback: int = 20, multiplier: float = 1.1) -> bool:
    if index < lookback:
        return False
    recent = volumes[index - lookback : index]
    average = sum(recent) / len(recent) if recent else 0.0
    return average > 0 and volumes[index] >= average * multiplier


@dataclass
class BacktestResult:
    start_capital: float
    final_equity: float
    total_return_pct: float
    total_trades: int
    win_rate: float
    pnl: float
    total_fees: float
    max_drawdown: float
    trades: list[dict[str, Any]]
    markers: list[dict[str, Any]]
    equity_curve: list[dict[str, Any]]


def _trade_pnl(entry_price: float, exit_price: float, quantity: float, entry_fee: float, fee_rate: float) -> tuple[float, float]:
    entry_notional = quantity * entry_price
    exit_notional = quantity * exit_price
    gross = quantity * (exit_price - entry_price)
    fees = entry_fee + (exit_notional * fee_rate)
    return gross - fees, fees


def run_trend_pullback_backtest(
    candles: list[dict[str, Any]],
    capital: float,
    leverage: float,
    stop_loss_atr_mult: float = 1.5,
    bollinger_enabled: bool = False,
    bollinger_period: int = 20,
    bollinger_stddev: float = 2.0,
    evaluation_start_time: int | None = None,
    fee_rate: float = BINANCE_TAKER_FEE_RATE,
) -> BacktestResult:
    candles = [c for c in candles if c["is_closed"]]
    if len(candles) < 220:
        return BacktestResult(capital, capital, 0.0, 0, 0.0, 0.0, 0.0, 0.0, [], [], [])

    closes = [float(candle["close"]) for candle in candles]
    highs = [float(candle["high"]) for candle in candles]
    lows = [float(candle["low"]) for candle in candles]
    opens = [float(candle["open"]) for candle in candles]
    volumes = [float(candle["volume"]) for candle in candles]

    entry_ema = _ema(closes, 20)
    trend_ema = _ema(closes, 50)
    filter_ema = _ema(closes, 200)
    atr = _atr(highs, lows, closes, 14)
    bollinger_middle, _, _ = _bollinger_bands(closes, bollinger_period, bollinger_stddev)

    equity = capital
    peak_equity = capital
    max_drawdown = 0.0
    total_fees = 0.0
    position: dict[str, Any] | None = None
    setup_active = False
    trades: list[dict[str, Any]] = []
    markers: list[dict[str, Any]] = []
    equity_curve: list[dict[str, Any]] = []

    for i, candle in enumerate(candles):
        if i < 200:
            continue
        if evaluation_start_time is not None and candle["close_time"] < evaluation_start_time:
            continue

        price = closes[i]
        entry_line = entry_ema[i]
        trend_line = trend_ema[i]
        filter_line = filter_ema[i]
        bollinger_line = bollinger_middle[i]
        open_price = opens[i]
        volume_ok = _volume_confirmed(volumes, i)
        hammer_ok = _is_bullish_hammer(opens[i], highs[i], lows[i], closes[i]) or _is_bullish_engulfing(
            opens[i - 1],
            closes[i - 1],
            open_price,
            price,
        )
        bollinger_ok = (not bollinger_enabled) or price >= bollinger_line
        atr_value = atr[i] if atr else 0.0
        stop_triggered = False
        stop_price = None
        if position is not None:
            stop_price = position.get("stop_price")
            stop_triggered = stop_price is not None and lows[i] <= stop_price

        trend_up = trend_line > filter_line and price > trend_line and trend_line >= trend_ema[max(0, i - 3)] and bollinger_ok
        pullback_touched = lows[i] <= entry_line * 1.002
        reclaim = price > entry_line and price > open_price and bollinger_ok
        exit_long = price < entry_line or price < trend_line or trend_line < filter_line
        exit_price = price

        if position is not None and (stop_triggered or exit_long):
            exit_price = stop_price if stop_triggered and stop_price is not None else price
            exit_fee = position["quantity"] * exit_price * fee_rate
            pnl, fees = _trade_pnl(position["entry_price"], exit_price, position["quantity"], position["entry_fee"], fee_rate)
            equity = position["entry_cash_equity"] + (position["quantity"] * (exit_price - position["entry_price"])) - exit_fee
            total_fees += fees
            markers.append(
                {
                    "time": candle["close_time"] // 1000,
                    "position": "aboveBar",
                    "color": "#ef4444",
                    "shape": "arrowDown",
                    "text": "SELL",
                    "price": exit_price,
                }
            )
            peak_equity = max(peak_equity, equity)
            max_drawdown = max(max_drawdown, peak_equity - equity)
            trades.append(
                {
                    "side": "long",
                    "entry_time": position["entry_time"],
                    "exit_time": candle["close_time"],
                    "entry_price": position["entry_price"],
                    "exit_price": exit_price,
                    "quantity": position["quantity"],
                    "leverage": leverage,
                    "entry_reason": position["entry_reason"],
                    "exit_reason": "stop_loss_long" if stop_triggered else "trend_exit_long",
                    "entry_fee": position["entry_fee"],
                    "exit_fee": exit_fee,
                    "fees": fees,
                    "pnl": pnl,
                    "return_pct": (pnl / position["entry_equity"] * 100.0) if position["entry_equity"] else 0.0,
                }
            )
            position = None
            setup_active = False
        elif position is None and setup_active and trend_up and reclaim and volume_ok and hammer_ok:
            entry_price = price
            stop_price = max(entry_price - atr_value * stop_loss_atr_mult, entry_price * 0.5)
            notional = equity * leverage
            quantity = notional / entry_price
            entry_fee = notional * fee_rate
            equity_after_entry_fee = equity - entry_fee
            markers.append(
                {
                    "time": candle["close_time"] // 1000,
                    "position": "belowBar",
                    "color": "#22c55e",
                    "shape": "arrowUp",
                    "text": "BUY",
                    "price": entry_price,
                }
            )
            position = {
                "entry_time": candle["close_time"],
                "entry_price": entry_price,
                "quantity": quantity,
                "entry_equity": equity_after_entry_fee,
                "entry_cash_equity": equity_after_entry_fee,
                "entry_notional": notional,
                "entry_fee": entry_fee,
                "entry_reason": "trend_entry_long",
                "stop_price": stop_price,
            }
            equity = equity_after_entry_fee
            total_fees += entry_fee
            setup_active = False
        elif position is None and not setup_active and trend_up and pullback_touched and price < entry_line:
            markers.append(
                {
                    "time": candle["close_time"] // 1000,
                    "position": "belowBar",
                    "color": "#f59e0b",
                    "shape": "circle",
                    "text": "SETUP",
                    "price": price,
                }
            )
            setup_active = True

        if setup_active and not trend_up:
            setup_active = False

        mark_to_market = equity
        if position is not None:
            unrealized = position["quantity"] * (price - position["entry_price"])
            mark_to_market = position["entry_cash_equity"] + unrealized

        peak_equity = max(peak_equity, mark_to_market)
        max_drawdown = max(max_drawdown, peak_equity - mark_to_market)
        equity_curve.append(
            {
                "time": candle["close_time"] // 1000,
                "equity": mark_to_market,
            }
        )

    if position is not None:
        last_candle = candles[-1]
        exit_price = float(last_candle["close"])
        exit_fee = position["quantity"] * exit_price * fee_rate
        pnl, fees = _trade_pnl(position["entry_price"], exit_price, position["quantity"], position["entry_fee"], fee_rate)
        equity = position["entry_cash_equity"] + (position["quantity"] * (exit_price - position["entry_price"])) - exit_fee
        total_fees += fees
        peak_equity = max(peak_equity, equity)
        max_drawdown = max(max_drawdown, peak_equity - equity)
        trades.append(
            {
                "side": "long",
                "entry_time": position["entry_time"],
                "exit_time": last_candle["close_time"],
                "entry_price": position["entry_price"],
                "exit_price": exit_price,
                "quantity": position["quantity"],
                "leverage": leverage,
                "entry_reason": position["entry_reason"],
                "exit_reason": "forced_exit_end_of_period",
                "entry_fee": position["entry_fee"],
                "exit_fee": exit_fee,
                "fees": fees,
                "pnl": pnl,
                "return_pct": (pnl / position["entry_equity"] * 100.0) if position["entry_equity"] else 0.0,
            }
        )
        markers.append(
            {
                "time": last_candle["close_time"] // 1000,
                "position": "aboveBar",
                "color": "#ef4444",
                "shape": "arrowDown",
                "text": "SELL",
                "price": exit_price,
            }
        )
        equity_curve.append(
            {
                "time": last_candle["close_time"] // 1000,
                "equity": equity,
            }
        )

    wins = sum(1 for trade in trades if trade["pnl"] > 0)
    total_trades = len(trades)
    win_rate = (wins / total_trades * 100.0) if total_trades else 0.0
    total_pnl = equity - capital
    total_return_pct = (total_pnl / capital * 100.0) if capital else 0.0
    return BacktestResult(
        start_capital=capital,
        final_equity=equity,
        total_return_pct=total_return_pct,
        total_trades=total_trades,
        win_rate=win_rate,
        pnl=total_pnl,
        total_fees=total_fees,
        max_drawdown=max_drawdown,
        trades=trades,
        markers=markers,
        equity_curve=equity_curve,
    )
