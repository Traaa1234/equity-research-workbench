# Provider fixtures

These JSON files are recorded responses from the Financial Datasets API for the AAPL ticker. They are replayed by `tests/providers/*.test.ts` so unit tests never hit the network.

## Refreshing fixtures

To capture fresh responses against a live key:

```bash
FD_KEY=$FINANCIAL_DATASETS_API_KEY tsx scripts/record-fixtures.ts AAPL
```

(That script is added in a later phase. For now, the fixtures here are hand-authored to match the documented API shape.)

## Provenance

Each fixture has a top-level `_fixture` block with `recorded_at` and `endpoint`. Do not include API keys or PII in fixture files.
