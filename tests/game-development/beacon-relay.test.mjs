import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import {runGameModelAcceptance, validateGameAcceptance} from '../../lib/game-development/rule-contract.mjs';
import {spec, acceptance, browserContract} from './beacon-relay.acceptance.mjs';
import {validateContract} from '../../scripts/project-context.mjs';
const source = readFileSync(new URL('../../app/project-pilots/beacon-relay/engine.ts',import.meta.url),'utf8');
const js = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {initialState,transition,encodeState,decodeState,STORAGE_KEY}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
const freeze = s => {Object.freeze(s.positions);Object.freeze(s.scores);return Object.freeze(s);};

test('versioned source-grounded rules and exact acceptance snapshots use actual engine',()=>{
  assert.equal(validateGameAcceptance(spec,acceptance).contractReady,true);
  validateContract(browserContract);
  const receipt=runGameModelAcceptance(spec,acceptance,transition);
  assert.equal(receipt.passed,true,JSON.stringify(receipt));
  assert.equal(receipt.browserChecks,'NOT_RUN');
  assert.equal(receipt.readyToRelease,false);
});

test('exhaustive positions, both actors, and destinations: only empty orthogonal moves succeed',()=>{
  for(const activePlayer of ['Red','Blue']) for(let from=0;from<16;from++) for(let occupied=0;occupied<16;occupied++){
    if(from===occupied)continue;
    const other=activePlayer==='Red'?'Blue':'Red';
    const s=freeze({...initialState(),activePlayer,turn:activePlayer==='Red'?1:2,positions:{[activePlayer]:from,[other]:occupied}});
    for(const cell of [-10,-1,...Array.from({length:17},(_,i)=>i),1.5,NaN,Infinity,'1',null]){
      const next=transition(s,{type:'MOVE',cell});
      const adjacent=Number.isInteger(cell)&&cell>=0&&cell<16&&cell!==occupied&&Math.abs(Math.floor(from/4)-Math.floor(cell/4))+Math.abs(from%4-cell%4)===1;
      if(adjacent) assert.deepEqual(next,{...s,positions:{...s.positions,[activePlayer]:cell},phase:'RESOLVE'});
      else assert.equal(next,s);
    }
    assert.equal(transition(s,{type:'END_TURN'}),s);
  }
});

test('both actors score only at beacons during RESOLVE and victory freezes every action',()=>{
  for(const activePlayer of ['Red','Blue']) for(let cell=0;cell<16;cell++) for(const prior of [0,1]){
    const other=activePlayer==='Red'?'Blue':'Red';
    const s=freeze({...initialState(),activePlayer,turn:activePlayer==='Red'?3:4,positions:{[activePlayer]:cell,[other]:(cell+1)%16},scores:{[activePlayer]:prior,[other]:0},phase:'RESOLVE'});
    for(let to=0;to<16;to++)assert.equal(transition(s,{type:'MOVE',cell:to}),s);
    const scored=cell===5||cell===10;
    const next=transition(s,{type:'END_TURN'});
    assert.equal(next.scores[activePlayer],prior+Number(scored));
    assert.equal(next.scores[other],0);
    assert.deepEqual(next.positions,s.positions);
    const won=prior===1&&scored;
    assert.equal(next.phase,won?'GAME_OVER':'MOVE');
    assert.equal(next.activePlayer,won?activePlayer:other);
    assert.equal(next.turn,s.turn+Number(!won));
    assert.equal(next.winner,won?activePlayer:null);
    if(won){
      for(let to=0;to<16;to++)assert.equal(transition(next,{type:'MOVE',cell:to}),next);
      assert.equal(transition(next,{type:'END_TURN'}),next);
    }
    assert.deepEqual(transition(next,{type:'RESET'}),initialState());
    assert.deepEqual(decodeState(encodeState(next)),next);
  }
});

test('versioned complete saves preserve MOVE, RESOLVE, GAME_OVER and Reset; corrupt saves fail closed',()=>{
  assert.equal(STORAGE_KEY,'beacon-relay-duel:v1');
  const moved=transition(initialState(),{type:'MOVE',cell:4});
  assert.equal(moved.phase,'RESOLVE');
  assert.deepEqual(decodeState(encodeState(moved)),moved);
  assert.deepEqual(decodeState(encodeState(transition(moved,{type:'RESET'}))),initialState());
  for(const raw of [null,'','{','null','{}',JSON.stringify({version:2,state:moved}),JSON.stringify({version:1,state:{...moved,positions:{Red:4,Blue:4}}}),JSON.stringify({version:1,state:{...moved,winner:'Blue'}}),JSON.stringify({version:1,state:{...moved,turn:2}}),JSON.stringify({version:1,state:{...moved,scores:{Red:2,Blue:0}}})]){
    assert.deepEqual(decodeState(raw),initialState());
  }
  const a=initialState(),b=initialState();a.positions.Red=4;assert.equal(b.positions.Red,0);
});

test('Blue can win a real alternating game; every intermediate phase reloads and resets',()=>{
  let state=initialState();
  // Each entry is the next active player's legal destination, starting with Red.
  for(const cell of [1,14,2,10,3,9,7,10]){
    state=transition(freeze(state),{type:'MOVE',cell});
    assert.equal(state.phase,'RESOLVE');
    state=decodeState(encodeState(state));
    assert.deepEqual(transition(state,{type:'RESET'}),initialState());
    state=transition(freeze(state),{type:'END_TURN'});
    assert.deepEqual(decodeState(encodeState(state)),state);
  }
  assert.deepEqual(state,{positions:{Red:7,Blue:10},scores:{Red:0,Blue:2},activePlayer:'Blue',turn:8,phase:'GAME_OVER',winner:'Blue'});
});
