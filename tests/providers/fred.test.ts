import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FredProvider } from '@/lib/providers/fred';

const csv = readFileSync(path.resolve(__dirname, '../../lib/providers/__fixtures__/fred-dgs10.csv'), 'utf8');
const json = readFileSync(path.resolve(__dirname, '../../lib/providers/__fixtures__/fred-dgs10.json'), 'utf8');

function fakeFetch(body: string, contentType: string): typeof fetch {
  return (async () => new Response(body, { status: 200, headers: { 'content-type': contentType } })) as unknown as typeof fetch;
}

describe('FredProvider', () => {
  it('parses keyless CSV and drops "." missing markers', async () => {
    const p = new FredProvider({ apiKey: undefined, fetch: fakeFetch(csv, 'text/csv') });
    const rows = await p.fetchSeries('DGS10', { start: '2026-05-01' });
    expect(rows).toEqual([
      { date: '2026-05-28', value: 4.2 },
      { date: '2026-06-01', value: 4.21 },
    ]);
  });

  it('parses the JSON API when a key is set', async () => {
    const p = new FredProvider({ apiKey: 'k', fetch: fakeFetch(json, 'application/json') });
    const rows = await p.fetchSeries('DGS10', { start: '2026-05-01' });
    expect(rows.map((r) => r.value)).toEqual([4.2, 4.21]);
  });

  it('uses the api.stlouisfed.org host when keyed, fredgraph when keyless', async () => {
    const seen: string[] = [];
    const spy: typeof fetch = (async (url: string) => {
      seen.push(String(url));
      return new Response(csv, { status: 200, headers: { 'content-type': 'text/csv' } });
    }) as unknown as typeof fetch;
    await new FredProvider({ apiKey: undefined, fetch: spy }).fetchSeries('DGS10', { start: '2026-05-01' });
    await new FredProvider({ apiKey: 'k', fetch: spy }).fetchSeries('DGS10', { start: '2026-05-01' });
    expect(seen[0]).toContain('fredgraph.csv');
    expect(seen[1]).toContain('api.stlouisfed.org');
    expect(seen[1]).toContain('api_key=k');
  });
});
