// Last-resort, lossless in-context encoding of a large durable exception ledger.
// It runs only after the accepted full/repeated-value/row representations exceed
// the existing management-input limit. No evidence is removed or summarized.
export function compactExceptionLedgerText(payload:Record<string,unknown>):Record<string,unknown>|null{
 const source=payload.exceptions;
 if(!Array.isArray(source)||!source.every(x=>Array.isArray(x)&&x.length>=7
   &&typeof x[3]==='string'&&typeof x[5]==='string'
   &&typeof x[6]==='string'
   &&(typeof x[4]==='string'
    ||Array.isArray(x[4])&&x[4].length===1&&Number.isInteger(x[4][0]))))return null;
 const rows=(source as unknown[][]).map(r=>[...r]);
 // Exact repeated details are already encoded as [priorRow]. Only factor
 // unique, still-literal detail strings. Preserve all whitespace and escapes.
 let segments:(Array<string|number>|null)[]=rows.map(r=>typeof r[4]==='string'?[r[4] as string]:null);
 const fragments:string[]=[];
 for(let round=0;round<12;round++){
  const counts=new Map<string,number>();
  for(const parts of segments){
   if(!parts)continue;
   const candidates=new Set<string>();
   for(const part of parts){
    if(typeof part!=='string')continue;
    const words=part.match(/\S+\s*/g)??[];
    for(let n=4;n<=24;n++)for(let i=0;i+n<=words.length;i++){
     const phrase=words.slice(i,i+n).join('');
     if(phrase.length>=50&&phrase.length<=280)candidates.add(phrase);
    }
   }
   for(const phrase of candidates)counts.set(phrase,(counts.get(phrase)??0)+1);
  }
  const best=[...counts.entries()]
   .filter(([,count])=>count>=2)
   .map(([phrase,count])=>({phrase,gain:(count-1)*phrase.length-15*count}))
   .sort((a,b)=>b.gain-a.gain||a.phrase.localeCompare(b.phrase))[0];
  if(!best||best.gain<90)break;
  const index=fragments.length;
  fragments.push(best.phrase);
  segments=segments.map(parts=>parts?.flatMap(part=>{
   if(typeof part!=='string'||!part.includes(best.phrase))return [part];
   const split=part.split(best.phrase),output:Array<string|number>=[];
   split.forEach((piece,i)=>{if(piece)output.push(piece);if(i<split.length-1)output.push(index);});
   return output;
  })??null);
 }
 rows.forEach((row,i)=>{
  const parts=segments[i];
  if(parts?.some(p=>typeof p==='number'))row[4]=[null,...parts];
 });
 const reasons=[...new Set(rows.map(row=>row[3] as string))];
 const statuses=[...new Set(rows.map(row=>row[5] as string))];
 const dates=[...new Set(rows.map(row=>(row[6] as string).slice(0,10)))];
 for(const row of rows){
  row[3]=reasons.indexOf(row[3] as string);
  row[5]=statuses.indexOf(row[5] as string);
  const date=row[6] as string;
  row[6]=[dates.indexOf(date.slice(0,10)),date.slice(10)];
 }
 // Verify the transformation before it can enter a model prompt.
 const same=rows.every((row,i)=>{
  const old=(source as unknown[][])[i];
  const when=row[6] as [number,string];
  const date=dates[when[0]]+when[1];
  const detail=Array.isArray(row[4])&&row[4][0]===null
   ?row[4].slice(1).map(part=>typeof part==='number'?fragments[part]:part).join('')
   :row[4];
  return reasons[row[3] as number]===old[3]
   &&statuses[row[5] as number]===old[5]
   &&date===old[6]&&JSON.stringify(detail)===JSON.stringify(old[4])
   &&row.length===old.length
   &&row.every((value,col)=>[3,4,5,6].includes(col)
    ||JSON.stringify(value)===JSON.stringify(old[col]));
 });
 if(!same)return null;
 const candidate={
  ...payload,exceptions:rows,
  exceptionReasonValues:reasons,exceptionStatusValues:statuses,
  exceptionDateValues:dates,exceptionDetailFragments:fragments,
  contextReferencePolicy:String(payload.contextReferencePolicy??'')+
   ' In exception rows, integer reason/status fields index exceptionReasonValues and exceptionStatusValues. '+
   'created_at [dateIndex,timeSuffix] is the verbatim concatenation of exceptionDateValues[dateIndex] and timeSuffix. '+
   'detail [null,...parts] concatenates literal strings and numeric references to exceptionDetailFragments verbatim; '+
   'a one-integer detail array [i] still refers to prior exception row i. All rows, identities, details and statuses remain mandatory.'
 };
 return JSON.stringify(candidate).length<JSON.stringify(payload).length?candidate:null;
}
