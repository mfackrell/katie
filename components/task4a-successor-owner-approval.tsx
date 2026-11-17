'use client';
import {useCallback,useEffect,useState} from 'react';
import {ownerSessionBearer} from '@/lib/tools/browser-owner-session';

const CHAT='e53defeb-16eb-457e-aa07-435141165ee8';
type Limits={tokens:number;calls:number;dollarsCents:number;assessmentTokens:number;
 completionTokens:number;assessmentCalls:number;completionCalls:number;
 seconds:number;models:string[]};
type Envelope={readiness?:{ready?:boolean;reason?:string;ledger?:{
  historicalActualTokens?:number;historicalCallReservedTokens?:number;
  historicalConservativeTokens?:number;historicalCalls?:number;
  historicalOverrunTokens?:number;historicalOverrunCalls?:number;
  historicalReservedExposureMicrousd?:number;maximumNewTokens?:number;
 }};ready?:boolean;digest?:string;proposal?:{
  predecessorId:string;incrementalTokens:number;incrementalCalls:number;
  incrementalMicrousd:number;durationSeconds:number;models:string[];
  assessmentReserveTokens:number;completionReserveTokens:number;
  assessmentReserveCalls:number;completionReserveCalls:number;
 };error?:string;reason?:string;accepted?:boolean};
// Prepopulate only the already-qualified Task 4A proposal. These are editable
// display defaults, never owner consent or authority to dispatch paid work.
const suggested={tokens:'240000',calls:'24',dollars:'9.00',assessmentTokens:'60000',
 completionTokens:'60000',assessmentCalls:'6',completionCalls:'6',hours:'4'};
type NumericKey=keyof typeof suggested;
export function Task4aSuccessorOwnerApproval({chatId}:{chatId:string}){
 const enabled=chatId===CHAT;
 const [readiness,setReadiness]=useState<Envelope|null>(null);
 const [entry,setEntry]=useState(suggested),[includeResearch,setIncludeResearch]=useState(true);
 const [offer,setOffer]=useState<Envelope|null>(null);
 const [busy,setBusy]=useState(false),[status,setStatus]=useState('');
 const refresh=useCallback(async()=>{
  if(!enabled)return;
  const token=await ownerSessionBearer();
  if(!token)return;
  try{
   const response=await fetch('/api/projects/task4a-successor',{
    headers:{Authorization:'Bearer '+token},cache:'no-store'
   });
   setReadiness(response.ok?await response.json() as Envelope:null);
  }catch{setReadiness(null);}
 },[enabled]);
 useEffect(()=>{void refresh();},[refresh]);
 if(!enabled||!readiness?.readiness?.ledger)return null;
 const ledger=readiness.readiness.ledger;
 const field=(key:NumericKey,value:string)=>{
  setEntry(e=>({...e,[key]:value}));setOffer(null);setStatus('');
 };
 const args=():Limits=>{
  if(Object.values(entry).some(v=>v.trim()===''))throw Error('Enter each explicit owner-selected limit.');
  if(!/^\d{1,3}\.\d{2}$/.test(entry.dollars))throw Error('Enter the dollar ceiling as dollars and two cents, e.g. 15.00.');
  const [dollars,cents]=entry.dollars.split('.').map(Number);
  const n=(k:NumericKey)=>{const v=Number(entry[k]);if(!Number.isSafeInteger(v)||v<0)throw Error('Limits must be nonnegative whole numbers.');return v;};
  return {tokens:n('tokens'),calls:n('calls'),dollarsCents:dollars*100+cents,
   assessmentTokens:n('assessmentTokens'),completionTokens:n('completionTokens'),
   assessmentCalls:n('assessmentCalls'),completionCalls:n('completionCalls'),
   seconds:n('hours')*3600,models:['openai:gpt-5.3-codex',...(includeResearch?['openai:gpt-5.6-sol']:[])]};
 };
 const request=async(action:'propose'|'approve')=>{
  if(busy)return;
  setBusy(true);setStatus('');
  try{
   const token=await ownerSessionBearer();
   if(!token)throw Error('Owner sign-in required.');
   const limits=args();
   if(action==='approve'&&!offer?.digest)throw Error('Preview the exact proposal first.');
   const response=await fetch('/api/projects/task4a-successor',{
    method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
    body:JSON.stringify({action,limits,...(action==='approve'?{digest:offer?.digest}:{})})
   });
   const data=await response.json() as Envelope;
   if(!response.ok)throw Error(data.reason??data.error??'Owner limits unavailable.');
   if(action==='propose'){if(!data.ready||!data.digest)throw Error('Unqualified successor proposal.');setOffer(data);}
   else{if(data.accepted!==true)throw Error('Owner consent not committed.');setOffer(null);
    setStatus('Successor continuation saved. The original development task remains blocked until separate native-owner authorization.');await refresh();}
  }catch(e){setOffer(null);setStatus(e instanceof Error?e.message:'Authorization unavailable');}
  finally{setBusy(false);}
 };
 const fields:{key:NumericKey;label:string}[]=[
  {key:'tokens',label:'New token ceiling'},
  {key:'calls',label:'New call ceiling'},
  {key:'dollars',label:'New dollar ceiling (USD 0.00)'},
  {key:'assessmentTokens',label:'Protected assessment tokens'},
  {key:'completionTokens',label:'Protected completion tokens'},
  {key:'assessmentCalls',label:'Protected assessment calls'},
  {key:'completionCalls',label:'Protected completion calls'},
  {key:'hours',label:'New authorization duration (hours)'}
 ];
 return <section aria-label="Task 4A successor owner authorization" className="rounded-xl border p-4 text-sm space-y-3">
  <h3 className="font-semibold">Task 4A — New successor authority (original project)</h3>
  <p>Prior continuation has expired. Actual historical usage: {Number(ledger.historicalActualTokens??0).toLocaleString()} tokens across {ledger.historicalCalls} calls.
   Conservative historical reservation: {Number(ledger.historicalCallReservedTokens??0).toLocaleString()} tokens;
   {'$'+((ledger.historicalReservedExposureMicrousd??0)/1_000_000).toFixed(6)} reserved exposure, not a confirmed charge.
   Conservative per-call encumbrance: {Number(ledger.historicalConservativeTokens??0).toLocaleString()} tokens;
   historical overrun: {Number(ledger.historicalOverrunCalls??0).toLocaleString()} call(s),
   {Number(ledger.historicalOverrunTokens??0).toLocaleString()} excess tokens included in the encumbrance.
   Maximum conservatively available project tokens: {Number(ledger.maximumNewTokens??0).toLocaleString()}.</p>
  <p>Suggested limits are prefilled for review and remain editable. No authority has been granted. Preview the current proposal and verify its digest before any explicit approval; eligibility also depends on the project deadline and fresh pricing.</p>
  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
   {fields.map(f=><label key={f.key} className="block">{f.label}
    <input className="mt-1 w-full rounded-md border bg-transparent px-2 py-1" type={f.key==='dollars'?'text':'number'}
     min={f.key==='hours'?1:0} step={f.key==='dollars'?undefined:1}
     value={entry[f.key]} onChange={e=>field(f.key,e.target.value)} required />
   </label>)}
  </div>
  <label className="flex gap-2 items-center"><input type="checkbox" checked={includeResearch}
   onChange={e=>{setIncludeResearch(e.target.checked);setOffer(null);setStatus('');}} />
   Also authorize model openai:gpt-5.6-sol. Native development always requires openai:gpt-5.3-codex.</label>
  {offer?.ready&&offer.proposal&&offer.digest?<div className="border-t pt-2 space-y-2">
   <p><strong>Exact owner decision:</strong> {offer.proposal.incrementalTokens.toLocaleString()} tokens;
    {offer.proposal.incrementalCalls} calls;
    {'$'+(offer.proposal.incrementalMicrousd/1_000_000).toFixed(2)};
    {offer.proposal.durationSeconds/3600} hours.
    Protected reserves: {offer.proposal.assessmentReserveTokens.toLocaleString()} assessment and
    {offer.proposal.completionReserveTokens.toLocaleString()} completion tokens.</p>
   <p className="break-all text-xs opacity-70">SHA-256 proposal digest: {offer.digest}</p>
   <p>No development dispatch or native spending is authorized by this first decision.</p>
   <button type="button" disabled={busy} onClick={()=>{void request('approve');}} className="rounded-md border px-3 py-2 font-semibold disabled:opacity-50">
    {busy?'Verifying…':'Authorize this exact successor continuation'}
   </button>
  </div>:<button type="button" disabled={busy} onClick={()=>{void request('propose');}}
   className="rounded-md border px-3 py-2 font-semibold disabled:opacity-50">{busy?'Checking…':'Preview exact successor limits'}</button>}
  {status?<p role="status">{status}</p>:null}
 </section>;
}
