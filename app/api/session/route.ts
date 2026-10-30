import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getSupabaseAdminClient } from '@/lib/data/supabase/admin';
import {
  authenticateStandalonePrincipal, cookieRefreshToken, SESSION_ACCESS_COOKIE,
  SESSION_REFRESH_COOKIE
} from '@/lib/standalone-accounting/auth';

export const runtime='nodejs';
export const dynamic='force-dynamic';
const cookieOptions=(request:NextRequest,maxAge:number)=>({
  httpOnly:true,secure:process.env.NODE_ENV==='production'||request.nextUrl.protocol==='https:',
  sameSite:'strict' as const,path:'/',maxAge
});
const noStore={'Cache-Control':'no-store, private'};

/** Bootstrap a browser automatically. No user email or login action is required.
 * Existing verified owner sessions take priority; guests never inherit owner data. */
export async function POST(request:NextRequest){
  const origin=request.headers.get('origin');
  if(origin && origin!==request.nextUrl.origin) return NextResponse.json({error:'Origin denied.'},{status:403,headers:noStore});
  const url=process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key=process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if(!url||!key) return NextResponse.json({error:'Katie session service is unavailable.'},{status:503,headers:noStore});
  try{
    // Explicit owner sign-out must revoke the owner cookie rather than silently reuse it.
    const resetToGuest=request.headers.get('x-katie-guest-reset')==='1';
    const presented=resetToGuest?null:request.headers.get('authorization');
    if(presented){
      const owner=await authenticateStandalonePrincipal(request);
      // An anonymous browser Bearer token is not elevated to administrative identity.
      const response=NextResponse.json({ready:true,guest:owner.isAnonymous},{headers:noStore});
      response.cookies.set(SESSION_ACCESS_COOKIE,presented.replace(/^Bearer /,''),cookieOptions(request,1800));
      if(!owner.isAnonymous)response.cookies.delete(SESSION_REFRESH_COOKIE);
      return response;
    }
    // A valid cookie is enough; no second anonymous signup is ever made on reload.
    if(!resetToGuest){
      try{
        const existing=await authenticateStandalonePrincipal(request);
        return NextResponse.json({ready:true,guest:existing.isAnonymous},{headers:noStore});
      }catch{/* Expired or missing access token; try the rotating refresh token. */}
    }
    const client=createClient(url,key,{
      auth:{autoRefreshToken:false,persistSession:false,detectSessionInUrl:false}
    });
    const refresh=resetToGuest?null:cookieRefreshToken(request);
    const result=refresh?await client.auth.refreshSession({refresh_token:refresh})
      :await client.auth.signInAnonymously();
    if(result.error||!result.data.session||!result.data.user){
      return NextResponse.json({error:'Automatic guest sessions are unavailable. Enable anonymous sign-ins and abuse protection in Supabase Auth.'},{status:503,headers:noStore});
    }
    if(result.data.user.is_anonymous!==true && !refresh)throw Error('Guest identity not anonymous');
    const session=result.data.session;
    const guest=result.data.user.is_anonymous===true;
    if(guest){
      const workspace=await getSupabaseAdminClient().rpc('standalone_guest_workspace',{p_owner:result.data.user.id});
      if(workspace.error||!workspace.data)throw Error('Guest workspace enrollment unavailable');
    }
    const response=NextResponse.json({ready:true,guest},{headers:noStore});
    response.cookies.set(SESSION_ACCESS_COOKIE,session.access_token,cookieOptions(request,Math.max(60,Math.min(1800,session.expires_in??1800))));
    if(guest)response.cookies.set(SESSION_REFRESH_COOKIE,session.refresh_token,cookieOptions(request,7*86400));
    return response;
  }catch{
    return NextResponse.json({error:'Katie session verification failed; no conversation access was granted.'},{status:503,headers:noStore});
  }
}

