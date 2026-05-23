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


def get_fx_rate_spot(from_ccy: str, to_ccy: str) -> float | None:
    """Get a spot FX rate via yfinance. Returns rate such that `value_in_from * rate = value_in_to`.
       Returns None if FX pair not found."""
    if from_ccy == to_ccy:
        return 1.0
    pair = f"{from_ccy}{to_ccy}=X"
    try:
        t = yf.Ticker(pair)
        info = t.info
        rate = info.get("regularMarketPrice") or info.get("previousClose")
        if rate is None:
            # Fallback to 1-day history
            h = t.history(period="5d")
            if h is None or h.empty:
                return None
            rate = float(h["Close"].iloc[-1])
        return float(rate) if rate else None
    except Exception:
        return None


def fetch_snapshot(ticker: str) -> dict:
    t = yf.Ticker(ticker)
    info = t.info
    if not info or not info.get("symbol"):
        fail(f"Ticker not found: {ticker}", "NotFound")

    listing_ccy = info.get("currency", "USD")
    financial_ccy = info.get("financialCurrency", listing_ccy)

    market_cap = num_or_none(info.get("marketCap"))
    pe = num_or_none(info.get("trailingPE"))
    ps_raw = num_or_none(info.get("priceToSalesTrailing12Months"))
    pb_raw = num_or_none(info.get("priceToBook"))

    # Currency-correct P/S and P/B when financial currency differs from listing currency.
    # yfinance returns market_cap in listing currency but revenue/book in financial currency,
    # so its pre-computed P/S and P/B are USD/<other>=garbage. Recompute using FX.
    ps = ps_raw
    pb = pb_raw
    if listing_ccy != financial_ccy:
        fx = get_fx_rate_spot(financial_ccy, listing_ccy)
        revenue_fc = num_or_none(info.get("totalRevenue"))
        book_value_fc = num_or_none(info.get("bookValue"))  # per-share
        shares = num_or_none(info.get("sharesOutstanding"))

        if fx and market_cap and revenue_fc and revenue_fc > 0:
            revenue_lc = revenue_fc * fx
            ps = market_cap / revenue_lc
        else:
            ps = None  # honest null rather than garbage

        if fx and market_cap and book_value_fc and shares and book_value_fc > 0:
            book_value_total_fc = book_value_fc * shares
            book_value_total_lc = book_value_total_fc * fx
            pb = market_cap / book_value_total_lc
        else:
            pb = None

    return {
        "ticker": ticker,
        "price": num_or_none(info.get("currentPrice") or info.get("regularMarketPrice")),
        "marketCap": market_cap,
        "week52High": num_or_none(info.get("fiftyTwoWeekHigh")),
        "week52Low": num_or_none(info.get("fiftyTwoWeekLow")),
        "pe": pe if (pe is None or pe > 0) else None,
        "ps": ps,
        "pb": pb,
        "evEbitda": num_or_none(info.get("enterpriseToEbitda")),  # safe: both EV and EBITDA in financial ccy
        "peg": num_or_none(info.get("pegRatio")),                 # safe: growth pct is dimensionless
        "asOf": datetime.utcnow().isoformat() + "Z",
        "financialCurrency": financial_ccy,
        "listingCurrency": listing_ccy
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
