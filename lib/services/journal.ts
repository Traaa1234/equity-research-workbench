import { and, asc, desc, eq, gte } from 'drizzle-orm';
import type { ServiceDb } from '@/lib/db/client';
import { journalPositions, journalEntries } from '@/lib/db/schema';
import { validateNewPosition, validateNewEntry } from '@/lib/compute/journal-validation';

export interface JournalPosition {
  id: bigint;
  userId: string;
  ticker: string;
  status: 'open' | 'closed';
  openedAt: string;
  closedAt: string | null;
  convictionAtOpen: number | null;
  targetPrice: string | null;
  stopPrice: string | null;
  expectedHoldingDays: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface JournalEntry {
  id: bigint;
  positionId: bigint;
  kind: 'entry' | 'review' | 'exit';
  occurredAt: string;
  thesisMd: string;
  convictionAtTime: number | null;
  outcome: 'right' | 'wrong' | 'mixed' | null;
  whatChanged: string | null;
  lessons: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PositionWithEntries extends JournalPosition {
  entries: JournalEntry[];
}

export interface NewPositionInput {
  ticker: string;
  openedAt: string;
  convictionAtOpen?: number;
  targetPrice?: number;
  stopPrice?: number;
  expectedHoldingDays?: number;
  firstEntry?: { thesisMd: string; convictionAtTime?: number };
}

export interface PositionUpdateInput {
  convictionAtOpen?: number | null;
  targetPrice?: number | null;
  stopPrice?: number | null;
  expectedHoldingDays?: number | null;
}

export interface NewEntryInput {
  kind: 'entry' | 'review' | 'exit';
  occurredAt: string;
  thesisMd: string;
  convictionAtTime?: number;
  outcome?: 'right' | 'wrong' | 'mixed';
  whatChanged?: string;
  lessons?: string;
}

export interface EntryUpdateInput {
  thesisMd?: string;
  convictionAtTime?: number | null;
  outcome?: 'right' | 'wrong' | 'mixed' | null;
  whatChanged?: string | null;
  lessons?: string | null;
}

export interface ClosePositionInput {
  closedAt: string;
  exitEntry?: NewEntryInput;
}

export interface ListPositionsOpts {
  ticker?: string;
  status?: 'open' | 'closed';
  minConviction?: number;
  limit?: number;
  offset?: number;
}

export class JournalService {
  constructor(private readonly deps: { db: ServiceDb }) {}

  async listPositions(userId: string, opts: ListPositionsOpts = {}): Promise<JournalPosition[]> {
    const conds = [eq(journalPositions.userId, userId)];
    if (opts.ticker) conds.push(eq(journalPositions.ticker, opts.ticker.toUpperCase()));
    if (opts.status) conds.push(eq(journalPositions.status, opts.status));
    if (opts.minConviction != null) {
      conds.push(gte(journalPositions.convictionAtOpen, opts.minConviction));
    }
    const rows = await this.deps.db.select()
      .from(journalPositions)
      .where(and(...conds))
      .orderBy(desc(journalPositions.openedAt))
      .limit(opts.limit ?? 100)
      .offset(opts.offset ?? 0);
    return rows.map((r) => ({ ...r, status: r.status as 'open' | 'closed' }));
  }

  async getPosition(userId: string, positionId: bigint): Promise<PositionWithEntries | null> {
    const posRows = await this.deps.db.select()
      .from(journalPositions)
      .where(and(eq(journalPositions.id, positionId), eq(journalPositions.userId, userId)))
      .limit(1);
    const pos = posRows[0];
    if (!pos) return null;
    const entries = await this.deps.db.select()
      .from(journalEntries)
      .where(eq(journalEntries.positionId, positionId))
      .orderBy(asc(journalEntries.occurredAt));
    return {
      ...pos,
      status: pos.status as 'open' | 'closed',
      entries: entries.map((e) => ({
        ...e,
        kind: e.kind as 'entry' | 'review' | 'exit',
        outcome: e.outcome as 'right' | 'wrong' | 'mixed' | null
      }))
    };
  }

  async createPosition(userId: string, input: NewPositionInput): Promise<JournalPosition> {
    validateNewPosition(input);
    return await this.deps.db.transaction(async (tx) => {
      const [row] = await tx.insert(journalPositions).values({
        userId,
        ticker: input.ticker.toUpperCase(),
        status: 'open',
        openedAt: input.openedAt,
        convictionAtOpen: input.convictionAtOpen,
        targetPrice: input.targetPrice != null ? String(input.targetPrice) : null,
        stopPrice: input.stopPrice != null ? String(input.stopPrice) : null,
        expectedHoldingDays: input.expectedHoldingDays
      }).returning();
      if (input.firstEntry) {
        await tx.insert(journalEntries).values({
          positionId: row!.id, kind: 'entry', occurredAt: input.openedAt,
          thesisMd: input.firstEntry.thesisMd,
          convictionAtTime: input.firstEntry.convictionAtTime ?? input.convictionAtOpen
        });
      }
      return { ...row!, status: row!.status as 'open' | 'closed' };
    });
  }

  async updatePosition(userId: string, positionId: bigint, input: PositionUpdateInput): Promise<JournalPosition> {
    if (input.convictionAtOpen != null && (input.convictionAtOpen < 1 || input.convictionAtOpen > 10)) {
      throw new Error(`conviction must be in [1, 10]: ${input.convictionAtOpen}`);
    }
    if (input.targetPrice != null && input.targetPrice <= 0) throw new Error('target_price must be positive');
    if (input.stopPrice != null && input.stopPrice <= 0) throw new Error('stop_price must be positive');

    const setFields: Record<string, unknown> = { updatedAt: new Date() };
    if ('convictionAtOpen' in input) setFields.convictionAtOpen = input.convictionAtOpen;
    if ('targetPrice' in input) setFields.targetPrice = input.targetPrice != null ? String(input.targetPrice) : null;
    if ('stopPrice' in input) setFields.stopPrice = input.stopPrice != null ? String(input.stopPrice) : null;
    if ('expectedHoldingDays' in input) setFields.expectedHoldingDays = input.expectedHoldingDays;

    const [row] = await this.deps.db.update(journalPositions)
      .set(setFields)
      .where(and(eq(journalPositions.id, positionId), eq(journalPositions.userId, userId)))
      .returning();
    if (!row) throw new Error('position not found or permission denied');
    return { ...row, status: row.status as 'open' | 'closed' };
  }

  async closePosition(userId: string, positionId: bigint, input: ClosePositionInput): Promise<PositionWithEntries> {
    return await this.deps.db.transaction(async (tx) => {
      const [row] = await tx.update(journalPositions)
        .set({ status: 'closed', closedAt: input.closedAt, updatedAt: new Date() })
        .where(and(eq(journalPositions.id, positionId), eq(journalPositions.userId, userId)))
        .returning();
      if (!row) throw new Error('position not found or permission denied');
      if (input.exitEntry) {
        validateNewEntry(input.exitEntry);
        await tx.insert(journalEntries).values({
          positionId,
          kind: input.exitEntry.kind,
          occurredAt: input.exitEntry.occurredAt,
          thesisMd: input.exitEntry.thesisMd,
          convictionAtTime: input.exitEntry.convictionAtTime,
          outcome: input.exitEntry.outcome,
          whatChanged: input.exitEntry.whatChanged,
          lessons: input.exitEntry.lessons
        });
      }
      const entries = await tx.select().from(journalEntries)
        .where(eq(journalEntries.positionId, positionId))
        .orderBy(asc(journalEntries.occurredAt));
      return {
        ...row,
        status: row.status as 'open' | 'closed',
        entries: entries.map((e) => ({
          ...e,
          kind: e.kind as 'entry' | 'review' | 'exit',
          outcome: e.outcome as 'right' | 'wrong' | 'mixed' | null
        }))
      };
    });
  }

  async deletePosition(userId: string, positionId: bigint): Promise<void> {
    const result = await this.deps.db.delete(journalPositions)
      .where(and(eq(journalPositions.id, positionId), eq(journalPositions.userId, userId)))
      .returning({ id: journalPositions.id });
    if (result.length === 0) throw new Error('position not found or permission denied');
  }

  async createEntry(userId: string, positionId: bigint, input: NewEntryInput): Promise<JournalEntry> {
    validateNewEntry(input);
    const owns = await this.deps.db.select({ id: journalPositions.id }).from(journalPositions)
      .where(and(eq(journalPositions.id, positionId), eq(journalPositions.userId, userId)))
      .limit(1);
    if (owns.length === 0) throw new Error('position not found or permission denied');

    const [row] = await this.deps.db.insert(journalEntries).values({
      positionId,
      kind: input.kind,
      occurredAt: input.occurredAt,
      thesisMd: input.thesisMd,
      convictionAtTime: input.convictionAtTime,
      outcome: input.outcome,
      whatChanged: input.whatChanged,
      lessons: input.lessons
    }).returning();
    return {
      ...row!,
      kind: row!.kind as 'entry' | 'review' | 'exit',
      outcome: row!.outcome as 'right' | 'wrong' | 'mixed' | null
    };
  }

  async updateEntry(userId: string, entryId: bigint, input: EntryUpdateInput): Promise<JournalEntry> {
    if (input.convictionAtTime != null && (input.convictionAtTime < 1 || input.convictionAtTime > 10)) {
      throw new Error(`conviction must be in [1, 10]`);
    }
    const owns = await this.deps.db.select({ id: journalEntries.id })
      .from(journalEntries)
      .innerJoin(journalPositions, eq(journalPositions.id, journalEntries.positionId))
      .where(and(eq(journalEntries.id, entryId), eq(journalPositions.userId, userId)))
      .limit(1);
    if (owns.length === 0) throw new Error('entry not found or permission denied');

    const setFields: Record<string, unknown> = { updatedAt: new Date() };
    if ('thesisMd' in input) setFields.thesisMd = input.thesisMd;
    if ('convictionAtTime' in input) setFields.convictionAtTime = input.convictionAtTime;
    if ('outcome' in input) setFields.outcome = input.outcome;
    if ('whatChanged' in input) setFields.whatChanged = input.whatChanged;
    if ('lessons' in input) setFields.lessons = input.lessons;

    const [row] = await this.deps.db.update(journalEntries)
      .set(setFields)
      .where(eq(journalEntries.id, entryId))
      .returning();
    return {
      ...row!,
      kind: row!.kind as 'entry' | 'review' | 'exit',
      outcome: row!.outcome as 'right' | 'wrong' | 'mixed' | null
    };
  }

  async deleteEntry(userId: string, entryId: bigint): Promise<void> {
    const owns = await this.deps.db.select({ id: journalEntries.id })
      .from(journalEntries)
      .innerJoin(journalPositions, eq(journalPositions.id, journalEntries.positionId))
      .where(and(eq(journalEntries.id, entryId), eq(journalPositions.userId, userId)))
      .limit(1);
    if (owns.length === 0) throw new Error('entry not found or permission denied');

    await this.deps.db.delete(journalEntries).where(eq(journalEntries.id, entryId));
  }
}
