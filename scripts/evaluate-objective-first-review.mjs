// Existing review workflow on wholly fictional data; no production chat writes.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const [baselineRoot, credentialFile, comparisonFile, outputFile, scope] = process.argv.slice(2);
if (!outputFile) throw new Error('Usage: BASELINE_ROOT CREDENTIAL_FILE SYNTHETIC_COMPARISON_JSON OUTPUT_JSON');
const comparison = JSON.parse(readFileSync(comparisonFile,'utf8'));
if (!comparison.dataScope.startsWith('Wholly fictional')) throw new Error('Only fully synthetic comparisons are permitted by this harness.');
const roots={baseline:path.join(path.resolve(baselineRoot),'.website-test-dist'),revised:path.resolve('.website-test-dist')};
const {ClaudeProvider}=require(path.join(roots.revised,'lib/providers/claude-provider.js'));
const provider=new ClaudeProvider(readFileSync(credentialFile,'utf8').trim());
const models=await provider.listModels();const leadModel=models.find(x=>/sonnet/i.test(x));const reviewerModel=models.find(x=>/opus/i.test(x));
if(!leadModel||!reviewerModel||leadModel===reviewerModel)throw new Error('Distinct supported lead and reviewer models required.');
const fixture=comparison.cases[0];
const weak='I have no international transfer-pricing experience and have never been CFO of a multinational manufacturer. I have 16 years of finance and operations experience: CFO of a domestic manufacturer with $72M annual revenue and interim CFO of a multinational software company with $48M annual revenue. I completed audit remediation in eight months, led an ERP migration and supported an acquisition. I also operated a hospitality side business.';
const report={dataScope:comparison.dataScope,leadModel,reviewerModel,cases:[]};
for(const variant of scope === '--revised-only' ? ['revised'] : ['baseline','revised']){
 const {runRequiredDraftReview}=require(path.join(roots[variant],'lib/collaboration/required-review.js'));
 const {getDeliverableStandardInstruction}=require(path.join(roots[variant],'lib/chat/deliverable-standard.js'));
 const params={name:'Katie',modelId:leadModel,persona:getDeliverableStandardInstruction()+'\nVerified fictional facts: '+fixture.facts,summary:'',history:[],user:fixture.task};
 const result=await runRequiredDraftReview({requestId:'synthetic-objective-first-'+variant,draft:{text:weak,provider:'anthropic',model:leadModel},params,leadProvider:provider,deadlineMs:Date.now()+600000,participantTimeoutMs:90000,selectHelper:async()=>({provider,modelId:reviewerModel}),onProgress:detail=>console.info(variant,detail)});
 report.cases.push({variant,result:result.result,audit:result.audit});writeFileSync(outputFile,JSON.stringify(report,null,2)+'\n');console.info('Review completed:',variant,result.audit.status);
}
