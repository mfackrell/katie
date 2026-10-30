'use client';
import { useEffect, useState } from 'react';
import { ownerSessionBearer } from '@/lib/tools/browser-owner-session';
import { usePathname } from 'next/navigation';
import { requiresKatieWorkspaceSession } from '@/lib/standalone-accounting/session-routes';

/** Only Katie's workspace is gated; independent routes render without Auth. */
export function ChatSessionGate({children}:{children:React.ReactNode}){
  const pathname=usePathname();
  if(!requiresKatieWorkspaceSession(pathname))return <>{children}</>;
  return <VerifiedWorkspaceSession>{children}</VerifiedWorkspaceSession>;
}

/** A new mount verifies the session before loading any workspace data. */
function VerifiedWorkspaceSession({children}:{children:React.ReactNode}){
  const [state,setState]=useState<'loading'|'ready'|'error'>('loading');
  const [message,setMessage]=useState('');
  useEffect(()=>{
    let active=true;
    async function bootstrap(resetToGuest=false){
      try{
        const token=resetToGuest?null:await ownerSessionBearer();
        const response=await fetch('/api/session',{method:'POST',credentials:'same-origin',
          headers:{...(token?{Authorization:'Bearer '+token}:{}),...(resetToGuest?{'x-katie-guest-reset':'1'}:{})}});
        if(!response.ok){
          const body=await response.json().catch(()=>({}));
          throw Error(body.error??'Automatic session could not be established.');
        }
        if(active){setState('ready');setMessage('');}
      }catch(error){
        if(active){setState('error');setMessage(error instanceof Error?error.message:'Katie session unavailable.');}
      }
    }
    void bootstrap();
    const onChanged=(event:Event)=>{
      const resetToGuest=(event as CustomEvent<{guestReset?:boolean}>).detail?.guestReset===true;
      if(active){setState('loading');void bootstrap(resetToGuest);}
    };
    const refresh=()=>{if(active)void bootstrap();};
    // Proactively rotate the short-lived HttpOnly access cookie so ordinary
    // long conversations do not suddenly fail after thirty minutes.
    const interval=window.setInterval(refresh,10*60*1000);
    window.addEventListener('focus',refresh);
    window.addEventListener('katie-owner-session-changed',onChanged);
    return ()=>{
      active=false;window.clearInterval(interval);
      window.removeEventListener('focus',refresh);
      window.removeEventListener('katie-owner-session-changed',onChanged);
    };
  },[]);
  if(state==='loading')return <main role="status" className="flex min-h-dvh items-center justify-center bg-zinc-950 text-zinc-200">Opening Katie…</main>;
  if(state==='error')return <main role="alert" className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-zinc-950 px-6 text-zinc-100">
    <p>{message}</p><button type="button" className="underline" onClick={()=>window.location.reload()}>Retry</button>
  </main>;
  return <>{children}</>;
}

