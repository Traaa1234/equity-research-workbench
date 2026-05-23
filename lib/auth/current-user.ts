import 'server-only';
import { stackServerApp } from '@/stack';

export async function getCurrentUserId(): Promise<string | null> {
  const user = await stackServerApp.getUser();
  return user?.id ?? null;
}

export async function requireUserId(): Promise<string> {
  const id = await getCurrentUserId();
  if (!id) throw new UnauthorizedError('Not signed in');
  return id;
}

export class UnauthorizedError extends Error {
  readonly status = 401 as const;
}
