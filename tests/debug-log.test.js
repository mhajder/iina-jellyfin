import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

import { runScript } from './helpers/load-commonjs.js';

function loadDebugLog() {
  const context = vm.createContext({ module: { exports: {} } });
  runScript('src/lib/debug-log.js', context);
  // Errors must come from the plugin's own realm for `instanceof Error` to hold.
  const PluginError = vm.runInContext('Error', context);
  return { ...context.module.exports, PluginError };
}

function createLogger(enabled = true) {
  const { createDebugLogger } = loadDebugLog();
  const lines = [];
  const debugLog = createDebugLogger(
    { get: (key) => key === 'debug_logging' && enabled },
    { log: (line) => lines.push(line) }
  );
  return { debugLog, lines };
}

test('nothing is logged while debug logging is off', () => {
  const { debugLog, lines } = createLogger(false);
  debugLog('hidden');
  assert.deepEqual(lines, []);
});

test('a logger without a preferences API stays silent instead of throwing', () => {
  const { createDebugLogger } = loadDebugLog();
  const lines = [];
  const console = { log: (line) => lines.push(line) };
  createDebugLogger(undefined, console)('hidden');
  createDebugLogger({}, console)('hidden');
  assert.deepEqual(lines, []);
});

test('logged parts are prefixed and joined with a separator', () => {
  const { debugLog, lines } = createLogger();
  debugLog('Loaded', 42, true, null, undefined, 10n);
  assert.deepEqual(lines, ['DEBUG: Loaded | 42 | true | null | undefined | 10']);
});

test('API keys in URLs are redacted, whatever their spelling', () => {
  const { redactSecrets } = loadDebugLog();
  assert.equal(
    redactSecrets('https://jf/Videos/1/stream?static=true&ApiKey=abc123&x=1'),
    'https://jf/Videos/1/stream?static=true&ApiKey=[redacted]&x=1'
  );
  assert.equal(redactSecrets('/Items?api_key=abc123'), '/Items?api_key=[redacted]');
  assert.equal(redactSecrets('/Items?X-Emby-Token=abc123'), '/Items?X-Emby-Token=[redacted]');
});

test('tokens in the authorization header and in JSON bodies are redacted', () => {
  const { redactSecrets } = loadDebugLog();
  assert.equal(
    redactSecrets('MediaBrowser Client="IINA", Token="0123456789abcdef"'),
    'MediaBrowser Client="IINA", Token="[redacted]"'
  );
  assert.equal(
    redactSecrets('{"AccessToken":"0123456789abcdef","User":"me"}'),
    '{"AccessToken":"[redacted]","User":"me"}'
  );
});

test('secrets inside logged objects are redacted too', () => {
  const { debugLog, lines } = createLogger();
  debugLog('Request', { url: 'https://jf/Users?api_key=supersecret', accessToken: 'abcdefgh1234' });
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes('supersecret'), lines[0]);
  assert.ok(!lines[0].includes('abcdefgh1234'), lines[0]);
});

test('long messages are truncated with the number of dropped characters', () => {
  const { debugLog, lines } = createLogger();
  debugLog('x'.repeat(650));
  assert.equal(lines[0], `DEBUG: ${'x'.repeat(600)}…[truncated 50 chars]`);
});

test('errors are logged as their name and message', () => {
  const { createDebugLogger, PluginError } = loadDebugLog();
  const lines = [];
  createDebugLogger(
    { get: () => true },
    { log: (line) => lines.push(line) }
  )(new PluginError('boom'));
  assert.deepEqual(lines, ['DEBUG: Error: boom']);
});

test('arrays are summarized by their length', () => {
  const { debugLog, lines } = createLogger();
  debugLog([1, 2, 3]);
  assert.deepEqual(lines, ['DEBUG: [Array(3)]']);
});

test('objects log only scalar fields and summarize nested values', () => {
  const { debugLog, lines } = createLogger();
  debugLog({
    name: 'Movie',
    count: 2,
    ok: false,
    missing: null,
    items: [1, 2],
    nested: { a: 1 },
    overview: 'y'.repeat(130),
  });
  const logged = JSON.parse(lines[0].slice('DEBUG: '.length));
  assert.deepEqual(logged, {
    name: 'Movie',
    count: 2,
    ok: false,
    missing: null,
    items: '[Array(2)]',
    nested: '[Object]',
    overview: `${'y'.repeat(120)}…[truncated 10 chars]`,
  });
});

test('objects with many keys log the first eight and count the rest', () => {
  const { debugLog, lines } = createLogger();
  const big = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, i]));
  debugLog(big);
  const logged = JSON.parse(lines[0].slice('DEBUG: '.length));
  assert.deepEqual(Object.keys(logged), [
    'k0',
    'k1',
    'k2',
    'k3',
    'k4',
    'k5',
    'k6',
    'k7',
    '__extraKeys',
  ]);
  assert.equal(logged.__extraKeys, 3);
});
