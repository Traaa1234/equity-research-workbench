#!/usr/bin/env python3
"""
yfinance fallback fetcher. Invoked by lib/providers/yfinance.ts.

Usage: python yfinance_fetch.py <ticker> <kind>
  kind: company | snapshot | prices_1y | prices_5y | earnings

Output: a single JSON object on stdout. Exit code 0 on success, 1 on failure
(with `{ "error": "...", "kind": "<NotFound|Provider|Validation|Unknown>" }`).
"""
import json
import sys
from datetime import datetime, timedelta

try:
    import yfinance as yf
except ImportError as e:
    print(json.dumps({"error": f"yfinance not installed: {e}", "kind": "Provider"}))
    sys.exit(1)


def fail(msg: str, kind: str = "Unknown"):
    print(json.dumps({"error": msg, "kind": kind}))
    sys.exit(1)


def num_or_none(v):
    try:
        f = float(v)
        if f != f or f in (float("inf"), float("-inf")):
            return None
        return f
    except (TypeError, ValueError):
        return None


def fetch_company(ticker: str) -> dict:
    t = yf.Ticker(ticker)
    info = t.info
    if not info or not info.get("symbol"):
        fail(f"Ticker not found: {ticker}", "NotFound")
    return {
        "ticker": ticker,
        "name": info.get("longName") or info.get("shortName") or ticker,
        "cik": None,
        "exchange": info.get("exchange"),
        "sector": info.get("sector"),
        "industry": info.get("industry"),
    }


def fetch_snapshot(ticker: str) -> dict:
    t = yf.Ticker(ticker)
    info = t.info
    if not info or not info.get("symbol"):
        fail(f"Ticker not found: {ticker}", "NotFound")

    pe = num_or_none(info.get("trailingPE"))
    return {
        "ticker": ticker,
        "price": num_or_none(info.get("currentPrice") or info.get("regularMarketPrice")),
        "marketCap": num_or_none(info.get("marketCap")),
        "week52High": num_or_none(info.get("fiftyTwoWeekHigh")),
        "week52Low": num_or_none(info.get("fiftyTwoWeekLow")),
        "pe": pe if (pe is None or pe > 0) else None,
        "ps": num_or_none(info.get("priceToSalesTrailing12Months")),
        "pb": num_or_none(info.get("priceToBook")),
        "evEbitda": num_or_none(info.get("enterpriseToEbitda")),
        "peg": num_or_none(info.get("pegRatio")),
        "asOf": datetime.utcnow().isoformat() + "Z",
    }


def fetch_prices(ticker: str, years: int) -> dict:
    t = yf.Ticker(ticker)
    end = datetime.utcnow().date()
    start = end - timedelta(days=365 * years)
    hist = t.history(start=start.isoformat(), end=end.isoformat(), interval="1d")
    if hist is None or hist.empty:
        return {"prices": []}
    rows = []
    for date, row in hist.iterrows():
        rows.append({
            "date": date.strftime("%Y-%m-%d"),
            "open": num_or_none(row.get("Open")),
            "high": num_or_none(row.get("High")),
            "low": num_or_none(row.get("Low")),
            "close": num_or_none(row.get("Close")) or 0,
            "adjClose": num_or_none(row.get("Close")),
            "volume": int(row.get("Volume")) if row.get("Volume") else None,
        })
    return {"prices": rows}


def fetch_earnings(ticker: str) -> dict:
    t = yf.Ticker(ticker)
    df = t.earnings_history
    if df is None or df.empty:
        return {"earnings": []}
    out = []
    for _, row in df.iterrows():
        out.append({
            "periodEnd": str(row.get("quarter", ""))[:10] or None,
            "reportedDate": None,
            "epsActual": num_or_none(row.get("epsActual")),
            "price1dPct": None,
            "price5dPct": None,
        })
    return {"earnings": out}


def main():
    if len(sys.argv) < 3:
        fail("Usage: yfinance_fetch.py <ticker> <kind>", "Validation")
    ticker = sys.argv[1].upper()
    kind = sys.argv[2]

    try:
        if kind == "company":
            print(json.dumps(fetch_company(ticker)))
        elif kind == "snapshot":
            print(json.dumps(fetch_snapshot(ticker)))
        elif kind == "prices_1y":
            print(json.dumps(fetch_prices(ticker, 1)))
        elif kind == "prices_5y":
            print(json.dumps(fetch_prices(ticker, 5)))
        elif kind == "earnings":
            print(json.dumps(fetch_earnings(ticker)))
        else:
            fail(f"Unknown kind: {kind}", "Validation")
    except SystemExit:
        raise
    except Exception as e:
        fail(f"{type(e).__name__}: {e}", "Provider")


if __name__ == "__main__":
    main()
