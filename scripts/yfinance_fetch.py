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


def get_fx_rate_history(from_ccy: str, to_ccy: str, period_ends: list[str]) -> dict:
    """Return a dict mapping period_end (YYYY-MM-DD string) -> FX rate.
       Uses daily history from yfinance and picks the nearest available date for each period_end."""
    if from_ccy == to_ccy:
        return {pe: 1.0 for pe in period_ends}
    if not period_ends:
        return {}
    pair = f"{from_ccy}{to_ccy}=X"
    try:
        t = yf.Ticker(pair)
        # Get enough history to cover all period_ends with margin.
        earliest = min(period_ends)
        latest = max(period_ends)
        from_date = datetime.fromisoformat(earliest).date() - timedelta(days=30)
        to_date = datetime.fromisoformat(latest).date() + timedelta(days=30)
        hist = t.history(start=from_date.isoformat(), end=to_date.isoformat(), interval="1d")
        if hist is None or hist.empty:
            return {pe: None for pe in period_ends}
        # For each period_end, find the closest available date.
        result = {}
        hist_dates = [d.strftime("%Y-%m-%d") for d in hist.index]
        for pe in period_ends:
            best = None
            best_delta = None
            pe_ms = datetime.fromisoformat(pe).timestamp()
            for hd, close in zip(hist_dates, hist["Close"]):
                delta = abs(datetime.fromisoformat(hd).timestamp() - pe_ms)
                if best_delta is None or delta < best_delta:
                    best_delta = delta
                    best = float(close)
            result[pe] = best
        return result
    except Exception:
        return {pe: None for pe in period_ends}


# Mapping from yfinance row index names -> our normalized line_item names.
# yfinance uses Title-Case names; we use snake_case.
INCOME_MAP = {
    "Total Revenue": "revenue",
    "Cost Of Revenue": "cost_of_revenue",
    "Gross Profit": "gross_profit",
    "Operating Expense": "operating_expense",
    "Operating Income": "operating_income",
    "Net Income": "net_income",
    "Net Income Common Stockholders": "net_income",
    "Basic EPS": "earnings_per_share",
    "Diluted EPS": "earnings_per_share",
}

BALANCE_MAP = {
    "Total Assets": "total_assets",
    "Total Liabilities Net Minority Interest": "total_liabilities",
    "Total Liab": "total_liabilities",
    "Stockholders Equity": "total_equity",
    "Total Stockholder Equity": "total_equity",
    "Cash And Cash Equivalents": "cash_and_equivalents",
    "Cash Cash Equivalents And Short Term Investments": "cash_and_equivalents",
    "Long Term Debt": "long_term_debt",
    "Current Debt": "short_term_debt",
    "Short Long Term Debt": "short_term_debt",
}

CASH_FLOW_MAP = {
    "Operating Cash Flow": "operating_cash_flow",
    "Total Cash From Operating Activities": "operating_cash_flow",
    "Investing Cash Flow": "investing_cash_flow",
    "Total Cashflows From Investing Activities": "investing_cash_flow",
    "Financing Cash Flow": "financing_cash_flow",
    "Total Cash From Financing Activities": "financing_cash_flow",
    "Capital Expenditure": "capital_expenditure",
    "Capital Expenditures": "capital_expenditure",
    "Free Cash Flow": "free_cash_flow",
}


def _statements_from_df(df, mapping: dict, fx_by_period: dict) -> list:
    """Pivot a yfinance statements DataFrame (rows=line items, cols=periods) to our row format."""
    if df is None or df.empty:
        return []
    rows = []
    period_cols = list(df.columns)
    for yf_name, our_name in mapping.items():
        if yf_name not in df.index:
            continue
        series = df.loc[yf_name]
        for period_col in period_cols:
            period_end = period_col.strftime("%Y-%m-%d") if hasattr(period_col, "strftime") else str(period_col)[:10]
            raw = series.get(period_col)
            value = num_or_none(raw)
            if value is None:
                continue
            fx = fx_by_period.get(period_end)
            if fx is not None and fx > 0:
                value = value * fx
                rows.append({
                    "periodEnd": period_end,
                    "lineItem": our_name,
                    "value": value,
                    "currency": "USD"
                })
    return rows


def fetch_statements(ticker: str, kind: str, period: str) -> dict:
    """kind: 'income' | 'balance' | 'cash_flow'.   period: 'annual' | 'quarterly'."""
    t = yf.Ticker(ticker)
    info = t.info
    if not info or not info.get("symbol"):
        fail(f"Ticker not found: {ticker}", "NotFound")

    listing_ccy = info.get("currency", "USD")
    financial_ccy = info.get("financialCurrency", listing_ccy)

    # Pick the right DataFrame attribute.
    df_attrs = {
        ("income", "annual"): "income_stmt",
        ("income", "quarterly"): "quarterly_income_stmt",
        ("balance", "annual"): "balance_sheet",
        ("balance", "quarterly"): "quarterly_balance_sheet",
        ("cash_flow", "annual"): "cashflow",
        ("cash_flow", "quarterly"): "quarterly_cashflow",
    }
    attr = df_attrs.get((kind, period))
    if not attr:
        fail(f"Unknown statements kind/period: {kind}/{period}", "Validation")
    df = getattr(t, attr, None)
    if df is None or df.empty:
        return {"ticker": ticker, "statementType": kind, "periodType": period, "rows": []}

    mappings = {"income": INCOME_MAP, "balance": BALANCE_MAP, "cash_flow": CASH_FLOW_MAP}
    mapping = mappings[kind]

    # Period_end strings for FX lookup.
    period_ends = []
    for col in df.columns:
        pe = col.strftime("%Y-%m-%d") if hasattr(col, "strftime") else str(col)[:10]
        period_ends.append(pe)
    fx_by_period = get_fx_rate_history(financial_ccy, listing_ccy, period_ends)

    rows = _statements_from_df(df, mapping, fx_by_period)
    return {
        "ticker": ticker,
        "statementType": kind,
        "periodType": period,
        "rows": rows
    }


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
        elif kind == "statements_income_annual":
            print(json.dumps(fetch_statements(ticker, "income", "annual")))
        elif kind == "statements_income_quarterly":
            print(json.dumps(fetch_statements(ticker, "income", "quarterly")))
        elif kind == "statements_balance_annual":
            print(json.dumps(fetch_statements(ticker, "balance", "annual")))
        elif kind == "statements_balance_quarterly":
            print(json.dumps(fetch_statements(ticker, "balance", "quarterly")))
        elif kind == "statements_cash_flow_annual":
            print(json.dumps(fetch_statements(ticker, "cash_flow", "annual")))
        elif kind == "statements_cash_flow_quarterly":
            print(json.dumps(fetch_statements(ticker, "cash_flow", "quarterly")))
        else:
            fail(f"Unknown kind: {kind}", "Validation")
    except SystemExit:
        raise
    except Exception as e:
        fail(f"{type(e).__name__}: {e}", "Provider")


if __name__ == "__main__":
    main()
