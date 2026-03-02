import test from 'node:test';
import assert from 'node:assert/strict';

function parseUrl(input, base = 'http://localhost') {
  try {
    const url = new URL(input, base);
    const query = Object.fromEntries(url.searchParams.entries());
    return { url, query };
  } catch {
    return null;
  }
}

test('parses absolute URL values', () => {
  const parsed = parseUrl('https://example.com:8443/path/to?q=1#frag');
  assert.ok(parsed);
  assert.equal(parsed.url.protocol, 'https:');
  assert.equal(parsed.url.hostname, 'example.com');
  assert.equal(parsed.url.port, '8443');
  assert.equal(parsed.url.pathname, '/path/to');
  assert.equal(parsed.url.hash, '#frag');
});

test('parses relative URL values with a safe base', () => {
  const parsed = parseUrl('/api/chat?actorId=a1');
  assert.ok(parsed);
  assert.equal(parsed.url.href, 'http://localhost/api/chat?actorId=a1');
  assert.equal(parsed.url.pathname, '/api/chat');
});

test('extracts querystring values via URL.searchParams', () => {
  const parsed = parseUrl('https://example.com/chat?chatId=abc&actorId=xyz');
  assert.deepEqual(parsed?.query, {
    chatId: 'abc',
    actorId: 'xyz'
  });
});

test('malformed URL handling returns null rather than throwing', () => {
  const parsed = parseUrl('http://[invalid-host');
  assert.equal(parsed, null);
});
