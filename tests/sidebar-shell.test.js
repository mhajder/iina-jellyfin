import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { runScript } from './helpers/load-commonjs.js';

const AUTH_METHODS = 'src/ui/sidebar/lib/auth-server-methods.js';
const SIDEBAR = 'src/ui/sidebar/sidebar.js';

// The media mixin is replaced by recorders so these tests see what the shell
// hands off to it without exercising media-methods.js itself.
const MEDIA_METHODS = [
  'showMainContent',
  'hideMainContent',
  'clearAllMediaContent',
  'loadHomeTab',
  'loadMovies',
  'loadSeries',
  'loadMusic',
  'debounceSearch',
  'loadEpisodes',
  'playSelectedEpisode',
  'openSelectedEpisodeInJellyfin',
  'hideEpisodeSelection',
  'playAllAlbumTracks',
  'openAlbumInJellyfin',
  'hideAlbumTracks',
  'scrollToTop',
];

const flush = () => new Promise((resolve) => setImmediate(resolve));

// Objects built inside the vm context have their own prototypes, so compare
// plain copies of them.
const plain = (value) => JSON.parse(JSON.stringify(value));

function createElement(id, { classes = [], dataset = {}, style = {} } = {}) {
  const listeners = {};
  const classSet = new Set(classes);
  let html = '';
  let children = [];
  const element = {
    id,
    value: '',
    textContent: '',
    disabled: false,
    style: { ...style },
    dataset,
    classList: {
      add: (name) => classSet.add(name),
      remove: (name) => classSet.delete(name),
      contains: (name) => classSet.has(name),
      toggle(name, force) {
        const on = force === undefined ? !classSet.has(name) : force;
        if (on) classSet.add(name);
        else classSet.delete(name);
        return on;
      },
    },
    get innerHTML() {
      return html;
    },
    set innerHTML(value) {
      html = value;
      children = [...value.matchAll(/class="([^"]*)" data-server-id="([^"]*)"/g)].map((match) =>
        createElement(null, {
          classes: match[1].split(/\s+/).filter(Boolean),
          dataset: { serverId: match[2] },
        })
      );
    },
    addEventListener(type, listener) {
      (listeners[type] ||= []).push(listener);
    },
    dispatch(type, event = {}) {
      for (const listener of listeners[type] || []) {
        listener({ target: element, stopPropagation() {}, ...event });
      }
    },
    click() {
      element.dispatch('click');
    },
    closest(selector) {
      return classSet.has(selector.slice(1)) ? element : null;
    },
    querySelectorAll(selector) {
      return children.filter((child) => child.classList.contains(selector.slice(1)));
    },
  };
  return element;
}

const TABS = ['home', 'movies', 'series', 'music', 'search'];

// The parts of index.html the shell wires up.
function createDom(readyState) {
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, createElement(id));
    return elements.get(id);
  };
  for (const id of [
    'savedServerList',
    'loginSection',
    'qcCodeSection',
    'mainContent',
    'moviesFilterPanel',
    'seriesFilterPanel',
    'musicFilterPanel',
  ]) {
    elements.set(id, createElement(id, { style: { display: 'none' } }));
  }
  const groups = {
    '.login-method-tab': ['password', 'quickconnect'].map((method) =>
      createElement(null, { classes: ['login-method-tab'], dataset: { method } })
    ),
    '.tab-button': TABS.map((tab) =>
      createElement(null, {
        classes: ['tab-button', ...(tab === 'home' ? ['active'] : [])],
        dataset: { tab },
      })
    ),
    '.tab-content': TABS.map((tab) => {
      const content = createElement(`${tab}Tab`, {
        classes: ['tab-content', ...(tab === 'home' ? ['active'] : [])],
      });
      elements.set(content.id, content);
      return content;
    }),
    '.search-type-chip': ['Movie', 'Series', 'MusicAlbum', 'Audio'].map((type) =>
      createElement(null, { classes: ['search-type-chip', 'active'], dataset: { type } })
    ),
  };
  const documentListeners = {};
  const document = {
    readyState,
    getElementById: get,
    querySelectorAll: (selector) => groups[selector] || [],
    addEventListener(type, listener) {
      (documentListeners[type] ||= []).push(listener);
    },
  };
  const fire = (type) => (documentListeners[type] || []).forEach((listener) => listener());
  return { document, get, groups, fire };
}

/**
 * Load the sidebar as index.html does: the auth mixin, a recording media
 * mixin, then sidebar.js. `respond(url, init)` plays the server behind
 * `fetch` and returns { status, body, headers }, or throws.
 */
function loadSidebar({ readyState = 'complete', bridge = true, respond } = {}) {
  const dom = createDom(readyState);
  const handlers = {};
  const posted = [];
  const logged = [];
  const fetched = [];
  const mediaCalls = [];

  const fetch = async (url, init) => {
    fetched.push({ url, init });
    // Thrown from the page's realm, as the webview's own fetch would.
    if (!respond) throw vm.runInContext("new TypeError('Load failed')", context);
    const { status = 200, statusText = 'OK', body = '', headers = {} } = await respond(url, init);
    return {
      status,
      statusText,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      headers: new Map(Object.entries(headers)),
    };
  };

  const context = vm.createContext({
    window: {},
    document: dom.document,
    console: { log: (line) => logged.push(line) },
    fetch,
    setInterval: () => 0,
    clearInterval() {},
  });
  if (bridge) {
    context.iina = {
      onMessage: (name, handler) => (handlers[name] = handler),
      postMessage: (name, data) => posted.push({ name, data }),
    };
  }

  runScript(AUTH_METHODS, context);
  context.window.createSidebarMediaMethods = () =>
    Object.fromEntries(
      MEDIA_METHODS.map((name) => [
        name,
        function (...args) {
          mediaCalls.push({ name, args, receiver: this });
        },
      ])
    );
  runScript(SIDEBAR, context);
  // Start-up only scrolls the login form into view; tests look at what follows.
  mediaCalls.length = 0;

  return {
    window: context.window,
    get sidebar() {
      return context.window.jellyfinSidebar;
    },
    dom,
    handlers,
    posted,
    postedNames: () => posted.map((message) => message.name),
    logged,
    fetched,
    mediaCalls,
    mediaCallNames: () => mediaCalls.map((call) => call.name),
  };
}

// A Jellyfin server that accepts any token for saved sessions and password login.
function jellyfin(url, init = {}) {
  const path = new URL(url).pathname;
  if (path === '/System/Info') return { body: { ServerName: 'Home' } };
  if (path === '/System/Info/Public') return { body: { ServerName: 'Home' } };
  if (path === '/Users/Me') return { body: { Id: 'user-1', Name: 'Ann' } };
  if (path === '/Users/AuthenticateByName' && init.method === 'POST') {
    return { body: { AccessToken: 'new-token-value', User: { Id: 'user-1', Name: 'Ann' } } };
  }
  if (path === '/QuickConnect/Enabled') return { body: false };
  return { status: 404, statusText: 'Not Found', body: '' };
}

const savedServer = {
  id: 'srv-a',
  serverUrl: 'https://jf.example.com',
  serverName: 'Home',
  accessToken: 'saved-token-value',
};

// --- Start-up -------------------------------------------------------------

test('the sidebar waits for the DOM, then asks the plugin for its identity and servers', () => {
  const env = loadSidebar({ readyState: 'loading' });

  assert.equal(env.sidebar, undefined);
  assert.deepEqual(env.posted, []);

  env.dom.fire('DOMContentLoaded');

  assert.ok(env.sidebar instanceof env.window.JellyfinSidebar);
  assert.deepEqual(env.postedNames(), ['get-client-identity', 'get-servers', 'get-session']);
  assert.equal(env.dom.get('loginSection').style.display, 'block');
  assert.equal(env.dom.get('passwordLoginForm').style.display, 'flex');
  assert.equal(env.dom.get('quickConnectForm').style.display, 'none');
});

test('starting the sidebar a second time keeps the first instance', () => {
  const env = loadSidebar({ readyState: 'loading' });
  env.dom.fire('DOMContentLoaded');
  const first = env.sidebar;

  env.dom.fire('DOMContentLoaded');

  assert.equal(env.sidebar, first);
  assert.equal(env.postedNames().filter((name) => name === 'get-servers').length, 1);
});

test('with the DOM already loaded the sidebar starts signed out right away', () => {
  const env = loadSidebar();

  assert.ok(env.sidebar instanceof env.window.JellyfinSidebar);
  assert.equal(env.sidebar.currentUser, null);
  assert.equal(env.sidebar.currentServer, null);
  assert.deepEqual(plain(env.sidebar.servers), []);
  assert.deepEqual(env.postedNames(), ['get-client-identity', 'get-servers', 'get-session']);
});

test('the sidebar still starts without the plugin bridge', () => {
  const env = loadSidebar({ bridge: false });

  assert.ok(env.sidebar);
  assert.equal(env.dom.get('loginSection').style.display, 'block');
});

test('the sidebar combines the auth and media mixins on one instance', () => {
  const env = loadSidebar();

  env.dom.get('logoutBtn').click();

  const cleared = env.mediaCalls.find((call) => call.name === 'clearAllMediaContent');
  assert.equal(cleared.receiver, env.sidebar, 'media methods run on the sidebar instance');
  assert.equal(env.dom.get('serverStatus').textContent, 'Not connected');
});

// --- Plugin messages ------------------------------------------------------

test('the sidebar listens for identity, session and server messages from the plugin', () => {
  const env = loadSidebar();

  assert.deepEqual(Object.keys(env.handlers).sort(), [
    'client-identity',
    'server-switched',
    'servers-list',
    'servers-updated',
    'session-available',
    'session-cleared',
    'session-data',
  ]);
});

test('a server list from the plugin reconnects with the plugin device identity', async () => {
  const env = loadSidebar({ respond: jellyfin });

  env.handlers['client-identity']({ deviceId: 'device-1', version: '1.2.3' });
  env.handlers['servers-list']({ servers: [savedServer], activeServerId: 'srv-a' });
  await flush();

  assert.deepEqual(
    env.fetched.map((request) => request.url),
    ['https://jf.example.com/System/Info', 'https://jf.example.com/Users/Me']
  );
  for (const { init } of env.fetched) {
    assert.equal(init.method, 'GET');
    assert.equal(init.body, undefined);
    assert.match(init.headers.Authorization, /DeviceId="device-1", Version="1\.2\.3"/);
    assert.match(init.headers.Authorization, /Token="saved-token-value"/);
  }
  assert.equal(env.sidebar.currentUser.Name, 'Ann');
  assert.equal(env.dom.get('serverStatus').textContent, 'Connected to Home as Ann');
  assert.ok(env.mediaCallNames().includes('loadHomeTab'));
  assert.equal(env.dom.get('savedServerList').style.display, 'flex');
});

test('an updated server list from the plugin re-renders the saved servers', () => {
  const env = loadSidebar({ respond: () => new Promise(() => {}) });
  const other = { ...savedServer, id: 'srv-b', serverUrl: 'https://b.example.com' };

  env.handlers['servers-updated']({ servers: [savedServer, other], activeServerId: 'srv-b' });

  const items = env.dom.get('savedServerList').querySelectorAll('.saved-server-item');
  assert.deepEqual(
    items.map((item) => [item.dataset.serverId, item.classList.contains('active')]),
    [
      ['srv-a', false],
      ['srv-b', true],
    ]
  );
});

test('a switch announced by the plugin connects to the new server', async () => {
  const env = loadSidebar({ respond: jellyfin });

  env.handlers['server-switched']({ server: savedServer, servers: [savedServer] });
  await flush();

  assert.equal(env.sidebar.currentServer.serverId, 'srv-a');
});

test('a stored legacy session from the plugin signs the sidebar in', async () => {
  for (const message of ['session-available', 'session-data']) {
    const env = loadSidebar({ respond: jellyfin });

    env.handlers[message]({ serverUrl: 'https://jf.example.com', accessToken: 'legacy-token' });
    await flush();

    assert.equal(env.sidebar.currentUser?.Name, 'Ann', message);
    assert.match(env.fetched[0].init.headers.Authorization, /Token="legacy-token"/);
  }
});

test('a cleared session from the plugin signs the sidebar out', async () => {
  const env = loadSidebar({ respond: jellyfin });
  env.handlers['servers-list']({ servers: [savedServer], activeServerId: 'srv-a' });
  await flush();

  env.handlers['session-cleared']();

  assert.equal(env.sidebar.currentUser, null);
  assert.equal(env.dom.get('serverStatus').textContent, 'Not connected');
  assert.equal(env.dom.get('connectBtn').style.display, 'block');
  assert.equal(env.dom.get('savedServerList').style.display, 'none');
});

// --- HTTP client ----------------------------------------------------------

test('the HTTP client returns parsed JSON with the status and headers', async () => {
  const env = loadSidebar({
    respond: () => ({
      status: 201,
      statusText: 'Created',
      body: { Id: 'x' },
      headers: { 'content-type': 'application/json' },
    }),
  });

  const response = await env.sidebar
    .getHttpClient()
    .post('https://jf.example.com/Items', { headers: { A: '1' }, data: '{"a":1}' });

  assert.deepEqual(plain(response), {
    data: { Id: 'x' },
    status: 201,
    statusText: 'Created',
    headers: { 'content-type': 'application/json' },
  });
  assert.deepEqual(plain(env.fetched[0].init), {
    method: 'POST',
    headers: { A: '1' },
    body: '{"a":1}',
  });
});

test('the HTTP client returns a body that is not JSON as text', async () => {
  const env = loadSidebar({ respond: () => ({ status: 500, body: 'Internal error' }) });

  const response = await env.sidebar.getHttpClient().get('https://jf.example.com/x');

  assert.equal(response.data, 'Internal error');
  assert.equal(response.status, 500);
  assert.deepEqual(plain(env.fetched[0].init), { method: 'GET', headers: {} });
});

test('the HTTP client turns a failed request into a network error', async () => {
  const env = loadSidebar();

  await assert.rejects(env.sidebar.getHttpClient().get('https://jf.example.com/x'), (error) => {
    assert.deepEqual(plain(error), {
      message: 'Load failed',
      status: 0,
      statusText: 'Network Error',
    });
    return true;
  });
});

// --- Debug logging --------------------------------------------------------

test('debug logs hide credentials and passwords', async () => {
  const env = loadSidebar({ respond: jellyfin });
  env.handlers['client-identity']({ deviceId: 'device-1', debugLogging: true });

  env.handlers['session-data']({
    serverUrl: 'https://jf.example.com',
    accessToken: 'saved-token-value',
  });
  await flush();
  await env.sidebar.getHttpClient().get('https://jf.example.com/Videos/1?api_key=abcdef123456&a=1');
  env.dom.get('serverUrl').value = 'https://jf.example.com';
  env.dom.get('username').value = 'ann';
  env.dom.get('password').value = 'hunter2-password';
  await env.sidebar.login();

  const log = env.logged.join('\n');
  assert.ok(env.logged.length > 0);
  assert.ok(env.logged.every((line) => line.startsWith('DEBUG: ')));
  assert.match(log, /api_key=\[redacted\]&a=1/);
  assert.match(log, /"password":"\[HIDDEN\]"/);
  assert.doesNotMatch(log, /saved-token-value|abcdef123456|hunter2-password|new-token-value/);
});

test('debug logs shorten long values and describe errors', async () => {
  const env = loadSidebar();
  env.handlers['client-identity']({ deviceId: 'device-1', debugLogging: true });

  env.handlers['servers-updated']({ servers: [], note: 'x'.repeat(1000) });
  await env.sidebar
    .getHttpClient()
    .get('https://jf.example.com/x')
    .catch(() => {});

  assert.ok(env.logged.some((line) => /…\[truncated \d+ chars\]$/.test(line)));
  assert.ok(
    env.logged.some((line) => line.endsWith('HTTP request failed: | TypeError: Load failed'))
  );
});

// --- Tabs -----------------------------------------------------------------

test('choosing a tab shows only that tab', () => {
  const env = loadSidebar();
  const [buttons, contents] = [env.dom.groups['.tab-button'], env.dom.groups['.tab-content']];

  buttons.find((button) => button.dataset.tab === 'series').click();

  assert.deepEqual(
    buttons.filter((b) => b.classList.contains('active')).map((b) => b.dataset.tab),
    ['series']
  );
  assert.deepEqual(
    contents.filter((c) => c.classList.contains('active')).map((c) => c.id),
    ['seriesTab']
  );
  assert.deepEqual(env.mediaCalls, [], 'nothing loads while signed out');
});

test('choosing a library tab while signed in loads it', () => {
  const env = loadSidebar();
  env.sidebar.currentUser = { Id: 'user-1', Name: 'Ann' };
  const tab = (name) => env.dom.groups['.tab-button'].find((b) => b.dataset.tab === name);

  for (const name of TABS) tab(name).click();

  assert.deepEqual(env.mediaCallNames(), ['loadHomeTab', 'loadMovies', 'loadSeries', 'loadMusic']);
});

// --- Controls -------------------------------------------------------------

test('media controls hand off to the media methods', () => {
  const env = loadSidebar();
  const clicks = {
    playEpisodeBtn: 'playSelectedEpisode',
    openEpisodeInJellyfinBtn: 'openSelectedEpisodeInJellyfin',
    cancelEpisodeBtn: 'hideEpisodeSelection',
    playAllTracksBtn: 'playAllAlbumTracks',
    openAlbumInJellyfinBtn: 'openAlbumInJellyfin',
    cancelAlbumTracksBtn: 'hideAlbumTracks',
  };

  for (const [id, method] of Object.entries(clicks)) {
    env.mediaCalls.length = 0;
    env.dom.get(id).click();
    assert.deepEqual(env.mediaCallNames(), [method], id);
  }
});

test('changing a library sort or filter reloads that library', () => {
  const env = loadSidebar();
  const selects = {
    moviesSortSelect: 'loadMovies',
    moviesFilterSelect: 'loadMovies',
    moviesGenreSelect: 'loadMovies',
    seriesSortSelect: 'loadSeries',
    seriesFilterSelect: 'loadSeries',
    seriesGenreSelect: 'loadSeries',
    musicViewSelect: 'loadMusic',
    musicSortSelect: 'loadMusic',
    musicGenreSelect: 'loadMusic',
  };

  for (const [id, method] of Object.entries(selects)) {
    env.mediaCalls.length = 0;
    env.dom.get(id).dispatch('change');
    assert.deepEqual(env.mediaCallNames(), [method], id);
  }
});

test('choosing a season loads its episodes', () => {
  const env = loadSidebar();
  const select = env.dom.get('seasonSelect');
  select.value = 'season-2';

  select.dispatch('change');

  assert.deepEqual(plain(env.mediaCalls.map(({ name, args }) => ({ name, args }))), [
    { name: 'loadEpisodes', args: ['season-2'] },
  ]);
});

test('the filter buttons show and hide their filter panels', () => {
  const env = loadSidebar();

  for (const library of ['movies', 'series', 'music']) {
    const panel = env.dom.get(`${library}FilterPanel`);
    env.dom.get(`${library}FilterBtn`).click();
    assert.equal(panel.style.display, 'block', library);
    env.dom.get(`${library}FilterBtn`).click();
    assert.equal(panel.style.display, 'none', library);
  }
});

test('typing in the search box searches for the text', () => {
  const env = loadSidebar();
  const input = env.dom.get('searchInput');
  input.value = 'matrix';

  input.dispatch('input');

  assert.deepEqual(plain(env.mediaCalls.map(({ name, args }) => ({ name, args }))), [
    { name: 'debounceSearch', args: ['matrix'] },
  ]);
});

test('toggling a search type re-runs the search only when there is a search term', () => {
  const env = loadSidebar();
  const [movieChip] = env.dom.groups['.search-type-chip'];
  const input = env.dom.get('searchInput');

  input.value = '   ';
  movieChip.click();
  assert.equal(movieChip.classList.contains('active'), false);
  assert.deepEqual(env.mediaCalls, []);

  input.value = 'matrix';
  movieChip.click();
  assert.equal(movieChip.classList.contains('active'), true);
  assert.deepEqual(plain(env.mediaCalls.map(({ name, args }) => ({ name, args }))), [
    { name: 'debounceSearch', args: ['matrix'] },
  ]);
});

// --- Login form controls --------------------------------------------------

test('the connect and add-server buttons open the login form', () => {
  for (const id of ['connectBtn', 'addServerBtn']) {
    const env = loadSidebar();
    env.dom.get('loginSection').style.display = 'none';

    env.dom.get(id).click();

    assert.equal(env.dom.get('loginSection').style.display, 'block', id);
  }
});

test('the cancel buttons close and clear the login form', () => {
  for (const id of ['cancelLoginBtn', 'qcCancelBtn']) {
    const env = loadSidebar();
    env.dom.get('serverUrl').value = 'https://jf.example.com';
    env.dom.get('qcServerUrl').value = 'https://jf.example.com';

    env.dom.get(id).click();

    assert.equal(env.dom.get('loginSection').style.display, 'none', id);
    assert.equal(env.dom.get('serverUrl').value, '', id);
    assert.equal(env.dom.get('qcServerUrl').value, '', id);
  }
});

test('the login method tabs switch between password and Quick Connect', () => {
  const env = loadSidebar();
  const [passwordTab, quickConnectTab] = env.dom.groups['.login-method-tab'];

  quickConnectTab.click();
  assert.equal(env.dom.get('quickConnectForm').style.display, 'flex');
  assert.equal(quickConnectTab.classList.contains('active'), true);

  passwordTab.click();
  assert.equal(env.dom.get('passwordLoginForm').style.display, 'flex');
  assert.equal(quickConnectTab.classList.contains('active'), false);
});

test('pressing Enter in a login field submits the login', async () => {
  for (const field of ['serverUrl', 'username', 'password']) {
    const env = loadSidebar({ respond: jellyfin });
    env.dom.get('serverUrl').value = 'https://jf.example.com';
    env.dom.get('username').value = 'ann';
    env.dom.get('password').value = 'pw';

    env.dom.get(field).dispatch('keypress', { key: 'a' });
    assert.equal(env.fetched.length, 0, `${field}: other keys do not submit`);

    env.dom.get(field).dispatch('keypress', { key: 'Enter' });
    await flush();

    assert.ok(
      env.fetched.some((request) => request.url.endsWith('/Users/AuthenticateByName')),
      field
    );
    assert.equal(env.sidebar.currentUser?.Name, 'Ann', field);
  }
});

test('the login button signs in with the entered credentials', async () => {
  const env = loadSidebar({ respond: jellyfin });
  env.dom.get('serverUrl').value = 'https://jf.example.com';
  env.dom.get('username').value = 'ann';
  env.dom.get('password').value = 'pw';

  env.dom.get('loginBtn').click();
  await flush();

  assert.equal(env.sidebar.currentUser.Name, 'Ann');
  assert.equal(env.posted.at(-1).name, 'store-session');
  assert.equal(env.dom.get('logoutBtn').style.display, 'block');
});

test('Quick Connect starts from its button or Enter in its server field', async () => {
  const start = (env) => env.dom.get('qcStartBtn').click();
  const enter = (env) => env.dom.get('qcServerUrl').dispatch('keypress', { key: 'Enter' });

  for (const trigger of [start, enter]) {
    const env = loadSidebar({ respond: jellyfin });
    env.dom.get('qcServerUrl').value = 'https://jf.example.com';

    trigger(env);
    await flush();

    assert.deepEqual(
      env.fetched.map((request) => request.url),
      ['https://jf.example.com/QuickConnect/Enabled']
    );
    assert.match(env.dom.get('qcError').textContent, /not enabled on this server/);
  }
});
