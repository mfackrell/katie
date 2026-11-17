// Read-only GitHub proof. The deployed merge SHA is discovered, never predicted.
export const TASK4A_HANDOFF_BASELINE='cff4c7c2ea175ef1f9752f64a0cf2e023c8eecd3';
export const TASK4A_HANDOFF_WORKFLOWS=['ci.yml','task4a-qualification.yml','benchmark-gateway-qualification.yml','website-reviews.yml'];
const repo='mfackrell/katie',root='/repos/'+repo;
const deny=()=>{throw Error('TASK4A_VERIFIER_RELEASE_UNQUALIFIED');};
export async function authenticateTask4aVerifierRelease(release,read){
 if(!/^[a-f0-9]{40}$/.test(release??''))deny();
 const main=await read(root+'/commits/main');
 if(main.sha!==release||main.parents?.length!==2||main.parents[0].sha!==TASK4A_HANDOFF_BASELINE)deny();
 const prs=await read(root+'/commits/'+release+'/pulls?per_page=100');
 if(!Array.isArray(prs)||prs.length!==1)deny();
 const pr=await read(root+'/pulls/'+prs[0].number);
 if(pr.merged!==true||pr.merge_commit_sha!==release||pr.base?.ref!=='main'||pr.base?.repo?.full_name!==repo||pr.head?.repo?.full_name!==repo
 ||pr.head?.sha!==main.parents[1].sha||pr.merged_by?.login!=='mfackrell')deny();
 const head=await read(root+'/commits/'+pr.head.sha),tree=main.commit?.tree?.sha;
 if(!/^[a-f0-9]{40}$/.test(tree??'')||head.commit?.tree?.sha!==tree)deny();
 const checks=[];
 for(const name of TASK4A_HANDOFF_WORKFLOWS){
 const path='.github/workflows/'+name;
 const [baseline,current,workflow,runs]=await Promise.all([
 read(root+'/contents/'+path+'?ref='+TASK4A_HANDOFF_BASELINE),read(root+'/contents/'+path+'?ref='+release),
 read(root+'/actions/workflows/'+name),read(root+'/actions/workflows/'+name+'/runs?head_sha='+pr.head.sha+'&event=pull_request&per_page=100')]);
 if(!baseline.sha||baseline.sha!==current.sha||workflow.path!==path||!Number.isSafeInteger(workflow.id)||runs.total_count>100)deny();
 const matching=(runs.workflow_runs??[]).filter(r=>r.head_sha===pr.head.sha&&r.event==='pull_request'&&r.workflow_id===workflow.id&&r.path===path
 &&r.repository?.full_name===repo&&r.head_repository?.full_name===repo&&r.head_branch===pr.head.ref);
 matching.sort((a,b)=>b.id-a.id);const run=matching[0];
 if(!run||run.status!=='completed'||run.conclusion!=='success'||!Number.isSafeInteger(run.id)||!Number.isSafeInteger(run.run_attempt))deny();
 checks.push({workflow:path,workflowId:workflow.id,runId:run.id,attempt:run.run_attempt,headSha:pr.head.sha});
 }
 if((await read(root+'/commits/main')).sha!==release)deny();
 return {version:'task4a-verifier-qualified-release-v1',repository:repo,baselineSha:TASK4A_HANDOFF_BASELINE,releaseSha:release,
 qualifiedHeadSha:pr.head.sha,treeSha:tree,pullRequest:pr.number,checks};
}
