import test from 'node:test';
import assert from 'node:assert/strict';
import {validateGameRules,validateGameAcceptance,runGameModelAcceptance} from '../lib/game-development/rule-contract.mjs';

// Illustrative model of the user-specified 3x3 pilot: no claim of re-running
// the historical game PR's browser or app runtime in this fixture.
function fixture(){
  const rules=[
    ['initial','setup','One blue token at 0 and zero moves'],
    ['orthogonal','action','Orthogonally adjacent move increments count'],
    ['illegal','action','Diagonal and distant moves do not change state'],
    ['persist','persistence','Browser reload preserves state'],
    ['reset','reset','Reset restores position 0 and zero moves']
  ];
  const spec={
    schemaVersion:1,
    game:{id:'token-board-pilot',title:'Token board',edition:'2026 approved pilot',kind:'original'},
    sources:[{id:'user-instruction',kind:'user',reference:'User-approved pilot objective 2026-10-18'}],
    rules:rules.map(([id,category,description])=>({id,category,description,status:'verified',sourceIds:['user-instruction']})),
    unknowns:[],
    invariants:[
      {id:'valid-position',description:'The token occupies a valid cell',ruleIds:['initial','orthogonal','illegal']},
      {id:'saved-state',description:'Reload retains state; reset returns defaults',ruleIds:['persist','reset']}
    ],
    stateModel:{initialState:{position:0,moves:0},phases:[]}
  };
  const action=(cell,position,moves)=>({action:{type:'move',cell},expectedState:{position,moves}});
  const acceptance={
    schemaVersion:1,gameId:spec.game.id,scenarios:[
      {id:'moves',kind:'model',description:'Legal move, illegal diagonal and row edges',ruleIds:['initial','orthogonal','illegal'],invariantIds:['valid-position'],steps:[action(1,1,1),action(5,1,1),action(2,2,2)]},
      {id:'reset-model',kind:'model',description:'Reset is a deterministic state transition',ruleIds:['reset'],invariantIds:['saved-state'],steps:[action(3,3,1),{action:{type:'reset'},expectedState:{position:0,moves:0}}]},
      {id:'visible-movement',kind:'browser',description:'Actual click must change visible counters',ruleIds:['initial','orthogonal','illegal'],invariantIds:['valid-position'],steps:[{action:'goto',path:'/project-pilots/token-board'},{action:'click',selector:'#cell-1'},{action:'expectText',selector:'#position',value:'1'},{action:'click',selector:'#cell-5'},{action:'expectText',selector:'#position',value:'1'}]},
      {id:'reload-reset',kind:'browser',description:'Persistence across real reload and reset',ruleIds:['persist','reset'],invariantIds:['saved-state'],steps:[{action:'goto',path:'/project-pilots/token-board'},{action:'click',selector:'#cell-1'},{action:'goto',path:'/project-pilots/token-board'},{action:'expectText',selector:'#moves',value:'1'},{action:'click',selector:'#reset'},{action:'expectText',selector:'#position',value:'0'},{action:'expectText',selector:'#moves',value:'0'}]}
    ]
  };
  const transition=(state,command)=>{
    if(command.type==='reset')return {position:0,moves:0};
    if(command.type!=='move')throw Error('invalid command');
    const dist=Math.abs(Math.floor(state.position/3)-Math.floor(command.cell/3))+Math.abs(state.position%3-command.cell%3);
    return dist===1?{position:command.cell,moves:state.moves+1}:state;
  };
  return {spec,acceptance,transition};
}
test('3x3 game rules and acceptance trace to five authorized mechanics',()=>{
  const {spec,acceptance,transition}=fixture();
  assert.equal(validateGameRules(spec).ruleIds.size,5);
  const preflight=validateGameAcceptance(spec,acceptance);
  assert.equal(preflight.scenarioCount,4);
  assert.equal(preflight.modelScenarioCount,2);
  assert.equal(preflight.browserScenarioCount,2);
  assert.equal(preflight.contractReady,true);
  const receipt=runGameModelAcceptance(spec,acceptance,transition);
  assert.equal(receipt.passed,true);
  assert.equal(receipt.modelChecks.length,2);
  assert.equal(receipt.browserChecks,'NOT_RUN');
  assert.equal(receipt.readyToRelease,false);
});
test('unresolved rules and open blocking edition conflicts cannot imply readiness',()=>{
  const {spec,acceptance}=fixture();
  spec.unknowns=[{id:'edition-conflict',question:'Which edition?',status:'open',blocking:true,ruleIds:['orthogonal']}];
  assert.deepEqual(validateGameAcceptance(spec,acceptance).pendingAmbiguities,['edition-conflict']);
  assert.equal(validateGameAcceptance(spec,acceptance).contractReady,false);
  spec.rules[0].status='unresolved';
  assert.throws(()=>validateGameAcceptance(spec,acceptance),/claims unresolved rule/);
});
test('fabricated provenance, invalid sources and duplicate rule IDs are rejected',()=>{
  const {spec}=fixture();
  spec.rules[0].sourceIds=['invented-source'];
  assert.throws(()=>validateGameRules(spec),/references must resolve/);
  spec.rules[0].sourceIds=['user-instruction'];
  spec.sources[0].kind='other';
  spec.rules[0].status='approved_interpretation';
  assert.throws(()=>validateGameRules(spec),/requires user decision source/);
  spec.rules[0].status='verified';spec.rules[0].id='orthogonal';
  assert.throws(()=>validateGameRules(spec),/unique stable ids/);
});
test('missing gameplay coverage and browser contract escape attempts are rejected',()=>{
  const {spec,acceptance}=fixture();
  acceptance.scenarios[1].ruleIds=['initial'];
  acceptance.scenarios[3].ruleIds=['persist'];
  assert.throws(()=>validateGameAcceptance(spec,acceptance),/approved rule reset missing acceptance coverage/);
  acceptance.scenarios[3].ruleIds=['persist','reset'];
  acceptance.scenarios[3].steps=[{action:'goto',path:'https://example.net'},{action:'expectVisible',selector:'#reset'}];
  assert.throws(()=>validateGameAcceptance(spec,acceptance),/invalid path\/selector/);
  acceptance.scenarios[3].steps=[{action:'goto',path:'/project-pilots/token-board'}];
  assert.throws(()=>validateGameAcceptance(spec,acceptance),/needs assertion/);
});
test('wrong expected state and mutation produce explicit failed receipts',()=>{
  const {spec,acceptance}=fixture();
  const wrong=runGameModelAcceptance(spec,acceptance,()=>({position:8,moves:99}));
  assert.equal(wrong.passed,false);
  assert.match(wrong.modelChecks[0].reason,/disagreed/);
  const mutated=runGameModelAcceptance(spec,acceptance,state=>{state.position=2;return state});
  assert.equal(mutated.passed,false);
  assert.match(mutated.modelChecks[0].reason,/mutated previous state/);
});
test('orthogonal transition fixture exhaustively tests all 81 source-destination pairs',()=>{
  const {transition}=fixture();
  for(let source=0;source<9;source++)for(let target=0;target<9;target++){
    const before=Object.freeze({position:source,moves:12});
    const next=transition(before,{type:'move',cell:target});
    const legal=Math.abs(Math.floor(source/3)-Math.floor(target/3))+Math.abs(source%3-target%3)===1;
    assert.deepEqual(next,legal?{position:target,moves:13}:before);
  }
});