// Synthetic provider HTTP transport only. The real mission model performs
// routing, counting, reservation, receipt settlement and worker validation.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
export function completionTransport({fixture,trace}){
 return async(input,init={})=>{
  const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
  assert.equal(url.origin,'https://api.openai.com');
  if(url.pathname==='/v1/models')return Response.json({object:'list',data:[{id:'gpt-5.3-codex',object:'model',created:1,owned_by:'synthetic'}]});
  const body=JSON.parse(init.body);assert.equal(body.model,'gpt-5.3-codex');
  if(url.pathname==='/v1/responses/input_tokens')return Response.json({input_tokens:100});
  assert.equal(url.pathname,'/v1/responses');assert.ok(fixture.completion,'Completion requires real host evidence');
  const format=body.text?.format?.name;
  const inputText=JSON.stringify(body.input);
  let value;
  if(format==='mission_review_comparison'){
   assert.ok(inputText.includes(fixture.completion.reviewedHeadSha),'Review must see immutable engineering evidence');
   value={verdict:'approve',optionalSuggestions:'',clarification:null,findings:'Synthetic reviewer verified saved immutable source and actual browser receipt.',checks:['requirement:assigned-outcome','criterion:1','criterion:2','overall-objective','factual-support','prior-findings'].map(id=>({id,passed:true,evidence:'Original task '+fixture.completion.taskId+'; immutable head '+fixture.completion.reviewedHeadSha+'; actual browser contract passed.'}))};
  }else if(format==='mission_deliverable'){
   assert.ok(inputText.includes(fixture.completion.reviewedHeadSha),'Composer must receive actual verified head');
   value={deliverable:'The original synthetic task '+fixture.completion.taskId+' satisfies the frozen display contract at '+fixture.completion.reviewedHeadSha+'. '+(fixture.completion.repairPerformed?'Implementation and initial review were preserved; repair, independent final review and actual Chromium acceptance passed.':'Implementation, independent reviews and actual Chromium acceptance passed under original authority; no repair or resource amendment was required.')+' This is isolated synthetic qualification, not a production deployment.',composerNotes:'Derived only from retained host/browser receipts.'};
  }else{
   assert.ok(!format,'Unexpected worker response format '+format);
   value={selected:{provider:'openai',model:'gpt-5.3-codex'}};
  }
  trace.push({boundary:'synthetic_completion_provider',format:format??'routing',model:body.model});
  return Response.json({id:'synthetic-completion-'+randomUUID(),object:'response',created_at:1,status:'completed',model:body.model,service_tier:'default',output:[{id:'message',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(value),annotations:[]}]}],usage:{input_tokens:100,output_tokens:50,total_tokens:150}});
 };
}
