// Diagnostic preflight only. Lease-bound PostgreSQL admission remains authoritative
// for identity, scope, context sizing, cumulative resources, deadlines and dispatch.
type Row=Record<string,unknown>;
const text=(v:unknown):string|null=>v==null?null:typeof v==='string'?v:JSON.stringify(v);
const length=(v:unknown)=>Array.from((text(v)??'').replace(/^ +| +$/g,'')).length;
const object=(v:unknown):v is Row=>v!==null&&typeof v==='object'&&!Array.isArray(v);

export function smartContractFields(c:unknown, parentObjective:unknown, projectObjective:unknown,
 role:string|undefined, worker:Row|undefined):string[]{
 if(!object(c))return ['contract'];
 const fields:string[]=[];
 const check=(valid:boolean,path:string)=>{if(!valid&&fields.length<32)fields.push(path);};
 check(length(c.objective)>=1&&length(c.objective)<=2000&&text(c.objective)!==parentObjective&&text(c.objective)!==projectObjective,'objective');
 check(length(c.deliverable)>=1&&length(c.deliverable)<=500,'deliverable');
 check(length(c.instruction)>=1&&length(c.instruction)<=5000,'instruction');
 check(text(c.parentObjective)===parentObjective,'parentObjective');
 for(const field of ['acceptance','inventory']){
  const entries=c[field];check(Array.isArray(entries)&&entries.length>0,field);
  if(Array.isArray(entries))entries.forEach((entry,index)=>{
   const value=object(entry)?entry:{};
   if(field==='acceptance')for(const key of ['criterion','evidence'])check(length(value[key])>0,`${field}[${index}].${key}`);
   else {check(length(value.item)>0,`${field}[${index}].item`);check(/^[0-9]{1,7}$/.test(text(value.contextChars)??''),`${field}[${index}].contextChars`);}
  });
 }
 const estimate=object(c.estimate)?c.estimate:{};
 check(estimate.basis==='declared_inventory','estimate.basis');
 for(const key of ['rationale','uncertainty'])check(length(estimate[key])>0,'estimate.'+key);
 check(/^[1-9][0-9]{0,8}$/.test(text(estimate.tokens)??''),'estimate.tokens');
 check(/^[1-9][0-9]{0,6}$/.test(text(estimate.seconds)??''),'estimate.seconds');
 check(/^[1-9][0-9]{0,8}$/.test(text(c.tokens)??''),'tokens');
 check(/^[1-9][0-9]{0,3}$/.test(text(c.maxAssignments)??''),'maxAssignments');
 check(c.deadline!=null,'deadline');
 // authorize_assignment's role/worker are resolved by SQL, never guessed here.
 if(role&&worker){
  const capability=role==='development'?'development':['compose','review','revise'].includes(role)?'analysis':c.capability==='writing'?'analysis':text(c.capability);
  check(capability!=null&&Array.isArray(worker.tools)&&worker.tools.includes(capability),'capability');
 }
 return fields;
}

// Only known definitive admission errors are classified. Transport errors and
// unknown outcomes must not be represented as rolled-back decisions or retried.
export function smartSqlRejection(error:unknown):{code:string;reason:string}|null{
 const message=error instanceof Error?error.message:'';
 const prefix='Mission state operation failed: ';
 if(!message.startsWith(prefix))return null;
 let payload:Row;try{payload=JSON.parse(message.slice(prefix.length));}catch{return null;}
 if(!object(payload)||payload.code!=='P0001'||typeof payload.message!=='string')return null;
 const reasons:Record<string,string>={
  'Ready-only response cannot abandon an owned open exception':'unresolved_management_exception',
  'Specific measurable single-worker SMART contract and traceable sizing estimate required':'smart_contract_fields_sql',
  'SMART estimated workload exceeds single-worker context, resources or execution window; decompose before dispatch':'smart_contract_capacity',
  'Explicit SMART scope required':'smart_contract_scope',
  'SMART requires an explicit bounded file inventory within worker scope':'smart_contract_scope',
 };
 const code=Object.prototype.hasOwnProperty.call(reasons,payload.message)?reasons[payload.message]:null;return code?{code,reason:payload.message}:null;
}


// PostgreSQL jsonb::text inserts one space after a colon/comma, uses JSON
// escapes and expands numeric exponents. Ordering of keys cannot affect
// length. Count Unicode code points, as length(text) does in PostgreSQL,
// not UTF-16 units or UTF-8 bytes. The submitted JSON has already been parsed.
export function smartJsonbChars(value:unknown):number{
 if(value===null)return 4;
 if(typeof value==='string'){
  if(value.includes('\u0000')||Array.from(value).some(c=>c.length===1&&/[\uD800-\uDFFF]/.test(c)))throw Error('Invalid PostgreSQL JSON text');
  return Array.from(JSON.stringify(value)).length;
 }
 if(typeof value==='boolean')return value?4:5;
 if(typeof value==='number'){
  if(!Number.isFinite(value))throw Error('Non-finite SMART JSON number');
  const s=JSON.stringify(value);
  const e=s.match(/^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/);
  if(!e)return s.length;
  const [,sign,whole,fraction='',exponent]=e;
  const digits=whole.length+fraction.length,point=whole.length+Number(exponent);
  return sign.length+(point<=0?2-point+digits:point>=digits?point:digits+1);
 }
 if(Array.isArray(value))return 2+value.reduce((sum,x)=>sum+smartJsonbChars(x),0)+Math.max(0,value.length-1)*2;
 if(object(value)){
  const entries=Object.entries(value).filter(([,v])=>v!==undefined);
  return 2+entries.reduce((sum,[k,v])=>sum+smartJsonbChars(k)+2+smartJsonbChars(v),0)+Math.max(0,entries.length-1)*2;
 }
 throw Error('Unsupported SMART JSON value');
}
type PackageRole='development'|'compose'|'review';
type WorkerCapacity={
 nodeId:string;agentId:string;contextChars:number;delegatedTokens:number;alreadyContractedTokens:number;
 remainingSizingTokens:number;deadline:string;roles:PackageRole[];
};
export type CommissioningSmartCapacity={
 workers:WorkerCapacity[];deadline:string;maxAttempts:number;requirementsChars:number;
 browserAcceptanceChars:number;milestoneChars:number;providerControlled:boolean;
};
const positive=(v:unknown):number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0?v:
 typeof v==='string'&&/^[1-9][0-9]*$/.test(v)&&Number.isSafeInteger(Number(v))?Number(v):NaN;
const date=(v:unknown)=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(v)?Date.parse(v):NaN;
export function commissioningSmartCapacity(
 principal:Row,project:Row,nodes:Row[],team:Row[],contracts:Row[],
 roles:{workerId:string;writerId:string;reviewerId:string},providerControlled:boolean,
 now=Date.now()
):CommissioningSmartCapacity{
 const end=Math.min(date(principal.deadline),date(project.deadline));
 const maxAttempts=positive(project.max_cycles);
 if(!Number.isFinite(end)||end<=now||!Number.isFinite(maxAttempts))throw Error('Current commissioning deadline or attempt allowance unavailable');
 const workerIds:Record<PackageRole,string>={development:roles.workerId,compose:roles.writerId,review:roles.reviewerId};
 const workers:WorkerCapacity[]=[];
 for(const id of [...new Set(Object.values(workerIds))]){
  const n=nodes.find(n=>n.id===id),a=team.find(a=>a.id===n?.agent_id);
  const cfg=a?.config;
  if(!n||n.parent_id!==principal.id||n.kind!=='worker'||n.status!=='active'||!a||a.archived!==false||!object(cfg)||typeof n.agent_id!=='string')
   throw Error('Current committed worker capacity unavailable');
  const contextChars=positive(cfg.maxInputChars??16000),delegatedTokens=positive(n.token_limit);
  const deadlines=Math.min(end,date(n.deadline));
  const committed=contracts.filter(c=>c.worker_id===id).map(c=>positive(c.token_limit));
  const alreadyContractedTokens=committed.reduce((sum,t)=>sum+t,0);
  const remainingSizingTokens=delegatedTokens-alreadyContractedTokens;
  if(!Number.isFinite(contextChars)||!Number.isFinite(remainingSizingTokens)||remainingSizingTokens<=0
    ||!Number.isFinite(deadlines)||deadlines<=now)throw Error('No available committed worker sizing capacity');
  workers.push({nodeId:id,agentId:n.agent_id,contextChars,delegatedTokens,alreadyContractedTokens,remainingSizingTokens,
   deadline:new Date(deadlines).toISOString(),roles:(Object.keys(workerIds) as PackageRole[]).filter(r=>workerIds[r]===id)});
 }
 const spec=project.spec;
 if(!object(spec)||!Array.isArray(spec.requirements)||!Array.isArray(spec.milestones)||!object(spec.milestones[0]))
  throw Error('Approved milestone workload inventory unavailable');
 const milestone=spec.milestones[0];
 // The owner-approved browser contract is data, not proof of execution.
 // Count the actual saved source rather than an invented workload estimate.
 const browser=spec.finalContract??milestone.contract;
 return {workers,deadline:new Date(Math.min(end,...workers.map(w=>Date.parse(w.deadline)))).toISOString(),
  maxAttempts,requirementsChars:smartJsonbChars(spec.requirements),browserAcceptanceChars:browser==null?0:smartJsonbChars(browser),
  milestoneChars:smartJsonbChars(milestone),providerControlled};
}
export function commissioningSmartCapacityInstruction(c:CommissioningSmartCapacity,now=Date.now()):string{
 const available=Math.floor((Date.parse(c.deadline)-now)/1000);
 return '\nSIGNED SMART WORKLOAD CAPACITY — MANDATORY for EACH development, compose and review contract: '+JSON.stringify({...c,remainingExecutionSeconds:available})+
  '. The numbers above are measured saved inputs, existing authorization and maximum limits, NOT a predetermined task estimate. For EACH role the exact PostgreSQL context formula is length(contract::jsonb::text) + SUM(inventory[].contextChars) <= that worker contextChars. JSONB has spaces after separators and counts Unicode characters. Include the entire serialized contract (objectives, instructions, acceptance, inventory, estimates, paths and deadlines); leave real room for it and for all evidence actually needed. Do not confuse token counts or output size with input characters. The review worker receives the bounded implementation/composition evidence, not the whole repo, complete management ledger or unrelated source. Count the actual approved requirements/browser contract where needed, once if identical, plus the planned evidence to be reviewed. The development and composition roles share ONE worker token-sizing allocation; review has its separate allocation. Sum the declared contract tokens by worker, including prior contracts, within remainingSizingTokens. In this provider-controlled window this is task sizing, not a new financial reconciliation or provider spending gate. estimate.tokens is the estimated tokens PER assignment; estimate.tokens * maxAssignments <= contract.tokens. estimate.seconds is seconds PER assignment; multiply by maxAssignments and fit the remaining execution window and the contract deadline. Each contract deadline <= its worker, manager, project AND package deadline; maxAssignments <= package.maxAttempts <= maxAttempts. Use a real, concise, explicit work inventory, exact approved file paths and evidence sources; explain estimation rationale and uncertainty. Do not lower, truncate, duplicate-count or zero out necessary evidence just to satisfy arithmetic. Scope a single coherent approved milestone into its existing development, technical composition and distinct review tasks. If real work cannot fit, fail closed rather than fabricate estimates or expand authorization. No new appointment, scope grant or coding dispatch.';
}
export type SmartCapacityDiagnostic={field:string;actual:number;limit:number};
export function smartPackageCapacityFields(command:Row,capacity:CommissioningSmartCapacity,now=Date.now()):SmartCapacityDiagnostic[]{
 const failures:SmartCapacityDiagnostic[]=[];
 const check=(field:string,actual:number,limit:number)=>{if(!Number.isFinite(actual)||!Number.isFinite(limit)||actual>limit)failures.push({field,actual:Number.isFinite(actual)?actual:-1,limit:Number.isFinite(limit)?limit:-1});};
 const deadline=date(command.deadline),cutoff=Date.parse(capacity.deadline),maxAttempts=positive(command.maxAttempts);
 check('deadline',deadline,cutoff);check('deadline.remainingSeconds',1,(deadline-now)/1000);
 check('maxAttempts',maxAttempts,capacity.maxAttempts);
 const tasks=object(command.tasks)?command.tasks:{};
 let secondsTotal=0;
 for(const worker of capacity.workers){
  let total=0;
  for(const role of worker.roles){
   const c=tasks[role];const prefix='tasks.'+role;
   if(!object(c)||!object(c.estimate)||!Array.isArray(c.inventory)){check(prefix+'.contract',1,0);continue;}
   const entries=c.inventory.map(x=>object(x)&&/^[0-9]{1,7}$/.test(text(x.contextChars)??'')?Number(x.contextChars):NaN);
   const inventoryChars=entries.reduce((sum,n)=>sum+n,0);
   let contractChars:number;try{contractChars=smartJsonbChars(c);}catch{contractChars=NaN;}
   check(prefix+'.contextChars',contractChars+inventoryChars,worker.contextChars);
   const tokens=positive(c.tokens),attempts=positive(c.maxAssignments),estTokens=positive(c.estimate.tokens),seconds=positive(c.estimate.seconds);
   total+=tokens;
   check(prefix+'.estimate.tokens*maxAssignments',estTokens*attempts,tokens);
   check(prefix+'.maxAssignments',attempts,maxAttempts);
   const taskEnd=date(c.deadline),limit=Math.min(deadline,Date.parse(worker.deadline),cutoff);
   check(prefix+'.deadline',taskEnd,limit);
   check(prefix+'.estimate.seconds*maxAssignments',seconds*attempts,(Math.min(taskEnd,limit)-now)/1000);
   secondsTotal+=seconds*attempts;
  }
  check('worker.'+worker.nodeId+'.totalContractTokens',total,worker.remainingSizingTokens);
 }
 // Development, composition, and review are sequential dependent work.
 // Their estimated full assignment windows must fit the actual package cutoff.
 check('package.totalEstimatedSeconds',secondsTotal,(Math.min(deadline,cutoff)-now)/1000);
 return failures;
}
