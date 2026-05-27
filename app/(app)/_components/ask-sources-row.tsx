// app/(app)/_components/ask-sources-row.tsx
'use client';

import { AskSourceCard } from './ask-source-card';

interface Source {
  marker: number;
  ticker: string;
  formType: string;
  filingDate: string;
  sectionKey: string;
  sectionTitle: string;
  accessionNo: string;
  snippet: string;
  distance: number;
}

interface Props {
  sources: Source[];
  highlightedMarker: number | null;
}

export function AskSourcesRow({ sources, highlightedMarker }: Props) {
  if (sources.length === 0) return null;
  return (
    <div className="overflow-x-auto pb-2">
      <div className="flex gap-3">
        {sources.map((s) => (
          <AskSourceCard
            key={s.marker}
            marker={s.marker}
            ticker={s.ticker}
            formType={s.formType}
            filingDate={s.filingDate}
            sectionKey={s.sectionKey}
            sectionTitle={s.sectionTitle}
            accessionNo={s.accessionNo}
            snippet={s.snippet}
            distance={s.distance}
            highlighted={highlightedMarker === s.marker}
          />
        ))}
      </div>
    </div>
  );
}
