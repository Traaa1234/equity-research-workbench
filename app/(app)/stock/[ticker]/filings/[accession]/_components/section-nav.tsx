'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

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

export function SectionNav({ ticker, accession, sections }: Props) {
  const firstKey = sections[0]?.sectionKey ?? '';
  const [active, setActive] = useState(firstKey);
  const [textCache, setTextCache] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!active || textCache[active] !== undefined) return;
    let cancelled = false;
    setLoading(true);
    fetch(`/api/tickers/${ticker}/filings/${accession}/sections/${active}`)
      .then((r) => r.json())
      .then((d: { text: string }) => {
        if (!cancelled) {
          setTextCache((c) => ({ ...c, [active]: d.text ?? '' }));
        }
      })
      .catch(() => {
        if (!cancelled) setTextCache((c) => ({ ...c, [active]: '' }));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [active, accession, ticker, textCache]);

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
      {sections.map((s) => (
        <TabsContent key={s.sectionKey} value={s.sectionKey}>
          <Card>
            <CardContent className="py-6">
              {textCache[s.sectionKey] === undefined ? (
                <p className="text-sm text-muted-foreground">{loading ? 'Loading section…' : ''}</p>
              ) : textCache[s.sectionKey] === '' ? (
                <p className="text-sm text-muted-foreground">No text available for this section.</p>
              ) : (
                <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">
                  {textCache[s.sectionKey]}
                </pre>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      ))}
    </Tabs>
  );
}
