import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse } from '@/lib/api/errors';
import { ValidationError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { JournalService, type PositionUpdateInput } from '@/lib/services/journal';

/** Serialize objects that may contain BigInt IDs to plain JSON-safe values. */
function ser<T>(v: T): T {
  return JSON.parse(JSON.stringify(v, (_k, val) =>
    typeof val === 'bigint' ? val.toString() : val
  ));
}

const UpdateSchema = z.object({
  convictionAtOpen: z.number().int().min(1).max(10).nullable().optional(),
  targetPrice: z.number().positive().nullable().optional(),
  stopPrice: z.number().positive().nullable().optional(),
  expectedHoldingDays: z.number().int().positive().nullable().optional()
});

interface Ctx { params: { id: string }; }

function parseId(raw: string): bigint {
  if (!/^\d+$/.test(raw)) throw new ValidationError(`Invalid position id: ${raw}`);
  return BigInt(raw);
}

export async function GET(_req: Request, ctx: Ctx) {
  try {
    let userId: string;
    try { userId = await requireUserId(); }
    catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

    const id = parseId(ctx.params.id);
    const svc = new JournalService({ db: getServiceDb() });
    const pos = await svc.getPosition(userId, id);
    if (!pos) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json(ser(pos), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    return errorResponse(err, { route: 'journal/positions/item' });
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    let userId: string;
    try { userId = await requireUserId(); }
    catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

    const id = parseId(ctx.params.id);
    const body = await req.json().catch(() => ({}));
    const parsed = UpdateSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);

    const svc = new JournalService({ db: getServiceDb() });
    const updated = await svc.updatePosition(userId, id, parsed.data as PositionUpdateInput);
    return NextResponse.json(ser(updated), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    return errorResponse(err, { route: 'journal/positions/item' });
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    let userId: string;
    try { userId = await requireUserId(); }
    catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

    const id = parseId(ctx.params.id);
    const svc = new JournalService({ db: getServiceDb() });
    await svc.deletePosition(userId, id);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err, { route: 'journal/positions/item' });
  }
}
