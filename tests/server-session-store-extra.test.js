import assert from 'node:assert/strict';
import test from 'node:test';
import { loadCommonJs } from './helpers/load-commonjs.js';

const { createServerSessionStore } = loadCommonJs('src/lib/server-session-store.js');
const { isSameJellyfinServer } = loadCommonJs('src/lib/jellyfin-api.js');

// Values built inside the vm context have that context's prototypes, which
// deepStrictEqual tells apart from this realm's.
const plain = (value) => JSON.parse(JSON.stringify(value));

function createView() {
  const messages = [];
  return { messages, postMessage: (name, data) => messages.push({ name, data: plain(data) }) };
}

function createStore(servers, { extraPrefs = {}, preferences, views = {} } = {}) {
  const prefs = {
    ...(servers === undefined ? {} : { jellyfin_servers: JSON.stringify(servers) }),
    ...extraPrefs,
  };
  const sidebar = views.sidebar === undefined ? createView() : views.sidebar;
  const standaloneWindow =
    views.standaloneWindow === undefined ? createView() : views.standaloneWindow;
  const logs = [];
  const store = createServerSessionStore({
    preferences: preferences || {
      get: (key) => prefs[key],
      set: (key, value) => (prefs[key] = value),
      sync() {},
    },
    sidebar,
    standaloneWindow,
    isSameJellyfinServer,
    log: (message) => logs.push(message),
  });
  return {
    store,
    prefs,
    sidebar,
    standaloneWindow,
    logs,
    stored: () => plain(JSON.parse(prefs.jellyfin_servers || '[]')),
  };
}

const HOME = { id: 'srv-home', serverUrl: 'https://home.example', accessToken: 'H', userId: 'U1' };
const WORK = { id: 'srv-work', serverUrl: 'https://work.example', accessToken: 'W', userId: 'U2' };

test('no stored servers is an empty list', () => {
  const { store } = createStore(undefined);

  assert.equal(store.loadStoredServers().length, 0);
  assert.equal(store.getActiveServer(), null);
  assert.equal(store.getStoredJellyfinSession(), null);
});

test('a corrupted server list in preferences reads as no servers', () => {
  const { store } = createStore(undefined, { extraPrefs: { jellyfin_servers: '{not json' } });

  assert.equal(store.loadStoredServers().length, 0);
});

test('a server list that is not an array reads as no servers', () => {
  const { store } = createStore(undefined, {
    extraPrefs: { jellyfin_servers: JSON.stringify({ id: 'srv-1' }) },
  });

  assert.equal(store.loadStoredServers().length, 0);
});

test('a server list already stored as an array is read as is', () => {
  const { store } = createStore(undefined, { extraPrefs: { jellyfin_servers: [HOME] } });

  assert.deepEqual(
    plain(store.loadStoredServers()).map((server) => server.id),
    ['srv-home']
  );
});

test('entries without a URL or token are dropped from the stored list', () => {
  const { store, stored } = createStore([
    HOME,
    { id: 'srv-no-token', serverUrl: 'https://x.example', userId: 'U' },
    { id: 'srv-no-url', accessToken: 'T', userId: 'U' },
    null,
  ]);

  assert.deepEqual(
    plain(store.loadStoredServers()).map((server) => server.id),
    ['srv-home']
  );
  assert.deepEqual(
    stored().map((server) => server.id),
    ['srv-home']
  );
});

test('a failing preferences write is logged instead of thrown', () => {
  const { store, logs } = createStore(undefined, {
    preferences: {
      get: () => undefined,
      set() {
        throw new Error('disk full');
      },
      sync() {},
    },
  });

  assert.doesNotThrow(() => store.saveStoredServers([HOME]));
  assert.ok(logs.some((message) => message.includes('disk full')));
});

test('signing in again as the same user updates that entry in place', () => {
  const { store, stored } = createStore([{ ...HOME, addedAt: 111 }, WORK], {
    extraPrefs: { jellyfin_active_server_id: 'srv-work' },
  });

  const entry = store.addOrUpdateServer({
    serverUrl: 'https://home.example/',
    accessToken: 'NEW',
    userId: 'U1',
    username: 'alice',
    serverName: 'Home',
  });

  assert.equal(entry.id, 'srv-home');
  assert.equal(entry.addedAt, 111);
  assert.equal(entry.serverUrl, 'https://home.example');
  assert.deepEqual(
    stored().map((server) => [server.id, server.accessToken, server.username]),
    [
      ['srv-home', 'NEW', 'alice'],
      ['srv-work', 'W', undefined],
    ]
  );
  // The active server is not changed by updating another entry
  assert.equal(store.getActiveServerId(), 'srv-work');
});

test('signing in takes over the URL session entry for that server', () => {
  const { store, stored } = createStore([
    { id: 'srv-url', serverUrl: 'https://home.example', accessToken: 'URLKEY' },
  ]);

  const entry = store.addOrUpdateServer({
    serverUrl: 'http://home.example',
    accessToken: 'T',
    userId: 'U1',
  });

  assert.equal(entry.id, 'srv-url');
  // A sign-in keeps the URL the user signed in with
  assert.equal(entry.serverUrl, 'http://home.example');
  assert.equal(entry.serverName, 'http://home.example');
  assert.deepEqual(
    stored().map((server) => [server.id, server.userId]),
    [['srv-url', 'U1']]
  );
});

test('a second user on the same server gets an entry of their own', () => {
  const { store, stored } = createStore([HOME], {
    extraPrefs: { jellyfin_active_server_id: 'srv-home' },
  });

  const entry = store.addOrUpdateServer({
    serverUrl: 'https://home.example',
    accessToken: 'T2',
    userId: 'U9',
  });

  assert.notEqual(entry.id, 'srv-home');
  assert.deepEqual(
    stored().map((server) => server.userId),
    ['U1', 'U9']
  );
  assert.equal(store.getActiveServerId(), 'srv-home');
});

test('the first server added becomes the active one', () => {
  const { store } = createStore([]);

  const entry = store.addOrUpdateServer({ serverUrl: 'https://home.example', accessToken: 'T' });

  assert.match(entry.id, /^srv-/);
  assert.equal(store.getActiveServerId(), entry.id);
});

test('a server added while none is active becomes the active one', () => {
  const { store } = createStore([HOME]);

  const entry = store.addOrUpdateServer({
    serverUrl: 'https://work.example',
    accessToken: 'W',
    userId: 'U2',
  });

  assert.equal(store.getActiveServerId(), entry.id);
});

test('adding a server without a URL fails without throwing', () => {
  const { store, stored } = createStore([HOME]);

  assert.equal(store.addOrUpdateServer({ accessToken: 'T' }), null);
  assert.deepEqual(
    stored().map((server) => server.id),
    ['srv-home']
  );
});

test('removing the active server makes the next one active and tells both views', () => {
  const { store, sidebar, standaloneWindow, stored } = createStore([HOME, WORK], {
    extraPrefs: { jellyfin_active_server_id: 'srv-home' },
  });

  store.removeServer('srv-home');

  assert.deepEqual(
    stored().map((server) => server.id),
    ['srv-work']
  );
  assert.equal(store.getActiveServerId(), 'srv-work');
  for (const view of [sidebar, standaloneWindow]) {
    assert.equal(view.messages.length, 1);
    assert.equal(view.messages[0].name, 'servers-updated');
    assert.equal(view.messages[0].data.activeServerId, 'srv-work');
    assert.deepEqual(
      view.messages[0].data.servers.map((server) => server.id),
      ['srv-work']
    );
  }
});

test('removing another server keeps the active one', () => {
  const { store } = createStore([HOME, WORK], {
    extraPrefs: { jellyfin_active_server_id: 'srv-home' },
  });

  store.removeServer('srv-work');

  assert.equal(store.getActiveServerId(), 'srv-home');
});

test('removing the last server leaves no active server', () => {
  const { store, sidebar } = createStore([HOME], {
    extraPrefs: { jellyfin_active_server_id: 'srv-home' },
  });

  store.removeServer('srv-home');

  assert.equal(store.getActiveServerId(), null);
  assert.equal(store.getActiveServer(), null);
  assert.equal(sidebar.messages[0].data.activeServerId, null);
});

test('views that were never created are skipped when notifying', () => {
  const { store } = createStore([HOME, WORK], {
    views: { sidebar: null, standaloneWindow: {} },
  });

  assert.doesNotThrow(() => store.removeServer('srv-home'));
  assert.equal(store.loadStoredServers().length, 1);
});

test('an active id pointing at no stored server falls back to the first server', () => {
  const { store } = createStore([HOME, WORK], {
    extraPrefs: { jellyfin_active_server_id: 'srv-gone' },
  });

  assert.equal(store.getActiveServer().id, 'srv-home');
});

test('switching to a stored server makes it active and tells both views', () => {
  const { store, sidebar, standaloneWindow } = createStore([HOME, WORK], {
    extraPrefs: { jellyfin_active_server_id: 'srv-home' },
  });

  store.switchActiveServer('srv-work');

  assert.equal(store.getActiveServerId(), 'srv-work');
  for (const view of [sidebar, standaloneWindow]) {
    assert.equal(view.messages[0].name, 'server-switched');
    assert.equal(view.messages[0].data.server.id, 'srv-work');
    assert.equal(view.messages[0].data.activeServerId, 'srv-work');
  }
});

test('switching to an unknown server changes nothing', () => {
  const { store, sidebar } = createStore([HOME, WORK], {
    extraPrefs: { jellyfin_active_server_id: 'srv-home' },
  });

  store.switchActiveServer('srv-gone');

  assert.equal(store.getActiveServerId(), 'srv-home');
  assert.equal(sidebar.messages.length, 0);
});

test('a played link for a new server stores it and offers its session to the views', () => {
  const { store, sidebar, standaloneWindow, stored } = createStore([]);

  store.storeJellyfinSession('https://media.example/', 'URLKEY');

  const [server] = stored();
  assert.equal(server.serverUrl, 'https://media.example');
  assert.equal(server.accessToken, 'URLKEY');
  assert.equal(server.userId, '');
  for (const view of [sidebar, standaloneWindow]) {
    assert.deepEqual(view.messages, [
      {
        name: 'session-available',
        data: { serverUrl: 'https://media.example', accessToken: 'URLKEY', serverId: server.id },
      },
    ]);
  }
});

test('a played link for a signed-in server offers the account session instead', () => {
  const { store, sidebar } = createStore([HOME]);

  store.storeJellyfinSession('http://HOME.example', 'URLKEY');

  assert.deepEqual(sidebar.messages, [
    {
      name: 'session-available',
      data: { serverUrl: 'https://home.example', accessToken: 'H', serverId: 'srv-home' },
    },
  ]);
});

test('a view that fails to take a message does not throw out of storing a session', () => {
  const { store, logs } = createStore([], {
    views: {
      sidebar: {
        postMessage() {
          throw new Error('webview gone');
        },
      },
    },
  });

  assert.doesNotThrow(() => store.storeJellyfinSession('https://media.example', 'URLKEY'));
  assert.ok(logs.some((message) => message.includes('webview gone')));
});

test('clearing the session removes every server and tells both views', () => {
  const { store, sidebar, standaloneWindow, stored } = createStore([HOME, WORK], {
    extraPrefs: { jellyfin_active_server_id: 'srv-home' },
  });

  store.clearJellyfinSession();

  assert.deepEqual(stored(), []);
  assert.equal(store.getActiveServerId(), null);
  for (const view of [sidebar, standaloneWindow]) {
    assert.deepEqual(view.messages, [{ name: 'session-cleared', data: {} }]);
  }
});

test('a view that fails to take a message does not throw out of clearing the session', () => {
  const { store } = createStore([HOME], {
    views: {
      sidebar: {
        postMessage() {
          throw new Error('webview gone');
        },
      },
    },
  });

  assert.doesNotThrow(() => store.clearJellyfinSession());
  assert.equal(store.loadStoredServers().length, 0);
});

test('the stored session describes the active server', () => {
  const { store } = createStore([HOME, { ...WORK, serverName: 'Work', username: 'bob' }], {
    extraPrefs: { jellyfin_active_server_id: 'srv-work' },
  });

  assert.deepEqual(plain(store.getStoredJellyfinSession()), {
    serverUrl: 'https://work.example',
    accessToken: 'W',
    serverId: 'srv-work',
    serverName: 'Work',
    userId: 'U2',
    username: 'bob',
  });
});
