import json
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable

from .config import settings


DB_PATH = Path(settings.database_path)
DB_LOCK = threading.Lock()


def get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=30)
    conn.execute("PRAGMA busy_timeout = 30000")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.row_factory = sqlite3.Row
    return conn


@contextmanager
def db_cursor():
    with DB_LOCK:
        conn = get_connection()
        try:
            yield conn.cursor(), conn
            conn.commit()
        finally:
            conn.close()


def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with db_cursor() as (cur, _):
        cur.executescript(
            """
            CREATE TABLE IF NOT EXISTS candles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol TEXT NOT NULL,
                interval TEXT NOT NULL,
                open_time INTEGER NOT NULL,
                close_time INTEGER NOT NULL,
                open REAL NOT NULL,
                high REAL NOT NULL,
                low REAL NOT NULL,
                close REAL NOT NULL,
                volume REAL NOT NULL,
                is_closed INTEGER NOT NULL DEFAULT 0,
                UNIQUE(symbol, interval, open_time)
            );

            CREATE TABLE IF NOT EXISTS signals (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol TEXT NOT NULL,
                interval TEXT NOT NULL,
                ts INTEGER NOT NULL,
                side TEXT NOT NULL,
                price REAL NOT NULL,
                fast_ema REAL NOT NULL,
                slow_ema REAL NOT NULL,
                reason TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS strategy_settings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol TEXT NOT NULL,
                interval TEXT NOT NULL,
                name TEXT NOT NULL,
                value TEXT NOT NULL,
                UNIQUE(symbol, interval, name)
            );

            CREATE TABLE IF NOT EXISTS runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol TEXT NOT NULL,
                interval TEXT NOT NULL,
                strategy TEXT NOT NULL,
                params_json TEXT NOT NULL,
                started_at INTEGER NOT NULL,
                finished_at INTEGER,
                total_trades INTEGER NOT NULL DEFAULT 0,
                win_rate REAL NOT NULL DEFAULT 0,
                pnl REAL NOT NULL DEFAULT 0,
                max_drawdown REAL NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS trades (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id INTEGER NOT NULL,
                symbol TEXT NOT NULL,
                interval TEXT NOT NULL,
                side TEXT NOT NULL,
                entry_time INTEGER NOT NULL,
                exit_time INTEGER NOT NULL,
                entry_price REAL NOT NULL,
                exit_price REAL NOT NULL,
                pnl REAL NOT NULL,
                FOREIGN KEY(run_id) REFERENCES runs(id)
            );

            CREATE TABLE IF NOT EXISTS strategy_versions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                strategy_name TEXT NOT NULL,
                strategy_label TEXT NOT NULL,
                git_commit TEXT NOT NULL,
                params_json TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_strategy_versions_unique
                ON strategy_versions(strategy_name, git_commit, params_json);

            CREATE TABLE IF NOT EXISTS backtest_bundles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                version_id INTEGER NOT NULL,
                symbol TEXT NOT NULL,
                interval TEXT NOT NULL,
                lookback_days INTEGER NOT NULL,
                capital REAL NOT NULL,
                leverage REAL NOT NULL,
                stop_loss_atr_mult REAL NOT NULL,
                comparison_intervals_json TEXT NOT NULL,
                stop_multipliers_json TEXT NOT NULL,
                analysis_ranges_json TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                FOREIGN KEY(version_id) REFERENCES strategy_versions(id)
            );

            CREATE TABLE IF NOT EXISTS backtest_evaluations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                bundle_id INTEGER NOT NULL,
                version_id INTEGER NOT NULL,
                symbol TEXT NOT NULL,
                interval TEXT NOT NULL,
                history_range TEXT NOT NULL,
                stop_loss_atr_mult REAL NOT NULL,
                run_kind TEXT NOT NULL,
                total_return_pct REAL NOT NULL,
                final_equity REAL NOT NULL,
                total_trades INTEGER NOT NULL,
                win_rate REAL NOT NULL,
                pnl REAL NOT NULL,
                total_fees REAL NOT NULL,
                max_drawdown REAL NOT NULL,
                score REAL NOT NULL,
                params_json TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                FOREIGN KEY(bundle_id) REFERENCES backtest_bundles(id),
                FOREIGN KEY(version_id) REFERENCES strategy_versions(id)
            );

            CREATE INDEX IF NOT EXISTS idx_backtest_bundles_version
                ON backtest_bundles(version_id);

            CREATE INDEX IF NOT EXISTS idx_backtest_evaluations_bundle
                ON backtest_evaluations(bundle_id);

            CREATE INDEX IF NOT EXISTS idx_backtest_evaluations_version
                ON backtest_evaluations(version_id);
            """
        )


def upsert_candle(candle: dict[str, Any]) -> None:
    with db_cursor() as (cur, _):
        cur.execute(
            """
            INSERT INTO candles (
                symbol, interval, open_time, close_time, open, high, low, close, volume, is_closed
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(symbol, interval, open_time) DO UPDATE SET
                close_time=excluded.close_time,
                open=excluded.open,
                high=excluded.high,
                low=excluded.low,
                close=excluded.close,
                volume=excluded.volume,
                is_closed=excluded.is_closed
            """,
            (
                candle["symbol"],
                candle["interval"],
                candle["open_time"],
                candle["close_time"],
                candle["open"],
                candle["high"],
                candle["low"],
                candle["close"],
                candle["volume"],
                1 if candle["is_closed"] else 0,
            ),
        )


def insert_signal(signal: dict[str, Any]) -> None:
    with db_cursor() as (cur, _):
        cur.execute(
            """
            INSERT INTO signals (symbol, interval, ts, side, price, fast_ema, slow_ema, reason)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                signal["symbol"],
                signal["interval"],
                signal["ts"],
                signal["side"],
                signal["price"],
                signal["fast_ema"],
                signal["slow_ema"],
                signal["reason"],
            ),
        )


def get_candles(symbol: str, interval: str, limit: int = 500) -> list[dict[str, Any]]:
    with db_cursor() as (cur, _):
        rows = cur.execute(
            """
            SELECT symbol, interval, open_time, close_time, open, high, low, close, volume, is_closed
            FROM candles
            WHERE symbol = ? AND interval = ?
            ORDER BY open_time DESC
            LIMIT ?
            """,
            (symbol, interval, limit),
        ).fetchall()
    candles = [dict(row) for row in reversed(rows)]
    for candle in candles:
        candle["is_closed"] = bool(candle["is_closed"])
    return candles


def get_candle_count(symbol: str, interval: str) -> int:
    with db_cursor() as (cur, _):
        row = cur.execute(
            """
            SELECT COUNT(*) AS count
            FROM candles
            WHERE symbol = ? AND interval = ?
            """,
            (symbol, interval),
        ).fetchone()
    return int(row["count"]) if row else 0


def get_oldest_closed_candle_time(symbol: str, interval: str) -> int | None:
    with db_cursor() as (cur, _):
        row = cur.execute(
            """
            SELECT open_time
            FROM candles
            WHERE symbol = ? AND interval = ? AND is_closed = 1
            ORDER BY open_time ASC
            LIMIT 1
            """,
            (symbol, interval),
        ).fetchone()
    return int(row["open_time"]) if row else None


def get_newest_closed_candle_time(symbol: str, interval: str) -> int | None:
    with db_cursor() as (cur, _):
        row = cur.execute(
            """
            SELECT open_time
            FROM candles
            WHERE symbol = ? AND interval = ? AND is_closed = 1
            ORDER BY open_time DESC
            LIMIT 1
            """,
            (symbol, interval),
        ).fetchone()
    return int(row["open_time"]) if row else None


def get_all_closed_candles(symbol: str, interval: str) -> list[dict[str, Any]]:
    with db_cursor() as (cur, _):
        rows = cur.execute(
            """
            SELECT symbol, interval, open_time, close_time, open, high, low, close, volume, is_closed
            FROM candles
            WHERE symbol = ? AND interval = ? AND is_closed = 1
            ORDER BY open_time ASC
            """,
            (symbol, interval),
        ).fetchall()
    candles = [dict(row) for row in rows]
    for candle in candles:
        candle["is_closed"] = True
    return candles


def get_signals(symbol: str, interval: str, limit: int = 200) -> list[dict[str, Any]]:
    with db_cursor() as (cur, _):
        rows = cur.execute(
            """
            SELECT symbol, interval, ts, side, price, fast_ema, slow_ema, reason
            FROM signals
            WHERE symbol = ? AND interval = ?
            ORDER BY ts DESC
            LIMIT ?
            """,
            (symbol, interval, limit),
        ).fetchall()
    return [dict(row) for row in reversed(rows)]


def get_strategy_setting(symbol: str, interval: str, name: str, default: str) -> str:
    with db_cursor() as (cur, _):
        row = cur.execute(
            """
            SELECT value
            FROM strategy_settings
            WHERE symbol = ? AND interval = ? AND name = ?
            """,
            (symbol, interval, name),
        ).fetchone()
    return row["value"] if row else default


def set_strategy_setting(symbol: str, interval: str, name: str, value: str) -> None:
    with db_cursor() as (cur, _):
        cur.execute(
            """
            INSERT INTO strategy_settings (symbol, interval, name, value)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(symbol, interval, name) DO UPDATE SET value=excluded.value
            """,
            (symbol, interval, name, value),
        )


def create_run(symbol: str, interval: str, strategy: str, params_json: str, started_at: int) -> int:
    with db_cursor() as (cur, _):
        cur.execute(
            """
            INSERT INTO runs (symbol, interval, strategy, params_json, started_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (symbol, interval, strategy, params_json, started_at),
        )
        return int(cur.lastrowid)


def finish_run(run_id: int, total_trades: int, win_rate: float, pnl: float, max_drawdown: float, finished_at: int) -> None:
    with db_cursor() as (cur, _):
        cur.execute(
            """
            UPDATE runs
            SET total_trades = ?, win_rate = ?, pnl = ?, max_drawdown = ?, finished_at = ?
            WHERE id = ?
            """,
            (total_trades, win_rate, pnl, max_drawdown, finished_at, run_id),
        )


def insert_trades(run_id: int, symbol: str, interval: str, trades: Iterable[dict[str, Any]]) -> None:
    with db_cursor() as (cur, _):
        cur.executemany(
            """
            INSERT INTO trades (
                run_id, symbol, interval, side, entry_time, exit_time, entry_price, exit_price, pnl
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    run_id,
                    symbol,
                    interval,
                    trade["side"],
                    trade["entry_time"],
                    trade["exit_time"],
                    trade["entry_price"],
                    trade["exit_price"],
                    trade["pnl"],
                )
                for trade in trades
            ],
        )


def insert_strategy_version(strategy_name: str, strategy_label: str, git_commit: str, params_json: str, created_at: int) -> int:
    with db_cursor() as (cur, _):
        cur.execute(
            """
            INSERT OR IGNORE INTO strategy_versions (strategy_name, strategy_label, git_commit, params_json, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (strategy_name, strategy_label, git_commit, params_json, created_at),
        )
        row = cur.execute(
            """
            SELECT id
            FROM strategy_versions
            WHERE strategy_name = ? AND git_commit = ? AND params_json = ?
            """,
            (strategy_name, git_commit, params_json),
        ).fetchone()
        return int(row["id"]) if row else int(cur.lastrowid)


def insert_backtest_bundle(
    version_id: int,
    symbol: str,
    interval: str,
    lookback_days: int,
    capital: float,
    leverage: float,
    stop_loss_atr_mult: float,
    comparison_intervals_json: str,
    stop_multipliers_json: str,
    analysis_ranges_json: str,
    created_at: int,
) -> int:
    with db_cursor() as (cur, _):
        cur.execute(
            """
            INSERT INTO backtest_bundles (
                version_id, symbol, interval, lookback_days, capital, leverage, stop_loss_atr_mult,
                comparison_intervals_json, stop_multipliers_json, analysis_ranges_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                version_id,
                symbol,
                interval,
                lookback_days,
                capital,
                leverage,
                stop_loss_atr_mult,
                comparison_intervals_json,
                stop_multipliers_json,
                analysis_ranges_json,
                created_at,
            ),
        )
        return int(cur.lastrowid)


def insert_backtest_evaluations(rows: Iterable[dict[str, Any]]) -> None:
    payload = list(rows)
    if not payload:
        return
    with db_cursor() as (cur, _):
        cur.executemany(
            """
            INSERT INTO backtest_evaluations (
                bundle_id, version_id, symbol, interval, history_range, stop_loss_atr_mult, run_kind,
                total_return_pct, final_equity, total_trades, win_rate, pnl, total_fees, max_drawdown,
                score, params_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    row["bundle_id"],
                    row["version_id"],
                    row["symbol"],
                    row["interval"],
                    row["history_range"],
                    row["stop_loss_atr_mult"],
                    row["run_kind"],
                    row["total_return_pct"],
                    row["final_equity"],
                    row["total_trades"],
                    row["win_rate"],
                    row["pnl"],
                    row["total_fees"],
                    row["max_drawdown"],
                    row["score"],
                    row["params_json"],
                    row["created_at"],
                )
                for row in payload
            ],
        )
