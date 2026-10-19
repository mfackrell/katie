import {readFileSync} from 'node:fs';

const env=process.env;
const receipt=JSON.parse(readFileSync(env.RECEIPT_FILE||'agent-result.json','utf8'));
const fail=(message)=>{process.stderr.write('RELEASE BLOCKED: '+message+'\n');process.exit(1);};
const sha=env.EXPECTED_SHA;
const repo=env.GITHUB_REPOSITORY;
const issue=Number(env.ISSUE_NUMBER),run=Number(env.RUN_ID),pr=Number(env.PR_NUMBER);
if(!/^[a-f0-9]{40}$/.test(sha||''))fail('Invalid expected commit SHA');
if(!Number.isSafeInteger(issue)||issue<1||!Number.isSafeInteger(run)||run<1||!Number.isSafeInteger(pr)||pr<1)fail('Invalid release identifiers');
if(receipt.version!==1||receipt.repository!==repo||receipt.issue_number!==issue||receipt.run_id!==run||
 receipt.outcome!=='READY'||receipt.tested_head_sha!==sha||receipt.reviewed_head_sha!==sha||
 receipt.pr_url!=='https://github.com/'+repo+'/pull/'+pr)fail('Completion receipt does not bind this review, commit, repo, issue and PR');
const c=receipt.checks;
if(c?.build!=='success')fail('Build did not pass');
const initial=c.test==='true'&&c.review==='pass';
const repaired=c.retest==='true'&&c.final_review==='pass';
if(!initial&&!repaired)fail('Independent tests and review did not pass for this commit');
process.stdout.write('VERIFIED RELEASE RECEIPT: '+sha+'\n');
