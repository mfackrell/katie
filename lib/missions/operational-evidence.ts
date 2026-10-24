/** Lossless transport encoding for repeated point-in-time operational records.
 * Each row version has its own reference; changed status/timestamps never replace
 * historical evidence. Raw snapshots remain unchanged in durable job storage. */
export function encodeOperationalEvidence<T extends Record<string,unknown>>(input:T):T|Record<string,unknown>{
 const rows:Record<string,unknown>={},seen=new Map<string,string>();
 const stable=(value:unknown):unknown=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,stable(item)])):value;
 const visit=(value:unknown,key=''):unknown=>{
  if(Array.isArray(value))return value.map(item=>visit(item));
  if(!value||typeof value!=='object')return value;
  const record=value as Record<string,unknown>;
  if(['operationalEvidence','operationalBaseline'].includes(key)&&record.kind==='scoped_workflow_trace'&&record.trace&&typeof record.trace==='object'){
   const trace=record.trace as Record<string,unknown>;
   return{...record,trace:Object.fromEntries(Object.entries(trace).map(([kind,items])=>[kind,
    ['missions','jobs','delegations'].includes(kind)&&Array.isArray(items)?items.map(item=>{
     if(!item||typeof item!=='object'||typeof item.id!=='string')return item;
     const identity=JSON.stringify(stable(item));let ref=seen.get(identity);
     if(!ref){ref=String(seen.size+1);seen.set(identity,ref);rows[ref]=item;}
     return{$operationalRecord:ref};
    }):items]))};
  }
  return Object.fromEntries(Object.entries(record).map(([name,item])=>[name,visit(item,name)]));
 };
 const encoded={...(visit(input) as T),operationalRecordEncoding:{version:1,instruction:'Every {$operationalRecord: id} in a snapshot trace resolves to the COMPLETE record at operationalRecordEncoding.records[id]. This is lossless deduplication, not a summary. Distinct row versions retain separate IDs. Each snapshot keeps its own observedAt and limitations. Read all referenced records when evaluating that snapshot.',records:rows}};
 return seen.size&&JSON.stringify(encoded).length+128<JSON.stringify(input).length?encoded:input;
}
