import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { validTimezone } from '@/lib/standalone-accounting/daily';
import { accountingError, accountingScope, noStore, scopeSchema } from '../_shared';

const microusd = z.string().regex(/^\d+$/).refine(value => BigInt(value) <= 9223372036854775807n, 'Amount is too large').nullable();
const configuration = scopeSchema.extend({ timezone: z.string().refine(validTimezone, 'A valid timezone is required'), perCallLimitMicrousd: microusd, requestLimitMicrousd: microusd }).strict();
export async function GET(request: NextRequest) {
  try {
    const scope = scopeSchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const { ownerId, ledger } = await accountingScope(request, scope);
    return NextResponse.json({ configuration: await ledger.readConfiguration(ownerId) }, { headers: noStore });
  } catch (error) { return accountingError(error); }
}
export async function PATCH(request: NextRequest) {
  try {
    const input = configuration.parse(await request.json());
    const { ownerId, ledger } = await accountingScope(request, input);
    const saved = await ledger.configure(ownerId, input);
    return NextResponse.json({ configuration: saved }, { headers: noStore });
  } catch (error) { return accountingError(error); }
}
