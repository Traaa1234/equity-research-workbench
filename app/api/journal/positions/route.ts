import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse } from '@/lib/api/errors';
import { ValidationError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { JournalService, type ListPositionsOpts, type NewPositionInput } from '@/lib/services/journal';

/** Serialize objects that may contain BigInt IDs to plain JSON-safe values. */
function ser<T>(v: T): T {
  return JSON.parse(JSON.stringify(v, (_k, val) =>
    typeof val === 'bigint' ? val.toString() : val
  ));
}

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;

const NewPositionSchema = z.object({
  ticker: z.string().regex(TICKER_RE),
  openedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  convictionAtOpen: z.number().int().min(1).max(10).optional(),
  targetPrice: z.number().positive().optional(),
  stopPrice: z.number().positive().optional(),
  expectedHoldingDays: z.number().int().positive().optional(),
  firstEntry: z.object({
    thesisMd: z.string().max(50_000),
    convictionAtTime: z.number().int().min(1).max(10).optional()
  }).optional()
});

const ListQuerySchema = z.object({
  status: z.enum(['open', 'closed']).optional(),
  ticker: z.string().regex(TICKER_RE).optional(),
  minConviction: z.coerce.number().int().min(1).max(10).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().min(0).optional()
});

export async function GET(req: Request) {
  try {
    let userId: string;
    try { userId = await requireUserId(); }
    catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

    const url = new URL(req.url);
    const parsed = ListQuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) throw new ValidationError(parsed.error.message);

    const svc = new JournalService({ db: getServiceDb() });
    const items = await svc.listPositions(userId, parsed.data as ListPositionsOpts);
    return NextResponse.json(ser({ items }), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    return errorResponse(err, { route: 'journal/positions' });
  }
}

export async function POST(req: Request) {
  try {
    let userId: string;
    try { userId = await requireUserId(); }
    catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

    const body = await req.json().catch(() => ({}));
    const parsed = NewPositionSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);

    const svc = new JournalService({ db: getServiceDb() });
    const created = await svc.createPosition(userId, parsed.data as NewPositionInput);
    return NextResponse.json(ser(created), { status: 201, headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    return errorResponse(err, { route: 'journal/positions' });
  }
}
