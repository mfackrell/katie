import { NextRequest,NextResponse } from 'next/server';
import { assertCronAuth } from '@/lib/runpod/durable-results';
import { reconcileWaitingQwenJobs } from '@/lib/chat/runpod-still-recovery';

export const dynamic='force-dynamic';
export const maxDuration=240;

export async function GET(request:NextRequest){
  if(!assertCronAuth(request))return NextResponse.json({error:'unauthorized'},{status:401});
  try{
    const result=await reconcileWaitingQwenJobs();
    return NextResponse.json(result,{headers:{'Cache-Control':'no-store'}});
  }catch(error){
    console.error('[QwenRecovery] supervisor failed',{
      name:error instanceof Error?error.name:'UnknownError',
    });
    return NextResponse.json({error:'Qwen recovery supervisor unavailable'},{status:503});
  }
}
