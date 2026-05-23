'use client';

import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

export function NotesEditor({ ticker }: { ticker: string }) {
  const [body, setBody] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [saving, setSaving] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/notes/${ticker}`)
      .then((r) => r.json())
      .then((d: { body: string }) => {
        if (!cancelled) {
          setBody(d.body);
          setLoaded(true);
        }
      })
      .catch(() => setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, [ticker]);

  useEffect(() => {
    if (!loaded) return;
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(async () => {
      setSaving(true);
      try {
        const res = await fetch(`/api/notes/${ticker}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ body })
        });
        if (res.ok) setSavedAt(new Date());
      } finally {
        setSaving(false);
      }
    }, 1000);
    return () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    };
  }, [body, loaded, ticker]);

  if (!loaded) return <p className="text-sm text-muted-foreground">Loading…</p>;

  return (
    <Tabs defaultValue="edit">
      <TabsList>
        <TabsTrigger value="edit">Edit</TabsTrigger>
        <TabsTrigger value="preview">Preview</TabsTrigger>
      </TabsList>
      <TabsContent value="edit">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={8}
          className="w-full bg-background border border-border rounded p-3 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          placeholder={`# ${ticker} thesis\n\nWhat I believe and why...`}
        />
        <p className="mt-2 text-xs text-muted-foreground">
          {saving ? 'Saving…' : savedAt ? `Saved ${savedAt.toLocaleTimeString()}` : 'Autosaves on change'}
        </p>
      </TabsContent>
      <TabsContent value="preview">
        <div className="max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{body || '_Empty_'}</ReactMarkdown>
        </div>
      </TabsContent>
    </Tabs>
  );
}
