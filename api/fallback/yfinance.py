"""
Vercel Python serverless function: yfinance fallback fetcher.

URL: /api/fallback/yfinance?ticker=<TICKER>&kind=<KIND>

kind values: company, snapshot, prices_1y, prices_5y, earnings,
             statements_income_annual, statements_income_quarterly,
             statements_balance_annual, statements_balance_quarterly,
             statements_cash_flow_annual, statements_cash_flow_quarterly

Returns: JSON body. HTTP 200 on success; 400 on validation; 404 if ticker not found;
         500 on provider/unknown error. Error body always has `{ error, kind }` shape.
"""
import json
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

try:
    import yfinance as yf
except ImportError:
    yf = None


def num_or_none(v):
    try:
        f = float(v)
        if f != f or f in (float("inf"), float("-inf")):
            return None
        return f
    except (TypeError, ValueError):
        return None


def get_fx_rate_spot(from_ccy, to_ccy):
    if from_ccy == to_ccy:
        return 1.0
    pair = f"{from_ccy}{to_ccy}=X"
    try:
        t = yf.Ticker(pair)
        info = t.info
        rate = info.get("regularMarketPrice") or info.get("previousClose")
        if rate is None:
            h = t.history(period="5d")
            if h is None or h.empty:
                return None
            rate = float(h["Close"].iloc[-1])
        return float(rate) if rate else None
    except Exception:
        return None


def get_fx_rate_history(from_ccy, to_ccy, period_ends):
    if from_ccy == to_ccy:
        return {pe: 1.0 for pe in period_ends}
    if not period_ends:
        return {}
    pair = f"{from_ccy}{to_ccy}=X"
    try:
        t = yf.Ticker(pair)
        earliest = min(period_ends)
        latest = max(period_ends)
        from_date = datetime.fromisoformat(earliest).date() - timedelta(days=30)
        to_date = datetime.fromisoformat(latest).date() + timedelta(days=30)
        hist = t.history(start=from_date.isoformat(), end=to_date.isoformat(), interval="1d")
        if hist is None or hist.empty:
            return {pe: None for pe in period_ends}
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
    "Common Stock Equity": "total_equity",
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


def _statements_from_df(df, mapping, fx_by_period):
    if df is None or df.empty:
        return []
    rows = []
    seen = set()
    period_cols = list(df.columns)
    for yf_name, our_name in mapping.items():
        if yf_name not in df.index:
            continue
        series = df.loc[yf_name]
        for period_col in period_cols:
            period_end = period_col.strftime("%Y-%m-%d") if hasattr(period_col, "strftime") else str(period_col)[:10]
            key = (period_end, our_name)
            if key in seen:
                continue
            raw = series.get(period_col)
            value = num_or_none(raw)
            if value is None:
                continue
            fx = fx_by_period.get(period_end)
            if fx is not None and fx > 0:
                value = value * fx
                rows.append({"periodEnd": period_end, "lineItem": our_name, "value": value, "currency": "USD"})
                seen.add(key)
    return rows


def fetch_company(ticker):
    t = yf.Ticker(ticker)
    info = t.info
    if not info or not info.get("symbol"):
        return None
    return {
        "ticker": ticker,
        "name": info.get("longName") or info.get("shortName") or ticker,
        "cik": None,
        "exchange": info.get("exchange"),
        "sector": info.get("sector"),
        "industry": info.get("industry"),
    }


def fetch_info(ticker):
    """
    Return enrichment metadata for a ticker from yfinance .info dict.
    Returns only the fields the discovery seeder consumes.
    """
    t = yf.Ticker(ticker)
    info = t.info or {}
    return {
        "longBusinessSummary": info.get("longBusinessSummary") or None,
        "country": info.get("country") or None,
        "sector": info.get("sector") or None,
        "industry": info.get("industry") or None,
        "exchange": info.get("exchange") or None,
        "marketCap": info.get("marketCap") or None,
        "longName": info.get("longName") or info.get("shortName") or None,
    }


def fetch_snapshot(ticker):
    t = yf.Ticker(ticker)
    info = t.info
    if not info or not info.get("symbol"):
        return None

    listing_ccy = info.get("currency", "USD")
    financial_ccy = info.get("financialCurrency", listing_ccy)

    market_cap = num_or_none(info.get("marketCap"))
    pe = num_or_none(info.get("trailingPE"))
    ps_raw = num_or_none(info.get("priceToSalesTrailing12Months"))
    pb_raw = num_or_none(info.get("priceToBook"))

    ps = ps_raw
    fx = None
    if listing_ccy != financial_ccy:
        fx = get_fx_rate_spot(financial_ccy, listing_ccy)
        revenue_fc = num_or_none(info.get("totalRevenue"))
        if fx and market_cap and revenue_fc and revenue_fc > 0:
            ps = market_cap / (revenue_fc * fx)
        else:
            ps = None

    pb = None
    try:
        bs = t.balance_sheet
        if bs is not None and not bs.empty:
            equity_keys = ["Stockholders Equity", "Total Stockholder Equity", "Total Equity Gross Minority Interest", "Common Stock Equity"]
            equity_fc = None
            for key in equity_keys:
                if key in bs.index:
                    val = bs.loc[key].iloc[0]
                    equity_fc = num_or_none(val)
                    if equity_fc is not None and equity_fc > 0:
                        break
            if equity_fc and equity_fc > 0 and market_cap:
                effective_fx = fx if fx is not None else 1.0
                pb = market_cap / (equity_fc * effective_fx)
    except Exception:
        pb = None

    if pb is None and listing_ccy == financial_ccy:
        pb = pb_raw

    return {
        "ticker": ticker,
        "price": num_or_none(info.get("currentPrice") or info.get("regularMarketPrice")),
        "marketCap": market_cap,
        "week52High": num_or_none(info.get("fiftyTwoWeekHigh")),
        "week52Low": num_or_none(info.get("fiftyTwoWeekLow")),
        "pe": pe if (pe is None or pe > 0) else None,
        "ps": ps,
        "pb": pb,
        "evEbitda": num_or_none(info.get("enterpriseToEbitda")),
        "peg": num_or_none(info.get("pegRatio")),
        "asOf": datetime.utcnow().isoformat() + "Z",
        "financialCurrency": financial_ccy,
        "listingCurrency": listing_ccy
    }


def fetch_prices(ticker, years):
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


def fetch_earnings(ticker):
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


def fetch_statements(ticker, kind, period):
    t = yf.Ticker(ticker)
    info = t.info
    if not info or not info.get("symbol"):
        return None
    listing_ccy = info.get("currency", "USD")
    financial_ccy = info.get("financialCurrency", listing_ccy)

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
        return None
    df = getattr(t, attr, None)
    if df is None or df.empty:
        return {"ticker": ticker, "statementType": kind, "periodType": period, "rows": []}

    mappings = {"income": INCOME_MAP, "balance": BALANCE_MAP, "cash_flow": CASH_FLOW_MAP}
    mapping = mappings[kind]
    period_ends = []
    for col in df.columns:
        pe = col.strftime("%Y-%m-%d") if hasattr(col, "strftime") else str(col)[:10]
        period_ends.append(pe)
    fx_by_period = get_fx_rate_history(financial_ccy, listing_ccy, period_ends)
    rows = _statements_from_df(df, mapping, fx_by_period)
    return {"ticker": ticker, "statementType": kind, "periodType": period, "rows": rows}


def dispatch(ticker, kind):
    """Returns (status_code, body_dict)."""
    if yf is None:
        return 500, {"error": "yfinance not installed", "kind": "Provider"}
    if not ticker:
        return 400, {"error": "ticker required", "kind": "Validation"}
    ticker = ticker.upper()

    try:
        if kind == "company":
            res = fetch_company(ticker)
            if res is None:
                return 404, {"error": f"Ticker not found: {ticker}", "kind": "NotFound"}
            return 200, res
        if kind == "info":
            return 200, fetch_info(ticker)
        if kind == "snapshot":
            res = fetch_snapshot(ticker)
            if res is None:
                return 404, {"error": f"Ticker not found: {ticker}", "kind": "NotFound"}
            return 200, res
        if kind == "prices_1y":
            return 200, fetch_prices(ticker, 1)
        if kind == "prices_5y":
            return 200, fetch_prices(ticker, 5)
        if kind == "earnings":
            return 200, fetch_earnings(ticker)
        for stmt_kind, period in [
            ("income", "annual"), ("income", "quarterly"),
            ("balance", "annual"), ("balance", "quarterly"),
            ("cash_flow", "annual"), ("cash_flow", "quarterly"),
        ]:
            if kind == f"statements_{stmt_kind}_{period}":
                res = fetch_statements(ticker, stmt_kind, period)
                if res is None:
                    return 404, {"error": f"Ticker not found: {ticker}", "kind": "NotFound"}
                return 200, res
        return 400, {"error": f"Unknown kind: {kind}", "kind": "Validation"}
    except Exception as e:
        return 500, {"error": f"{type(e).__name__}: {e}", "kind": "Provider"}


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            url = urlparse(self.path)
            qs = parse_qs(url.query)
            ticker = (qs.get("ticker") or [""])[0]
            kind = (qs.get("kind") or [""])[0]
            status, body = dispatch(ticker, kind)
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(body).encode("utf-8"))
        except Exception as e:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": f"{type(e).__name__}: {e}", "kind": "Provider"}).encode("utf-8"))
