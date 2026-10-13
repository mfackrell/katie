import { NextRequest, NextResponse } from 'next/server';
import { syntheticAccess, startSyntheticValidation, syntheticStatus, cleanupSyntheticValidation } from '@/lib/runpod/synthetic-validation';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 45;
const headers = {'cache-control':'no-store'};
async function handle(request: NextRequest, action: () => Promise<unknown>) {
  const denied = syntheticAccess(request);
  if (denied) return NextResponse.json({error:denied === 401 ? 'unauthorized' : 'disabled'},{status:denied,headers});
  try {return NextResponse.json(await action(),{headers});}
  catch {return NextResponse.json({error:'synthetic_validation_failed'},{status:503,headers});}
}
export async function POST(request: NextRequest) {return handle(request,startSyntheticValidation);}
export async function GET(request: NextRequest) {return handle(request,syntheticStatus);}
export async function DELETE(request: NextRequest) {return handle(request,cleanupSyntheticValidation);}
