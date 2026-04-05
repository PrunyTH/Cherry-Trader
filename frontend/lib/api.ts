export const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8000";

export type Candle = {
  symbol: string;
  interval: string;
  open_time: number;
  close_time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  is_closed: boolean;
};

export type Signal = {
  symbol: string;
  interval: string;
  ts: number;
  side: "buy" | "sell";
  price: number;
  fast_ema: number;
  slow_ema: number;
  reason: string;
};

export type BacktestTrade = {
  side: string;
  entry_time: number;
  exit_time: number;
  entry_price: number;
  exit_price: number;
  quantity: number;
  leverage: number;
  entry_reason: string;
  exit_reason: string;
  entry_fee?: number;
  exit_fee?: number;
  fees: number;
  pnl: number;
  return_pct: number;
};

export type BacktestStats = {
  start_capital: number;
  final_equity: number;
  total_return_pct: number;
  total_trades: number;
  win_rate: number;
  pnl: number;
  total_fees: number;
  max_drawdown: number;
};

export type BacktestResponse = {
  run_id: number;
  stats: BacktestStats;
  trades: BacktestTrade[];
  equity_curve: Array<{
    time: number;
    equity: number;
  }>;
  markers: Array<{
    time: number;
    position: "aboveBar" | "belowBar";
    color: string;
    shape: "arrowUp" | "arrowDown" | "circle";
    text: string;
    price?: number;
  }>;
};

function intervalToMinutes(interval: string): number {
  const lookup: Record<string, number> = {
    "1m": 1,
    "3m": 3,
    "5m": 5,
    "15m": 15,
    "30m": 30,
    "1h": 60,
    "2h": 120,
    "4h": 240,
    "6h": 360,
    "8h": 480,
    "12h": 720,
    "1d": 1440,
    "3d": 4320,
    "1w": 10080,
    "1M": 43200,
  };
  return lookup[interval] ?? 1;
}

async function fetchBinanceCandlesPaged(symbol: string, interval: string, targetCount: number) {
  const pages: Candle[][] = [];
  let endTime: number | undefined;

  while (pages.reduce((sum, page) => sum + page.length, 0) < targetCount) {
    const url = new URL("https://api.binance.com/api/v3/klines");
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", interval);
    url.searchParams.set("limit", "1000");
    if (endTime != null) {
      url.searchParams.set("endTime", String(endTime));
    }

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`binance backtest candles request failed: ${response.status}`);
    }

    const rows = (await response.json()) as Array<
      [number, string, string, string, string, string, number, string, number, string, string, string]
    >;
    if (!rows.length) {
      break;
    }

    const candles = rows.map((row) => ({
      symbol,
      interval,
      open_time: row[0],
      close_time: row[6],
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
      is_closed: true,
    }));
    pages.unshift(candles);

    if (rows.length < 1000) {
      break;
    }

    endTime = rows[0][0] - 1;
  }

  return pages.flat();
}

function ema(values: number[], period: number) {
  if (!values.length) {
    return [];
  }
  const alpha = 2 / (period + 1);
  const output = [values[0]];
  for (let i = 1; i < values.length; i += 1) {
    output.push((values[i] - output[output.length - 1]) * alpha + output[output.length - 1]);
  }
  return output;
}

function atr(highs: number[], lows: number[], closes: number[], period: number) {
  if (!highs.length) {
    return [];
  }
  const trueRanges = [highs[0] - lows[0]];
  for (let i = 1; i < highs.length; i += 1) {
    trueRanges.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  return ema(trueRanges, period);
}

function tradePnl(entryPrice: number, exitPrice: number, quantity: number, feeRate: number) {
  const entryNotional = quantity * entryPrice;
  const exitNotional = quantity * exitPrice;
  const gross = quantity * (exitPrice - entryPrice);
  const fees = (entryNotional + exitNotional) * feeRate;
  return { pnl: gross - fees, fees };
}

const BINANCE_TAKER_FEE_RATE = 0.0005;

function runTrendPullbackBacktestLocal(
  candles: Candle[],
  capital: number,
  leverage: number,
  stopLossAtrMult: number,
  lookbackDays: number,
): BacktestResponse {
  const closed = candles.filter((candle) => candle.is_closed);
  if (closed.length < 220) {
    return {
      run_id: 0,
      stats: {
        start_capital: capital,
        final_equity: capital,
        total_return_pct: 0,
        total_trades: 0,
        win_rate: 0,
        pnl: 0,
        total_fees: 0,
        max_drawdown: 0,
      },
      trades: [],
      equity_curve: [],
      markers: [],
    };
  }

  const closes = closed.map((candle) => candle.close);
  const highs = closed.map((candle) => candle.high);
  const lows = closed.map((candle) => candle.low);
  const opens = closed.map((candle) => candle.open);
  const entryEma = ema(closes, 20);
  const trendEma = ema(closes, 50);
  const filterEma = ema(closes, 200);
  const atrValues = atr(highs, lows, closes, 14);
  const latestCloseTime = closed[closed.length - 1]?.close_time ?? 0;
  const evaluationStartTime = latestCloseTime - lookbackDays * 24 * 60 * 60 * 1000;

  let equity = capital;
  let peakEquity = capital;
  let maxDrawdown = 0;
  let totalFees = 0;
  let position:
    | {
        entry_time: number;
        entry_price: number;
        quantity: number;
        entry_equity: number;
        entry_cash_equity: number;
        entry_fee: number;
        entry_reason: string;
        stop_price: number;
      }
    | null = null;
  let setupActive = false;
  const trades: BacktestTrade[] = [];
  const markers: BacktestResponse["markers"] = [];
  const equityCurve: BacktestResponse["equity_curve"] = [];

  for (let i = 200; i < closed.length; i += 1) {
    const candle = closed[i];
    if (candle.close_time < evaluationStartTime) {
      continue;
    }
    const price = closes[i];
    const entryLine = entryEma[i];
    const trendLine = trendEma[i];
    const filterLine = filterEma[i];
    const openPrice = opens[i];

    const trendUp = trendLine > filterLine && price > trendLine && trendLine >= trendEma[Math.max(0, i - 3)];
    const pullbackTouched = lows[i] <= entryLine * 1.002;
    const reclaim = price > entryLine && price > openPrice;
    const exitLong = price < entryLine || price < trendLine || trendLine < filterLine;
    const atrValue = atrValues[i] ?? 0;
    const stopPrice = position?.stop_price ?? null;
    const stopTriggered = stopPrice != null && lows[i] <= stopPrice;

    if (position && (stopTriggered || exitLong)) {
      const exitPrice = stopTriggered && stopPrice != null ? stopPrice : price;
      const exitFee = position.quantity * exitPrice * BINANCE_TAKER_FEE_RATE;
      const { pnl, fees } = tradePnl(position.entry_price, exitPrice, position.quantity, BINANCE_TAKER_FEE_RATE);
      equity = position.entry_cash_equity + position.quantity * (exitPrice - position.entry_price) - exitFee;
      totalFees += fees;
      peakEquity = Math.max(peakEquity, equity);
      maxDrawdown = Math.max(maxDrawdown, peakEquity - equity);
      trades.push({
        side: "long",
        entry_time: position.entry_time,
        exit_time: candle.close_time,
        entry_price: position.entry_price,
        exit_price: exitPrice,
        quantity: position.quantity,
        leverage,
        entry_reason: position.entry_reason,
        exit_reason: stopTriggered ? "stop_loss_long" : "trend_exit_long",
        entry_fee: position.entry_fee,
        exit_fee: exitFee,
        fees,
        pnl,
        return_pct: position.entry_equity ? (pnl / position.entry_equity) * 100 : 0,
      });
      markers.push({
        time: candle.close_time / 1000,
        position: "aboveBar",
        color: "#ef4444",
        shape: "arrowDown",
        text: "SELL",
        price: exitPrice,
      });
      position = null;
      setupActive = false;
    } else if (!position && setupActive && trendUp && reclaim) {
      const entryPrice = price;
      const notional = equity * leverage;
      const quantity = notional / entryPrice;
      const stopPriceCandidate = entryPrice - atrValue * stopLossAtrMult;
      const entryFee = notional * BINANCE_TAKER_FEE_RATE;
      const equityAfterEntryFee = equity - entryFee;
      position = {
        entry_time: candle.close_time,
        entry_price: entryPrice,
        quantity,
        entry_equity: equityAfterEntryFee,
        entry_cash_equity: equityAfterEntryFee,
        entry_fee: entryFee,
        entry_reason: "trend_entry_long",
        stop_price: Math.max(stopPriceCandidate, entryPrice * 0.5),
      };
      equity = equityAfterEntryFee;
      totalFees += entryFee;
      setupActive = false;
      markers.push({
        time: candle.close_time / 1000,
        position: "belowBar",
        color: "#22c55e",
        shape: "arrowUp",
        text: "BUY",
        price: entryPrice,
      });
    } else if (!position && !setupActive && trendUp && pullbackTouched && price < entryLine) {
      markers.push({
        time: candle.close_time / 1000,
        position: "belowBar",
        color: "#f59e0b",
        shape: "circle",
        text: "SETUP",
        price,
      });
      setupActive = true;
    }

    if (setupActive && !trendUp) {
      setupActive = false;
    }

    let markToMarket = equity;
    if (position) {
      const unrealized = position.quantity * (price - position.entry_price);
      markToMarket = position.entry_cash_equity + unrealized;
    }

    peakEquity = Math.max(peakEquity, markToMarket);
    maxDrawdown = Math.max(maxDrawdown, peakEquity - markToMarket);
    equityCurve.push({
      time: candle.close_time / 1000,
      equity: markToMarket,
    });
  }

  if (position) {
    const lastCandle = closed[closed.length - 1];
    const exitPrice = lastCandle.close;
    const exitFee = position.quantity * exitPrice * BINANCE_TAKER_FEE_RATE;
    const { pnl, fees } = tradePnl(position.entry_price, exitPrice, position.quantity, BINANCE_TAKER_FEE_RATE);
    equity = position.entry_cash_equity + position.quantity * (exitPrice - position.entry_price) - exitFee;
    totalFees += fees;
    peakEquity = Math.max(peakEquity, equity);
    maxDrawdown = Math.max(maxDrawdown, peakEquity - equity);
    trades.push({
      side: "long",
      entry_time: position.entry_time,
      exit_time: lastCandle.close_time,
      entry_price: position.entry_price,
      exit_price: exitPrice,
      quantity: position.quantity,
      leverage,
      entry_reason: position.entry_reason,
      exit_reason: "forced_exit_end_of_period",
      entry_fee: position.entry_fee,
      exit_fee: exitFee,
      fees,
      pnl,
      return_pct: position.entry_equity ? (pnl / position.entry_equity) * 100 : 0,
    });
    markers.push({
      time: lastCandle.close_time / 1000,
      position: "aboveBar",
      color: "#ef4444",
      shape: "arrowDown",
      text: "SELL",
      price: exitPrice,
    });
    equityCurve.push({
      time: lastCandle.close_time / 1000,
      equity,
    });
  }

  const wins = trades.filter((trade) => trade.pnl > 0).length;
  const totalTrades = trades.length;
  const winRate = totalTrades ? (wins / totalTrades) * 100 : 0;
  const totalPnl = equity - capital;
  const totalReturnPct = capital ? (totalPnl / capital) * 100 : 0;

  return {
    run_id: Date.now(),
    stats: {
      start_capital: capital,
      final_equity: equity,
      total_return_pct: totalReturnPct,
      total_trades: totalTrades,
      win_rate: winRate,
      pnl: totalPnl,
      total_fees: totalFees,
      max_drawdown: maxDrawdown,
    },
    trades,
    equity_curve: equityCurve,
    markers,
  };
}

export async function fetchCandles(symbol: string, interval: string, limit = 300) {
  try {
    const response = await fetch(`${BACKEND_URL}/api/candles?symbol=${symbol}&interval=${interval}&limit=${limit}`);
    if (!response.ok) {
      throw new Error(`backend candles request failed: ${response.status}`);
    }
    const payload = (await response.json()) as { candles: Candle[] };
    if (payload.candles.length >= limit) {
      return payload;
    }
    const candles = await fetchBinanceCandlesPaged(symbol, interval, Math.min(limit, 250000));
    return { candles };
  } catch {
    const candles = await fetchBinanceCandlesPaged(symbol, interval, Math.min(limit, 250000));
    return { candles };
  }
}

export async function fetchChartCandles(symbol: string, interval: string, limit = 300) {
  const candles = await fetchBinanceCandlesPaged(symbol, interval, Math.min(limit, 250000));
  return { candles };
}

export async function fetchSignals(symbol: string, interval: string, limit = 200) {
  try {
    const response = await fetch(`${BACKEND_URL}/api/signals?symbol=${symbol}&interval=${interval}&limit=${limit}`);
    if (!response.ok) {
      throw new Error(`backend signals request failed: ${response.status}`);
    }
    return (await response.json()) as { signals: Signal[] };
  } catch {
    return { signals: [] };
  }
}

export async function runBacktest(
  symbol: string,
  interval: string,
  lookback_days: number,
  capital: number,
  leverage: number,
  stop_loss_atr_mult = 1.5,
) {
  try {
    const response = await fetch(`${BACKEND_URL}/api/backtest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, interval, lookback_days, capital, leverage, stop_loss_atr_mult }),
    });
    if (!response.ok) {
      throw new Error(`backend backtest request failed: ${response.status}`);
    }
    return (await response.json()) as BacktestResponse;
  } catch {
    const candlesNeeded = Math.min(Math.max(Math.ceil((lookback_days * 24 * 60) / intervalToMinutes(interval)) + 250, 500), 250000);
    const candles = await fetchBinanceCandlesPaged(symbol, interval, candlesNeeded);
    return runTrendPullbackBacktestLocal(candles, capital, leverage, stop_loss_atr_mult, lookback_days);
  }
}
