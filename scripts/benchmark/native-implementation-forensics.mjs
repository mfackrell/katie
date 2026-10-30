// Incident-scoped read-only retrieval. No inference requests, authority changes, or retries.
const ids=Object.freeze([
 'resp_05cc15ea1ad2c2ed016ae4ca07ff9487d2a485a7953d10819d',
 'resp_05cc15ea1ad2c2ed016ae4ca1563d487d28045a03b98388d55',
 'resp_05cc15ea1ad2c2ed016ae4ca19050487d283cc5a174c5a4444',
 'resp_05cc15ea1ad2c2ed016ae4ca1c5d2087d2980b5e3c9b86a480'
]);
const key=process.env.OPENAI_API_KEY;
if(!key)throw Error('Existing provider credential unavailable');
const clean=text=>String(text??'').split(key).join('[REDACTED]')
 .replace(/Bearer\s+[^\s"']+/gi,'Bearer [REDACTED]')
 .replace(/sk-[A-Za-z0-9_-]+/g,'[REDACTED]')
 .replace(/[A-Za-z0-9_-]{80,}\.[A-Za-z0-9_-]{20,}/g,'[REDACTED]')
 .slice(0,6000);
for(const [index,id]of ids.entries()){
 const r=await fetch('https://api.openai.com/v1/responses/'+id,{method:'GET',redirect:'error',headers:{Authorization:'Bearer '+key},signal:AbortSignal.timeout(10000)});
 if(!r.ok){console.log(JSON.stringify({sample:index+1,status:r.status,outcome:r.status===404?'not-retained':'read-failed'}));continue;}
 const body=await r.json();
 console.log(JSON.stringify({sample:index+1,status:r.status,responseState:body.status,output:body.output?.map(item=>({
  type:item.type,name:item.name,arguments:clean(item.arguments),input:clean(item.input),
  text:clean(item.content?.filter(c=>c.type==='output_text').map(c=>c.text).join('\n'))
 }))}));
}
