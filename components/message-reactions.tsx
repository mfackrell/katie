"use client";

import { useEffect, useState } from "react";
import type { MessageReaction } from "@/lib/chat/message-reactions";

const options: Array<{code:MessageReaction;emoji:string;label:string}> = [
 {code:"laugh",emoji:"😂",label:"Laugh"},
 {code:"love",emoji:"❤️",label:"Love"},
 {code:"like",emoji:"👍",label:"Like"},
 {code:"dislike",emoji:"👎",label:"Dislike"},
 {code:"surprised",emoji:"😮",label:"Surprised"},
 {code:"sad",emoji:"😢",label:"Sad"},
 {code:"frustrated",emoji:"😡",label:"Frustrated"}
];

type ReactionSnapshot={reactions:Record<string,MessageReaction>};
const cache=new Map<string,ReactionSnapshot>();
const inflight=new Map<string,Promise<ReactionSnapshot>>();

async function fetchSnapshot(actorId:string,chatId:string):Promise<ReactionSnapshot> {
  const key=actorId+":"+chatId;
  if(cache.has(key))return cache.get(key)!;
  let job=inflight.get(key);
  if(!job) {
    job=fetch(`/api/message-reactions?actorId=${encodeURIComponent(actorId)}&chatId=${encodeURIComponent(chatId)}`,{cache:"no-store"})
      .then(async res=>{const json=await res.json();if(!res.ok)throw Error(json.error||"Could not load reactions.");cache.set(key,json);return json;})
      .finally(()=>inflight.delete(key));
    inflight.set(key,job);
  }
  return job;
}

export function MessageReactions({actorId,chatId,messageId,onReaction,disabled=false}:{actorId:string;chatId:string;messageId:string;disabled?:boolean;onReaction:(reaction:MessageReaction|null)=>void}) {
  const [selected,setSelected]=useState<MessageReaction|null>(null);
  const [pending,setPending]=useState(false);
  const [ready,setReady]=useState(false);
  const [error,setError]=useState("");
  const [delivered,setDelivered]=useState(false);
  useEffect(()=>{
    let active=true;
    setReady(false);setError("");setSelected(null);setDelivered(false);
    void fetchSnapshot(actorId,chatId).then(data=>{
      if(active){setSelected(data.reactions[messageId]??null);setReady(true);}
    }).catch(e=>{if(active){setError(e instanceof Error?e.message:"Reactions unavailable.");setReady(true);}});
    return ()=>{active=false};
  },[actorId,chatId,messageId]);

  async function choose(code:MessageReaction) {
    if(pending || disabled)return;
    const next=selected===code?null:code;
    setPending(true);setError("");setDelivered(false);
    try {
      const response=await fetch("/api/message-reactions",{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({actorId,chatId,messageId,reaction:next})
      });
      const result=await response.json();
      if(!response.ok)throw Error(result.error||"Reaction could not be saved.");
      setSelected(next);
      setDelivered(true);
      onReaction(next);
      const key=actorId+":"+chatId;
      const snapshot=cache.get(key)??{reactions:{}};
      if(next)snapshot.reactions[messageId]=next;
      else delete snapshot.reactions[messageId];
      cache.set(key,snapshot);
    } catch(e) {setError(e instanceof Error?e.message:"Reaction could not be saved.");}
    finally {setPending(false);}
  }
  return <div className="mt-3 border-t border-white/10 pt-2">
    <div className="flex flex-wrap gap-1" role="group" aria-label="React to Katie's message">
      {options.map(option=><button key={option.code} type="button" title={option.label}
        aria-label={option.label+" reaction"} aria-pressed={selected===option.code}
        disabled={!ready||pending||disabled||Boolean(error&& !ready)}
        onClick={()=>void choose(option.code)}
        className={`rounded-lg border px-2 py-1 text-base transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-40 ${selected===option.code?"border-emerald-400 bg-emerald-500/20":"border-white/10 hover:bg-white/10"}`}>
        {option.emoji}
      </button>)}
    </div>
    {delivered && <p role="status" className="mt-1 text-xs text-emerald-300">Reaction saved. Katie’s reply is queued and will appear here.</p>}
    {error&&<p role="alert" className="mt-1 text-xs text-rose-300">{error}</p>}
  </div>;
}
