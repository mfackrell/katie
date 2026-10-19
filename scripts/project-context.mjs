import { createHash } from 'node:crypto';
import {validateProjectGame} from './project-game-rules.mjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== [...keys].sort().join()) throw Error('Invalid project metadata fields');
}
function string(value, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw Error('Invalid contract string');
}
export function internalPath(value) {
  string(value);
  // Decode repeatedly to reject encoded separators/schemes and traversal that
  // different URL parsers or an application router might normalize differently.
  let decoded = value;
  for (let i = 0; i < 4; i++) {
    string(decoded);
    if (!decoded.startsWith('/') || decoded.startsWith('//') || /[\\\s#]/u.test(decoded) || /(^|\/)\.\.?($|[/?])/u.test(decoded)) throw Error('Contract navigation must stay on an internal path');
    const next = decodeURIComponent(decoded);
    if (next === decoded) return value;
    decoded = next;
  }
  throw Error('Excessive path encoding');
}
export function canonicalJSON(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalJSON(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export function contractHash(contract) { return createHash('sha256').update(canonicalJSON(contract)).digest('hex'); }
export function validateContract(contract) {
  exact(contract, ['path', 'scenarios']);
  internalPath(contract.path);
  if (!Array.isArray(contract.scenarios) || contract.scenarios.length < 1 || contract.scenarios.length > 20) throw Error('Expected 1-20 browser scenarios');
  let steps = 0;
  const names = new Set();
  for (const scenario of contract.scenarios) {
    exact(scenario, ['name', 'steps']); string(scenario.name, 200);
    if (names.has(scenario.name)) throw Error('Duplicate scenario name');
    names.add(scenario.name);
    if (!Array.isArray(scenario.steps) || !scenario.steps.length) throw Error('Empty browser scenario');
    let assertions = 0;
    for (const step of scenario.steps) {
      if (!step || !['goto', 'click', 'fill', 'expectVisible', 'expectText'].includes(step.action)) throw Error('Unknown browser action');
      const keys = step.action === 'goto' ? ['action', 'path'] : step.action === 'fill' || step.action === 'expectText' ? ['action', 'selector', 'value'] : ['action', 'selector'];
      exact(step, keys);
      if (step.action === 'goto') internalPath(step.path);
      else {
        string(step.selector, 500);
        // Reject trivial document-exists assertions. Assertions must name app UI.
        if (step.action.startsWith('expect') && /^(?:\*|html|body|:root)$/i.test(step.selector.trim())) throw Error('Assertion must target application state');
        if (keys.includes('value')) string(step.value);
        if (step.action.startsWith('expect')) assertions++;
      }
      if (++steps > 100) throw Error('Too many browser steps');
    }
    if (!assertions) throw Error('Every scenario requires an application assertion');
  }
  return contract;
}
export function validateProjectContext(value) {
  exact(value, ['version', 'projectId', 'baseSha', 'baselineSha', 'allowedPaths', 'contractHash', 'contract',...(value?.game?['game']:[])]);
  if (value.version !== 1 || !uuid.test(value.projectId) || !/^[a-f0-9]{40}$/.test(value.baseSha) || !/^[a-f0-9]{40}$/.test(value.baselineSha) || !/^[a-f0-9]{64}$/.test(value.contractHash)) throw Error('Invalid project identity');
  if(!Array.isArray(value.allowedPaths)||!value.allowedPaths.length||value.allowedPaths.length>12||value.allowedPaths.some(p=>typeof p!=='string'||p.length>200||!/^(?:app|apps|components|lib|public|tests|docs)\/[a-zA-Z0-9_./[\]-]+\/?$/.test(p)||p.split('/').some(s=>s==='.'||s==='..')||/\.env|\.github|node_modules/.test(p)))throw Error('Invalid approved project paths');
  validateContract(value.contract);
  if (contractHash(value.contract) !== value.contractHash) throw Error('Project contract digest mismatch');
  if(value.game)validateProjectGame(value.game,value.allowedPaths,value.contract);
  return value;
}
export function parseProjectContext(request) {
  if (typeof request !== 'string' || Buffer.byteLength(request) > 1_000_000) throw Error('Request exceeds bounds');
  const occurrences = request.match(/<!--\s*katie-project\b/g) ?? [];
  if (!occurrences.length) return null;
  const markers = [...request.matchAll(/<!-- katie-project: ([A-Za-z0-9_-]+) -->/g)];
  if (occurrences.length !== 1 || markers.length !== 1) throw Error('Malformed or duplicate project marker');
  const encoded = markers[0][1];
  if (encoded.length > 42667) throw Error('Project marker exceeds bounds');
  const bytes = Buffer.from(encoded, 'base64url');
  if (bytes.length > 32000 || bytes.toString('base64url') !== encoded) throw Error('Invalid project encoding');
  return validateProjectContext(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
}
export function projectMarker(context) {
  validateProjectContext(context);
  const bytes = Buffer.from(JSON.stringify(context));
  if (bytes.length > 32000) throw Error('Project marker exceeds bounds');
  return `<!-- katie-project: ${bytes.toString('base64url')} -->`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== 'prepare') throw Error('Usage: project-context.mjs prepare ORIGINAL_AGENT_REQUEST.md');
    console.log(JSON.stringify(parseProjectContext(readFileSync(process.argv[3], 'utf8'))));
  } catch (error) { console.error(error.message.slice(0, 600)); process.exitCode = 1; }
}
