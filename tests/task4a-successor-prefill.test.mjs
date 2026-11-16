import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const source=readFileSync("components/task4a-successor-owner-approval.tsx","utf8");

test("original Task 4A successor form prepopulates the verified 4-hour proposal",()=>{
 for(const [name,value] of Object.entries({
  tokens:"240000",calls:"24",dollars:"9.00",assessmentTokens:"60000",
  completionTokens:"60000",assessmentCalls:"6",completionCalls:"6",hours:"4"
 })){
  assert.ok(source.includes(name+":'"+value+"'"),"missing suggested limit "+name);
 }
 assert.ok(source.includes("useState(suggested)"),"owner fields have suggested initial values");
 assert.ok(source.includes("setIncludeResearch]=useState(true)"),"both verified models initially included");
});

test("suggested limits do not create authority without a fresh owner proposal and explicit confirmation",()=>{
 assert.ok(source.includes("onChange={e=>field(f.key,e.target.value)}"),"suggestions editable");
 assert.ok(source.includes("setOffer(null)"),"edits invalidate digest");
 assert.ok(source.includes("action==='approve'&&!offer?.digest"),"preview digest mandatory");
 assert.ok(source.includes("Preview exact successor limits"),"preview remains distinct");
 assert.ok(source.includes("Authorize this exact successor continuation"),"separate owner action");
 assert.ok(source.includes("ownerSessionBearer()"),"owner authentication remains required");
 assert.ok(source.includes("No authority has been granted"),"prefill not confused with approval");
});
