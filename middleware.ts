import { NextRequest, NextResponse } from 'next/server';
const SESSION_ACCESS_COOKIE='katie_session_access';

const noStore = {'Cache-Control':'no-store, private'};
const guestPaths=[
  '/api/actors','/api/chats','/api/messages','/api/chat','/api/chat/status',
  '/api/long-term-memory','/api/standalone-accounting/',
  '/api/models','/api/version','/api/upload/'
];
function guestAllowed(path:string):boolean{
  return guestPaths.some(prefix=>path===prefix||prefix.endsWith('/')&&path.startsWith(prefix));
}
export async function middleware(request:NextRequest){
  const path=request.nextUrl.pathname;
  if(path==='/api/session'||path.startsWith('/api/internal/')||
    path.startsWith('/api/health/'))return NextResponse.next();
  const url=process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key=process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if(!url||!key)return NextResponse.json({error:'Session verification unavailable.'},{status:503,headers:noStore});
  const bearer=request.headers.get('authorization');
  const token=bearer?.startsWith('Bearer ')?bearer.slice(7):request.cookies.get(SESSION_ACCESS_COOKIE)?.value;
  if(!token||!(/^[A-Za-z0-9._~-]+$/.test(token))||token.length>8192)
    return NextResponse.json({error:'Katie session required.'},{status:401,headers:noStore});
  let principal:{id?:unknown;is_anonymous?:unknown};
  try{
    const response=await fetch(url.replace(/\/$/,'')+'/auth/v1/user',{
      headers:{Authorization:'Bearer '+token,apikey:key},
      signal:AbortSignal.timeout(5000),cache:'no-store',redirect:'error'
    });
    if(!response.ok){await response.body?.cancel();throw Error('invalid auth');}
    principal=await response.json();
  }catch{return NextResponse.json({error:'Katie session expired. Reload to renew it.'},{status:401,headers:noStore});}
  if(typeof principal.id!=='string')return NextResponse.json({error:'Session invalid.'},{status:401,headers:noStore});
  if(principal.is_anonymous===true){
    if(!guestAllowed(path))return NextResponse.json({error:'Owner access required for this feature.'},{status:403,headers:noStore});
  } else if(principal.id!==process.env.KATIE_OWNER_AUTH_USER_ID) {
    return NextResponse.json({error:'Owner access denied.'},{status:403,headers:noStore});
  }
  return NextResponse.next();
}
export const config={matcher:['/api/:path*']};

