from dataclasses import dataclass
import os

from dotenv import load_dotenv


load_dotenv()


@dataclass(frozen=True)
class Settings:
    app_name: str = os.getenv("APP_NAME", "Cherry Trader")
    database_path: str = os.getenv("DATABASE_PATH", "./data/cherry-trader.sqlite3")
    binance_rest_base: str = os.getenv("BINANCE_REST_BASE", "https://api.binance.com")
    binance_ws_base: str = os.getenv("BINANCE_WS_BASE", "wss://stream.binance.com:9443")
    default_symbol: str = os.getenv("DEFAULT_SYMBOL", "BTCUSDT")
    default_interval: str = os.getenv("DEFAULT_INTERVAL", "15m")
    frontend_origin: str = os.getenv("FRONTEND_ORIGIN", "http://127.0.0.1:3000")
    frontend_origin_alt: str = os.getenv("FRONTEND_ORIGIN_ALT", "http://localhost:3000")


settings = Settings()
