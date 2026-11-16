// Pure advisory forecast. Inputs are normalized by a trusted, read-only adapter;
// this module neither authenticates remote artifacts nor authorizes execution.
export const CAPACITY_VERSION='lifecycle-capacity-v1';
export const STAGES=Object.freeze({implementation:'native',initial_review:'native',repair:'native',verification:'deterministic',final_review:'native',do_completion:'completion',assessment:'assessment',browser_delivery:'deterministic'});
const integer=n=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
const known=n=>integer(n)?n:null;
const add=xs=>xs.every(integer)&&Number.isSafeInteger(xs.reduce((a,b)=>a+b,0))?xs.reduce((a,b)=>a+b,0):null;
const sub=(a,b)=>integer(a)&&integer(b)?Math.max(0,a-b):null;
const min=xs=>xs.every(integer)?Math.min(...xs):null;
const text=v=>typeof v==='string'&&v.length>0&&v.length<=160?v:null;
const decimal=v=>typeof v==='string'&&/^\d{1,18}(?:\.\d{1,12})?$/.test(v)?v:null;
const fraction=v=>{const [a,b='']=v.split('.');return [BigInt(a+b),10n**BigInt(b.length)];};
export function modelCostMicrousd(inputTokens,outputTokens,pricing,observedAt){
 if(!integer(inputTokens)||!integer(outputTokens)||pricing?.status!=='verified'||pricing.serviceTier!=='default'||!text(pricing.source)||!integer(observedAt)||!integer(pricing.verifiedAt)||pricing.verifiedAt>observedAt||observedAt-pricing.verifiedAt>86400000)return null;
 const i=decimal(pricing.inputUsdPerMillion),o=decimal(pricing.outputUsdPerMillion);if(!i||!o)return null;
 const [a,b]=fraction(i),[c,d]=fraction(o);if(a<=0n||c<=0n)return null;
 // USD/million * tokens = microUSD. Round upward once, never use floats.
 const numerator=BigInt(inputTokens)*a*d+BigInt(outputTokens)*c*b,denominator=b*d;
 return ((numerator+denominator-1n)/denominator).toString();
}
const MONEY_SCALE=10n**12n;
const money=v=>decimal(v)?(()=>{const [n,d]=fraction(v);return n*(MONEY_SCALE/d);})():null;
const moneyText=n=>{const sign=n<0n?'-':'';const a=n<0n?-n:n;const f=(a%MONEY_SCALE).toString().padStart(12,'0').replace(/0+$/,'');return sign+(a/MONEY_SCALE).toString()+(f?'.'+f:'');};
const sumMoney=xs=>xs.every(x=>money(x)!==null)?moneyText(xs.reduce((a,b)=>a+money(b),0n)):null;
function measure(samples,key,units){
 if(units===0)return {expected:0,contingency:0,projected:0,samples:0,basis:'completed_or_not_required'};
 const values=samples.map(s=>s[key]).filter(integer).sort((a,b)=>a-b);
 if(!integer(units)||values.length<3)return {expected:null,contingency:null,projected:null,samples:values.length,basis:'insufficient_comparable_completed_observations'};
 const expected=values[Math.floor(values.length/2)]*units,projected=values.at(-1)*units;
 if(!integer(projected))return {expected:null,contingency:null,projected:null,samples:values.length,basis:'numeric_range_unavailable'};
 return {expected,contingency:projected-expected,projected,samples:values.length,basis:'upper_median_plus_observed_maximum_difference'};
}
export function assessLifecycleCapacity(input){
 const binding=input.binding??{},progress=input.progress??{},authority=input.authorization??{},now=known(input.observedAt);
 const identities=['taskId','projectId','baselineSha','scopeHash','contractHash'];
 const bindingValid=identities.every(k=>text(binding[k]));
 const trusted=bindingValid&&['authenticated_recovery','trusted_host'].includes(progress.source)&&identities.every(k=>progress.binding?.[k]===binding[k]);
 const requested=Array.isArray(progress.completedStages)?progress.completedStages:[];
 const consistent=requested.every(k=>Object.hasOwn(STAGES,k))&&(!requested.includes('initial_review')||requested.includes('implementation'))&&(!requested.includes('final_review')||requested.includes('initial_review'))&&(!requested.includes('do_completion')||requested.includes('final_review'))&&(!requested.includes('assessment')||requested.includes('do_completion'));
 const recoveryProof=progress.source!=='authenticated_recovery'||typeof progress.checkpointSha==='string'&&/^[a-f0-9]{40}$/.test(progress.checkpointSha);
 const valid=trusted&&consistent&&recoveryProof&&Object.hasOwn(STAGES,progress.phase);
 const completed=valid?requested:[];
 const waived=valid&&Array.isArray(progress.notRequiredStages)?progress.notRequiredStages.filter(s=>s==='repair'&&input.work?.repairIterations===0&&input.work?.additionalRepairIterations===0):[];
 const uncertainties=[];
 if(!valid)uncertainties.push('untrusted_or_conflicting_progress');
 if(now===null)uncertainties.push('missing_snapshot_time');
 const nativeFloor=input.work?.nativePhaseProfile==='fresh-native-inspection-v1'&&input.work?.nativeMinimumCalls===2?2:1;
 const repairs=known(input.work?.repairIterations);
 const extras=known(input.work?.additionalRepairIterations);
 const remainingRepairs=waived.includes('repair')?0:completed.includes('repair')?extras:add([repairs,extras]);
 const stages=Object.entries(STAGES).map(([stage,pool])=>{
  // Each planned repair invalidates verification, even if the initial verifier passed.
  const verificationUnits=remainingRepairs===null?null:remainingRepairs>0?add([remainingRepairs,!completed.includes('verification')&&!completed.includes('initial_review')?1:0]):completed.includes('verification')?0:1;
  const done=stage==='verification'?verificationUnits===0:(completed.includes(stage)||waived.includes(stage))&&!(stage==='repair'&&extras>0);
  const units=stage==='verification'?verificationUnits:done?0:stage==='repair'?remainingRepairs:1;
  const samples=(input.observations??[]).filter(s=>s?.stage===stage&&s.completed===true&&s.source==='verified_phase_receipts'&&text(input.cohort)&&s.cohort===input.cohort&&text(s.id)&&s.binding?.projectId===binding.projectId&&s.binding?.scopeHash===binding.scopeHash);
  const unique=new Set(samples.map(s=>s.id));if(unique.size!==samples.length)samples.length=0;
  const metrics=Object.fromEntries(['calls','inputTokens','outputTokens','seconds'].map(k=>[k,measure(samples,k,units)]));
  if(pool==='deterministic')for(const k of ['calls','inputTokens','outputTokens'])metrics[k]={expected:0,contingency:0,projected:0,samples:0,basis:'no_model_execution_in_this_stage'};
  const minimumCalls=done||pool==='deterministic'?0:stage==='do_completion'?4:pool==='native'?nativeFloor*(stage==='repair'?(units===null?1:units):1):1;
  if(pool!=='deterministic'&&metrics.calls.projected!==null&&metrics.calls.projected<minimumCalls){metrics.calls={expected:null,contingency:null,projected:null,samples:samples.length,basis:'observations_conflict_with_required_calls'};}
  const pricing=input.pricing?.[pool];
  const expectedMicrousd=done||pool==='deterministic'?'0':modelCostMicrousd(metrics.inputTokens.expected,metrics.outputTokens.expected,pricing,now);
  const projectedMicrousd=done||pool==='deterministic'?'0':modelCostMicrousd(metrics.inputTokens.projected,metrics.outputTokens.projected,pricing,now);
  const otherApiCost=done?'0':decimal(input.otherApiCostMicrousd?.[stage]);
  // Other API costs must be bounded explicitly, even when model tokens are zero.
  const other=otherApiCost&&/^\d+$/.test(otherApiCost)?otherApiCost:null;
  if(Object.values(metrics).some(x=>x.projected===null))uncertainties.push(stage+':missing_measurements');
  if(projectedMicrousd===null)uncertainties.push(stage+':unverified_or_missing_pricing');
  if(other===null)uncertainties.push(stage+':unbounded_other_api_cost');
  return {stage,pool,status:waived.includes(stage)?'not_required':done?'completed':valid&&progress.phase===stage?'in_progress':'remaining',remainingUnits:units,minimumCalls,metrics,
   cost:{unit:'microUSD',expected:sumMoney([expectedMicrousd,other]),projected:sumMoney([projectedMicrousd,other])},
   evidence:samples.map(s=>s.id).sort(),confidence:done?'completed':samples.length>=3?'empirical_not_guaranteed':'uncertain'};
 });
 const t=authority.tokens??{},c=authority.calls??{},d=authority.money??{};
 const total=sub(t.cumulativeLimit,t.accountEncumbered),development=sub(t.developmentLimit,t.developmentEncumbered);
 const completionTokens=known(t.completionReserveRemaining),assessmentTokens=known(t.assessmentReserveRemaining);
 const completionCalls=known(c.completionReserveRemaining),developmentCalls=sub(c.developmentLimit,c.developmentConsumed);
 const active=authority.live===true&&now!==null&&integer(authority.deadline)&&authority.deadline>now;
 const capacity={totalTokens:total,nativeTokens:min([sub(development,completionTokens),sub(total,add([completionTokens,assessmentTokens]))]),completionTokens:min([completionTokens,development,sub(total,assessmentTokens)]),assessmentTokens:min([assessmentTokens,total]),
  nativeCalls:sub(developmentCalls,completionCalls),completionCalls:min([completionCalls,developmentCalls]),assessmentCalls:sub(c.assessmentLimit,c.assessmentConsumed),seconds:now!==null&&integer(authority.deadline)?Math.max(0,Math.floor((authority.deadline-now)/1000)):null};
 const ceiling=money(d.ceilingMicrousd),exposure=money(d.exposureMicrousd);
 const dollars=d.complete===true&&ceiling!==null&&exposure!==null?moneyText(ceiling>exposure?ceiling-exposure:0n):null;
 const dimensions={};
 function compare(name,unit,required,available,minimum=0){
  const isMoney=unit==='microUSD',convert=v=>isMoney?money(v):known(v),need=convert(required),have=convert(available),floor=convert(minimum);
  let status=have!==null&&floor!==null&&have<floor?'insufficient':need===null||have===null?'indeterminate':have<need?'insufficient':'sufficient';
  const difference=need!==null&&have!==null?have-need:null;
  dimensions[name]={unit,expectedRemaining:null,projectedRemaining:required,minimumRemaining:minimum,authorizedRemaining:available,
   currentlyUsable:active&&authority.executionAuthorized===true?available:authority.executionAuthorized===false||authority.live===false||capacity.seconds===0?(isMoney?'0':0):null,status,minimumShortfall:have!==null&&floor!==null?(isMoney?moneyText(floor>have?floor-have:0n):Math.max(0,floor-have)):null,
   shortfall:difference===null?null:isMoney?moneyText(difference<0n?-difference:0n):Math.max(0,-difference),headroom:difference===null?null:isMoney?moneyText(difference):difference};
 }
 const sumMetric=(rows,key,field)=>add(rows.map(s=>s.metrics[key][field]));
 for(const [pool,prefix]of [['native','native'],['completion','completion'],['assessment','assessment']]){
  const rows=stages.filter(s=>s.pool===pool),minimum=add(rows.map(s=>s.minimumCalls));
  compare(prefix+'Calls','calls',sumMetric(rows,'calls','projected'),capacity[prefix+'Calls'],minimum);
  compare(prefix+'Tokens','input_plus_output_tokens',add([sumMetric(rows,'inputTokens','projected'),sumMetric(rows,'outputTokens','projected')]),capacity[prefix+'Tokens']);
  dimensions[prefix+'Calls'].expectedRemaining=sumMetric(rows,'calls','expected');
  dimensions[prefix+'Tokens'].expectedRemaining=add([sumMetric(rows,'inputTokens','expected'),sumMetric(rows,'outputTokens','expected')]);
 }
 compare('totalTokens','input_plus_output_tokens',add([sumMetric(stages,'inputTokens','projected'),sumMetric(stages,'outputTokens','projected')]),capacity.totalTokens);
 compare('money','microUSD',sumMoney(stages.map(s=>s.cost.projected)),dollars,'0');
 // Unknown stages must not erase a known estimated requirement. This subtotal
 // is a partial forecast, not a hard minimum or a complete funding estimate.
 dimensions.money.knownProjectedRemaining=sumMoney(stages.filter(s=>s.cost.projected!==null).map(s=>s.cost.projected));
 dimensions.money.unestimatedStages=stages.filter(s=>s.cost.projected===null).map(s=>s.stage);
 if(dimensions.money.projectedRemaining===null&&dollars!==null&&money(dimensions.money.knownProjectedRemaining)>money(dollars)){
  dimensions.money.status='insufficient';
  dimensions.money.knownProjectedShortfall=moneyText(money(dimensions.money.knownProjectedRemaining)-money(dollars));
  uncertainties.push('money:partial_estimate_excludes_unestimated_stages');
 }
 compare('time','seconds',sumMetric(stages,'seconds','projected'),capacity.seconds);
 dimensions.totalTokens.expectedRemaining=add([sumMetric(stages,'inputTokens','expected'),sumMetric(stages,'outputTokens','expected')]);
 dimensions.money.expectedRemaining=sumMoney(stages.map(s=>s.cost.expected));dimensions.time.expectedRemaining=sumMetric(stages,'seconds','expected');
 for(const value of Object.values(dimensions)){const a=value.expectedRemaining,b=value.projectedRemaining;value.contingency=a===null||b===null?null:value.unit==='microUSD'?moneyText(money(b)-money(a)):b-a;}
 const shortages=Object.entries(dimensions).filter(([,v])=>v.status==='insufficient').map(([k])=>k);
 if(integer(t.cumulativeLimit)&&integer(t.accountEncumbered)&&t.accountEncumbered>t.cumulativeLimit)shortages.push('totalTokens');
 if(integer(t.developmentLimit)&&integer(t.developmentEncumbered)&&t.developmentEncumbered>t.developmentLimit)shortages.push('nativeTokens');
 if(ceiling!==null&&exposure!==null&&exposure>ceiling)shortages.push('money');
 if(authority.live===false||authority.executionAuthorized===false||capacity.seconds===0)shortages.push('executionAuthority');
 if(!active&&authority.live!==false&&capacity.seconds!==0)uncertainties.push('execution_authority_unknown');
 for(const name of shortages)if(dimensions[name])dimensions[name].status='insufficient';
 const status=shortages.length?'insufficient':!valid||!active||Object.values(dimensions).some(v=>v.status==='indeterminate')?'indeterminate':'sufficient';
 return {version:CAPACITY_VERSION,kind:'forecast_not_authorization',binding:Object.fromEntries(identities.map(k=>[k,text(binding[k])])),observedAt:now,
  evidence:{source:valid?progress.source:null,checkpointSha:valid?text(progress.checkpointSha):null,accountingSource:text(authority.source),cohort:text(input.cohort)},
  currentPhase:valid?progress.phase:null,stages,dimensions,status,shortages,uncertainties:[...new Set(uncertainties)].sort(),
  protectedReserves:{completionTokens,completionCalls,assessmentTokens},authorization:{executionAuthorized:authority.executionAuthorized??null,live:authority.live??null,deadline:authority.deadline??null,spendingPermission:'unchanged',snapshotOnly:true},
  methodology:{minimumComparableObservations:3,expected:'upper median of comparable completed phase observations',contingency:'observed maximum minus upper median, per metric; no fixed multiplier',tokenAccounting:'input plus output; authorized input/output sublimits are not invented',monetaryAccounting:'cumulative model/API exposure including uncertain reservations; integer microUSD strings',guaranteed:false}};
}
