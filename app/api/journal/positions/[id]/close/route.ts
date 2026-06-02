import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse } from '@/lib/api/errors';
import { ValidationError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { JournalService, type ClosePositionInput } from '@/lib/services/journal';

/** Serialize objects that may contain BigInt IDs to plain JSON-safe values. */
function ser<T>(v: T): T {
  return JSON.parse(JSON.stringify(v, (_k, val) =>
    typeof val === 'bigint' ? val.toString() : val
  ));
}

const CloseSchema = z.object({
  closedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  exitEntry: z.object({
    kind: z.literal('exit'),
    occurredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    thesisMd: z.string().max(50_000),
    convictionAtTime: z.number().int().min(1).max(10).optional(),
    outcome: z.enum(['right', 'wrong', 'mixed']).optional(),
    whatChanged: z.string().max(50_000).optional(),
    lessons: z.string().max(50_000).optional()
  }).optional()
});

interface Ctx { params: { id: string }; }

export async function POST(req: Request, ctx: Ctx) {
  try {
    let userId: string;
    try { userId = await requireUserId(); }
    catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

    if (!/^\d+$/.test(ctx.params.id)) throw new ValidationError(`Invalid id: ${ctx.params.id}`);
    const id = BigInt(ctx.params.id);

    const body = await req.json().catch(() => ({}));
    const parsed = CloseSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);

    const svc = new JournalService({ db: getServiceDb() });
    const result = await svc.closePosition(userId, id, parsed.data as ClosePositionInput);
    return NextResponse.json(ser(result), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    return errorResponse(err, { route: 'journal/positions/close' });
  }
}
