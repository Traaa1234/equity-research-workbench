// app/(app)/_components/ask-answer.tsx
'use client';

import { Card, CardContent } from '@/components/ui/card';
import { useMemo } from 'react';

interface Props {
  text: string;
  isStreaming: boolean;
  maxMarker: number;
  onMarkerHover: (marker: number | null) => void;
}

export function AskAnswer({ text, isStreaming, maxMarker, onMarkerHover }: Props) {
  const parts = useMemo(() => {
    // Match [N] and [N, M, ...] (single or multi-marker citations)
    const regex = /\[(\d[\d,\s]*)\]/g;
    const out: Array<{ kind: 'text'; value: string } | { kind: 'cite'; markers: number[]; raw: string }> = [];
    let lastIdx = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIdx) {
        out.push({ kind: 'text', value: text.slice(lastIdx, match.index) });
      }
      const markers = match[1]!.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
      out.push({ kind: 'cite', markers, raw: match[0] });
      lastIdx = regex.lastIndex;
    }
    if (lastIdx < text.length) {
      out.push({ kind: 'text', value: text.slice(lastIdx) });
    }
    return out;
  }, [text]);

  return (
    <Card>
      <CardContent className="py-6 space-y-2">
        <p className="text-sm leading-relaxed whitespace-pre-wrap">
          {parts.map((p, i) => {
            if (p.kind === 'text') return <span key={i}>{p.value}</span>;
            const validMarkers = p.markers.filter((n) => n >= 1 && n <= maxMarker);
            if (validMarkers.length === 0) return <span key={i}>{p.raw}</span>;
            return (
              <sup
                key={i}
                className="cursor-pointer text-primary font-medium ml-0.5"
                onMouseEnter={() => onMarkerHover(validMarkers[0]!)}
                onMouseLeave={() => onMarkerHover(null)}
              >
                {p.raw}
              </sup>
            );
          })}
          {isStreaming && (
            <span
              className="ml-1 inline-block w-2 h-4 bg-foreground animate-pulse align-middle"
              aria-hidden
            />
          )}
        </p>
      </CardContent>
    </Card>
  );
}
