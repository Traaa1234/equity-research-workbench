'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import type { SecTable } from '@/lib/providers/types';
import { SectionText } from './section-text';

interface SectionRef {
  sectionKey: string;
  sectionTitle: string;
  charCount: number;
}

interface Props {
  ticker: string;
  accession: string;
  sections: SectionRef[];
}

interface CachedSection {
  text: string;
  tables: SecTable[];
}

export function SectionNav({ ticker, accession, sections }: Props) {
  const firstKey = sections[0]?.sectionKey ?? '';
  const [active, setActive] = useState(firstKey);
  const [cache, setCache] = useState<Record<string, CachedSection | ''>>({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const hash = window.location.hash;
    const match = hash.match(/^#section-([a-z0-9_]+)$/);
    if (match && sections.some((s) => s.sectionKey === match[1])) {
      setActive(match[1]!);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!active || cache[active] !== undefined) return;
    let cancelled = false;
    setLoading(true);
    fetch(`/api/tickers/${ticker}/filings/${accession}/sections/${active}`)
      .then((r) => r.json())
      .then((d: { text?: string; tables?: SecTable[] }) => {
        if (cancelled) return;
        if (typeof d.text === 'string') {
          setCache((c) => ({ ...c, [active]: { text: d.text!, tables: d.tables ?? [] } }));
        } else {
          setCache((c) => ({ ...c, [active]: '' }));
        }
      })
      .catch(() => {
        if (!cancelled) setCache((c) => ({ ...c, [active]: '' }));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [active, accession, ticker, cache]);

  if (sections.length === 0) return null;

  return (
    <Tabs value={active} onValueChange={setActive}>
      <TabsList className="flex flex-wrap h-auto">
        {sections.map((s) => (
          <TabsTrigger key={s.sectionKey} value={s.sectionKey}>
            {s.sectionTitle}
          </TabsTrigger>
        ))}
      </TabsList>
      {sections.map((s) => {
        const c = cache[s.sectionKey];
        return (
          <TabsContent key={s.sectionKey} value={s.sectionKey}>
            <Card>
              <CardContent className="py-6">
                {c === undefined ? (
                  <p className="text-sm text-muted-foreground">{loading ? 'Loading section…' : ''}</p>
                ) : c === '' ? (
                  <p className="text-sm text-muted-foreground">No text available for this section.</p>
                ) : (
                  <SectionText text={c.text} tables={c.tables} />
                )}
              </CardContent>
            </Card>
          </TabsContent>
        );
      })}
    </Tabs>
  );
}
