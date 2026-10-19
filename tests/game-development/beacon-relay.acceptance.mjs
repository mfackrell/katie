import { readFileSync } from 'node:fs';
export const spec = JSON.parse(readFileSync(new URL('./beacon-relay.rules.json', import.meta.url)));
const initial = spec.stateModel.initialState;
const allRules = spec.rules.map(r => r.id);
const scenario = (id, kind, steps) => ({ id, kind, description: id.replaceAll('-', ' '), ruleIds: allRules, invariantIds: ['state-integrity'], steps });
// Explicit expected snapshots are independent of the production transition.
let expected = structuredClone(initial);
const modelSteps = [];
function step(action, patch = {}) {
  expected = { ...expected, ...patch };
  modelSteps.push({ action, expectedState: structuredClone(expected) });
}
step({type:'END_TURN'});
for (const cell of [0, 5, 15, -1, 16, 3]) step({type:'MOVE',cell});
step({type:'MOVE',cell:1}, {positions:{Red:1,Blue:15},phase:'RESOLVE'});
step({type:'MOVE',cell:2});
step({type:'END_TURN'}, {activePlayer:'Blue',turn:2,phase:'MOVE'});
step({type:'MOVE',cell:14}, {positions:{Red:1,Blue:14},phase:'RESOLVE'});
step({type:'END_TURN'}, {activePlayer:'Red',turn:3,phase:'MOVE'});
step({type:'MOVE',cell:5}, {positions:{Red:5,Blue:14},phase:'RESOLVE'});
step({type:'MOVE',cell:6});
step({type:'END_TURN'}, {scores:{Red:1,Blue:0},activePlayer:'Blue',turn:4,phase:'MOVE'});
step({type:'END_TURN'});
step({type:'MOVE',cell:10}, {positions:{Red:5,Blue:10},phase:'RESOLVE'});
step({type:'END_TURN'}, {scores:{Red:1,Blue:1},activePlayer:'Red',turn:5,phase:'MOVE'});
step({type:'MOVE',cell:6}, {positions:{Red:6,Blue:10},phase:'RESOLVE'});
step({type:'END_TURN'}, {activePlayer:'Blue',turn:6,phase:'MOVE'});
step({type:'MOVE',cell:11}, {positions:{Red:6,Blue:11},phase:'RESOLVE'});
step({type:'END_TURN'}, {activePlayer:'Red',turn:7,phase:'MOVE'});
step({type:'MOVE',cell:5}, {positions:{Red:5,Blue:11},phase:'RESOLVE'});
step({type:'END_TURN'}, {scores:{Red:2,Blue:1},phase:'GAME_OVER',winner:'Red'});
step({type:'END_TURN'});
step({type:'MOVE',cell:4});
step({type:'RESET'}, structuredClone(initial));
const click = selector => ({action:'click',selector});
const text = (selector,value) => ({action:'expectText',selector,value:String(value)});
const path='/project-pilots/beacon-relay';
const snapshot = state => [
  ...['Red','Blue'].flatMap(p=>[text(`#${p.toLowerCase()}-position`,state.positions[p]),text(`#${p.toLowerCase()}-score`,state.scores[p])]),
  text('#phase',state.phase),text('#active-player',state.activePlayer),text('#turn-number',state.turn),text('#winner',state.winner??'None')
];
const browserSteps=[{action:'goto',path},click('#reset'),...snapshot(initial)];
for(const entry of modelSteps){
  browserSteps.push(click(entry.action.type==='MOVE'?`#cell-${entry.action.cell}`:entry.action.type==='RESET'?'#reset':'#end-turn'));
  // Out-of-board actions are model-only; no corresponding DOM controls exist.
  if(entry.action.type==='MOVE' && (entry.action.cell<0 || entry.action.cell>15)){browserSteps.pop();continue;}
  const s=entry.expectedState;
  if(entry.action.type==='RESET') browserSteps.push(...snapshot(s));
  else if(entry.action.type==='MOVE') browserSteps.push(text('#phase',s.phase));
  else browserSteps.push(text('#active-player',s.activePlayer),text('#red-score',s.scores.Red));
  if(s.turn===5 && entry.action.type==='END_TURN') browserSteps.push(text('#blue-score',1));
  if(s.phase==='GAME_OVER' && entry.action.type==='MOVE') browserSteps.push(text('#phase','GAME_OVER'),text('#turn-number',7));
  if(s.phase==='GAME_OVER' && entry.action.type==='END_TURN') browserSteps.push(text('#winner','Red'));
  if(entry.action.type==='MOVE' && entry.action.cell===5 && entry.expectedState.turn===3){
    browserSteps.push({action:'goto',path},...snapshot(entry.expectedState));
  }
}
browserSteps.push({action:'goto',path},...snapshot(initial));
export const acceptance={schemaVersion:1,gameId:spec.game.id,scenarios:[
  scenario('red-victory-and-reset','model',modelSteps),
  scenario('play-reload-resolve-win-reset','browser',browserSteps)
]};
export const browserContract={path,scenarios:acceptance.scenarios.filter(s=>s.kind==='browser').map(s=>({name:s.description,steps:s.steps}))};
