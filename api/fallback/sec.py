"""
Vercel Python serverless function: SEC EDGAR fallback fetcher.

URL: /api/fallback/sec?kind=<KIND>&...

kind values:
  resolve_cik    requires: ticker
  index          requires: cik; optional: forms (default 10-K,10-Q), years (default 5)
  filing         requires: primary_url, form_type

Returns JSON. HTTP 200 on success; non-2xx with { error, kind } shape on failure.
"""
import json
import os
import re
import time
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

try:
    import requests
except ImportError:
    requests = None

try:
    from bs4 import BeautifulSoup
except ImportError:
    BeautifulSoup = None


USER_AGENT = os.environ.get(
    "SEC_USER_AGENT",
    "Equity Research Workbench admin@example.com"
)
SESSION = None  # initialized lazily so the import doesn't fail in cold-start before deps load

MIN_INTERVAL_SECONDS = 0.21
_last_request = 0.0


SECTION_PATTERNS_10K = [
    ('item_1_business',             re.compile(r'^(?:item\s+|part\s+i,?\s*item\s+)?1\.?\s+(?:business|the\s+business)\b', re.I | re.M)),
    ('item_1a_risk_factors',        re.compile(r'^(?:item\s+)?1a\.?\s+risk\s+factors', re.I | re.M)),
    ('item_7_mdna',                 re.compile(r'^(?:item\s+|part\s+ii,?\s*item\s+)?7\.?\s+management.?s\s+discussion', re.I | re.M)),
    ('item_7a_market_risk',         re.compile(r'^(?:item\s+)?7a\.?\s+quantitative\s+and\s+qualitative', re.I | re.M)),
    ('item_8_financial_statements', re.compile(r'^(?:item\s+)?8\.?\s+financial\s+statements', re.I | re.M)),
]

# 10-Q sections are matched on their Item header directly. The Part prefix is
# implied by document order (Part I items come first). Standalone Item headers
# like "Item 1. Financial Statements" are unambiguous in 10-Qs.
SECTION_PATTERNS_10Q = [
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


def session():
    global SESSION
    if SESSION is None:
        SESSION = requests.Session()
        SESSION.headers.update({"User-Agent": USER_AGENT, "Accept-Encoding": "gzip, deflate"})
    return SESSION


def throttled_get(url):
    global _last_request
    elapsed = time.time() - _last_request
    if elapsed < MIN_INTERVAL_SECONDS:
        time.sleep(MIN_INTERVAL_SECONDS - elapsed)
    _last_request = time.time()
    return session().get(url, timeout=30)


def clean_html_to_text(html):
    soup = BeautifulSoup(html, 'html.parser')
    for tag in soup(['script', 'style', 'head', 'meta', 'link']):
        tag.decompose()
    for table in soup.find_all('table'):
        text = table.get_text(' ', strip=True)
        if 'table of contents' in text.lower()[:200]:
            table.decompose()
    text = soup.get_text('\n')
    text = re.sub(r'\r\n', '\n', text)
    text = re.sub(r'[ \t]+', ' ', text)
    text = re.sub(r'\n[ \t]+', '\n', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()


def extract_sections(text, form_type):
    patterns = SECTION_PATTERNS_10K if form_type == '10-K' else SECTION_PATTERNS_10Q
    hits = []
    for key, pat in patterns:
        for m in pat.finditer(text):
            hits.append((m.start(), key))
    if not hits:
        return [{
            'section_key': 'full_document',
            'section_title': SECTION_TITLES['full_document'],
            'text': text,
            'char_offset_start': 0,
            'char_offset_end': len(text)
        }]
    # Sort by offset ascending, then dedupe by section_key keeping the LAST
    # occurrence. The ToC at the start of every SEC filing repeats each Item
    # header — keeping the latest match skips it and finds the real section.
    hits.sort(key=lambda h: h[0])
    seen = set()
    deduped = []
    for h in reversed(hits):
        if h[1] in seen:
            continue
        seen.add(h[1])
        deduped.append(h)
    deduped.sort(key=lambda h: h[0])
    sections = []
    for i, (offset, key) in enumerate(deduped):
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


def resolve_cik(ticker):
    url = "https://www.sec.gov/files/company_tickers.json"
    resp = throttled_get(url)
    if resp.status_code == 429:
        return 503, {"error": "SEC rate limited", "kind": "RateLimit"}
    if resp.status_code >= 500:
        return 503, {"error": f"SEC returned {resp.status_code}", "kind": "Provider"}
    if not resp.ok:
        return 500, {"error": f"SEC unexpected {resp.status_code}", "kind": "Unknown"}
    data = resp.json()
    target = ticker.upper()
    for row in data.values():
        if row.get("ticker", "").upper() == target:
            return 200, {"cik": f"{int(row['cik_str']):010d}"}
    return 404, {"error": f"Ticker not found at SEC: {ticker}", "kind": "NotFound"}


def list_filings(cik, forms, years):
    url = f"https://data.sec.gov/submissions/CIK{cik}.json"
    resp = throttled_get(url)
    if resp.status_code == 404:
        return 404, {"error": f"CIK not found: {cik}", "kind": "NotFound"}
    if resp.status_code == 429:
        return 503, {"error": "SEC rate limited", "kind": "RateLimit"}
    if resp.status_code >= 500:
        return 503, {"error": f"SEC returned {resp.status_code}", "kind": "Provider"}
    if not resp.ok:
        return 500, {"error": f"SEC unexpected {resp.status_code}", "kind": "Unknown"}
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
        accession = recent["accessionNumber"][i]
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
    return 200, {"cik": cik, "filings": out}


def fetch_filing(primary_url, form_type):
    resp = throttled_get(primary_url)
    if resp.status_code == 404:
        return 404, {"error": f"Filing document not found: {primary_url}", "kind": "NotFound"}
    if resp.status_code == 429:
        return 503, {"error": "SEC rate limited", "kind": "RateLimit"}
    if resp.status_code >= 500:
        return 503, {"error": f"SEC returned {resp.status_code}", "kind": "Provider"}
    if not resp.ok:
        return 500, {"error": f"SEC unexpected {resp.status_code}", "kind": "Unknown"}
    html = resp.text
    text = clean_html_to_text(html)
    sections = extract_sections(text, form_type)
    return 200, {
        "formType": form_type,
        "primaryDocUrl": primary_url,
        "sections": sections,
        "totalChars": len(text)
    }


def dispatch(qs):
    if requests is None or BeautifulSoup is None:
        return 500, {"error": "Python deps not installed", "kind": "Provider"}
    kind = (qs.get("kind") or [""])[0]
    if kind == "resolve_cik":
        ticker = (qs.get("ticker") or [""])[0]
        if not ticker:
            return 400, {"error": "ticker required", "kind": "Validation"}
        return resolve_cik(ticker)
    if kind == "index":
        cik = (qs.get("cik") or [""])[0]
        if not cik:
            return 400, {"error": "cik required", "kind": "Validation"}
        forms = (qs.get("forms") or ["10-K,10-Q"])[0].split(",")
        years = int((qs.get("years") or ["5"])[0])
        return list_filings(cik, forms, years)
    if kind == "filing":
        primary_url = (qs.get("primary_url") or [""])[0]
        form_type = (qs.get("form_type") or [""])[0]
        if not primary_url or not form_type:
            return 400, {"error": "primary_url and form_type required", "kind": "Validation"}
        return fetch_filing(primary_url, form_type)
    return 400, {"error": f"Unknown kind: {kind}", "kind": "Validation"}


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            url = urlparse(self.path)
            qs = parse_qs(url.query)
            status, body = dispatch(qs)
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(body).encode("utf-8"))
        except Exception as e:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": f"{type(e).__name__}: {e}", "kind": "Provider"}).encode("utf-8"))
