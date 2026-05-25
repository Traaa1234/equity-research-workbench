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


# ---------- Section parsing ----------

SECTION_PATTERNS_10K = [
    ('item_1_business',             re.compile(r'^(?:item\s+|part\s+i,?\s*item\s+)?1\.?\s+(?:business|the\s+business)\b', re.I | re.M)),
    ('item_1a_risk_factors',        re.compile(r'^(?:item\s+)?1a\.?\s+risk\s+factors', re.I | re.M)),
    ('item_7_mdna',                 re.compile(r'^(?:item\s+|part\s+ii,?\s*item\s+)?7\.?\s+management.?s\s+discussion', re.I | re.M)),
    ('item_7a_market_risk',         re.compile(r'^(?:item\s+)?7a\.?\s+quantitative\s+and\s+qualitative', re.I | re.M)),
    ('item_8_financial_statements', re.compile(r'^(?:item\s+)?8\.?\s+financial\s+statements', re.I | re.M)),
]

SECTION_PATTERNS_10Q = [
    # 10-Q sections are matched on their Item header directly. The Part prefix
    # is implied by document order (Part I items come first). Standalone Item
    # headers like "Item 1. Financial Statements" are unambiguous in 10-Qs.
    ('part1_item1_financial_statements', re.compile(r'^item\s+1\.?\s+financial\s+statements', re.I | re.M)),
    ('part1_item2_mdna',                 re.compile(r'^item\s+2\.?\s+management.?s\s+discussion', re.I | re.M)),
    ('part2_item1a_risk_factor_updates', re.compile(r'^item\s+1a\.?\s+risk\s+factors', re.I | re.M)),
]

SECTION_TITLES = {
    'item_1_business': 'Business',
    'item_1a_risk_factors': 'Risk Factors',
    'item_7_mdna': "Management's Discussion and Analysis",
    'item_7a_market_risk': 'Quantitative and Qualitative Disclosures About Market Risk',
    'item_8_financial_statements': 'Financial Statements and Notes',
    'part1_item1_financial_statements': 'Financial Statements',
    'part1_item2_mdna': "Management's Discussion and Analysis",
    'part2_item1a_risk_factor_updates': 'Risk Factor Updates',
    'full_document': 'Full Document'
}


def clean_html_to_text(html: str) -> str:
    """Strip scripts/styles/nav, extract text, collapse whitespace."""
    soup = BeautifulSoup(html, 'html.parser')
    for tag in soup(['script', 'style', 'head', 'meta', 'link']):
        tag.decompose()
    # Drop tables that look like ToC (header rows mentioning "Table of Contents")
    for table in soup.find_all('table'):
        text = table.get_text(' ', strip=True)
        if 'table of contents' in text.lower()[:200]:
            table.decompose()
    text = soup.get_text('\n')
    # Collapse whitespace: many \n -> two \n; many spaces -> one
    text = re.sub(r'\r\n', '\n', text)
    text = re.sub(r'[ \t]+', ' ', text)
    text = re.sub(r'\n[ \t]+', '\n', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()


def extract_sections(text: str, form_type: str) -> list[dict]:
    """Find section boundaries via regex patterns; return list of {section_key, section_title, text, char_offset_start, char_offset_end}."""
    patterns = SECTION_PATTERNS_10K if form_type == '10-K' else SECTION_PATTERNS_10Q
    # Find all matches across all patterns; record (offset, section_key, length_of_match)
    hits = []
    for key, pat in patterns:
        for m in pat.finditer(text):
            hits.append((m.start(), key, m.end() - m.start()))
    if not hits:
        # Fallback: return one chunk for the whole document
        return [{
            'section_key': 'full_document',
            'section_title': SECTION_TITLES['full_document'],
            'text': text,
            'char_offset_start': 0,
            'char_offset_end': len(text)
        }]
    # Sort hits by offset (ascending), then dedupe by section_key keeping the
    # LAST occurrence. Rationale: every SEC filing starts with a Table of
    # Contents that repeats each Item header on its own line — those entries
    # match the regex but aren't the real sections. The real section headers
    # always appear later in the document body. Keeping the last match
    # naturally skips the ToC.
    hits.sort(key=lambda h: h[0])
    seen = set()
    deduped = []
    for h in reversed(hits):
        if h[1] in seen:
            continue
        seen.add(h[1])
        deduped.append(h)
    # deduped is now in reverse offset order; the next `deduped.sort(...)` call
    # below restores ascending offset order before building sections.
    deduped.sort(key=lambda h: h[0])
    # Build sections: from this hit's offset to next hit's offset (or end of text)
    sections = []
    for i, (offset, key, _match_len) in enumerate(deduped):
        end_offset = deduped[i + 1][0] if i + 1 < len(deduped) else len(text)
        section_text = text[offset:end_offset].strip()
        if not section_text:
            continue
        sections.append({
            'section_key': key,
            'section_title': SECTION_TITLES.get(key, key),
            'text': section_text,
            'char_offset_start': offset,
            'char_offset_end': end_offset
        })
    return sections


def fetch_filing(primary_url: str, form_type: str) -> dict:
    """Download the primary document, clean to plaintext, parse sections."""
    resp = throttled_get(primary_url)
    if resp.status_code == 404:
        fail(f"Filing document not found: {primary_url}", "NotFound")
    if resp.status_code == 429:
        fail("SEC rate limited", "RateLimit")
    if resp.status_code >= 500:
        fail(f"SEC returned {resp.status_code}", "Provider")
    if not resp.ok:
        fail(f"SEC unexpected {resp.status_code}", "Unknown")

    html = resp.text
    text = clean_html_to_text(html)
    sections = extract_sections(text, form_type)
    return {
        "formType": form_type,
        "primaryDocUrl": primary_url,
        "sections": sections,
        "totalChars": len(text)
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("kind", choices=["resolve_cik", "index", "filing"])
    parser.add_argument("--ticker")
    parser.add_argument("--cik")
    parser.add_argument("--accession")
    parser.add_argument("--primary-url")
    parser.add_argument("--form-type")
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
            if not args.primary_url or not args.form_type:
                fail("--primary-url and --form-type required", "Validation")
            result = fetch_filing(args.primary_url, args.form_type)
            print(json.dumps(result))
    except SystemExit:
        raise
    except Exception as e:
        fail(f"{type(e).__name__}: {e}", "Provider")


if __name__ == "__main__":
    main()
