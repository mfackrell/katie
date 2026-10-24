"use client";

import { FormEvent, useEffect, useState } from "react";
import { browserOwnerAuth } from "@/lib/tools/browser-owner-session";

/** Authentication is not authorization: server separately requires an explicit actor/chat grant. */
export function SelfToolsOwnerSession() {
  const client = browserOwnerAuth();
  const [email, setEmail] = useState("");
  const [signedIn, setSignedIn] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!client) return;
    let active = true;
    void client.auth.getSession().then(({data}) => { if(active) setSignedIn(Boolean(data.session)); });
    const {data:{subscription}} = client.auth.onAuthStateChange((_event,session)=>{
      if(active) setSignedIn(Boolean(session));
    });
    return ()=>{active=false;subscription.unsubscribe();};
  },[client]);
  if (!client) return null;
  async function signIn(event: FormEvent) {
    event.preventDefault();
    if (!client || !email.trim()) return;
    const {error} = await client.auth.signInWithOtp({
      email: email.trim(), options: { emailRedirectTo: window.location.origin }
    });
    setNotice(error ? "Could not start owner sign-in." : "Check your email for a secure sign-in link.");
  }
  async function signOut() {
    if (!client) return;
    const {error} = await client.auth.signOut();
    setNotice(error ? "Sign-out failed." : "Signed out of self-management tools.");
  }
  return (
    <section aria-label="Katie self-tools owner authentication" className="border-t border-white/10 px-3 py-2 text-xs text-zinc-400">
      {signedIn ? (
        <div className="flex items-center justify-between gap-3">
          <span>Owner session active. Self-management still requires server authorization.</span>
          <button type="button" onClick={()=>void signOut()} className="underline">Sign out</button>
        </div>
      ) : (
        <form onSubmit={(event)=>void signIn(event)} className="flex items-center gap-2">
          <label htmlFor="self-tools-owner-email">Owner sign-in</label>
          <input id="self-tools-owner-email" type="email" autoComplete="email" required
            value={email} onChange={event=>setEmail(event.target.value)}
            className="min-w-0 flex-1 rounded bg-zinc-900 px-2 py-1 text-white"
            placeholder="Email address" />
          <button type="submit" className="underline">Send link</button>
        </form>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
