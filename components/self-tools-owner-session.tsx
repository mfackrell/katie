"use client";

import { FormEvent, useEffect, useState } from "react";
import { browserOwnerAuth, ownerSessionBearer } from "@/lib/tools/browser-owner-session";

/** Authentication is not authorization: server separately requires an explicit actor/chat grant. */
export function SelfToolsOwnerSession({ chatId }: { chatId?: string }) {
  const client = browserOwnerAuth();
  const [email, setEmail] = useState("");
  const [emailReady, setEmailReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [code, setCode] = useState("");
  const [codeRequested, setCodeRequested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!client) return;
    let active = true;
    let settled = false;
    const finish = (session: boolean) => {
      if (!active) return;
      settled = true;
      setSignedIn(session);
      setSessionReady(true);
    };
    const recoveryTimeout = window.setTimeout(() => {
      if (!active || settled) return;
      setSessionReady(true);
      setNotice("Owner session restoration timed out. Authentication was not confirmed; you can retry sign-in.");
    }, 6000);
    try { const stored = window.sessionStorage.getItem("katie-owner-otp-email"); if (stored) setEmail(stored); } catch {}
    setEmailReady(true);
    // Passwordless callback failures arrive in the URL hash, not as a React error.
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const code = fragment.get("error_code");
    if (code) {
      setNotice(code === "otp_expired"
        ? "This sign-in link was already used or expired. Request a fresh link and open it once in this browser."
        : "Sign-in could not be completed. Request a new link.");
    }
    // INITIAL_SESSION is the authoritative completion of Supabase's persisted
    // session recovery. Do not let an older getSession result overwrite a later
    // SIGNED_IN or TOKEN_REFRESHED event.
    const {data:{subscription}} = client.auth.onAuthStateChange((event,session)=>{
      if (!active) return;
      if (event === "INITIAL_SESSION" || event === "SIGNED_IN" ||
          event === "TOKEN_REFRESHED" || event === "SIGNED_OUT" ||
          event === "USER_UPDATED") {
        finish(Boolean(session));
        if (session) setNotice("");
      }
    });
    void client.auth.getSession().then(({data,error}) => {
      if(!active) return;
      if (error) {
        setNotice("Owner session recovery failed: " + error.message);
      } else if (data.session) {
        finish(true);
      } else {
        // A null result does not supersede a later authenticated event.
        if (!settled) finish(false);
      }
    }).catch((error:unknown)=>{
      if (!active) return;
      finish(false);
      setNotice("Owner session recovery failed: " + (error instanceof Error ? error.message : "unknown error"));
    });
    return ()=>{active=false;window.clearTimeout(recoveryTimeout);subscription.unsubscribe();};
  },[client]);
  if (!client) return null;
  async function signIn(event: FormEvent) {
    event.preventDefault();
    if (!client || !email.trim() || busy) return;
    try { window.sessionStorage.setItem("katie-owner-otp-email", email.trim()); } catch {}
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
      setNotice("Verification code requested. The code field remains available after a page refresh; do not request another code if you already have one.");
    } finally { setBusy(false); }
  }
  async function verifyCode(event: FormEvent) {
    event.preventDefault();
    if (!client || busy) return;
    if (!email.trim()) { setNotice("Enter the owner email address before verifying the code. No new email is needed."); return; }
    if (!/^[0-9]{6,8}$/.test(code)) { setNotice("Enter your six- or eight-digit verification code."); return; }
    try { window.sessionStorage.setItem("katie-owner-otp-email", email.trim()); } catch {}
    setBusy(true);
    try {
      const {error} = await client.auth.verifyOtp({
        email: email.trim(), token: code, type: "email"
      });
      if(error) {setNotice("Code verification failed: " + error.message);return;}
      setCode("");
      setCodeRequested(false);
      setSignedIn(true);
      setSessionReady(true);
      setNotice("Owner session active.");
      window.dispatchEvent(new Event("katie-owner-session-changed"));
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
    if(!error)window.dispatchEvent(new CustomEvent("katie-owner-session-changed",{detail:{guestReset:true}}));
  }
  return (
    <details aria-label="Katie optional account tools" className="shrink-0 border-t border-white/10 bg-zinc-900 px-4 py-2 text-sm text-zinc-100">
      <summary className="cursor-pointer text-zinc-400">Owner account (optional)</summary>
      <section className="py-3">
      {!sessionReady ? (
        <p role="status">Restoring owner session…</p>
      ) : signedIn ? (
        <div className="flex items-center justify-between gap-3">
          <span>Owner session active.</span>
          <div className="flex gap-3">{chatId && <button type="button" onClick={()=>void authorizeChat()} className="underline">Authorize this chat</button>}<button type="button" onClick={()=>void signOut()} className="underline">Sign out</button></div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <form onSubmit={(event)=>void signIn(event)} className="flex flex-wrap items-center gap-3">
            <label htmlFor="self-tools-owner-email">Owner email</label>
            <input id="self-tools-owner-email" type="email" autoComplete="email" required
              value={email} onChange={event=>{setEmail(event.target.value);try{window.sessionStorage.setItem("katie-owner-otp-email",event.target.value);}catch{}}} disabled={busy || !emailReady}
              className="min-w-[180px] flex-1 rounded border border-zinc-600 bg-zinc-950 px-3 py-2 text-white"
              placeholder="Email address" />
            {!codeRequested && <button type="submit" disabled={busy} className="rounded bg-emerald-500 px-4 py-2 font-semibold text-zinc-950">Send verification code</button>}
          </form>
          {<form onSubmit={(event)=>void verifyCode(event)} className="flex flex-wrap items-center gap-2">
            <label htmlFor="self-tools-email-code">Verification code</label>
            <input id="self-tools-email-code" inputMode="numeric" pattern="[0-9]{6}([0-9]{2})?" maxLength={8}
              autoComplete="one-time-code" required value={code}
              onChange={event=>setCode(event.target.value.replace(/\D/g,"").slice(0,8))}
              className="w-32 rounded border border-zinc-600 bg-zinc-950 px-3 py-2 text-white" />
            <button type="submit" disabled={busy || ![6,8].includes(code.length)} className="rounded bg-emerald-500 px-4 py-2 font-semibold text-zinc-950">Verify code</button>

          </form>}
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      </section>
    </details>
  );
}
