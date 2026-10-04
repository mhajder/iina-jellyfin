import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Load sidebar.js as the webview would, with an `iina` bridge that has no
// preferences API, and return the registered message handlers.
function loadSidebar() {
  const logged = [];
  const handlers = {};
  const context = vm.createContext({
    window: {
      createSidebarAuthServerMethods: () => ({}),
      createSidebarMediaMethods: () => ({}),
    },
    document: { readyState: 'loading', addEventListener() {} },
    console: { log: (line) => logged.push(line) },
    iina: {
      onMessage: (name, callback) => {
        handlers[name] = callback;
      },
      postMessage() {},
    },
  });
  vm.runInContext(readFileSync('src/ui/sidebar/sidebar.js', 'utf8'), context);
  context.window.JellyfinSidebar.prototype.setupMessageHandlers.call({
    handleClientIdentity() {},
  });
  return { logged, handlers };
}

test('sidebar debug logging follows the flag sent with the client identity', () => {
  const { logged, handlers } = loadSidebar();
  assert.equal(logged.length, 0, 'nothing is logged before the plugin sends the flag');

  handlers['client-identity']({ deviceId: 'test-device', debugLogging: true });
  assert.ok(logged.some((line) => line.includes('Received client-identity')));

  logged.length = 0;
  handlers['client-identity']({ deviceId: 'test-device', debugLogging: false });
  assert.equal(logged.length, 0);
});

test('plugin sends the debug_logging preference with every client identity', () => {
  const source = readFileSync('src/index.js', 'utf8');
  assert.match(source, /debugLogging: Boolean\(preferences\.get\('debug_logging'\)\)/);
  assert.doesNotMatch(source, /postMessage\('client-identity', getClientIdentity\(\)\)/);
});
