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
