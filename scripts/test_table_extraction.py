"""Plain Python assertion tests for table extraction in sec_fetch.py.

Usage: python scripts/test_table_extraction.py
Exit 0 on success, 1 on failure. No pytest dependency.

Matches the style of scripts/test_render_table.py (Slice 3.5).
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from bs4 import BeautifulSoup
from sec_fetch import (
    extract_table_structure,
    clean_html_to_text,
    assign_tables_to_section,
)

# ---------- Test 1: simple 2x2 ----------
html1 = '<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>'
table1 = BeautifulSoup(html1, 'html.parser').find('table')
r1 = extract_table_structure(table1)
assert r1 == {
    'rows': [['a', 'b'], ['c', 'd']],
    'colspans': [[1, 1], [1, 1]],
    'head_row_count': 0,
}, f'Test 1 failed: {r1}'

# ---------- Test 2: <thead> + <tbody> ----------
html2 = (
    '<table><thead><tr><th>H1</th><th>H2</th></tr></thead>'
    '<tbody><tr><td>x</td><td>y</td></tr></tbody></table>'
)
table2 = BeautifulSoup(html2, 'html.parser').find('table')
r2 = extract_table_structure(table2)
assert r2['rows'] == [['H1', 'H2'], ['x', 'y']]
assert r2['colspans'] == [[1, 1], [1, 1]]
assert r2['head_row_count'] == 1, f'Test 2 failed: {r2}'

# ---------- Test 3: colspan="2" ----------
html3 = (
    '<table><tr><th colspan="2">Q1</th><th>Note</th></tr>'
    '<tr><td>1</td><td>2</td><td>3</td></tr></table>'
)
table3 = BeautifulSoup(html3, 'html.parser').find('table')
r3 = extract_table_structure(table3)
assert r3['rows'] == [['Q1', '', 'Note'], ['1', '2', '3']], f'Test 3 rows wrong: {r3["rows"]}'
assert r3['colspans'] == [[2, 0, 1], [1, 1, 1]], f'Test 3 colspans wrong: {r3["colspans"]}'

# ---------- Test 4: empty <td>'s preserved ----------
html4 = '<table><tr><td>label</td><td></td><td>123</td></tr></table>'
table4 = BeautifulSoup(html4, 'html.parser').find('table')
r4 = extract_table_structure(table4)
assert r4['rows'] == [['label', '', '123']], f'Test 4 failed: {r4}'

# ---------- Test 5: whitespace-heavy cell collapsed ----------
html5 = '<table><tr><td>  Net\n\nSales\t\t</td></tr></table>'
table5 = BeautifulSoup(html5, 'html.parser').find('table')
r5 = extract_table_structure(table5)
assert r5['rows'] == [['Net Sales']], f'Test 5 failed: {r5}'

# ---------- Test 6: clean_html_to_text returns (text, tables) ----------
html6 = (
    '<html><body>'
    '<p>Lead-in.</p>'
    '<table><tr><td>foo</td></tr></table>'
    '<p>Trailing.</p>'
    '</body></html>'
)
text6, tables6 = clean_html_to_text(html6)
assert '<<TABLE_0>>' in text6, f'Test 6: marker missing: {text6!r}'
assert 'Lead-in.' in text6 and 'Trailing.' in text6
assert len(tables6) == 1
assert tables6[0]['id'] == 0
assert tables6[0]['rows'] == [['foo']]

# ---------- Test 7: ToC table dropped before marker assignment ----------
html7 = (
    '<html><body>'
    '<table><tr><td>Table of Contents</td></tr><tr><td>Item 1</td></tr></table>'
    '<p>Body.</p>'
    '<table><tr><td>real</td><td>data</td></tr></table>'
    '</body></html>'
)
text7, tables7 = clean_html_to_text(html7)
assert len(tables7) == 1, f'Test 7: ToC not dropped, got {len(tables7)} tables'
assert tables7[0]['rows'] == [['real', 'data']]
assert '<<TABLE_0>>' in text7

# ---------- Test 8: assign_tables_to_section renumbers ids ----------
section_text = 'Foo bar.\n\n<<TABLE_3>>\n\nBaz.\n\n<<TABLE_7>>\n\nDone.'
all_tables = [
    {'id': 3, 'rows': [['a']], 'colspans': [[1]], 'head_row_count': 0},
    {'id': 7, 'rows': [['b']], 'colspans': [[1]], 'head_row_count': 0},
    {'id': 12, 'rows': [['c']], 'colspans': [[1]], 'head_row_count': 0},  # not in this section
]
new_text, new_tables = assign_tables_to_section(section_text, all_tables)
assert '<<TABLE_0>>' in new_text and '<<TABLE_1>>' in new_text
assert '<<TABLE_3>>' not in new_text and '<<TABLE_7>>' not in new_text
assert len(new_tables) == 2
assert new_tables[0] == {'id': 0, 'rows': [['a']], 'colspans': [[1]], 'head_row_count': 0}
assert new_tables[1] == {'id': 1, 'rows': [['b']], 'colspans': [[1]], 'head_row_count': 0}

print('All 8 tests passed.')
