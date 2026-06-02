#!/usr/bin/env python3
"""
Smoke test for the EarningsCall API — run BEFORE re-speccing the Transcripts
slice around it, to confirm the free tier actually delivers what we need.

Prereq:  pip install --upgrade earningscall   (needs Python 3.10+)

Usage:
  # 1) No key needed — AAPL/MSFT are free demo companies:
  python scripts/try-earningscall.py

  # 2) With a free API key (unlocks 5,000+ companies) — confirms broader coverage:
  EARNINGSCALL_API_KEY=your-key python scripts/try-earningscall.py NVDA

What it checks:
  - Library installs + imports
  - Can list available quarters for a ticker
  - Level 1 (full text) works + how long the text is + a sample
  - Level 2 (speaker-segmented) — works on the free tier, or requires "Enhanced"?
  - With a key: does a NON-demo ticker resolve (coverage), or 401/empty?

This tells us whether the Transcripts slice can stand on a free, non-scraping
foundation, and whether we get speaker labels for free or must pay for Enhanced.
"""
import os
import sys


def main() -> None:
    ticker = (sys.argv[1] if len(sys.argv) > 1 else "AAPL").upper()

    try:
        import earningscall
        from earningscall import get_company
    except ImportError:
        print("FAIL: earningscall not installed. Run: pip install --upgrade earningscall")
        sys.exit(1)

    key = os.environ.get("EARNINGSCALL_API_KEY")
    if key:
        earningscall.api_key = key
        print(f"Using API key (…{key[-4:]}). Testing ticker: {ticker}")
    else:
        print(f"No EARNINGSCALL_API_KEY set — demo mode (only AAPL/MSFT work). Testing: {ticker}")
        if ticker not in ("AAPL", "MSFT"):
            print(f"  NOTE: {ticker} likely won't resolve without a key. Try AAPL first, "
                  f"or set EARNINGSCALL_API_KEY.")

    # 1) Resolve company
    company = get_company(ticker)
    if company is None:
        print(f"FAIL: get_company('{ticker}') returned None — ticker not covered on this tier.")
        sys.exit(1)
    print(f"OK: resolved company → {getattr(company, 'name', ticker)}")

    # 2) List available quarters
    events = list(company.events())
    if not events:
        print("FAIL: no transcript events listed for this company.")
        sys.exit(1)
    print(f"OK: {len(events)} quarters available. Most recent few:")
    for ev in events[:4]:
        print(f"     Q{ev.quarter} {ev.year}")

    latest = events[0]

    # 3) Level 1 — full text
    t1 = company.get_transcript(year=latest.year, quarter=latest.quarter)
    if not t1 or not getattr(t1, "text", None):
        print("FAIL: Level 1 transcript returned no text.")
        sys.exit(1)
    text = t1.text
    print(f"\nLEVEL 1 (full text): {len(text):,} chars for Q{latest.quarter} {latest.year}")
    print(f"  Sample: {text[:200].strip()}...")

    # 4) Level 2 — speaker-segmented (this is the paid 'Enhanced' feature — see if free)
    print("\nLEVEL 2 (speaker-segmented) — probing whether the free tier includes it:")
    try:
        t2 = company.get_transcript(year=latest.year, quarter=latest.quarter, level=2)
        speakers = getattr(t2, "speakers", None) if t2 else None
        if speakers:
            print(f"  OK: {len(speakers)} speaker turns. First two:")
            for sp in speakers[:2]:
                info = getattr(sp, "speaker_info", None)
                name = getattr(info, "name", None) if info else getattr(sp, "speaker", "?")
                title = getattr(info, "title", None) if info else None
                snippet = (sp.text or "")[:80].strip()
                print(f"     - {name}{f' ({title})' if title else ''}: {snippet}...")
            print("  => Speaker segmentation is AVAILABLE on this tier. No parser work needed.")
        else:
            print("  Level 2 returned no speakers — likely requires a paid 'Enhanced' plan.")
            print("  => Fall back to Level 1 full-text + our own chunking for v1 (still works for Ask).")
    except Exception as e:  # noqa: BLE001 — smoke test, surface any gating error
        print(f"  Level 2 errored ({type(e).__name__}: {e}).")
        print("  => Likely gated to a paid 'Enhanced' plan. Use Level 1 full-text for v1.")

    print("\nSMOKE TEST DONE. Verdict inputs:")
    print(f"  - Coverage: {'broad (key)' if key else 'demo only (AAPL/MSFT)'}")
    print(f"  - Level 1 text: working ({len(text):,} chars)")
    print("  - Level 2 speaker labels: see above (free vs needs-Enhanced)")


if __name__ == "__main__":
    main()
