import {reconcileExecutiveFinance} from '@/lib/executive/autonomous';
import {reconcileExecutiveManagement} from '@/lib/executive/general';
import {runRecoveryBatch} from '@/lib/recovery/worker';
import {runProjectBatch} from '@/lib/projects/worker';
import { NextRequest,NextResponse } from 'next/server';
import { assertCronAuth } from '@/lib/runpod/durable-results';
import { runMissionBatch } from '@/lib/missions/worker';
export const dynamic='force-dynamic';
export const maxDuration=240;
export async function GET(request:NextRequest){
 if(!assertCronAuth(request))return NextResponse.json({error:'unauthorized'},{status:401});
 try{
  // Admission paths share the same database and advisory lock. Serialize only
  // their batch entrypoints within a dispatcher invocation; each batch retains
  // its own fenced leases and execution logic.
  const projects=await runProjectBatch();
  const missions=await runMissionBatch();
  const recovery=await runRecoveryBatch().catch(error=>{console.error('[Recovery] Supervisor failed',error instanceof Error?error.message:'Unknown error');return{status:'unavailable',discovered:0};});
  const executive=await reconcileExecutiveFinance().catch(error=>{console.error('[Executive] Reconcile failed',error);return{verified:0,blocked:0};});
  const executiveManagement=await reconcileExecutiveManagement().catch(error=>{console.error('[Executive] Management reconciliation failed',error);return{completed:0,blocked:0,working:0};});
  return NextResponse.json({...missions,projects,recovery,executive,executiveManagement},{headers:{'Cache-Control':'no-store'}});}
 catch(error){console.error('[Missions] Background dispatcher failed',error);return NextResponse.json({error:'Mission dispatcher unavailable'},{status:503});}
}
