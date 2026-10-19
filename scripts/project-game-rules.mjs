import {isDeepStrictEqual} from 'node:util';
// Game-domain contract only: no executive orchestration or authority to deploy.
const ok = (condition, message) => { if (!condition) throw Error('Game contract invalid: ' + message); };
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const label = x => typeof x === 'string' && x.trim().length > 0;
const id = x => label(x) && /^[a-z][a-z0-9-]{0,79}$/.test(x);
const json = value => {try {return isDeepStrictEqual(JSON.parse(JSON.stringify(value)),value)} catch {return false}};
function ids(items, name) {
  ok(Array.isArray(items) && items.length > 0, name + ' must be nonempty');
  const found = new Set();
  for (const item of items) {
    ok(object(item) && id(item.id) && !found.has(item.id), name + ' needs unique stable ids');
    found.add(item.id);
  }
  return found;
}
function refs(values, allowed, name) {
  ok(Array.isArray(values) && values.length > 0 && values.every(value=>allowed.has(value)),name+' references must resolve');
  ok(new Set(values).size===values.length,name+' contains duplicate references');
}
const categories = new Set(['setup','action','turn','phase','combat','randomness','information','victory','persistence','reset','ui','other']);
export function validateGameRules(spec) {
  ok(object(spec) && spec.schemaVersion===1 && object(spec.game),'schemaVersion/game required');
  ok(id(spec.game.id) && label(spec.game.title) && label(spec.game.edition) && ['original','reproduction'].includes(spec.game.kind),'identify game and edition');
  const sourceIds=ids(spec.sources,'sources');
  for(const source of spec.sources){
    ok(['user','official','authorized_reference','other'].includes(source.kind) && label(source.reference),'source needs kind and reference');
    if(source.kind==='official')ok(label(source.edition),'official source needs edition');
  }
  const ruleIds=ids(spec.rules,'rules');
  const unresolvedRules=[];
  for(const rule of spec.rules){
    ok(label(rule.description) && categories.has(rule.category) && ['verified','approved_interpretation','unresolved'].includes(rule.status),'rule '+rule.id+' incomplete');
    refs(rule.sourceIds,sourceIds,'rule '+rule.id+' sourceIds');
    if(rule.status==='approved_interpretation')ok(rule.sourceIds.some(sourceId=>spec.sources.find(s=>s.id===sourceId).kind==='user'),'approved interpretation requires user decision source');
    if(rule.status==='unresolved')unresolvedRules.push(rule.id);
  }
  ok(Array.isArray(spec.unknowns),'unknowns array is required');
  const seenUnknowns=new Set();
  const unresolvedBlocking=[];
  for(const unknown of spec.unknowns){
    ok(object(unknown) && id(unknown.id) && !seenUnknowns.has(unknown.id),'unknowns need unique ids');
    seenUnknowns.add(unknown.id);
    ok(label(unknown.question) && ['open','resolved'].includes(unknown.status) && typeof unknown.blocking==='boolean','unknown incomplete');
    refs(unknown.ruleIds,ruleIds,'unknown '+unknown.id+' ruleIds');
    if(unknown.status==='resolved')refs([unknown.decisionSourceId],sourceIds,'resolution source');
    if(unknown.status==='open' && unknown.blocking)unresolvedBlocking.push(unknown.id);
  }
  const invariantIds=ids(spec.invariants,'invariants');
  for(const invariant of spec.invariants){
    ok(label(invariant.description),'invariant needs description');
    refs(invariant.ruleIds,ruleIds,'invariant '+invariant.id+' ruleIds');
  }
  ok(object(spec.stateModel) && json(spec.stateModel.initialState) && Array.isArray(spec.stateModel.phases) && spec.stateModel.phases.every(label),'stateModel needs serializable initialState and phases');
  return {gameId:spec.game.id,sourceIds,ruleIds,invariantIds,unresolvedRules,unresolvedBlocking};
}
export function validateGameAcceptance(spec,acceptance) {
  const rules=validateGameRules(spec);
  ok(object(acceptance) && acceptance.schemaVersion===1 && acceptance.gameId===spec.game.id,'acceptance schema/game mismatch');
  const scenarioIds=ids(acceptance.scenarios,'scenarios');
  const covered=new Set();let model=0,browser=0;
  for(const s of acceptance.scenarios){
    ok(label(s.description) && ['model','browser'].includes(s.kind),'scenario '+s.id+' needs kind/description');
    refs(s.ruleIds,rules.ruleIds,'scenario '+s.id+' ruleIds');
    refs(s.invariantIds,rules.invariantIds,'scenario '+s.id+' invariantIds');
    for(const r of s.ruleIds){ok(!rules.unresolvedRules.includes(r),'scenario '+s.id+' claims unresolved rule '+r);covered.add(r)}
    ok(Array.isArray(s.steps) && s.steps.length>0,'scenario '+s.id+' needs steps');
    if(s.kind==='model'){
      model++;
      ok(s.steps.every(step=>object(step) && object(step.action) && label(step.action.type) && json(step.action) && json(step.expectedState)),'model scenario '+s.id+' needs exact expected states');
    }else{
      browser++;
      ok(s.steps.every(step=>object(step) && ['goto','click','fill','expectText','expectVisible'].includes(step.action)),'unsupported browser action');
      ok(s.steps.some(step=>['expectText','expectVisible'].includes(step.action)),'browser scenario '+s.id+' needs assertion');
      ok(s.steps.every(step=>step.action==='goto'?typeof step.path==='string' && step.path.startsWith('/') && !step.path.startsWith('//') : label(step.selector)),'browser scenario '+s.id+' invalid path/selector');
      ok(s.steps.every(step=>!['fill','expectText'].includes(step.action)||typeof step.value==='string'),'browser expected value missing');
    }
  }
  ok(model>0 && browser>0,'a browser game needs model and real-browser contracts');
  for(const rule of spec.rules)if(rule.status!=='unresolved')ok(covered.has(rule.id),'approved rule '+rule.id+' missing acceptance coverage');
  return {gameId:spec.game.id,scenarioCount:scenarioIds.size,modelScenarioCount:model,browserScenarioCount:browser,pendingAmbiguities:rules.unresolvedBlocking,contractReady:rules.unresolvedBlocking.length===0&&rules.unresolvedRules.length===0};
}
export function runGameModelAcceptance(spec,acceptance,applyAction){
  const preflight=validateGameAcceptance(spec,acceptance);ok(typeof applyAction==='function','applyAction must be function');
  const checks=[];
  for(const scenario of acceptance.scenarios.filter(s=>s.kind==='model')){
    let state=structuredClone(spec.stateModel.initialState);
    try{
      for(let i=0;i<scenario.steps.length;i++){
        const step=scenario.steps[i],before=structuredClone(state);
        const next=applyAction(state,structuredClone(step.action));
        ok(isDeepStrictEqual(state,before),'action '+i+' mutated previous state');
        ok(json(next),'action '+i+' returned unserializable state');
        ok(isDeepStrictEqual(next,step.expectedState),'action '+i+' disagreed with expected state');
        state=next;
      }
      checks.push({id:scenario.id,passed:true,steps:scenario.steps.length});
    }catch(error){checks.push({id:scenario.id,passed:false,reason:String(error.message).slice(0,250)})}
  }
  return {gameId:preflight.gameId,passed:checks.length>0&&checks.every(c=>c.passed),modelChecks:checks,browserChecks:'NOT_RUN',readyToRelease:false,pendingAmbiguities:preflight.pendingAmbiguities};
}
export function validateProjectGame(game,allowedPaths,finalContract) {
  ok(object(game) && Object.keys(game).sort().join() === ['acceptance','enginePath','rules'].join(),'game registration fields');
  ok(typeof game.enginePath==='string' && /^(?:app|lib)\/[a-zA-Z0-9_/-]+\.(?:ts|mjs)$/.test(game.enginePath) && !game.enginePath.split('/').includes('..'),'pure engine path required');
  ok(allowedPaths.some(p=>p===game.enginePath||p.endsWith('/')&&game.enginePath.startsWith(p)),'engine outside approved paths');
  const preflight=validateGameAcceptance(game.rules,game.acceptance);
  ok(preflight.contractReady,'resolve game rules and blocking unknowns before coding');
  const scenarios=game.acceptance.scenarios.filter(s=>s.kind==='browser').map(s=>({name:s.id,steps:s.steps}));
  ok(isDeepStrictEqual(structuredClone(scenarios),structuredClone(finalContract.scenarios)),'final browser contract must exactly execute registered game scenarios');
  return game;
}
