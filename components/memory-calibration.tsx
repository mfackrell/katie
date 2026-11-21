"use client";
import Link from "next/link";
import { useState } from "react";

const button =
  "inline-flex min-h-11 items-center justify-center rounded-lg border border-white/15 px-3 py-2 text-sm hover:bg-white/5 disabled:opacity-40";

async function change(url: string, method: string, body?: unknown, requestId?: string) {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...(requestId ? {"x-request-id":requestId} : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let data: Record<string,unknown>;
  try {data=JSON.parse(text) as Record<string,unknown>;} catch {throw Error("Katie returned an invalid server response.");}
  if (!response.ok || response.status===202) throw Error(String(data.error ?? data.status ?? "The change could not be saved."));
  return data;
}


type CalibrationGroup={type:"redundancy"|"irrelevant";keys:string[];reason:string};
type CalibrationResult={hash:string;proof:string;groups:CalibrationGroup[];conflicts:Array<{keys:string[];question:string}>;entries:Array<{key:string;value:string}>};
export function MemoryCalibration({actorId,actorName,chatId,inChat=false}:{actorId:string;actorName:string;chatId?:string;inChat?:boolean}) {
 const [busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
 const [report,setReport]=useState<CalibrationResult|null>(null),[selected,setSelected]=useState<number[]>([]);
 async function preview(){
   setBusy(true);setError("");setNotice("");setSelected([]);
   try {
     if(!chatId) throw Error("Start a conversation with this specialist before calibrating memory.");
     const result=await change("/api/actors","POST",{calibration:"preview",actorId:actorId,chatId},crypto.randomUUID()) as CalibrationResult;
     setReport(result);
     setNotice("Review the proposed changes below. No memory has been modified.");
   }catch(e){setError(e instanceof Error?e.message:"Calibration failed");}
   finally{setBusy(false);}
 }
 async function apply(){
   if(!report||!selected.length)return;
   if(!window.confirm("Apply these selected memory changes? A full restoration copy will be saved first. Contradictions remain unchanged."))return;
   setBusy(true);setError("");
   try{
     const result=await change(`/api/actors?id=${encodeURIComponent(actorId)}`,"PATCH",{
       calibration:"apply",hash:report.hash,proof:report.proof,groups:report.groups,approved:selected.map(i=>report.groups[i])
     }) as {previous:number;current:number};
     setNotice(`Memory calibrated: ${result.previous} → ${result.current} entries. Restoration backup saved.`);
     setReport(null);setSelected([]);
   }catch(e){setError(e instanceof Error?e.message:"Apply failed");}
   finally{setBusy(false);}
 }
 const values=new Map((report?.entries||[]).map(e=>[e.key,e.value]));
 return <section id="memory-calibration" className="mt-4 scroll-mt-24 rounded-lg border border-emerald-400/30 p-3">
   <h3 className="font-medium text-sm">Long-term memory calibration</h3>
   <p className="mt-2 text-xs text-zinc-400">AI reviews this actor&apos;s memory against its purpose. Nothing is removed automatically. Contradictions require your clarification; uncertain or unique facts stay intact.</p>
   <button type="button" className={button+" mt-3"} disabled={busy} onClick={()=>void preview()}>{busy?"Working…":"Calibrate memory"}</button>
   {report&&<div className="mt-4 space-y-3 text-sm">
     <p>{report.entries.length} stored entries · {report.groups.length} optional cleanup proposals · {report.conflicts.length} questions</p>
     {!!report.conflicts.length&&<div className="rounded-lg border border-amber-400/30 p-3">
       <h4 className="font-medium text-amber-200">Clarification needed — records preserved</h4>
       {report.conflicts.map((conflict,i)=><div key={i} className="mt-3">
         <p>{conflict.question}</p>
         {conflict.keys.map(key=><p key={key} className="mt-2 break-words text-xs text-zinc-400"><strong>{key}</strong>: {values.get(key)}</p>)}
         <p className="mt-1 text-xs">These entries are not changed until you clarify. Your answer should be recorded as new source evidence, not inferred by the reviewer.</p>
         {inChat ? <button type="button" className={button+" mt-2"} onClick={() => {
           if (!chatId) return;
           window.dispatchEvent(new CustomEvent("katie:compose-correction", {
             detail: {chatId, text: "Please ask me to resolve this long-term-memory contradiction, and retain my clarification for future use: "+conflict.question+" [keys: "+conflict.keys.join(", ")+"]"}
           }));
         }}>Clarify in this conversation</button> : <Link className={button+" mt-2"} href={`/conversations/new?actor=${encodeURIComponent(actorId)}&request=${encodeURIComponent("Please ask me to resolve this long-term-memory contradiction, and retain my clarification for future use: "+conflict.question+" [keys: "+conflict.keys.join(", ")+"]")}`}>Clarify with {actorName}</Link>}
       </div>)}
     </div>}
     {report.groups.map((group,i)=><label key={i} className="block rounded-lg border border-white/10 p-3">
       <span className="flex items-start gap-2">
         <input type="checkbox" className="mt-1" checked={selected.includes(i)} onChange={event=>setSelected(prev=>event.target.checked?[...prev,i]:prev.filter(x=>x!==i))}/>
         <span><strong>{group.type==="redundancy"?"Consolidate duplicates":"Remove likely irrelevant entries"}</strong> — {group.reason}</span>
       </span>
       {group.keys.map(key=><p key={key} className="ml-6 mt-2 break-words text-xs text-zinc-400"><strong>{key}</strong>: {values.get(key)}</p>)}
     </label>)}
     {!!report.groups.length&&<button type="button" className={button} disabled={busy||!selected.length} onClick={()=>void apply()}>Apply {selected.length} selected change(s)</button>}
   </div>}
   {error&&<p role="alert" className="mt-2 text-red-300 text-xs">{error}</p>}
   {notice&&<p role="status" className="mt-2 text-emerald-300 text-xs">{notice}</p>}
 </section>;
}
