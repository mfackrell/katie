// Count-only operational qualification. Never invoke responses.create/inference.
import {createResponsesProvider} from './native-provider-receipts.mjs';
const provider=createResponsesProvider({apiKey:process.env.OPENAI_API_KEY});
const model='gpt-5.3-codex';
const samples=[
 {model,input:'Count this fixed qualification text.'},
 {model,input:'Synthetic bounded qualification text. '.repeat(1000),tools:[{type:'function',name:'exec_command',parameters:{type:'object',properties:{cmd:{type:'string'}},required:['cmd'],additionalProperties:false}}]},
 {model,input:[{role:'user',content:'Inspect the fixture.'},{type:'message',role:'assistant',phase:'commentary',content:[{type:'output_text',text:'I will inspect it.',annotations:[],logprobs:[]}]},{type:'function_call',call_id:'fixed_count_call',name:'exec_command',namespace:'functions',arguments:'{"cmd":"pwd"}'},{type:'function_call_output',call_id:'fixed_count_call',output:'/work'}]}
];
for(let i=0;i<samples.length;i++){
 const inputTokens=await provider.countInputTokens(samples[i]);
 console.log('NATIVE_INPUT_COUNT_QUALIFICATION='+JSON.stringify({sample:i+1,model,inputTokens,payloadBytes:Buffer.byteLength(JSON.stringify(samples[i]))}));
}
