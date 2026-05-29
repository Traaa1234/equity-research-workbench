"""
Vercel Python serverless function: SEC EDGAR fallback fetcher.

URL: /api/fallback/sec?kind=<KIND>&...

kind values:
  resolve_cik           requires: ticker
  index                 requires: cik; optional: forms (default 10-K,10-Q), years (default 5)
  filing                requires: primary_url, form_type
  thirteen_f_filings    requires: cik

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

THIRTEEN_F_FORMS = ('13F-HR', '13F-HR/A')


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


def _parse_row(tr):
    """Parse a single <tr>. Returns (cells_with_placeholders, colspans).

    cells_with_placeholders: list of strings. For a cell with colspan=N, the
      cell text appears at index i and empty strings fill the next N-1 slots.
    colspans: parallel list of ints. Cell span at index i; 0 marks placeholders.
    """
    cells = []
    colspans = []
    for td in tr.find_all(['td', 'th'], recursive=False):
        cell_text = td.get_text(' ', strip=True)
        # Collapse internal whitespace to single space (matches Slice 3.5)
        cell_text = re.sub(r'\s+', ' ', cell_text).strip()
        try:
            span = int(td.get('colspan', '1'))
            if span < 1:
                span = 1
        except (ValueError, TypeError):
            span = 1
        cells.append(cell_text)
        colspans.append(span)
        for _ in range(span - 1):
            cells.append('')
            colspans.append(0)
    return cells, colspans


def _is_all_th_row(tr):
    """True if every direct child cell in this row is a <th>."""
    children = tr.find_all(['td', 'th'], recursive=False)
    return len(children) > 0 and all(c.name == 'th' for c in children)


def extract_table_structure(table):
    """Parse <table> into {rows, colspans, head_row_count}.

    Empty cells preserved (fixes Slice 3.5 column-shift bug). Whitespace in
    cells collapsed to single spaces. colspans parallel to rows: 1=normal,
    n>1=spans n cols starting here, 0=covered by previous span.
    head_row_count counts leading rows from <thead> or all-<th> rows.
    """
    rows = []
    colspans = []
    head_row_count = 0

    thead = table.find('thead')
    thead_trs = thead.find_all('tr') if thead else []
    for tr in thead_trs:
        row_cells, row_spans = _parse_row(tr)
        rows.append(row_cells)
        colspans.append(row_spans)
    head_row_count = len(rows)

    # Process remaining <tr>s (either in <tbody> or directly under <table>)
    tbody = table.find('tbody')
    if tbody:
        body_trs = tbody.find_all('tr', recursive=False)
    else:
        # All <tr>s not in <thead>
        body_trs = [tr for tr in table.find_all('tr') if tr not in thead_trs]

    saw_first_body = False
    for tr in body_trs:
        row_cells, row_spans = _parse_row(tr)
        rows.append(row_cells)
        colspans.append(row_spans)
        # If no <thead>, but the first row is all <th>, count it as header
        if head_row_count == 0 and not saw_first_body and _is_all_th_row(tr):
            head_row_count = 1
        saw_first_body = True

    return {
        'rows': rows,
        'colspans': colspans,
        'head_row_count': head_row_count,
    }


def clean_html_to_text(html):
    """Strip noise, drop ToC tables, replace remaining tables with markers.

    Returns (text_with_markers, all_tables).
    text_with_markers: plaintext with `\n<<TABLE_N>>\n` where each <table> was.
    all_tables: list of {id, rows, colspans, head_row_count} for each kept table.
    """
    soup = BeautifulSoup(html, 'html.parser')
    for tag in soup(['script', 'style', 'head', 'meta', 'link']):
        tag.decompose()

    # Drop Table of Contents tables (existing Slice 2A behavior)
    for table in soup.find_all('table'):
        toc_text = table.get_text(' ', strip=True)
        if 'table of contents' in toc_text.lower()[:200]:
            table.decompose()

    # Replace remaining tables with markers; collect structured data
    all_tables = []
    for table in soup.find_all('table'):
        structure = extract_table_structure(table)
        table_id = len(all_tables)
        all_tables.append({**structure, 'id': table_id})
        marker = soup.new_string(f'\n<<TABLE_{table_id}>>\n')
        table.replace_with(marker)

    # Slice 3.7: inject newlines around BLOCK-LEVEL elements so they separate
    # in the final text, while INLINE elements (<font>, <span>, <a>, <em>,
    # <strong>, etc.) join with spaces only. Using get_text('\n') splits every
    # text node onto its own line, which fragments prose like
    # "As of March 28, 2026, <font>79</font>% of..." into three lines.
    BLOCK_TAGS = ['p', 'div', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'hr']
    for tag in soup.find_all(BLOCK_TAGS):
        tag.insert_before('\n')
        if tag.name != 'br' and tag.name != 'hr':
            tag.insert_after('\n')

    text = soup.get_text(' ')
    text = re.sub(r'\r\n', '\n', text)
    text = re.sub(r'[ \t]+', ' ', text)
    text = re.sub(r'[ \t]+\n', '\n', text)   # trim trailing space before \n
    text = re.sub(r'\n[ \t]+', '\n', text)   # trim leading space after \n
    text = re.sub(r'\n{3,}', '\n\n', text)
    # Collapse "79 %" → "79%" (and "79\n%" → "79%") that survived block-tag
    # joining when SEC wraps a number in a <font> tag separate from the
    # trailing percent sign.
    text = re.sub(r'(\d)\s+%', r'\1%', text)
    return text.strip(), all_tables


_TABLE_MARKER_RE = re.compile(r'<<TABLE_(\d+)>>')


def assign_tables_to_section(section_text, all_tables):
    """For a section's text slice, find markers, return (new_text, subset_tables).

    Renumbers marker ids starting at 0 in order of first appearance within the
    section. Subset tables get matching new ids. Markers not present in section
    are filtered out.
    """
    seen = {}  # original_id -> new_id
    new_tables = []
    by_id = {t['id']: t for t in all_tables}

    def repl(m):
        original_id = int(m.group(1))
        if original_id not in seen:
            new_id = len(seen)
            seen[original_id] = new_id
            original = by_id.get(original_id)
            if original is not None:
                new_tables.append({**original, 'id': new_id})
        return f'<<TABLE_{seen[original_id]}>>'

    new_text = _TABLE_MARKER_RE.sub(repl, section_text)
    return new_text, new_tables


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


def _parse_information_table(xml_bytes):
    """Parse a 13F-HR InformationTable XML into a list of position dicts.

    SEC reports <value> in thousands of dollars — multiply by 1000 for
    value_usd. Returns a list of position dicts; skips rows whose
    required fields are missing or non-numeric.
    """
    if BeautifulSoup is None:
        raise RuntimeError("BeautifulSoup not installed")
    soup = BeautifulSoup(xml_bytes, 'xml')
    positions = []
    for info in soup.find_all('infoTable'):
        cusip_el = info.find('cusip')
        value_el = info.find('value')
        shares_el = info.find('sshPrnamt')
        shares_type_el = info.find('sshPrnamtType')
        name_el = info.find('nameOfIssuer')
        class_el = info.find('titleOfClass')
        if not (cusip_el and value_el and shares_el):
            continue
        try:
            value_thousands = int(value_el.text.strip())
            shares = int(shares_el.text.strip())
        except (ValueError, AttributeError):
            continue
        positions.append({
            'cusip': cusip_el.text.strip(),
            'issuer_name': name_el.text.strip() if name_el else '',
            'class_title': class_el.text.strip() if class_el else '',
            'value_usd': value_thousands * 1000,
            'shares': shares,
            'shares_type': shares_type_el.text.strip() if shares_type_el else 'SH'
        })
    return positions


def fetch_thirteen_f_filings(cik):
    """Fetch the investor's submissions index, find recent 13F-HR filings
    (up to 8), download each InformationTable XML via the SEC index.json
    manifest, return parsed positions.

    Returns (http_status, response_body_dict).
    """
    cik_padded = cik.zfill(10)
    cik_unpadded = str(int(cik_padded))

    # Step 1: investor submissions index
    sub_url = f"https://data.sec.gov/submissions/CIK{cik_padded}.json"
    r = throttled_get(sub_url)
    if r.status_code == 404:
        return 404, {"error": "investor not found", "kind": "thirteen_f_filings", "cik": cik_padded}
    if r.status_code == 429:
        return 503, {"error": "SEC rate limited", "kind": "RateLimit"}
    if r.status_code >= 500:
        return 503, {"error": f"SEC returned {r.status_code}", "kind": "Provider"}
    if not r.ok:
        return 500, {"error": f"SEC submissions index returned {r.status_code}", "kind": "thirteen_f_filings"}
    sub_json = r.json()
    investor_name = sub_json.get("name", "")

    recent = sub_json.get("filings", {}).get("recent", {})
    forms = recent.get("form", [])
    accessions = recent.get("accessionNumber", [])
    filing_dates = recent.get("filingDate", [])
    report_dates = recent.get("reportDate", [])

    targets = []
    for form, acc, fdate, rdate in zip(forms, accessions, filing_dates, report_dates):
        if form in THIRTEEN_F_FORMS:
            targets.append({
                "accession": acc,
                "filing_date": fdate,
                "report_period": rdate,
                "form_type": form,
            })
            if len(targets) >= 8:
                break

    filings = []
    for t in targets:
        acc_no_dashes = t["accession"].replace("-", "")
        archive_dir = f"https://www.sec.gov/Archives/edgar/data/{cik_unpadded}/{acc_no_dashes}/"

        # Step 2: filing's index.json — find the InformationTable XML filename
        idx_r = throttled_get(archive_dir + "index.json")
        if idx_r.status_code != 200:
            continue
        idx_json = idx_r.json()
        items = idx_json.get("directory", {}).get("item", [])
        info_filename = None
        for item in items:
            name = item.get("name", "")
            if "informationtable" in name.lower() and name.lower().endswith(".xml"):
                info_filename = name
                break
        if not info_filename:
            continue

        # Step 3: download + parse InformationTable XML
        xml_r = throttled_get(archive_dir + info_filename)
        if xml_r.status_code != 200:
            continue
        try:
            positions = _parse_information_table(xml_r.content)
        except Exception:
            continue

        filings.append({
            "accession": t["accession"],
            "filing_date": t["filing_date"],
            "report_period": t["report_period"],
            "form_type": t["form_type"],
            "positions": positions,
        })

    return 200, {
        "cik": cik_padded,
        "investor_name": investor_name,
        "filings": filings,
    }


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
    text_with_markers, all_tables = clean_html_to_text(html)
    sections = extract_sections(text_with_markers, form_type)
    # Attach per-section tables, renumbering markers
    for s in sections:
        new_text, new_tables = assign_tables_to_section(s['text'], all_tables)
        s['text'] = new_text
        s['tables'] = new_tables
    return 200, {
        "formType": form_type,
        "primaryDocUrl": primary_url,
        "sections": sections,
        "totalChars": len(text_with_markers)
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
    if kind == "thirteen_f_filings":
        cik = (qs.get("cik") or [""])[0]
        if not cik:
            return 400, {"error": "cik required", "kind": "Validation"}
        return fetch_thirteen_f_filings(cik)
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


if __name__ == '__main__':
    # Inline assertions for _parse_information_table
    import pathlib
    fixture_path = pathlib.Path(__file__).resolve().parents[2] / 'lib' / 'providers' / '__fixtures__' / 'sec-13f-berkshire-2026q1.xml'
    if fixture_path.exists():
        with open(fixture_path, 'rb') as f:
            xml_bytes = f.read()
        positions = _parse_information_table(xml_bytes)
        assert len(positions) == 3, f"expected 3 positions, got {len(positions)}"
        aapl = next(p for p in positions if p['cusip'] == '037833100')
        assert aapl['issuer_name'] == 'APPLE INC', f"expected APPLE INC, got {aapl['issuer_name']!r}"
        # SEC reports value in thousands; parser multiplies by 1000
        assert aapl['value_usd'] == 263_012_040_000, f"expected 263012040000, got {aapl['value_usd']}"
        assert aapl['shares'] == 905_560_000
        assert aapl['shares_type'] == 'SH'
        print('[thirteen_f_filings] inline assertions PASS')
    else:
        print(f'[thirteen_f_filings] fixture not found at {fixture_path}, skipping inline test')
