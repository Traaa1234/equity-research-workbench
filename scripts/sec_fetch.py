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

THIRTEEN_F_FORMS = ('13F-HR', '13F-HR/A')


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
    text_with_markers, all_tables = clean_html_to_text(html)
    sections = extract_sections(text_with_markers, form_type)
    # Attach per-section tables, renumbering markers
    for s in sections:
        new_text, new_tables = assign_tables_to_section(s['text'], all_tables)
        s['text'] = new_text
        s['tables'] = new_tables
    return {
        "formType": form_type,
        "primaryDocUrl": primary_url,
        "sections": sections,
        "totalChars": len(text_with_markers)
    }


def _parse_information_table(xml_bytes):
    """Parse a 13F-HR InformationTable XML into a list of position dicts.

    SEC reports <value> in dollars directly since Feb 2023 (was thousands prior).
    The <value> element is now value_usd as-is. Returns a list of position dicts;
    skips rows whose required fields are missing or non-numeric.
    """
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
            value_dollars = int(value_el.text.strip())
            shares = int(shares_el.text.strip())
        except (ValueError, AttributeError):
            continue
        positions.append({
            'cusip': cusip_el.text.strip(),
            'issuer_name': name_el.text.strip() if name_el else '',
            'class_title': class_el.text.strip() if class_el else '',
            'value_usd': value_dollars,
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

        # Step 2: filing's index.json — find the InformationTable XML filename.
        # Filenames vary across filers: 'form13fInfoTable.xml' (BlackRock),
        # '53405.xml' (Berkshire), 'informationtable.xml', etc. Heuristic:
        # any .xml that isn't primary_doc.xml or an *-index*.xml manifest.
        idx_r = throttled_get(archive_dir + "index.json")
        if idx_r.status_code != 200:
            continue
        idx_json = idx_r.json()
        items = idx_json.get("directory", {}).get("item", [])
        candidate_xmls = []
        for item in items:
            name = item.get("name", "")
            name_lower = name.lower()
            if not name_lower.endswith(".xml"):
                continue
            if name_lower == "primary_doc.xml":
                continue
            if "-index" in name_lower:
                continue
            candidate_xmls.append(name)
        if not candidate_xmls:
            continue

        # Step 3: try each candidate; the InformationTable XML has root
        # element <informationTable>. _parse_information_table returns []
        # for non-matching XMLs, so we keep the one with positions.
        positions = []
        for candidate in candidate_xmls:
            xml_r = throttled_get(archive_dir + candidate)
            if xml_r.status_code != 200:
                continue
            try:
                parsed = _parse_information_table(xml_r.content)
            except Exception:
                continue
            if parsed:
                positions = parsed
                break
        if not positions:
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("kind", choices=["resolve_cik", "index", "filing", "thirteen_f_filings"])
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
        elif args.kind == "thirteen_f_filings":
            if not args.cik:
                fail("--cik required", "Validation")
            status, body = fetch_thirteen_f_filings(args.cik)
            if status != 200:
                print(json.dumps(body))
                sys.exit(1)
            print(json.dumps(body))
    except SystemExit:
        raise
    except Exception as e:
        fail(f"{type(e).__name__}: {e}", "Provider")


if __name__ == "__main__":
    main()
