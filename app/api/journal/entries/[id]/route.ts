import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse } from '@/lib/api/errors';
import { ValidationError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { JournalService, type EntryUpdateInput } from '@/lib/services/journal';

/** Serialize objects that may contain BigInt IDs to plain JSON-safe values. */
function ser<T>(v: T): T {
  return JSON.parse(JSON.stringify(v, (_k, val) =>
    typeof val === 'bigint' ? val.toString() : val
  ));
}

const UpdateSchema = z.object({
  thesisMd: z.string().max(50_000).optional(),
  convictionAtTime: z.number().int().min(1).max(10).nullable().optional(),
  outcome: z.enum(['right', 'wrong', 'mixed']).nullable().optional(),
  whatChanged: z.string().max(50_000).nullable().optional(),
  lessons: z.string().max(50_000).nullable().optional()
});

interface Ctx { params: { id: string }; }

function parseId(raw: string): bigint {
  if (!/^\d+$/.test(raw)) throw new ValidationError(`Invalid entry id: ${raw}`);
  return BigInt(raw);
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
    try {
      const updated = await svc.updateEntry(userId, id, parsed.data as EntryUpdateInput);
      return NextResponse.json(ser(updated), { headers: { 'Cache-Control': 'private, no-store' } });
    } catch (err) {
      if (/permission|not found/i.test(String(err))) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }
      throw err;
    }
  } catch (err) {
    return errorResponse(err, { route: 'journal/entries/item' });
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    let userId: string;
    try { userId = await requireUserId(); }
    catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

    const id = parseId(ctx.params.id);
    const svc = new JournalService({ db: getServiceDb() });
    try {
      await svc.deleteEntry(userId, id);
      return new NextResponse(null, { status: 204 });
    } catch (err) {
      if (/permission|not found/i.test(String(err))) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }
      throw err;
    }
  } catch (err) {
    return errorResponse(err, { route: 'journal/entries/item' });
  }
}
