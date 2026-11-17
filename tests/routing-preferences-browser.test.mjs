import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium as playwright } from 'playwright-core';
import chromium from '@sparticuz/chromium';

test('routing controls persist, clear and switch conversations at desktop and mobile sizes', async () => {
  const bundle = await build({
    stdin: {contents: `import React, {useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {RoutingPreferenceControls, useRoutingPreferences} from './components/routing-preferences';
      function App() {const [chat,setChat]=useState('chat-a'); const preferences=useRoutingPreferences('actor',chat);
      return <main><button onClick={()=>setChat(chat==='chat-a'?'chat-b':'chat-a')}>Switch conversation</button><RoutingPreferenceControls preferences={preferences}/><output>{chat}:{preferences.value?.effective}</output></main>}
      createRoot(document.getElementById('root')).render(<App/>);`, resolveDir: process.cwd(), loader: 'tsx'},
    bundle: true, write: false, platform: 'browser', jsx: 'automatic', define: {'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_SUPABASE_URL': '""', 'process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY': '""'},
  });
  const browser = await playwright.launch({executablePath: await chromium.executablePath(), args: chromium.args, headless: true});
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({viewport: {width, height: 800}});
      let global = 'best_value';
      const chats = {};
      await page.route('http://preferences.test/**', async route => {
        const req = route.request();
        if (!req.url().includes('/api/')) return route.fulfill({contentType: 'text/html', body: '<div id="root"></div>'});
        const chat = new URL(req.url()).searchParams.get('chatId');
        if (req.method() === 'PATCH') {
          const body = req.postDataJSON();
          if (body.target === 'global') global = body.mode; else chats[body.chatId] = body.mode;
        }
        await route.fulfill({contentType: 'application/json', body: JSON.stringify({global, conversation: chats[chat] ?? null, effective: chats[chat] ?? global})});
      });
      const load = async () => {await page.goto('http://preferences.test/'); await page.addScriptTag({content: bundle.outputFiles[0].text}); await page.getByLabel('Routing preference', {exact: true}).waitFor(); await page.waitForFunction(() => !document.querySelector('select[aria-label="Routing preference"]').disabled);};
      await load();
      const mode = page.getByLabel('Routing preference', {exact: true});
      assert.deepEqual(await mode.locator('option').allTextContents(), ['Best Answer', 'Best Value']);
      assert.equal(await mode.inputValue(), 'best_value');
      await page.getByLabel('Routing preference scope').selectOption('global');
      await mode.selectOption('best_answer');
      await page.waitForFunction(() => document.querySelector('output').textContent === 'chat-a:best_answer');
      await load();
      assert.equal(await mode.inputValue(), 'best_answer');
      await mode.selectOption('best_value');
      await page.waitForFunction(() => document.querySelector('output').textContent === 'chat-a:best_value');
      await page.getByRole('button', {name: 'Switch conversation'}).click();
      await page.waitForFunction(() => document.querySelector('output').textContent === 'chat-b:best_answer');
      await page.getByRole('button', {name: 'Switch conversation'}).click();
      await page.waitForFunction(() => document.querySelector('output').textContent === 'chat-a:best_value');
      await page.getByRole('button', {name: 'Use global default'}).click();
      await page.waitForFunction(() => document.querySelector('output').textContent === 'chat-a:best_answer');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.close();
    }
  } finally {await browser.close();}
});
