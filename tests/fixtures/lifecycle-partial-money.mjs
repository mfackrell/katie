export function partialMoneyFixture(){
 const now=Date.parse('2026-11-01T00:00:00Z'),binding={taskId:'synthetic-task',projectId:'synthetic-project',baselineSha:'b'.repeat(40),scopeHash:'a'.repeat(64),contractHash:'c'.repeat(64)};
 const snapshot={binding,model:'gpt-5.3-codex',snapshotHash:'d'.repeat(64),originalWindowSeconds:3600,scope:{allowedPaths:['app/pilot/']},acceptance:{path:'/pilot'},snapshot:{calls:[]},exposureMicrousd:'0',pricing:{status:'verified',source:'synthetic pinned price',serviceTier:'default',verifiedAt:now-1000,inputUsdPerMillion:'2.5',outputUsdPerMillion:'14'},position:{cumulativeTokens:1000000,developmentTokens:900000,accountEncumberedTokens:0,developmentEncumberedTokens:0,completionTokens:60000,assessmentTokens:60000,developmentCalls:100,developmentConsumedCalls:12,completionCalls:4,assessmentCalls:10,assessmentConsumedCalls:0,expiresAt:now+3600000,committedMicrousd:'0',outstandingMicrousd:'0',ceilingMicrousd:'1'}};
 const record={taskId:binding.taskId,projectId:binding.projectId,originalBaselineSha:binding.baselineSha,approvedScopeHash:binding.scopeHash,approvedScope:{contractHash:binding.contractHash},checkpointSha:'e'.repeat(40),phase:'repair'},observations=[];
 for(const stage of ['repair','final_review'])for(let i=0;i<3;i++){
  const operationIds=[stage+i+'a',stage+i+'b'];snapshot.snapshot.calls.push(...operationIds.map(id=>({id,state:'settled',model:snapshot.model,provider_usage:{input_tokens:1000,output_tokens:1000}})));
  observations.push({id:stage+i,stage,source:'verified_phase_receipts',cohort:binding.scopeHash,binding:{projectId:binding.projectId,scopeHash:binding.scopeHash},completed:true,calls:2,inputTokens:2000,outputTokens:2000,seconds:10,operationIds});
 }
 return {now,snapshot,record,observations};
}
