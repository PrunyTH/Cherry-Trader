"use client";

import { useEffect, useRef, useState } from "react";
import {
  CandlestickData,
  ColorType,
  CrosshairMode,
  LineData,
  MouseEventParams,
  createChart,
  IChartApi,
  ISeriesApi,
  UTCTimestamp,
} from "lightweight-charts";

import {
  BACKEND_URL,
  AdminBacktestRun,
  Candle,
  BacktestTrade,
  fetchAdminRuns,
  fetchCandles,
  fetchChartCandles,
  fetchSignals,
  runBacktestBundle,
  Signal,
} from "@/lib/api";

type Marker = {
  time: UTCTimestamp;
  position: "aboveBar" | "belowBar";
  color: string;
  shape: "arrowUp" | "arrowDown" | "circle";
  text: string;
  price?: number;
};

type EquityPoint = {
  time: number;
  equity: number;
};

type CherryPin = {
  left: number;
  top: number;
  kind: "buy" | "sell";
};

type ChartHoverSnapshot = {
  time: number;
  price: number;
  ema20: number;
  ema50: number;
  ema200: number;
};

type ChartZone = {
  left: number;
  width: number;
  kind: "good" | "bad";
};

type HistoryRange = "1D" | "1M" | "3M" | "6M" | "1Y" | "2Y" | "ALL";

type TimeframeComparisonRow = {
  interval: string;
  stats: {
    total_return_pct: number;
    final_equity: number;
    total_trades: number;
    win_rate: number;
    total_fees: number;
    max_drawdown: number;
    score: number;
  };
};

type StopSensitivityRow = {
  stopLossAtrMult: number;
  stats: {
    total_return_pct: number;
    final_equity: number;
    total_trades: number;
    win_rate: number;
    total_fees: number;
    max_drawdown: number;
    score: number;
  };
};

type HeatmapCell = {
  interval: string;
  stopLossAtrMult: number;
  stats: {
    total_return_pct: number;
    final_equity: number;
    total_trades: number;
    win_rate: number;
    total_fees: number;
    max_drawdown: number;
    score: number;
  };
};

type AnalysisHeatmapCell = {
  interval: string;
  historyRange: HistoryRange;
  stats: {
    total_return_pct: number;
    final_equity: number;
    total_trades: number;
    win_rate: number;
    total_fees: number;
    max_drawdown: number;
    score: number;
  };
};

const SYMBOL = process.env.NEXT_PUBLIC_DEFAULT_SYMBOL ?? "BTCUSDT";
const DEFAULT_INTERVAL = process.env.NEXT_PUBLIC_DEFAULT_INTERVAL ?? "1w";
const TIMEFRAMES = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d", "3d", "1w", "1M"];
const CHART_TIMEFRAMES = ["15m", "1h", "4h", "1d", "1w", "1M"];
const HISTORY_OPTIONS: Array<{ value: HistoryRange; label: string }> = [
  { value: "1D", label: "1 day" },
  { value: "1M", label: "1 month" },
  { value: "3M", label: "3 months" },
  { value: "6M", label: "6 months" },
  { value: "1Y", label: "1 year" },
  { value: "2Y", label: "2 years" },
  { value: "ALL", label: "All available" },
];
const COMPARISON_INTERVALS = ["15m", "1h", "4h", "1d", "1w", "1M"];
const STOP_MULTIPLIERS = [0.75, 1, 1.5, 2, 2.5, 3];
const STRATEGY_NAME = "Trend Pullback v2";
const BINANCE_TAKER_FEE_RATE = 0.0005;
const DAY_MS = 24 * 60 * 60 * 1000;

function toSeries(candle: Candle): CandlestickData {
  return {
    time: Math.floor(candle.open_time / 1000) as UTCTimestamp,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
  };
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function formatDateTime(value: number) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatLongDateTime(value: number) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatLongDate(value: number) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
  }).format(new Date(value));
}

function formatTradeTime(value: number) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
  }).format(new Date(value));
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

function emaSeries(candles: CandlestickData[], period: number): LineData[] {
  const closes = candles.map((candle) => candle.close);
  const emaValues = ema(closes, period);
  return candles.map((candle, index) => ({
    time: candle.time,
    value: emaValues[index],
  }));
}

function heikinAshiSeries(candles: CandlestickData[]): CandlestickData[] {
  if (!candles.length) {
    return [];
  }

  const series: CandlestickData[] = [];
  let previousOpen = (candles[0].open + candles[0].close) / 2;
  let previousClose = (candles[0].open + candles[0].high + candles[0].low + candles[0].close) / 4;

  for (const candle of candles) {
    const haClose = (candle.open + candle.high + candle.low + candle.close) / 4;
    const haOpen = series.length === 0 ? previousOpen : (previousOpen + previousClose) / 2;
    const haHigh = Math.max(candle.high, haOpen, haClose);
    const haLow = Math.min(candle.low, haOpen, haClose);
    series.push({
      time: candle.time,
      open: haOpen,
      high: haHigh,
      low: haLow,
      close: haClose,
    });
    previousOpen = haOpen;
    previousClose = haClose;
  }

  return series;
}

function mergeCandleSeries(current: CandlestickData[], next: CandlestickData) {
  if (!current.length) {
    return [next];
  }
  const last = current[current.length - 1];
  if (last.time === next.time) {
    return [...current.slice(0, -1), next];
  }
  if (last.time < next.time) {
    return [...current, next];
  }
  return current;
}

function historyDaysForRange(range: HistoryRange) {
  switch (range) {
    case "1D":
      return 1;
    case "1M":
      return 30;
    case "3M":
      return 90;
    case "6M":
      return 180;
    case "1Y":
      return 365;
    case "2Y":
      return 730;
    case "ALL":
      return 3650;
  }
}

function intervalToMinutes(interval: string) {
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
  return lookup[interval] ?? 15;
}

function chartCandleLimitFor(interval: string, historyDays: number) {
  const required = Math.ceil((historyDays * 24 * 60) / intervalToMinutes(interval)) + 1500;
  return Math.min(Math.max(required, 2500), 250000);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function TradingLabPage() {
  const [backtestInterval, setBacktestInterval] = useState(DEFAULT_INTERVAL);
  const [chartInterval, setChartInterval] = useState(DEFAULT_INTERVAL);
  const [historyRange, setHistoryRange] = useState<HistoryRange>("1Y");
  const [capital, setCapital] = useState(1000);
  const [leverageInput, setLeverageInput] = useState("1.0");
  const [chartMaximized, setChartMaximized] = useState(false);
  const [chartHistoryRange] = useState<HistoryRange>("ALL");
  const [stats, setStats] = useState({
    start_capital: 1000,
    final_equity: 1000,
    total_return_pct: 0,
    total_trades: 0,
    win_rate: 0,
    pnl: 0,
    total_fees: 0,
    max_drawdown: 0,
    score: 0,
  });
  const [status, setStatus] = useState("loading market data");
  const [candles, setCandles] = useState<CandlestickData[]>([]);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [equityCurve, setEquityCurve] = useState<EquityPoint[]>([]);
  const [trades, setTrades] = useState<BacktestTrade[]>([]);
  const [comparisonRows, setComparisonRows] = useState<TimeframeComparisonRow[]>([]);
  const [comparisonBusy, setComparisonBusy] = useState(false);
  const [stopRows, setStopRows] = useState<StopSensitivityRow[]>([]);
  const [stopBusy, setStopBusy] = useState(false);
  const [heatmapCells, setHeatmapCells] = useState<HeatmapCell[]>([]);
  const [heatmapBusy, setHeatmapBusy] = useState(false);
  const [analysisHeatmapCells, setAnalysisHeatmapCells] = useState<AnalysisHeatmapCell[]>([]);
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [progressStage, setProgressStage] = useState<"idle" | "loading" | "backtest" | "compare" | "stops" | "done">("idle");
  const [progressPct, setProgressPct] = useState(0);
  const [cherryPins, setCherryPins] = useState<CherryPin[]>([]);
  const [chartZones, setChartZones] = useState<ChartZone[]>([]);
  const [chartHover, setChartHover] = useState<ChartHoverSnapshot | null>(null);
  const [chartZoomed, setChartZoomed] = useState(false);
  const [showHeikinAshi, setShowHeikinAshi] = useState(false);
  const [showAdminPanel, setShowAdminPanel] = useState(false);
  const [adminRuns, setAdminRuns] = useState<AdminBacktestRun[]>([]);
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminError, setAdminError] = useState<string | null>(null);
  const chartAutoFitRef = useRef(true);
  const chartLatestViewRef = useRef(false);
  const chartRef = useRef<HTMLDivElement | null>(null);
  const chartApi = useRef<IChartApi | null>(null);
  const seriesApi = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const ema20Api = useRef<ISeriesApi<"Line"> | null>(null);
  const ema50Api = useRef<ISeriesApi<"Line"> | null>(null);
  const ema200Api = useRef<ISeriesApi<"Line"> | null>(null);
  const heikinAshiApi = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const chartDataRef = useRef<{
    candles: CandlestickData[];
    heikinAshi: CandlestickData[];
    ema20: LineData[];
    ema50: LineData[];
    ema200: LineData[];
  }>({
    candles: [],
    heikinAshi: [],
    ema20: [],
    ema50: [],
    ema200: [],
  });
  const chartHoverTimeRef = useRef<number | null>(null);
  const chartPaneCellRef = useRef<HTMLTableCellElement | null>(null);
  const chartLoadSeqRef = useRef(0);
  const zoomResetRef = useRef<number | null>(null);
  const dragStateRef = useRef<{
    active: boolean;
    pointerId: number | null;
    startY: number;
    startShiftPx: number;
  }>({
    active: false,
    pointerId: null,
    startY: 0,
    startShiftPx: 0,
  });
  const verticalShiftPxRef = useRef(0);
  const leverage = sanitizeLeverage(leverageInput);
  const lookbackDays = historyDaysForRange(historyRange);
  const chartCandleLimit = chartCandleLimitFor(chartInterval, historyDaysForRange(chartHistoryRange));
  const chartStatusBusy = status.startsWith("loading") || status.startsWith("refreshing");

  async function loadAdminRuns() {
    setAdminBusy(true);
    setAdminError(null);
    try {
      const payload = await fetchAdminRuns(5);
      setAdminRuns(payload.runs);
    } catch (error) {
      setAdminError(error instanceof Error ? error.message : "unknown error");
    } finally {
      setAdminBusy(false);
    }
  }

  function syncChartHover(time: number | null) {
    chartHoverTimeRef.current = time;
    const { candles: dataCandles, ema20, ema50, ema200 } = chartDataRef.current;
    if (time == null || !dataCandles.length) {
      setChartHover(null);
      return;
    }

    const index = dataCandles.findIndex((candle) => Number(candle.time) === time);
    if (index < 0) {
      setChartHover(null);
      return;
    }

    const candle = dataCandles[index];
    const ema20Point = ema20[index];
    const ema50Point = ema50[index];
    const ema200Point = ema200[index];
    if (ema20Point?.value == null || ema50Point?.value == null || ema200Point?.value == null) {
      setChartHover(null);
      return;
    }

    setChartHover({
      time: Number(candle.time),
      price: candle.close,
      ema20: ema20Point.value,
      ema50: ema50Point.value,
      ema200: ema200Point.value,
    });
  }

  function updateChartZones() {
    const chart = chartApi.current;
    const { candles: dataCandles, ema20, ema50, ema200 } = chartDataRef.current;
    if (!chart || !dataCandles.length || !ema20.length || !ema50.length || !ema200.length) {
      setChartZones([]);
      return;
    }

    const segments: ChartZone[] = [];
    let segmentStartIndex = 0;
    let currentKind: ChartZone["kind"] | null = null;

    const pushSegment = (startIndex: number, endIndex: number, kind: ChartZone["kind"]) => {
      const startTime = dataCandles[startIndex]?.time;
      const endTime = dataCandles[endIndex + 1]?.time ?? dataCandles[endIndex]?.time;
      if (startTime == null || endTime == null) {
        return;
      }
      const left = chart.timeScale().timeToCoordinate(startTime as UTCTimestamp);
      const right = chart.timeScale().timeToCoordinate(endTime as UTCTimestamp);
      if (left == null || right == null) {
        return;
      }
      segments.push({
        left,
        width: Math.max(1, right - left),
        kind,
      });
    };

    for (let i = 200; i < dataCandles.length; i += 1) {
      const price = dataCandles[i].close;
      const trendLine = ema50[i]?.value ?? 0;
      const filterLine = ema200[i]?.value ?? 0;
      const prevTrend = ema50[Math.max(0, i - 3)]?.value ?? trendLine;
      const trendUp = trendLine > filterLine && price > trendLine && trendLine >= prevTrend;
      const kind: ChartZone["kind"] = trendUp ? "good" : "bad";
      if (currentKind == null) {
        currentKind = kind;
        segmentStartIndex = i;
        continue;
      }
      if (kind !== currentKind) {
        pushSegment(segmentStartIndex, i - 1, currentKind);
        currentKind = kind;
        segmentStartIndex = i;
      }
    }

    if (currentKind != null && dataCandles.length > 0) {
      pushSegment(segmentStartIndex, dataCandles.length - 1, currentKind);
    }

    setChartZones(segments);
  }

  function applyChartData(candleData: CandlestickData[]) {
    if (!seriesApi.current || !chartApi.current || !candleData.length) {
      return;
    }
    const ema20 = emaSeries(candleData, 20);
    const ema50 = emaSeries(candleData, 50);
    const ema200 = emaSeries(candleData, 200);
    const heikinAshi = heikinAshiSeries(candleData);
    chartDataRef.current = {
      candles: candleData,
      heikinAshi,
      ema20,
      ema50,
      ema200,
    };
    seriesApi.current.setData(candleData);
    if (heikinAshiApi.current) {
      heikinAshiApi.current.setData(heikinAshi);
    }
    ema20Api.current?.setData(ema20);
    ema50Api.current?.setData(ema50);
    ema200Api.current?.setData(ema200);
    chartApi.current.applyOptions({
      localization: { priceFormatter: (price: number) => formatNumber(price) },
    });
    if (chartAutoFitRef.current) {
      chartApi.current.timeScale().fitContent();
    } else if (chartLatestViewRef.current) {
      const visibleBars = Math.min(250, candleData.length);
      chartApi.current.timeScale().setVisibleLogicalRange({
        from: Math.max(0, candleData.length - visibleBars),
        to: candleData.length - 1,
      });
    }
    updateCherryPins();
    updateChartZones();
    syncChartHover(chartHoverTimeRef.current);
  }

  useEffect(() => {
    if (!heikinAshiApi.current || !chartDataRef.current.candles.length) {
      return;
    }
    heikinAshiApi.current.setData(showHeikinAshi ? chartDataRef.current.heikinAshi : []);
  }, [showHeikinAshi]);

  useEffect(() => {
    const loadSeq = chartLoadSeqRef.current + 1;
    chartLoadSeqRef.current = loadSeq;
    let cancelled = false;

    async function load() {
      try {
        setStatus(`loading ${chartInterval} candles`);
        const candlesRes = await fetchChartCandles(SYMBOL, chartInterval, chartCandleLimit);
        if (cancelled || chartLoadSeqRef.current !== loadSeq) {
          return;
        }

        const candleData = candlesRes.candles.map(toSeries);
        setCandles(candleData);
        void fetchSignals(SYMBOL, chartInterval, 100)
          .then((signalsRes) => {
            if (cancelled || chartLoadSeqRef.current !== loadSeq) {
              return;
            }
            setMarkers(signalsRes.signals.flatMap((signal) => signalToMarkers(signal)));
          })
          .catch((error) => {
            if (cancelled || chartLoadSeqRef.current !== loadSeq) {
              return;
            }
          });
        setStatus(`loaded ${candleData.length} candles`);
      } catch (error) {
        if (cancelled || chartLoadSeqRef.current !== loadSeq) {
          return;
        }
        setStatus(`chart load failed: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [chartInterval, chartCandleLimit]);

  useEffect(() => {
    applyChartData(candles);
  }, [candles]);

  useEffect(() => {
    if (!chartRef.current) {
      return;
    }
    const chart = createChart(chartRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "#ffffff" },
        textColor: "#111111",
      },
      grid: {
        vertLines: { color: "rgba(17, 17, 17, 0.08)" },
        horzLines: { color: "rgba(17, 17, 17, 0.08)" },
      },
      rightPriceScale: {
        borderColor: "rgba(17, 17, 17, 0.14)",
      },
      timeScale: {
        borderColor: "rgba(17, 17, 17, 0.14)",
        timeVisible: true,
        barSpacing: 14,
        minBarSpacing: 0.05,
        rightOffset: 0,
        fixLeftEdge: true,
        fixRightEdge: true,
        lockVisibleTimeRangeOnResize: true,
      },
      crosshair: { mode: CrosshairMode.Normal },
      handleScroll: {
        mouseWheel: false,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      handleScale: {
        mouseWheel: false,
        pinch: true,
        axisPressedMouseMove: { time: true, price: true },
        axisDoubleClickReset: { time: true, price: true },
      },
      width: chartRef.current.clientWidth,
      height: chartRef.current.clientHeight,
    });

    const series = chart.addCandlestickSeries({
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderUpColor: "#22c55e",
      borderDownColor: "#ef4444",
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
    });
    const ema20 = chart.addLineSeries({
      color: "#f59e0b",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    const ema50 = chart.addLineSeries({
      color: "#0f9d58",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    const ema200 = chart.addLineSeries({
      color: "#1d4ed8",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    const heikinAshi = chart.addCandlestickSeries({
      visible: false,
      upColor: "rgba(34, 197, 94, 0.28)",
      downColor: "rgba(239, 68, 68, 0.28)",
      borderUpColor: "rgba(34, 197, 94, 0.34)",
      borderDownColor: "rgba(239, 68, 68, 0.34)",
      wickUpColor: "rgba(34, 197, 94, 0.22)",
      wickDownColor: "rgba(239, 68, 68, 0.22)",
    });
    chartApi.current = chart;
    seriesApi.current = series;
    ema20Api.current = ema20;
    ema50Api.current = ema50;
    ema200Api.current = ema200;
    heikinAshiApi.current = heikinAshi;
    chartPaneCellRef.current = chart.chartElement().querySelector("table tr td:nth-child(2)") as HTMLTableCellElement | null;
    updateCherryPins();
    applyChartData(chartDataRef.current.candles);
    if (chartDataRef.current.candles.length) {
      chart.timeScale().fitContent();
      chartAutoFitRef.current = true;
      chartLatestViewRef.current = false;
    }

    const onWheel = (event: WheelEvent) => {
      if (!chartApi.current) {
        return;
      }
      event.preventDefault();
      chartAutoFitRef.current = false;
      chartLatestViewRef.current = false;
      const timeScale = chartApi.current.timeScale();
      const currentSpacing = timeScale.options().barSpacing ?? 14;
      const zoomFactor = event.deltaY > 0 ? 0.86 : 1.16;
      const nextSpacing = Math.min(40, Math.max(0.08, currentSpacing * zoomFactor));
      timeScale.applyOptions({ barSpacing: nextSpacing });
      setChartZoomed(nextSpacing > 14 || Math.abs(verticalShiftPxRef.current) > 1);
      if (zoomResetRef.current) {
        window.clearTimeout(zoomResetRef.current);
      }
      zoomResetRef.current = window.setTimeout(() => {
        zoomResetRef.current = null;
      }, 200);
    };

    const onCrosshairMove = (param: MouseEventParams) => {
      if (typeof param.time !== "number") {
        setChartHover(null);
        return;
      }
      syncChartHover(param.time);
    };

    const onViewportChange = () => {
      updateCherryPins();
      updateChartZones();
    };

    chartRef.current.addEventListener("wheel", onWheel, { passive: false });
    chart.subscribeCrosshairMove(onCrosshairMove);
    chart.timeScale().subscribeVisibleLogicalRangeChange(onViewportChange);

    const applyVerticalShift = (shift: number) => {
      if (!chartPaneCellRef.current) {
        return;
      }
      const nextShift = clamp(shift, -chartRef.current!.clientHeight * 0.35, chartRef.current!.clientHeight * 0.35);
      verticalShiftPxRef.current = nextShift;
      chartPaneCellRef.current.style.transform = `translateY(${nextShift}px)`;
      setChartZoomed(Math.abs(nextShift) > 1 || (chartApi.current?.timeScale().options().barSpacing ?? 14) > 14);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) {
        return;
      }
      chartAutoFitRef.current = false;
      chartLatestViewRef.current = false;
      dragStateRef.current = {
        active: true,
        pointerId: event.pointerId,
        startY: event.clientY,
        startShiftPx: verticalShiftPxRef.current,
      };
      chartRef.current?.setPointerCapture(event.pointerId);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!dragStateRef.current.active || dragStateRef.current.pointerId !== event.pointerId || !chartRef.current) {
        return;
      }
      const height = chartRef.current.clientHeight || 1;
      const delta = (event.clientY - dragStateRef.current.startY) / height;
      applyVerticalShift(dragStateRef.current.startShiftPx + delta * height * 0.35);
    };

    const endDrag = (event: PointerEvent) => {
      if (dragStateRef.current.pointerId !== event.pointerId) {
        return;
      }
      dragStateRef.current = {
        active: false,
        pointerId: null,
        startY: 0,
        startShiftPx: verticalShiftPxRef.current,
      };
      if (chartRef.current?.hasPointerCapture(event.pointerId)) {
        chartRef.current.releasePointerCapture(event.pointerId);
      }
    };

    chartRef.current.addEventListener("pointerdown", onPointerDown);
    chartRef.current.addEventListener("pointermove", onPointerMove);
    chartRef.current.addEventListener("pointerup", endDrag);
    chartRef.current.addEventListener("pointercancel", endDrag);
    chartRef.current.addEventListener("pointerleave", endDrag);

    const observer = new ResizeObserver(() => {
      if (!chartRef.current) {
        return;
      }
      chart.resize(chartRef.current.clientWidth, chartRef.current.clientHeight);
      if (chartAutoFitRef.current) {
        chart.timeScale().fitContent();
      }
      updateCherryPins();
      updateChartZones();
    });
    observer.observe(chartRef.current);

    return () => {
      chartRef.current?.removeEventListener("wheel", onWheel);
      chart.unsubscribeCrosshairMove(onCrosshairMove);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onViewportChange);
      chartRef.current?.removeEventListener("pointerdown", onPointerDown);
      chartRef.current?.removeEventListener("pointermove", onPointerMove);
      chartRef.current?.removeEventListener("pointerup", endDrag);
      chartRef.current?.removeEventListener("pointercancel", endDrag);
      chartRef.current?.removeEventListener("pointerleave", endDrag);
      if (zoomResetRef.current) {
        window.clearTimeout(zoomResetRef.current);
      }
      chartAutoFitRef.current = false;
      observer.disconnect();
      chart.remove();
      chartApi.current = null;
      seriesApi.current = null;
      ema20Api.current = null;
      ema50Api.current = null;
      ema200Api.current = null;
      chartPaneCellRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!chartRef.current || !chartApi.current) {
      return;
    }
    const raf = window.requestAnimationFrame(() => {
      if (!chartRef.current || !chartApi.current) {
        return;
      }
      chartApi.current.resize(chartRef.current.clientWidth, chartRef.current.clientHeight);
      if (chartAutoFitRef.current) {
        chartApi.current.timeScale().fitContent();
      }
      updateCherryPins();
    });
    return () => window.cancelAnimationFrame(raf);
  }, [chartMaximized]);

  useEffect(() => {
    if (!showAdminPanel) {
      return;
    }
    void loadAdminRuns();
  }, [showAdminPanel]);

  useEffect(() => {
    try {
      const ws = new WebSocket(`${BACKEND_URL.replace("http", "ws")}/ws/stream`);
      ws.onmessage = (event) => {
        const payload = JSON.parse(event.data) as
          | { type: "ready" }
          | { type: "candle"; candle: Candle }
          | { type: "signal"; signal: Signal };

        if (payload.type === "candle" && payload.candle.interval === chartInterval && seriesApi.current) {
          setCandles((current) => mergeCandleSeries(current, toSeries(payload.candle)));
          updateCherryPins();
          updateChartZones();
        }

        if (payload.type === "signal" && payload.signal.interval === chartInterval) {
          const signalLabel = payload.signal.reason.startsWith("pullback_setup")
            ? "SETUP"
            : payload.signal.reason.startsWith("trend_exit")
              ? "SELL"
              : "BUY";
          setMarkers((current) => [...current, ...signalToMarkers(payload.signal)]);
        }
      };

      return () => {
        ws.close();
      };
    } catch (error) {
      setStatus(`websocket unavailable: ${error instanceof Error ? error.message : "unknown error"}`);
      return;
    }
  }, [chartInterval]);

  useEffect(() => {
    if (seriesApi.current) {
      seriesApi.current.setMarkers(markers);
    }
    updateCherryPins();
  }, [markers]);

  async function onRunBacktest() {
    try {
      setProgressStage("loading");
      setProgressPct(8);
      setStatus("running bundled backtest");
      setComparisonBusy(true);
      setStopBusy(true);
      setHeatmapBusy(true);
      setAnalysisBusy(true);
      const result = await runBacktestBundle(
        SYMBOL,
        backtestInterval,
        lookbackDays,
        capital,
        leverage,
      );
      setProgressStage("backtest");
      setProgressPct(70);
      setStats(result.base.stats);
      setTrades(result.base.trades ?? []);
      setEquityCurve(result.base.equity_curve ?? []);
      if (result.base.markers?.length) {
        setMarkers(
          result.base.markers.map((marker) => ({
            ...marker,
            time: marker.time as UTCTimestamp,
          })),
        );
      }
      setComparisonRows(result.comparison_rows ?? []);
      setStopRows(result.stop_rows ?? []);
      setHeatmapCells(result.heatmap_cells ?? []);
      setAnalysisHeatmapCells(
        (result.analysis_heatmap_cells ?? []).map((cell) => ({
          ...cell,
          historyRange: cell.historyRange as HistoryRange,
        })),
      );
      setProgressStage("done");
      setProgressPct(100);
      setStatus(`run ${result.run_id} complete`);
    } catch (error) {
      setStatus(`backtest failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setComparisonBusy(false);
      setStopBusy(false);
      setHeatmapBusy(false);
      setAnalysisBusy(false);
      window.setTimeout(() => {
        setProgressStage("idle");
        setProgressPct(0);
      }, 1200);
    }
  }

  function updateCherryPins() {
    const chart = chartApi.current;
    const series = seriesApi.current;
    if (!chart || !series) {
      setCherryPins([]);
      return;
    }

    const pins = markers.flatMap((marker) => {
      if (marker.price == null) {
        return [];
      }
      const isSell = marker.text === "SELL" || marker.position === "aboveBar";
      const x = chart.timeScale().timeToCoordinate(marker.time);
      const y = series.priceToCoordinate(marker.price);
      if (x == null || y == null) {
        return [];
      }
      const kind: CherryPin["kind"] = isSell ? "sell" : "buy";
      return [
        {
          left: x,
          top: y,
          kind,
        },
      ];
    });

    setCherryPins(pins);
  }

  function resetChartZoom() {
    if (!chartApi.current) {
      return;
    }
    chartApi.current.timeScale().applyOptions({ barSpacing: 14 });
    chartApi.current.timeScale().fitContent();
    chartPaneCellRef.current?.style.removeProperty("transform");
    verticalShiftPxRef.current = 0;
    dragStateRef.current.startShiftPx = 0;
    setChartZoomed(false);
    chartAutoFitRef.current = true;
    chartLatestViewRef.current = false;
    updateCherryPins();
    updateChartZones();
  }

  function refreshChart() {
    const loadSeq = chartLoadSeqRef.current + 1;
    chartLoadSeqRef.current = loadSeq;
    chartAutoFitRef.current = true;
    chartLatestViewRef.current = false;
    setChartZoomed(false);
    chartPaneCellRef.current?.style.removeProperty("transform");
    verticalShiftPxRef.current = 0;
    setStatus(`refreshing ${chartInterval} candles`);
    void (async () => {
      try {
        const candlesRes = await fetchChartCandles(SYMBOL, chartInterval, chartCandleLimit);
        if (chartLoadSeqRef.current !== loadSeq) {
          return;
        }
        const candleData = candlesRes.candles.map(toSeries);
        setCandles(candleData);
        void fetchSignals(SYMBOL, chartInterval, 100)
          .then((signalsRes) => {
            if (chartLoadSeqRef.current !== loadSeq) {
              return;
            }
            setMarkers(signalsRes.signals.flatMap((signal) => signalToMarkers(signal)));
          })
          .catch((error) => {
            if (chartLoadSeqRef.current !== loadSeq) {
              return;
            }
          });
        setStatus(`loaded ${candleData.length} candles`);
      } catch (error) {
        if (chartLoadSeqRef.current !== loadSeq) {
          return;
        }
        setStatus(`chart refresh failed: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    })();
  }

  return (
    <div className={`app-shell ${chartMaximized ? "maximized" : ""}`}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <img className="logo-image" src="/icon.png" alt="" />
          </div>
          <div>
            <h1 className="title">Cherry Trader</h1>
            <p className="muted">
              {STRATEGY_NAME}. Long-only trend pullback with setup, volume, and candle-confirmation markers.
            </p>
          </div>
        </div>

        <div className="section stack">
          <div className="field">
            <label>Symbol</label>
            <input value={SYMBOL} disabled />
          </div>
          <div className="field">
            <label>Backtest timeframe</label>
            <select value={backtestInterval} onChange={(event) => setBacktestInterval(event.target.value)}>
              {TIMEFRAMES.map((timeframe) => (
                <option key={timeframe} value={timeframe}>
                  {timeframe}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="section stack">
          <div className="field">
            <label>History</label>
            <select value={historyRange} onChange={(event) => setHistoryRange(event.target.value as HistoryRange)}>
              {HISTORY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Starting Capital (USDT)</label>
            <input type="number" min={10} step={10} value={capital} onChange={(event) => setCapital(Number(event.target.value))} />
          </div>
          <div className="field">
            <label>Leverage</label>
            <input
              type="number"
              min={1}
              max={3}
              step={0.1}
              value={leverageInput}
              onChange={(event) => setLeverageInput(event.target.value)}
              onBlur={() => setLeverageInput(sanitizeLeverage(leverageInput).toFixed(1))}
            />
          </div>
            <button className="button secondary" onClick={onRunBacktest}>Run backtest</button>
          {progressStage !== "idle" ? (
            <div className="backtest-progress" aria-label="Backtest progress">
              <div className="backtest-progress-track">
                <div className="backtest-progress-fill" style={{ width: `${progressPct}%` }} />
                <div className="backtest-progress-cherry" style={{ left: `${Math.min(100, progressPct)}%` }}>
                  <img className="backtest-progress-cherry-img" src="/progress-cherry.png" alt="" />
                </div>
              </div>
              <div className="backtest-progress-label">
                {progressStage === "loading" && "Loading data"}
                {progressStage === "backtest" && "Running base backtest"}
                {progressStage === "compare" && "Comparing timeframes"}
                {progressStage === "stops" && "Testing stop-loss variants"}
                {progressStage === "done" && "Done"}
              </div>
            </div>
          ) : null}
          <div className="strategy-summary">
            <div className="strategy-summary-title">Current strategy</div>
            <ul className="strategy-summary-list">
              <li>Trend filter: 50 EMA above 200 EMA for longs.</li>
              <li>Pullback: price trades back down into the 20 EMA area after being above it.</li>
              <li>Reclaim: the candle closes back above the 20 EMA after that pullback.</li>
              <li>Entry: reclaim candle must be bullish, with volume above recent average and hammer / engulfing confirmation.</li>
              <li>Risk: ATR stop, one position at a time, long-only for now.</li>
              <li>Fees: Binance taker-style commission is deducted on entry and exit.</li>
            </ul>
            <div className="strategy-summary-note">
              All performance figures are shown in USDT. Funding fees and fiat conversion fees are not included.
            </div>
          </div>
        </div>

        <div className="section">
          <div className="stats">
            <Stat label="Trades" value={stats.total_trades.toString()} />
            <Stat label="Win rate" value={`${formatNumber(stats.win_rate)}%`} />
            <Stat label="Start (USDT)" value={formatNumber(stats.start_capital)} />
            <Stat label="Final (USDT)" value={formatNumber(stats.final_equity)} />
            <Stat label="Return" value={`${formatNumber(stats.total_return_pct)}%`} />
            <Stat label="Fees (USDT)" value={formatNumber(stats.total_fees)} />
            <Stat label="Score" value={formatNumber(stats.score)} />
            <Stat label="Max DD" value={formatNumber(stats.max_drawdown)} />
          </div>
          <div className="metric-note">
            Max drawdown is the largest peak-to-trough drop in equity during the test. Lower is better.
          </div>
          <div className="strategy-note">This strategy is long-only. Shorting is not active yet. Funding and fiat conversion fees are excluded.</div>
        </div>

      </aside>

      <main className={`main ${chartMaximized ? "maximized" : ""}`}>
        <div className="chart-header">
          <div>
            <h2 className="chart-title">Live candlestick chart</h2>
            <div className="chart-symbol">{SYMBOL}</div>
            <div className="chart-legend" aria-label="Strategy overlays">
              <span className="legend-item"><span className="legend-swatch ema20" />EMA 20</span>
              <span className="legend-item"><span className="legend-swatch ema50" />EMA 50</span>
              <span className="legend-item"><span className="legend-swatch ema200" />EMA 200</span>
              <button
                type="button"
                className={`legend-item legend-toggle ${showHeikinAshi ? "active" : ""}`}
                onClick={() => setShowHeikinAshi((current) => !current)}
              >
                Heikin-Ashi {showHeikinAshi ? "on" : "off"}
              </button>
              <span className="legend-item">Drag to pan</span>
              <span className="legend-item">Mouse wheel zoom</span>
            </div>
            <div className="chart-timeframe-switcher" aria-label="Chart timeframe">
              <span className="chart-timeframe-label">Chart timeframe</span>
              <div className="chart-timeframe-pills">
                {CHART_TIMEFRAMES.map((timeframe) => (
                  <button
                    key={timeframe}
                    type="button"
                    className={`chart-timeframe-pill ${timeframe === chartInterval ? "active" : ""}`}
                    onClick={() => {
                      setChartInterval(timeframe);
                      chartAutoFitRef.current = false;
                      chartLatestViewRef.current = true;
                      setChartZoomed(false);
                      chartPaneCellRef.current?.style.removeProperty("transform");
                      verticalShiftPxRef.current = 0;
                    }}
                  >
                    {timeframe}
                  </button>
                ))}
                <button type="button" className="chart-timeframe-pill refresh" onClick={refreshChart}>
                  Refresh
                </button>
              </div>
            </div>
          </div>
          <div className="chart-actions">
            <div className="pill">Realtime via backend WebSocket</div>
            <div className="chart-status-cluster" aria-label="Chart status">
              <div className={`chart-status-pill ${chartStatusBusy ? "busy" : ""}`}>
                <span className="chart-status-text">Status: {status}</span>
                {chartStatusBusy ? (
                  <span className="chart-status-progress" aria-hidden="true">
                    <span className="chart-status-progress-bar" />
                  </span>
                ) : null}
              </div>
            </div>
            {chartZoomed ? (
              <button className="button chart-toggle secondary" onClick={resetChartZoom}>
                Reset zoom
              </button>
            ) : null}
            <button className="button chart-toggle" onClick={() => setChartMaximized((current) => !current)}>
              {chartMaximized ? "Restore chart" : "Maximize chart"}
            </button>
            <button className="button chart-toggle secondary" onClick={() => setShowAdminPanel((current) => !current)}>
              {showAdminPanel ? "Trading view" : "Admin"}
            </button>
          </div>
        </div>
        {showAdminPanel ? (
          <section className="panel admin-panel">
            <div className="panel-head">
              <div>
                <h3>Strategy History</h3>
                <div className="table-note">Top five persisted runs ranked by the robustness score stored in the database.</div>
              </div>
              <button className="button chart-toggle secondary" onClick={() => void loadAdminRuns()}>
                Refresh
              </button>
            </div>
            <div className="table-note">
              Database: backend/data/cherry-trader.sqlite3. Each row links back to the exact git commit used for that run.
            </div>
            {adminError ? <div className="error-banner">Admin load failed: {adminError}</div> : null}
            {adminBusy ? <div className="pill">Loading saved runs...</div> : null}
            <AdminRunsTable runs={adminRuns} />
          </section>
        ) : (
          <>
        <div className={`chart-wrap ${chartMaximized ? "maximized" : ""}`}>
          <div className="chart" ref={chartRef} />
          {chartHover ? (
            <div className="chart-hover-box" aria-live="polite">
              <div className="chart-hover-title">{formatLongDateTime(chartHover.time * 1000)}</div>
              <div className="chart-hover-row">
                <span>Price</span>
                <strong>{formatNumber(chartHover.price)} USDT</strong>
              </div>
              <div className="chart-hover-row">
                <span>EMA 20</span>
                <strong>{formatNumber(chartHover.ema20)} USDT</strong>
              </div>
              <div className="chart-hover-row">
                <span>EMA 50</span>
                <strong>{formatNumber(chartHover.ema50)} USDT</strong>
              </div>
              <div className="chart-hover-row">
                <span>EMA 200</span>
                <strong>{formatNumber(chartHover.ema200)} USDT</strong>
              </div>
            </div>
          ) : null}
          <div className="chart-overlay" aria-hidden="true">
            <div className="chart-zone-layer">
              {chartZones.map((zone, index) => (
                <div
                  key={`${zone.kind}-${index}-${zone.left}-${zone.width}`}
                  className={`chart-zone ${zone.kind}`}
                  style={{ left: `${zone.left}px`, width: `${zone.width}px` }}
                />
              ))}
            </div>
            {cherryPins.map((pin, index) => (
              <div
                key={`${pin.kind}-${index}-${pin.left}-${pin.top}`}
                className={`chart-pin ${pin.kind}`}
                style={{ left: `${pin.left}px`, top: `${pin.top}px` }}
              >
                <CherryIcon kind={pin.kind} />
              </div>
            ))}
          </div>
        </div>
        <section className="panel comparison-panel heatmap-panel heatmap-first">
          <div className="panel-head">
            <h3>Heatmap</h3>
            <span className="pill">{heatmapBusy ? "running..." : `${heatmapCells.length} combos`}</span>
          </div>
          <HeatmapTable cells={heatmapCells} activeInterval={backtestInterval} activeStop={1.5} />
        </section>
        <section className="panel comparison-panel heatmap-panel">
          <div className="panel-head">
            <h3>Analysis Period Heatmap</h3>
            <span className="pill">{analysisBusy ? "running..." : `${analysisHeatmapCells.length} combos`}</span>
          </div>
          <div className="table-note">
            Cells are ranked by a heuristic robustness score that blends return, drawdown, win rate, fees, and trade count.
          </div>
          <AnalysisHeatmapTable cells={analysisHeatmapCells} activeInterval={backtestInterval} activeRange={historyRange} />
        </section>
        <div className={`insights-grid ${chartMaximized ? "hidden" : ""}`}>
          <section className="panel comparison-panel">
          <div className="panel-head">
            <h3>Timeframe Comparison</h3>
            <span className="pill">{comparisonBusy ? "running..." : `${comparisonRows.length} frames`}</span>
          </div>
          <div className="table-note">All values below are in USDT unless labeled as a percentage.</div>
          <ComparisonTable rows={comparisonRows} activeInterval={backtestInterval} />
        </section>
          <section className="panel comparison-panel">
            <div className="panel-head">
              <h3>Stop Loss Sensitivity</h3>
              <span className="pill">{stopBusy ? "running..." : `${stopRows.length} stops`}</span>
            </div>
            <StopSensitivityTable rows={stopRows} activeStop={1.5} />
          </section>
          <section className="panel">
            <div className="panel-head">
              <h3>Equity Curve</h3>
              <span className="pill">{equityCurve.length} points</span>
            </div>
            <EquityCurveChart points={equityCurve} />
          </section>
          <section className="panel">
            <div className="panel-head">
              <h3>Trade Log</h3>
              <span className="pill">{trades.length} long trades</span>
            </div>
            <TradeTable trades={trades} />
          </section>
        </div>
          </>
        )}
      </main>
    </div>
  );
}

function AdminRunsTable({ runs }: { runs: AdminBacktestRun[] }) {
  if (!runs.length) {
    return <div className="empty-state">Run a backtest to populate the saved strategy leaderboard.</div>;
  }

  return (
    <div className="trade-table-wrap table-static-wrap admin-table-wrap">
      <table className="trade-table comparison-table">
        <thead>
          <tr>
            <th>When</th>
            <th>Strategy</th>
            <th>Commit</th>
            <th>Frame</th>
            <th>History</th>
            <th>Stop</th>
            <th>Return</th>
            <th>Final Equity</th>
            <th>Fees</th>
            <th>Max DD</th>
            <th>Score</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.evaluation_id}>
              <td>{formatLongDateTime(run.evaluation_created_at)}</td>
              <td>
                <div className="admin-strategy-name">{run.strategy_label}</div>
                <div className="admin-strategy-meta">{run.strategy_name}</div>
              </td>
              <td className="mono-cell">{run.git_commit}</td>
              <td>
                <span className="trade-chip time-frame">{run.interval}</span>
              </td>
              <td>{run.history_range}</td>
              <td>{run.stop_loss_atr_mult.toFixed(2)}x</td>
              <td className={run.total_return_pct >= 0 ? "good" : "bad"}>{formatNumber(run.total_return_pct)}%</td>
              <td>{formatNumber(run.final_equity)}</td>
              <td>{formatNumber(run.total_fees)}</td>
              <td>{formatNumber(run.max_drawdown)}</td>
              <td>{formatNumber(run.score)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function signalToMarkers(signal: Signal): Marker[] {
  if (signal.reason.startsWith("pullback_setup")) {
    return [
      {
        time: Math.floor(signal.ts / 1000) as UTCTimestamp,
        position: "belowBar",
        color: "#f59e0b",
        shape: "circle",
        text: "SETUP",
        price: signal.price,
      },
    ];
  }

  const marker: Marker = {
    time: Math.floor(signal.ts / 1000) as UTCTimestamp,
    position: signal.side === "buy" ? "belowBar" : "aboveBar",
    color: signal.side === "buy" ? "#22c55e" : "#ef4444",
    shape: signal.side === "buy" ? "arrowUp" : "arrowDown",
    text: signal.reason.startsWith("trend_entry") ? "BUY" : signal.reason.startsWith("trend_exit") ? "SELL" : signal.side.toUpperCase(),
    price: signal.price,
  };
  return [marker];
}

function sanitizeLeverage(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 1;
  }
  return Math.min(3, Math.max(1, parsed));
}

function CherryIcon({ kind }: { kind: "buy" | "sell" }) {
  const stem = kind === "buy" ? "#166534" : "#7b0f1d";
  const body = kind === "buy" ? "#22c55e" : "#dc2626";
  const highlight = kind === "buy" ? "#dcfce7" : "#fecdd3";

  return (
    <svg viewBox="0 0 48 48" className={`cherry-icon ${kind}`} role="img" aria-hidden="true">
      <defs>
        <linearGradient id={`cherry-body-${kind}`} x1="14" y1="14" x2="34" y2="38" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor={highlight} />
          <stop offset="55%" stopColor={body} />
          <stop offset="100%" stopColor={kind === "buy" ? "#15803d" : "#991b1b"} />
        </linearGradient>
      </defs>
      <path
        d="M21 10C23 16 24 19 26 24"
        fill="none"
        stroke={stem}
        strokeWidth="3"
        strokeLinecap="round"
      />
      <path
        d="M26 13C30 9 34 9 37 12C33 15 30 17 27 20"
        fill={kind === "buy" ? "#34d399" : "#86efac"}
        opacity="0.92"
      />
      <circle cx="20" cy="30" r="11" fill={`url(#cherry-body-${kind})`} />
      <circle cx="30" cy="31" r="11" fill={`url(#cherry-body-${kind})`} />
      <circle cx="16" cy="26" r="2.4" fill="#ffffff" fillOpacity="0.45" />
      <circle cx="26" cy="27" r="2.4" fill="#ffffff" fillOpacity="0.45" />
    </svg>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="muted">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}

function normalizeTimeMs(time: number) {
  return time < 1_000_000_000_000 ? time * 1000 : time;
}

function bucketEquityCurve(points: EquityPoint[]) {
  if (!points.length) {
    return points;
  }
  const buckets = new Map<number, EquityPoint>();
  for (const point of points) {
    const timeMs = normalizeTimeMs(point.time);
    const bucket = Math.floor(timeMs / DAY_MS) * DAY_MS;
    buckets.set(bucket, {
      time: bucket,
      equity: point.equity,
    });
  }
  return Array.from(buckets.values()).sort((a, b) => a.time - b.time);
}

function EquityCurveChart({ points }: { points: EquityPoint[] }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const dailyPoints = bucketEquityCurve(points);
  if (!dailyPoints.length) {
    return <div className="empty-state">Run a backtest to see the equity curve.</div>;
  }

  const width = 640;
  const height = 220;
  const padding = 18;
  const values = dailyPoints.map((point) => point.equity);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;

  const polyline = dailyPoints
    .map((point, index) => {
      const x = padding + (index / Math.max(dailyPoints.length - 1, 1)) * (width - padding * 2);
      const y = height - padding - ((point.equity - min) / span) * (height - padding * 2);
      return `${x},${y}`;
    })
    .join(" ");

  const area = [
    `M ${padding} ${height - padding}`,
    ...dailyPoints.map((point, index) => {
      const x = padding + (index / Math.max(dailyPoints.length - 1, 1)) * (width - padding * 2);
      const y = height - padding - ((point.equity - min) / span) * (height - padding * 2);
      return `L ${x} ${y}`;
    }),
    `L ${width - padding} ${height - padding}`,
    "Z",
  ].join(" ");

  const first = dailyPoints[0]?.equity ?? 0;
  const lastPoint = dailyPoints[dailyPoints.length - 1];
  const last = lastPoint?.equity ?? 0;
  const direction = last >= first ? "up" : "down";
  const activeHoverIndex = hoverIndex == null ? dailyPoints.length - 1 : Math.min(hoverIndex, dailyPoints.length - 1);
  const activePoint = dailyPoints[activeHoverIndex];
  const activeX = padding + (activeHoverIndex / Math.max(dailyPoints.length - 1, 1)) * (width - padding * 2);
  const activeY = height - padding - ((activePoint.equity - min) / span) * (height - padding * 2);
  const showTooltip = hoverIndex != null;

  return (
    <div className="equity-chart">
      <div className="equity-summary">
        <div>
          <div className="muted">Start</div>
          <div className="value">{formatNumber(first)}</div>
        </div>
        <div>
          <div className="muted">Latest</div>
          <div className={`value ${direction}`}>{formatNumber(last)}</div>
        </div>
      </div>
      <div
        className="equity-plot"
        onPointerLeave={() => setHoverIndex(null)}
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
          setHoverIndex(Math.round(ratio * (dailyPoints.length - 1)));
        }}
      >
        <svg viewBox={`0 0 ${width} ${height}`} className="equity-svg" role="img" aria-label="Equity curve">
          <defs>
            <linearGradient id="equityFill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="rgba(220, 38, 38, 0.35)" />
              <stop offset="100%" stopColor="rgba(220, 38, 38, 0.02)" />
            </linearGradient>
          </defs>
          <path d={area} fill="url(#equityFill)" />
          <polyline points={polyline} fill="none" stroke="#dc2626" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
          {showTooltip ? <line x1={activeX} x2={activeX} y1={padding} y2={height - padding} className="equity-crosshair" /> : null}
          {showTooltip ? <circle cx={activeX} cy={activeY} r="4.5" fill="#dc2626" stroke="#fff" strokeWidth="2" /> : null}
        </svg>
        <div className={`equity-tooltip ${showTooltip ? "visible" : ""}`} style={{ left: `${activeX}px`, top: `${activeY}px` }}>
          <div>{formatLongDate(activePoint.time)}</div>
          <div>{formatNumber(activePoint.equity)} USDT</div>
        </div>
      </div>
      <div className="chart-footnote">
        <span>{formatLongDate(normalizeTimeMs(dailyPoints[0].time))}</span>
        <span>{formatLongDate(normalizeTimeMs(lastPoint?.time ?? dailyPoints[0].time))}</span>
      </div>
    </div>
  );
}

function TradeTable({ trades }: { trades: BacktestTrade[] }) {
  if (!trades.length) {
    return <div className="empty-state">Trade fills will appear here after a backtest.</div>;
  }

  return (
    <div className="trade-table-wrap trade-log-wrap">
      <table className="trade-table">
        <thead>
          <tr>
            <th>Entry</th>
            <th>Exit</th>
            <th>Side</th>
            <th>PnL</th>
            <th>Return</th>
          </tr>
        </thead>
        <tbody>
          {trades
            .slice()
            .reverse()
            .map((trade, index) => (
              <tr key={`${trade.entry_time}-${trade.exit_time}-${index}`}>
                <td>{formatTradeTime(trade.entry_time)}</td>
                <td>{formatTradeTime(trade.exit_time)}</td>
                <td>
                  <span className={`trade-chip ${trade.side.toLowerCase() === "long" || trade.side.toLowerCase() === "buy" ? "good" : "bad"}`}>
                    {trade.side}
                  </span>
                </td>
                <td className={trade.pnl >= 0 ? "good" : "bad"}>{formatNumber(trade.pnl)}</td>
                <td className={trade.return_pct >= 0 ? "good" : "bad"}>{formatNumber(trade.return_pct)}%</td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

function ComparisonTable({
  rows,
  activeInterval,
}: {
  rows: TimeframeComparisonRow[];
  activeInterval: string;
}) {
  if (!rows.length) {
    return <div className="empty-state">Run a backtest to compare timeframe returns.</div>;
  }

  const ordered = [...rows].sort((a, b) => {
    if (a.interval === activeInterval) return -1;
    if (b.interval === activeInterval) return 1;
    return COMPARISON_INTERVALS.indexOf(a.interval) - COMPARISON_INTERVALS.indexOf(b.interval);
  });

  return (
    <div className="trade-table-wrap table-static-wrap">
      <table className="trade-table comparison-table">
        <thead>
          <tr>
            <th>Timeframe</th>
            <th>Return</th>
            <th>Final Equity (USDT)</th>
            <th>Fees (USDT)</th>
            <th>Trades</th>
            <th>Win Rate</th>
            <th>Score</th>
            <th>Max DD</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((row) => (
            <tr key={row.interval} className={row.interval === activeInterval ? "active-row" : ""}>
              <td>
                <span className="trade-chip time-frame">{row.interval}</span>
              </td>
              <td className={row.stats.total_return_pct >= 0 ? "good" : "bad"}>{formatNumber(row.stats.total_return_pct)}%</td>
              <td>{formatNumber(row.stats.final_equity)}</td>
              <td>{formatNumber(row.stats.total_fees)}</td>
              <td>{row.stats.total_trades}</td>
              <td>{formatNumber(row.stats.win_rate)}%</td>
              <td>{formatNumber(row.stats.score)}</td>
              <td>{formatNumber(row.stats.max_drawdown)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StopSensitivityTable({
  rows,
  activeStop,
}: {
  rows: StopSensitivityRow[];
  activeStop: number;
}) {
  if (!rows.length) {
    return <div className="empty-state">Run a backtest to compare stop-loss settings.</div>;
  }

  const ordered = [...rows].sort((a, b) => a.stopLossAtrMult - b.stopLossAtrMult);

  return (
    <div className="trade-table-wrap table-static-wrap">
      <table className="trade-table comparison-table">
        <thead>
          <tr>
            <th>Stop ATR</th>
            <th>Return</th>
            <th>Final Equity (USDT)</th>
            <th>Fees (USDT)</th>
            <th>Trades</th>
            <th>Win Rate</th>
            <th>Score</th>
            <th>Max DD</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((row) => (
            <tr key={row.stopLossAtrMult} className={row.stopLossAtrMult === activeStop ? "active-row" : ""}>
              <td>
                <span className="trade-chip time-frame">{row.stopLossAtrMult.toFixed(2)}x</span>
              </td>
              <td className={row.stats.total_return_pct >= 0 ? "good" : "bad"}>{formatNumber(row.stats.total_return_pct)}%</td>
              <td>{formatNumber(row.stats.final_equity)}</td>
              <td>{formatNumber(row.stats.total_fees)}</td>
              <td>{row.stats.total_trades}</td>
              <td>{formatNumber(row.stats.win_rate)}%</td>
              <td>{formatNumber(row.stats.score)}</td>
              <td>{formatNumber(row.stats.max_drawdown)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HeatmapTable({
  cells,
  activeInterval,
  activeStop,
}: {
  cells: HeatmapCell[];
  activeInterval: string;
  activeStop: number;
}) {
  if (!cells.length) {
    return <div className="empty-state">Run a backtest to generate the heat map.</div>;
  }

  const rows = COMPARISON_INTERVALS;
  const cols = STOP_MULTIPLIERS;
  const cellMap = new Map(cells.map((cell) => [`${cell.interval}:${cell.stopLossAtrMult}`, cell]));
  const values = cells.map((cell) => cell.stats.total_return_pct);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;

  function cellClass(value: number) {
    if (value >= 0) {
      return "heat-cell gain";
    }
    return "heat-cell loss";
  }

  function intensity(value: number) {
    const normalized = (value - min) / span;
    return 0.12 + normalized * 0.3;
  }

  return (
    <div className="trade-table-wrap heatmap-wrap">
      <table className="trade-table heatmap-table">
        <thead>
          <tr>
            <th>Timeframe</th>
            {cols.map((stop) => (
              <th key={stop}>{stop.toFixed(2)}x</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((intervalRow) => (
            <tr key={intervalRow} className={intervalRow === activeInterval ? "active-row" : ""}>
              <td>
                <span className="trade-chip time-frame">{intervalRow}</span>
              </td>
              {cols.map((stop) => {
                const cell = cellMap.get(`${intervalRow}:${stop}`);
                if (!cell) {
                  return <td key={stop} className="heat-empty">-</td>;
                }
                const active = intervalRow === activeInterval && stop === activeStop;
                const backgroundOpacity = intensity(cell.stats.total_return_pct);
                return (
                  <td
                    key={stop}
                    className={`${cellClass(cell.stats.total_return_pct)} ${active ? "active-cell" : ""}`}
                    style={{
                      backgroundColor:
                        cell.stats.total_return_pct >= 0
                          ? `rgba(15, 157, 88, ${backgroundOpacity})`
                          : `rgba(215, 38, 61, ${backgroundOpacity})`,
                    }}
                  >
                    <div className="heat-value">{formatNumber(cell.stats.total_return_pct)}%</div>
                    <div className="heat-meta">{formatNumber(cell.stats.final_equity)} USDT</div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AnalysisHeatmapTable({
  cells,
  activeInterval,
  activeRange,
}: {
  cells: AnalysisHeatmapCell[];
  activeInterval: string;
  activeRange: HistoryRange;
}) {
  if (!cells.length) {
    return <div className="empty-state">Run a backtest to compare periods and timeframe robustness.</div>;
  }

  const rows = COMPARISON_INTERVALS;
  const cols = HISTORY_OPTIONS.map((option) => option.value);
  const cellMap = new Map(cells.map((cell) => [`${cell.interval}:${cell.historyRange}`, cell]));
  const values = cells.map((cell) => cell.stats.score);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;

  function intensity(value: number) {
    const normalized = (value - min) / span;
    return 0.12 + normalized * 0.32;
  }

  function scoreClass(value: number) {
    if (value >= 70) {
      return "heat-cell gain";
    }
    if (value >= 45) {
      return "heat-cell neutral";
    }
    return "heat-cell loss";
  }

  return (
    <div className="trade-table-wrap heatmap-wrap">
      <table className="trade-table heatmap-table">
        <thead>
          <tr>
            <th>Timeframe</th>
            {cols.map((range) => (
              <th key={range}>{HISTORY_OPTIONS.find((option) => option.value === range)?.label ?? range}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((intervalRow) => (
            <tr key={intervalRow} className={intervalRow === activeInterval ? "active-row" : ""}>
              <td>
                <span className="trade-chip time-frame">{intervalRow}</span>
              </td>
              {cols.map((range) => {
                const cell = cellMap.get(`${intervalRow}:${range}`);
                if (!cell) {
                  return <td key={range} className="heat-empty">-</td>;
                }
                const active = intervalRow === activeInterval && range === activeRange;
                const backgroundOpacity = intensity(cell.stats.score);
                return (
                  <td
                    key={range}
                    className={`${scoreClass(cell.stats.score)} ${active ? "active-cell" : ""}`}
                    style={{
                      backgroundColor:
                        cell.stats.score >= 50
                          ? `rgba(15, 157, 88, ${backgroundOpacity})`
                          : `rgba(215, 38, 61, ${backgroundOpacity})`,
                    }}
                  >
                    <div className="heat-value">{formatNumber(cell.stats.score)}</div>
                    <div className="heat-meta">{formatNumber(cell.stats.total_return_pct)}%</div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
