import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { StandaloneAuthorizationError } from '@/lib/standalone-accounting/auth';
import { preferenceScopeSchema, resolveRoutingPreferences, writeRoutingPreference } from '@/lib/routing-preferences/server';

function failure(error: unknown) {
  const status = error instanceof StandaloneAuthorizationError ? 403 : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 503;
  return NextResponse.json({error: status === 403 ? 'Preference access denied.' : status === 400 ? 'Invalid preferences.' : 'Preferences unavailable.'}, {status, headers: {'Cache-Control': 'no-store'}});
}
export async function GET(request: NextRequest) {
  try {
    const scope = preferenceScopeSchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    return NextResponse.json(await resolveRoutingPreferences(request, scope), {headers: {'Cache-Control': 'no-store'}});
  } catch (error) { return failure(error); }
}
export async function PATCH(request: NextRequest) {
  try {
    return NextResponse.json(await writeRoutingPreference(request, await request.json()), {headers: {'Cache-Control': 'no-store'}});
  } catch (error) { return failure(error); }
}
