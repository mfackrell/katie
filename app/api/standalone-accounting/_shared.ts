import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeStandaloneCaller } from '@/lib/standalone-accounting/auth';
import { createStandaloneLedger } from '@/lib/standalone-accounting/ledger';

export const scopeSchema = z.object({ actorId: z.string().uuid(), chatId: z.string().uuid() });
export const noStore = { 'Cache-Control': 'no-store' };
export async function accountingScope(request: Request, scope: { actorId: string; chatId: string }) {
  const ownerId = await authorizeStandaloneCaller(request, scope.actorId, scope.chatId);
  return { ownerId, ledger: createStandaloneLedger() };
}
export function accountingError(error: unknown) {
  if (error instanceof z.ZodError || error instanceof SyntaxError) return NextResponse.json({ error: 'Invalid accounting request.' }, { status: 400, headers: noStore });
  // Auth errors are deliberately generic. Never reveal another owner's records.
  const status = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : 503;
  return NextResponse.json({ error: status === 401 ? 'Owner sign-in required.' : status === 403 ? 'This conversation is not authorized for this owner.' : 'Accounting is unavailable or this decision is stale. Refresh before trying again.' }, { status: [401, 403, 404, 409].includes(status) ? status : 503, headers: noStore });
}
