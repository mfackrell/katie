import {runProjectBatch} from '@/lib/projects/worker';
import { NextRequest,NextResponse } from 'next/server';
import { assertCronAuth } from '@/lib/runpod/durable-results';
import { runMissionBatch } from '@/lib/missions/worker';
export const dynamic='force-dynamic';
export const maxDuration=240;
export async function GET(request:NextRequest){
 if(!assertCronAuth(request))return NextResponse.json({error:'unauthorized'},{status:401});
 try{const projects=await runProjectBatch();return NextResponse.json({...await runMissionBatch(),projects},{headers:{'Cache-Control':'no-store'}});}
 catch(error){console.error('[Missions] Background dispatcher failed',error);return NextResponse.json({error:'Mission dispatcher unavailable'},{status:503});}
}
