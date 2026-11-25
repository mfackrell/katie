import test from 'node:test';
import assert from 'node:assert/strict';
import {validateContract,contractHash,parseProjectContext,projectMarker} from '../scripts/project-context.mjs';
const contract={path:'/milestone-3-tic-tac-toe',scenarios:[{name:'Initial board and legal turns',steps:[{action:'expectText',selector:'#status',value:"X's turn"},{action:'expectText',selector:'[data-cell="0"]',value:''}]},{name:'Horizontal win and terminal freeze',steps:[{action:'expectText',selector:'[data-cell="5"]',value:''}]},{name:'New Game clears the board',steps:[{action:'expectText',selector:'[data-cell="0"]',value:''},{action:'expectText',selector:'[data-cell="4"]',value:''}]},{name:'Reload clears the board',steps:[{action:'expectText',selector:'[data-cell="0"]',value:''}]}]};
test('Mission108 five approved empty-cell checks survive exact contract encoding and digest',()=>{
 const fixture={version:1,projectId:'fe9d2658-41e3-44c1-ae8e-a0cba98371fe',baseSha:'a'.repeat(40),baselineSha:'a'.repeat(40),allowedPaths:['app/milestone-3-tic-tac-toe/page.tsx'],contractHash:contractHash(contract),contract};
 assert.deepEqual(validateContract(contract),contract);
 assert.deepEqual(parseProjectContext(projectMarker(fixture)),fixture);
 assert.equal(contract.scenarios.flatMap(s=>s.steps).filter(s=>s.value==='').length,5);
 for(const bad of [{action:'expectText',selector:'',value:''},{action:'expectText',selector:'body',value:''},{action:'expectText',selector:'#status',value:' '},{action:'expectText',selector:'#status',value:3},{action:'expectText',selector:'#status',value:'\u0000'},{action:'fill',selector:'#status',value:''},{action:'goto',path:''}])assert.throws(()=>validateContract({path:contract.path,scenarios:[{name:'Invalid',steps:[{action:'expectText',selector:'#status',value:"X's turn"},bad]}]}));
});
