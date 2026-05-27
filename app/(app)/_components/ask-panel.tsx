// app/(app)/_components/ask-panel.tsx
'use client';

import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { AskInput } from './ask-input';
import { AskSourcesRow } from './ask-sources-row';
import { AskAnswer } from './ask-answer';
import { AskSkeleton } from './ask-skeleton';

type Scope = { type: 'watchlist' } | { type: 'ticker'; ticker: string };

interface Source {
  marker: number;
  ticker: string;
  companyName: string;
  formType: string;
  filingDate: string;
  sectionKey: string;
  sectionTitle: string;
  accessionNo: string;
  snippet: string;
  distance: number;
}

interface Props {
  scope: Scope;
  placeholder?: string;
  examples?: string[];
}

type State =
  | { kind: 'idle' }
  | { kind: 'retrieving' }
  | { kind: 'streaming'; sources: Source[]; answer: string }
  | { kind: 'done'; sources: Source[]; answer: string }
  | { kind: 'error'; message: string };

export function AskPanel({ scope, placeholder, examples }: Props) {
  const [input, setInput] = useState('');
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [highlightedMarker, setHighlightedMarker] = useState<number | null>(null);

  async function submit() {
    const trimmed = input.trim();
    if (trimmed.length === 0) return;
    setInput('');
    setState({ kind: 'retrieving' });

    try {
      const res = await fetch('/api/rag/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: trimmed, scope })
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        setState({
          kind: 'error',
          message: `Q&A failed (HTTP ${res.status}): ${errBody.slice(0, 200)}`
        });
        return;
      }

      // Parse sources from X-Rag-Sources header
      const sourcesHeader = res.headers.get('X-Rag-Sources');
      const sources: Source[] = sourcesHeader
        ? (JSON.parse(atob(sourcesHeader)) as Source[])
        : [];

      setState({ kind: 'streaming', sources, answer: '' });

      // Stream tokens
      if (!res.body) {
        setState({ kind: 'error', message: 'No response body to stream from' });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        accumulated += decoder.decode(value, { stream: true });
        setState({ kind: 'streaming', sources, answer: accumulated });
      }

      setState({ kind: 'done', sources, answer: accumulated });
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Unknown error'
      });
    }
  }

  function askAnother() {
    setState({ kind: 'idle' });
    setInput('');
    setHighlightedMarker(null);
  }

  if (state.kind === 'error') {
    return (
      <div className="space-y-4">
        <Card>
          <CardContent className="py-6 space-y-3">
            <p className="text-sm text-muted-foreground">Q&A unavailable: {state.message}</p>
            <button onClick={askAnother} className="text-sm text-primary hover:underline">
              Try again
            </button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const showInput = state.kind === 'idle';
  const isStreaming = state.kind === 'streaming';
  const showResults = state.kind === 'streaming' || state.kind === 'done';
  const sources = showResults ? state.sources : [];
  const answer = showResults ? state.answer : '';
  const isBusy = state.kind === 'retrieving' || state.kind === 'streaming';

  return (
    <div className="space-y-4">
      {showInput && (
        <>
          <AskInput
            value={input}
            onChange={setInput}
            onSubmit={submit}
            busy={isBusy}
            placeholder={placeholder ?? '🔍 Ask a question about your filings…'}
          />
          {examples && examples.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Examples: {examples.map((ex, i) => (
                <span key={i}>
                  {i > 0 && ', '}
                  <span className="italic">&quot;{ex}&quot;</span>
                </span>
              ))}
            </p>
          )}
        </>
      )}

      {state.kind === 'retrieving' && <AskSkeleton />}

      {sources.length > 0 && (
        <AskSourcesRow sources={sources} highlightedMarker={highlightedMarker} />
      )}

      {answer && (
        <AskAnswer
          text={answer}
          isStreaming={isStreaming}
          maxMarker={sources.length}
          onMarkerHover={setHighlightedMarker}
        />
      )}

      {state.kind === 'done' && (
        <button
          onClick={askAnother}
          className="text-sm text-primary hover:underline"
        >
          Ask another question
        </button>
      )}
    </div>
  );
}
