import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

import { loadCommonJs, runScript } from './helpers/load-commonjs.js';

// Load src/global.js with a fake `iina` bridge and return its message handlers.
function loadGlobalEntry({ createPlayerInstance } = {}) {
  const handlers = {};
  const posted = [];
  const created = [];
  const context = vm.createContext({
    Date,
    require: (path) => loadCommonJs(path.replace('./', 'src/')),
    iina: {
      console: { log() {} },
      preferences: { get: () => false },
      global: {
        onMessage: (name, callback) => {
          handlers[name] = callback;
        },
        createPlayerInstance:
          createPlayerInstance ??
          ((options) => {
            created.push(options);
            return 7;
          }),
        postMessage: (player, name, data) => posted.push({ player, name, data: { ...data } }),
      },
    },
  });
  runScript('src/global.js', context);
  return { handlers, posted, created };
}

test('a create-player message opens the URL in a new player with plugins enabled', () => {
  const { handlers, created } = loadGlobalEntry();
  handlers['create-player']({ url: 'https://jf/Videos/1/stream', title: 'Movie' }, 'player-1');

  assert.equal(created.length, 1);
  assert.equal(created[0].url, 'https://jf/Videos/1/stream');
  assert.equal(created[0].enablePlugins, true);
  assert.match(created[0].label, /^jellyfin-\d+$/);
});

test('the requesting player is told which player was created', () => {
  const { handlers, posted } = loadGlobalEntry();
  handlers['create-player']({ url: 'https://jf/Videos/1/stream', title: 'Movie' }, 'player-1');

  assert.deepEqual(posted, [
    {
      player: 'player-1',
      name: 'player-created',
      data: { playerId: 7, title: 'Movie', url: 'https://jf/Videos/1/stream' },
    },
  ]);
});

test('without a requesting player the new player still opens and nothing is posted', () => {
  const { handlers, posted, created } = loadGlobalEntry();
  handlers['create-player']({ url: 'https://jf/Videos/1/stream', title: 'Movie' });

  assert.equal(created.length, 1);
  assert.deepEqual(posted, []);
});

test('a failure to create the player is reported back to the requesting player', () => {
  const { handlers, posted } = loadGlobalEntry({
    createPlayerInstance() {
      throw new Error('no window');
    },
  });
  handlers['create-player']({ url: 'https://jf/Videos/1/stream', title: 'Movie' }, 'player-1');

  assert.deepEqual(posted, [
    {
      player: 'player-1',
      name: 'player-creation-failed',
      data: { error: 'Error: no window', url: 'https://jf/Videos/1/stream' },
    },
  ]);
});

test('a create-player message without data is reported as a failure, not thrown', () => {
  const { handlers, posted } = loadGlobalEntry();
  assert.doesNotThrow(() => handlers['create-player'](undefined, 'player-1'));
  assert.equal(posted.length, 1);
  assert.equal(posted[0].name, 'player-creation-failed');
  assert.equal(posted[0].data.url, undefined);
});
