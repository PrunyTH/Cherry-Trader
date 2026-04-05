from pydantic import BaseModel, Field


class StrategyParams(BaseModel):
    fast_ema: int = Field(default=12, ge=2, le=200)
    slow_ema: int = Field(default=26, ge=3, le=400)


class BacktestRequest(BaseModel):
    symbol: str = "BTCUSDT"
    interval: str = "1m"
    lookback_days: int = Field(default=365, ge=7, le=3650)
    capital: float = Field(default=1000.0, ge=10.0, le=10_000_000.0)
    leverage: float = Field(default=1.0, ge=1.0, le=3.0)
    stop_loss_atr_mult: float = Field(default=1.5, ge=0.5, le=10.0)


class Candle(BaseModel):
    symbol: str
    interval: str
    open_time: int
    close_time: int
    open: float
    high: float
    low: float
    close: float
    volume: float
    is_closed: bool = False


class Signal(BaseModel):
    symbol: str
    interval: str
    ts: int
    side: str
    price: float
    fast_ema: float
    slow_ema: float
    reason: str
