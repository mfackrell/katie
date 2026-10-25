"use client";

import { FormEvent, useEffect, useState } from "react";
import { browserOwnerAuth, ownerSessionBearer } from "@/lib/tools/browser-owner-session";

/** Authentication is not authorization: server separately requires an explicit actor/chat grant. */
export function SelfToolsOwnerSession({ chatId }: { chatId: string }) {
  const client = browserOwnerAuth();
  const [email, setEmail] = useState("");
  const [signedIn, setSignedIn] = useState(false);
  const [code, setCode] = useState("");
  const [codeRequested, setCodeRequested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!client) return;
    let active = true;
    // Passwordless callback failures arrive in the URL hash, not as a React error.
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const code = fragment.get("error_code");
    if (code) {
      setNotice(code === "otp_expired"
        ? "This sign-in link was already used or expired. Request a fresh link and open it once in this browser."
        : "Sign-in could not be completed. Request a new link.");
    }
    void client.auth.getSession().then(({data,error}) => {
      if(!active) return;
      setSignedIn(Boolean(data.session));
      if(error) setNotice("Unable to restore the owner session. Request a fresh sign-in link.");
    });
    const {data:{subscription}} = client.auth.onAuthStateChange((_event,session)=>{
      if(active) setSignedIn(Boolean(session));
    });
    return ()=>{active=false;subscription.unsubscribe();};
  },[client]);
  if (!client) return null;
  async function signIn(event: FormEvent) {
    event.preventDefault();
    if (!client || !email.trim() || busy) return;
    setBusy(true);
    try {
      const {error} = await client.auth.signInWithOtp({
        email: email.trim(), options: { shouldCreateUser: false }
      });
      if(error) {
        const rateLimited = error.status === 429 || error.code === "over_email_send_rate_limit";
        setNotice(rateLimited ? "Supabase's email limit has been reached. Please avoid repeated requests." :
          "Could not send verification code: " + error.message);
        return;
      }
      setCodeRequested(true);
      setNotice("Verification code requested. Enter the six-digit code from your email.");
    } finally { setBusy(false); }
  }
  async function verifyCode(event: FormEvent) {
    event.preventDefault();
    if (!client || !/^[0-9]{6}$/.test(code) || busy) return;
    setBusy(true);
    try {
      const {error} = await client.auth.verifyOtp({
        email: email.trim(), token: code, type: "email"
      });
      if(error) {setNotice("Code verification failed: " + error.message);return;}
      setCode("");
      setCodeRequested(false);
      setSignedIn(true);
      setNotice("Owner session active. Authorize this chat to use self-management tools.");
    } finally {setBusy(false);}
  }
  async function authorizeChat() {
    const token=await ownerSessionBearer();
    if(!token) {setNotice("Please sign in first.");return;}
    try {
      const response=await fetch("/api/self-tools/owner-grant",{
        method:"POST",
        headers:{"content-type":"application/json",Authorization:`Bearer ${token}`},
        body:JSON.stringify({chatId})
      });
      setNotice(response.ok ? "Owner authorization recorded for this chat." :
        "Owner enrollment unavailable or not authorized. Check server configuration.");
    } catch { setNotice("Could not reach owner authorization service."); }
  }
  async function signOut() {
    if (!client) return;
    const {error} = await client.auth.signOut();
    setNotice(error ? "Sign-out failed." : "Signed out of self-management tools.");
  }
  return (
    <section aria-label="Katie self-tools owner authentication" className="shrink-0 border-t border-emerald-500/30 bg-zinc-900 px-4 py-3 text-sm text-zinc-100">
      {signedIn ? (
        <div className="flex items-center justify-between gap-3">
          <span>Owner session active. Self-management still requires server authorization.</span>
          <div className="flex gap-3"><button type="button" onClick={()=>void authorizeChat()} className="underline">Authorize this chat</button><button type="button" onClick={()=>void signOut()} className="underline">Sign out</button></div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <form onSubmit={(event)=>void signIn(event)} className="flex flex-wrap items-center gap-3">
            <label htmlFor="self-tools-owner-email">Owner email</label>
            <input id="self-tools-owner-email" type="email" autoComplete="email" required
              value={email} onChange={event=>setEmail(event.target.value)} disabled={busy || codeRequested}
              className="min-w-[180px] flex-1 rounded border border-zinc-600 bg-zinc-950 px-3 py-2 text-white"
              placeholder="Email address" />
            {!codeRequested && <button type="submit" disabled={busy} className="rounded bg-emerald-500 px-4 py-2 font-semibold text-zinc-950">Send verification code</button>}
          </form>
          {codeRequested && <form onSubmit={(event)=>void verifyCode(event)} className="flex flex-wrap items-center gap-2">
            <label htmlFor="self-tools-email-code">Six-digit code</label>
            <input id="self-tools-email-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6}
              autoComplete="one-time-code" required value={code}
              onChange={event=>setCode(event.target.value.replace(/\\D/g,"").slice(0,6))}
              className="w-32 rounded border border-zinc-600 bg-zinc-950 px-3 py-2 text-white" />
            <button type="submit" disabled={busy || code.length!==6} className="rounded bg-emerald-500 px-4 py-2 font-semibold text-zinc-950">Verify code</button>
            <button type="button" onClick={()=>{setCodeRequested(false);setCode("");setNotice("");}} className="underline">Change email</button>
          </form>}
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
