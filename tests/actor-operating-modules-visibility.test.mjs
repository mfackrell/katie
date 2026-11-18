import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("components/specialist-directory.tsx", "utf8");
const controls = source.slice(source.indexOf("function AgentControls("), source.indexOf("function AgentCard("));
const card = source.slice(source.indexOf("function AgentCard("), source.indexOf("export function SpecialistDirectory("));

test("operating instruction editor is visible before collapsed system instructions on actor detail", () => {
  assert.match(controls, /detail = false/);
  const moduleSection = controls.indexOf('<section id="operating-instruction-modules"');
  const collapsedEditor = controls.indexOf('<details className="mt-4');
  assert.ok(moduleSection >= 0 && collapsedEditor > moduleSection, "Module section must not be nested in collapsed system instructions");
  assert.match(controls, /detail \? \(/);
  assert.match(controls, /Save operating modules/);
  assert.match(controls, /onClick=\{\(\) => void saveModules\(\)\}/);
  assert.match(controls, /operatingInstructionMode: instructionMode/);
  assert.match(controls, /operatingInstructionModuleIds: instructionMode === "modular" \? moduleIds : \[\]/);
});

test("actor list has discoverable deep link to visible module settings", () => {
  assert.match(controls, /Configure operating modules/);
  assert.match(controls, /#operating-instruction-modules/);
  assert.match(card, /<AgentControls card=\{card\} actors=\{actors\} operatingModules=\{operatingModules\} onChanged=\{onChanged\} detail=\{detail\}/);
});

test("existing system instruction editor remains independently collapsible", () => {
  assert.match(controls, /<details className="mt-4 rounded-lg border border-white\/15 p-3">/);
  assert.match(controls, /System instructions & agent settings/);
  assert.match(controls, /Save system instructions/);
});

test("advanced actor inventory exposes a direct link to the module editor", () => {
  const advanced = readFileSync("components/identity-directory.tsx", "utf8");
  assert.match(advanced, /Operating modules/);
  assert.match(advanced, /#operating-instruction-modules/);
  assert.match(advanced, /!actor\.managedAgentId && actor\.actorKind !== "executive"/);
});
