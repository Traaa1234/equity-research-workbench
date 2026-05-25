#!/usr/bin/env python3
"""
SEC EDGAR fetcher used by lib/providers/sec-edgar.ts.

Usage: python sec_fetch.py <kind> [--ticker T] [--cik C] [--accession A] [--forms 10-K,10-Q] [--years 5]

  kind = resolve_cik | index | filing

Output: JSON on stdout. Exit 0 on success, exit 1 on failure with
        { "error": str, "kind": "NotFound" | "Provider" | "Validation" | "RateLimit" | "Unknown" }
"""
import argparse
import json
import os
import re
import sys
import time
from datetime import date, timedelta

try:
    import requests
except ImportError as e:
    print(json.dumps({"error": f"requests not installed: {e}", "kind": "Provider"}))
    sys.exit(1)

try:
    from bs4 import BeautifulSoup
except ImportError as e:
    print(json.dumps({"error": f"beautifulsoup4 not installed: {e}", "kind": "Provider"}))
    sys.exit(1)


USER_AGENT = os.environ.get(
    "SEC_USER_AGENT",
    "Equity Research Workbench admin@example.com"
)
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": USER_AGENT, "Accept-Encoding": "gzip, deflate"})

MIN_INTERVAL_SECONDS = 0.21  # ~4.76 req/sec; well under SEC's 10/sec ceiling
_last_request = 0.0


def fail(msg: str, kind: str = "Unknown"):
    print(json.dumps({"error": msg, "kind": kind}))
    sys.exit(1)


def throttled_get(url: str) -> requests.Response:
    global _last_request
    elapsed = time.time() - _last_request
    if elapsed < MIN_INTERVAL_SECONDS:
        time.sleep(MIN_INTERVAL_SECONDS - elapsed)
    _last_request = time.time()
    return SESSION.get(url, timeout=30)


def resolve_cik(ticker: str) -> str:
    """SEC publishes a ticker->CIK index. Tickers are case-insensitive."""
    url = "https://www.sec.gov/files/company_tickers.json"
    resp = throttled_get(url)
    if resp.status_code == 429:
        fail("SEC rate limited", "RateLimit")
    if resp.status_code >= 500:
        fail(f"SEC returned {resp.status_code}", "Provider")
    if not resp.ok:
        fail(f"SEC unexpected {resp.status_code}", "Unknown")
    data = resp.json()
    target = ticker.upper()
    for row in data.values():
        if row.get("ticker", "").upper() == target:
            return f"{int(row['cik_str']):010d}"
    fail(f"Ticker not found at SEC: {ticker}", "NotFound")


def list_filings(cik: str, forms: list[str], years: int) -> dict:
    """SEC publishes a per-CIK submissions JSON; we filter to the requested forms + date window."""
    url = f"https://data.sec.gov/submissions/CIK{cik}.json"
    resp = throttled_get(url)
    if resp.status_code == 404:
        fail(f"CIK not found: {cik}", "NotFound")
    if resp.status_code == 429:
        fail("SEC rate limited", "RateLimit")
    if resp.status_code >= 500:
        fail(f"SEC returned {resp.status_code}", "Provider")
    if not resp.ok:
        fail(f"SEC unexpected {resp.status_code}", "Unknown")
    data = resp.json()
    recent = data.get("filings", {}).get("recent", {})
    cutoff = date.today() - timedelta(days=years * 365)
    out = []
    for i in range(len(recent.get("accessionNumber", []))):
        form = recent["form"][i]
        if form not in forms:
            continue
        filed = date.fromisoformat(recent["filingDate"][i])
        if filed < cutoff:
            continue
        accession = recent["accessionNumber"][i]  # '0000320193-24-000123'
        accession_nodash = accession.replace("-", "")
        primary_doc = recent.get("primaryDocument", [None] * (i + 1))[i]
        period_end = recent.get("reportDate", [None] * (i + 1))[i] or None
        primary_url = (
            f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{accession_nodash}/{primary_doc}"
            if primary_doc
            else None
        )
        out.append({
            "accessionNo": accession,
            "formType": form,
            "filingDate": recent["filingDate"][i],
            "periodEnd": period_end if period_end else None,
            "primaryDocUrl": primary_url
        })
    return {"cik": cik, "filings": out}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("kind", choices=["resolve_cik", "index", "filing"])
    parser.add_argument("--ticker")
    parser.add_argument("--cik")
    parser.add_argument("--accession")
    parser.add_argument("--forms", default="10-K,10-Q")
    parser.add_argument("--years", type=int, default=5)
    args = parser.parse_args()

    try:
        if args.kind == "resolve_cik":
            if not args.ticker:
                fail("--ticker required", "Validation")
            cik = resolve_cik(args.ticker)
            print(json.dumps({"cik": cik}))
        elif args.kind == "index":
            if not args.cik:
                fail("--cik required", "Validation")
            forms = [f.strip() for f in args.forms.split(",") if f.strip()]
            result = list_filings(args.cik, forms, args.years)
            print(json.dumps(result))
        elif args.kind == "filing":
            if not args.accession:
                fail("--accession required", "Validation")
            # Implemented in Task 2.2
            fail("filing kind not yet implemented", "Provider")
    except SystemExit:
        raise
    except Exception as e:
        fail(f"{type(e).__name__}: {e}", "Provider")


if __name__ == "__main__":
    main()
