"""Inline assertion tests for render_table_as_text.

Run via: py scripts/test_render_table.py
Exits 0 on success, non-zero on any assertion failure.
"""
from bs4 import BeautifulSoup
from sec_fetch import render_table_as_text


def t(html):
    """Helper: parse HTML, find the table, render it."""
    table = BeautifulSoup(html, 'html.parser').find('table')
    if table is None:
        return ''
    return render_table_as_text(table)


def main():
    # 1. Empty table renders as empty string
    assert t('<table></table>') == '', 'empty table'

    # 2. Single row, three cells, pipe-separated
    assert t('<table><tr><td>A</td><td>B</td><td>C</td></tr></table>') == 'A | B | C', \
        'single row three cells'

    # 3. Multi-row: rows separated by newline
    expected = 'A | B\nC | D'
    assert t('<table><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></table>') == expected, \
        'multi-row'

    # 4. Empty cells dropped (financial tables have layout-padding <td>'s)
    assert t('<table><tr><td></td><td>X</td><td>&nbsp;</td><td>Y</td></tr></table>') == 'X | Y', \
        'empty cells dropped'

    # 5. <th> treated same as <td>
    assert t('<table><tr><th>Q1</th><th>Q2</th></tr><tr><td>10</td><td>20</td></tr></table>') \
        == 'Q1 | Q2\n10 | 20', '<th> headers'

    # 6. Whitespace inside cells collapsed to single space
    assert t('<table><tr><td>  hello\n  world  </td></tr></table>') == 'hello world', \
        'whitespace collapsed in cells'

    print('All 6 tests passed.')


if __name__ == '__main__':
    main()
