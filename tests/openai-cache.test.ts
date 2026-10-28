import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationCacheKey, openAiCacheSettings } from '../lib/providers/openai-cache';
import { OpenAiProvider } from '../lib/providers/openai-provider';
import { nativeToolTurn } from '../lib/providers/native-tools';

test('cache scope is stable, opaque and isolated by actor and conversation', () => {
  const key = conversationCacheKey('actor', 'chat');
  assert.equal(key, conversationCacheKey('actor', 'chat'));
  assert.notEqual(key, conversationCacheKey('other', 'chat'));
  assert.notEqual(key, conversationCacheKey('actor', 'other'));
  assert.ok(!key.includes('actor') && key.length < 128);
});

test('retention uses documented model settings without opting into premium long writes', () => {
  for (const model of ['gpt-5.5-pro', 'gpt-5.5-pro-2026-04-23', 'gpt-5.4', 'gpt-5.1-codex-mini']) {
    assert.deepEqual(openAiCacheSettings(model, 'key'), {prompt_cache_key:'key',prompt_cache_retention:'24h'});
  }
  for (const model of ['gpt-5.4-pro', 'gpt-5.4-mini', 'gpt-4o']) {
    assert.deepEqual(openAiCacheSettings(model, 'key'), {prompt_cache_key:'key'});
  }
  assert.deepEqual(openAiCacheSettings('gpt-6.1-sol', 'key'), {prompt_cache_key:'key',prompt_cache_options:{ttl:'30m'}});
  assert.deepEqual(openAiCacheSettings('gpt-6.1-sol','key','chat-completions'),{prompt_cache_key:'key'});
  assert.deepEqual(openAiCacheSettings('unknown','key'),{});
  assert.deepEqual(openAiCacheSettings('gpt-5.5'),{});
});

test('generation and native-tool requests transmit scope and retention without changing content', async () => {
  const original = globalThis.fetch;
  const bodies: any[] = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({id:'resp_test',object:'response',model:'gpt-5.5',output:[{type:'message',content:[{type:'output_text',text:'ok'}]}]}),{headers:{'content-type':'application/json'}});
  };
  try {
    const provider = new OpenAiProvider('test-key');
    const params = {name:'Katie',persona:'unchanged persona',summary:'unchanged summary',history:[],user:'unchanged question',modelId:'gpt-5.5',promptCacheKey:'stable-key'};
    await provider.generate(params);
    await nativeToolTurn('openai','test-key',{modelId:'gpt-5.5',system:'unchanged system',signal:new AbortController().signal,messages:[],tools:[],promptCacheKey:'stable-key'});
    assert.equal(bodies.length,2);
    for(const body of bodies) {
      assert.equal(body.prompt_cache_key,'stable-key');
      assert.equal(body.prompt_cache_retention,'24h');
    }
    assert.match(JSON.stringify(bodies[0].input),/unchanged persona/);
    assert.match(JSON.stringify(bodies[0].input),/unchanged question/);
    assert.equal(bodies[1].instructions,'unchanged system');
  } finally { globalThis.fetch = original; }
});
