// app/(app)/_components/ask-input.tsx
'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormEvent } from 'react';

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  busy: boolean;
  placeholder: string;
}

export function AskInput({ value, onChange, onSubmit, busy, placeholder }: Props) {
  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (value.trim().length === 0) return;
    onSubmit();
  }

  return (
    <form onSubmit={handleSubmit} className="flex gap-2">
      <label htmlFor="ask-input" className="sr-only">Ask a question</label>
      <Input
        id="ask-input"
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1"
        maxLength={500}
        disabled={busy}
      />
      <Button type="submit" disabled={busy || value.trim().length === 0} aria-label="Submit question">
        {busy ? 'Asking…' : 'Submit'}
      </Button>
    </form>
  );
}
