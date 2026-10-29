import { NextRequest,NextResponse } from 'next/server';
import { assertCronAuth } from '@/lib/runpod/durable-results';
import { refreshStandalonePricing } from '@/lib/standalone-accounting/pricing-intake';
import { createStandaloneLedger } from '@/lib/standalone-accounting/ledger';
export async function GET(request:NextRequest){
 if(!assertCronAuth(request))return NextResponse.json({error:'Unauthorized'},{status:401});
 try{const snapshot=await refreshStandalonePricing(createStandaloneLedger());return NextResponse.json({ok:true,version:snapshot.version,models:snapshot.models.length});}
 catch{return NextResponse.json({error:'Pricing refresh failed; previous immutable versions retained.'},{status:503});}
}
export const runtime='nodejs';

export const maxDuration=60;
