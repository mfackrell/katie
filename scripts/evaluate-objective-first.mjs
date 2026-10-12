// Standalone development evaluation; does not call Katie routes or write chat data.
// Compile test:review in both checkouts first. Supply a private credential file.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const [baselineRoot, credentialFile, outputFile, scope] = process.argv.slice(2);
if (!baselineRoot || !credentialFile || !outputFile) throw new Error('Usage: node scripts/evaluate-objective-first.mjs BASELINE_ROOT CREDENTIAL_FILE OUTPUT_JSON');
const compiled = path.resolve('.website-test-dist');
const { ClaudeProvider } = require(path.join(compiled, 'lib/providers/claude-provider.js'));
const current = require(path.join(compiled, 'lib/chat/deliverable-standard.js'));
const baseline = require(path.join(path.resolve(baselineRoot), '.website-test-dist/lib/chat/deliverable-standard.js'));
const { objectiveFirstCases } = require(path.join(compiled, 'tests/fixtures/objective-first-cases.js'));
const syntheticCases = [
  {name:'fictional CFO application',task:'Write an application response to a hiring team filling an interim industrial CFO role during a finance leadership transition. The company needs to finish overdue audits and stabilize controls after an ERP migration. Their question asks about manufacturing, multinational finance, audits and transfer pricing. Include verified revenue sizes. Use only these fictional facts.',facts:'Fictional candidate: 16 years finance and operations leadership. CFO of a domestic manufacturer with $72M annual revenue; international distributor negotiation responsibilities. Interim CFO of a multinational software company with $48M annual revenue and $150M enterprise valuation. Completed audit remediation in eight months; led ERP migration and supported an acquisition. No direct international transfer pricing experience. Never CFO of a multinational manufacturer. A prior hospitality side business is irrelevant.',outcome:'Truthful executive value, separate engagements and metrics, concise required limitation.'},
  {name:'fictional fit assessment',task:'Assess this fictional candidate for a cloud migration lead role. Balance strengths and gaps; do not write an application.',facts:'Candidate led three on-premise database migrations and managed teams of six. No production Kubernetes experience. The role requires production Kubernetes ownership.',outcome:'Balanced fit judgment with an explicit relevant gap; no unsupported equivalence.'},
  {name:'fictional cash analysis',task:'Analyze the projected cash position, highlight the most important supported conclusion, and distinguish facts from options. Do not assume new financing.',facts:'Opening cash $80000; receipts $35000; payments $140000; no approved financing or deferred payments.',outcome:'Projected $25000 shortfall, clear implication and labeled options without invented financing.'},
  {name:'fictional technical diagnosis',task:'Diagnose this fictional checkout failure. Use the evidence; change nothing.',facts:'After a discount patch, invoice subtotal is 100, discount is 10, tax rate is 10 percent, stored tax is 10 and displayed total is 100. Tax should apply to discounted subtotal. No deployment or fix has been made.',outcome:'Tax applied before discount, expected total 99, precise diagnosis without false completion.'},
  {name:'fictional vendor communication',task:'Draft a short message to a fictional vendor about an overdue invoice. Promise an update Monday, not payment Monday. Avoid invented assurances.',facts:'Invoice is overdue. Payment timing and funding are unconfirmed. An update Monday is authorized; no payment date is authorized.',outcome:'Respectful useful communication without promising payment.'}
];
const cases = scope === '--synthetic-application' ? [syntheticCases[0]] : scope?.startsWith('--synthetic') ? syntheticCases : objectiveFirstCases;
const provider = new ClaudeProvider(readFileSync(credentialFile, 'utf8').trim());
const models = await provider.listModels();
const model = models.find(id => /sonnet/i.test(id));
if (!model) throw new Error('No verified Sonnet model discovered; refusing to guess a model ID.');
const report = { generatedAt: new Date().toISOString(), model, method: 'One same-model primary generation per prompt variant and fixture. No reviewer workflow or statistical quality claim. Baseline prompts from checked-out production-source commit; revised prompts from local branch.', dataScope: scope?.startsWith('--synthetic') ? 'Wholly fictional inputs; no BTG or real career facts' : 'BTG regression and synthetic controls', cases: [] };
const settings = scope === '--synthetic-revised' ? [['revised', current.getDeliverableStandardInstruction()]] : [ ['baseline', baseline.getDeliverableStandardInstruction()], ['revised', current.getDeliverableStandardInstruction()] ];
for (const fixture of cases) {
  const pair = await Promise.all(settings.map(async ([variant, instruction]) => {
    const result = await provider.generate({ name: 'Katie', modelId: model,
      persona: instruction + '\n\nVerified fixture facts: ' + fixture.facts + '\nUser preferences: concise, direct, no client names. Never substitute enterprise valuation for revenue.',
      summary: '', history: [], user: fixture.task });
    return { variant, promptCharacters: instruction.length, text: result.text, truncated: result.truncated ?? false, usage: result.usage ?? null };
  }));
  report.cases.push({ ...fixture, outputs: pair });
  mkdirSync(path.dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, JSON.stringify(report, null, 2) + '\n');
  console.info('Evaluated:', fixture.name, 'model:', model);
}
console.info('Saved comparison:', outputFile);
