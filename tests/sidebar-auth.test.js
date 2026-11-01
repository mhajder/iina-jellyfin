import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { runScript } from './helpers/load-commonjs.js';

const AUTH_METHODS = 'src/ui/sidebar/lib/auth-server-methods.js';

// Objects built inside the vm context have their own prototypes, so compare
// plain copies of them.
const plain = (value) => JSON.parse(JSON.stringify(value));

const flush = () => new Promise((resolve) => setImmediate(resolve));

// Just enough DOM for the auth and server-list code: elements are created on
// first lookup, and the saved-server list exposes the items rendered into it.
function createElement(id, { classes = [], dataset = {} } = {}) {
  const listeners = {};
  const classSet = new Set(classes);
  let html = '';
  let children = [];
  const element = {
    id,
    value: '',
    textContent: '',
    disabled: false,
    style: {},
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
    click(event = {}) {
      let stopped = false;
      for (const listener of listeners.click || []) {
        listener({ target: element, stopPropagation: () => (stopped = true), ...event });
      }
      return { stopped };
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

function createDom() {
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, createElement(id));
    return elements.get(id);
  };
  const methodTabs = ['password', 'quickconnect'].map((method) =>
    createElement(null, { classes: ['login-method-tab'], dataset: { method } })
  );
  const document = {
    getElementById: get,
    querySelectorAll: (selector) => (selector === '.login-method-tab' ? methodTabs : []),
  };
  return { document, get, methodTabs };
}

// setInterval stand-in that only fires when a test calls tick().
function createIntervals() {
  const intervals = new Map();
  let nextId = 1;
  return {
    setInterval(callback, delay) {
      const id = nextId++;
      intervals.set(id, { callback, delay });
      return id;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
    active: () => [...intervals.values()],
    async tick() {
      for (const { callback } of [...intervals.values()]) callback();
      await flush();
    },
  };
}

const networkError = (message = 'Load failed') => ({
  message,
  status: 0,
  statusText: 'Network Error',
});

/**
 * Build a sidebar from the real auth/server methods. `respond(method, url,
 * options)` plays the server: it returns { status, data } like the sidebar's
 * fetch-based client, or throws its network error.
 */
function createSidebar({ respond = () => ({ status: 404, data: '' }), identity } = {}) {
  const dom = createDom();
  const intervals = createIntervals();
  const posted = [];
  const requests = [];
  const calls = [];
  const context = vm.createContext({
    window: {},
    document: dom.document,
    iina: { postMessage: (name, data) => posted.push({ name, data }) },
    setInterval: intervals.setInterval,
    clearInterval: intervals.clearInterval,
  });
  runScript(AUTH_METHODS, context);
  const methods = context.window.createSidebarAuthServerMethods(() => {});

  const send = async (method, url, options = {}) => {
    requests.push({ method, url, options });
    return respond(method, url, options);
  };
  const record = (name) =>
    function () {
      calls.push(name);
    };

  const sidebar = {
    ...methods,
    currentUser: null,
    currentServer: null,
    servers: [],
    activeServerId: null,
    initialAutoConnectDone: false,
    clientIdentity: identity === undefined ? { deviceId: 'device-1', version: '1.2.3' } : identity,
    fallbackDeviceId: null,
    qcSecret: null,
    qcPollingInterval: null,
    qcServerUrl: null,
    getHttpClient: () => ({
      get: (url, options) => send('GET', url, options),
      post: (url, options) => send('POST', url, options),
    }),
    // Media methods the auth code hands off to.
    showMainContent: record('showMainContent'),
    hideMainContent: record('hideMainContent'),
    clearAllMediaContent: record('clearAllMediaContent'),
    loadHomeTab: record('loadHomeTab'),
    scrollToTop: record('scrollToTop'),
  };

  const messages = (name) => posted.filter((m) => m.name === name).map((m) => plain(m.data ?? {}));
  return { sidebar, dom, intervals, posted, messages, requests, calls };
}

function fillLogin(dom, { server = 'https://jf.example.com', user = 'ann', password = 'pw' }) {
  dom.get('serverUrl').value = server;
  dom.get('username').value = user;
  dom.get('password').value = password;
}

const signedIn = { AccessToken: 'new-token', User: { Id: 'user-1', Name: 'Ann' } };

// --- Authorization header -------------------------------------------------

test('the authorization header identifies the plugin device and carries the token', () => {
  const { sidebar } = createSidebar({
    identity: {
      clientName: 'Client',
      deviceName: 'Mac',
      deviceId: 'device-1',
      version: '1.2.3',
    },
  });

  assert.equal(
    sidebar.buildAuthorizationHeader('tok'),
    'MediaBrowser Client="Client", Device="Mac", DeviceId="device-1", Version="1.2.3", Token="tok"'
  );
  assert.doesNotMatch(sidebar.buildAuthorizationHeader(), /Token=/);
});

test('before the client identity arrives each webview uses its own stable device id', () => {
  const first = createSidebar({ identity: null }).sidebar;
  const second = createSidebar({ identity: null }).sidebar;

  const deviceId = (header) => header.match(/DeviceId="([^"]+)"/)[1];
  const firstId = deviceId(first.buildAuthorizationHeader());

  assert.match(first.buildAuthorizationHeader(), /Client="IINA Jellyfin Plugin"/);
  assert.match(first.buildAuthorizationHeader(), /Version="0\.0\.0"/);
  assert.equal(deviceId(first.buildAuthorizationHeader('t')), firstId);
  assert.notEqual(deviceId(second.buildAuthorizationHeader()), firstId);
});

test('a client identity without a device id is ignored', () => {
  const { sidebar } = createSidebar({ identity: { deviceId: 'device-1' } });

  sidebar.handleClientIdentity({ version: '9.9.9' });
  sidebar.handleClientIdentity(null);
  assert.equal(sidebar.clientIdentity.deviceId, 'device-1');

  sidebar.handleClientIdentity({ deviceId: 'device-2', version: '2.0.0' });
  assert.match(sidebar.buildAuthorizationHeader(), /DeviceId="device-2", Version="2\.0\.0"/);
});

// --- Server URL normalization ---------------------------------------------

test('server URLs default to http and lose their trailing slash', () => {
  const { sidebar } = createSidebar();

  assert.equal(sidebar.normalizeServerUrl('jf.local:8096'), 'http://jf.local:8096');
  assert.equal(sidebar.normalizeServerUrl('  https://jf.example.com/  '), 'https://jf.example.com');
  assert.equal(
    sidebar.normalizeServerUrl('https://example.com/jellyfin/'),
    'https://example.com/jellyfin'
  );
});

test('empty or malformed server URLs are rejected with a reason', () => {
  const { sidebar } = createSidebar();

  assert.throws(() => sidebar.normalizeServerUrl(''), { message: 'Invalid server URL' });
  assert.throws(() => sidebar.normalizeServerUrl(undefined), { message: 'Invalid server URL' });
  assert.throws(() => sidebar.normalizeServerUrl('   '), { message: 'Server URL cannot be empty' });
  assert.throws(() => sidebar.normalizeServerUrl('http:// jf.local'), {
    message: 'Invalid server URL format',
  });
});

// --- Password login -------------------------------------------------------

test('password login posts the credentials and stores the new session', async () => {
  const { sidebar, dom, requests, messages, calls } = createSidebar({
    respond(method, url) {
      if (url === 'http://jf.local:8096/System/Info/Public') {
        return { status: 200, data: { ServerName: 'Home' } };
      }
      if (method === 'POST' && url === 'http://jf.local:8096/Users/AuthenticateByName') {
        return { status: 200, data: signedIn };
      }
      throw new Error(`unexpected ${method} ${url}`);
    },
  });
  dom.get('loginSection').style.display = 'block';
  fillLogin(dom, { server: ' jf.local:8096/ ', user: ' ann ', password: ' secret ' });

  await sidebar.login();

  const auth = requests.find((request) => request.method === 'POST');
  assert.deepEqual(JSON.parse(auth.options.data), { Username: 'ann', Pw: ' secret ' });
  assert.equal(auth.options.headers['Content-Type'], 'application/json');
  assert.equal(auth.options.headers.Accept, 'application/json');
  assert.match(auth.options.headers.Authorization, /^MediaBrowser .*DeviceId="device-1"/);
  assert.doesNotMatch(auth.options.headers.Authorization, /Token=/);

  assert.deepEqual(messages('store-session'), [
    {
      serverUrl: 'http://jf.local:8096',
      accessToken: 'new-token',
      serverName: 'Home',
      userId: 'user-1',
      username: 'Ann',
    },
  ]);
  assert.deepEqual(plain(sidebar.currentServer), {
    name: 'Home',
    url: 'http://jf.local:8096',
    userId: 'user-1',
    accessToken: 'new-token',
  });
  assert.equal(sidebar.currentUser.Name, 'Ann');
  assert.equal(dom.get('serverStatus').textContent, 'Connected as Ann');
  assert.equal(dom.get('serverStatus').className, 'server-status connected');
  assert.equal(dom.get('loginSection').style.display, 'none');
  assert.equal(dom.get('password').value, '', 'the password is cleared from the form');
  assert.equal(dom.get('logoutBtn').style.display, 'block');
  assert.equal(dom.get('connectBtn').style.display, 'none');
  assert.ok(calls.includes('showMainContent'));
  assert.ok(calls.includes('loadHomeTab'));
  assert.equal(dom.get('loginBtn').disabled, false);
  assert.equal(dom.get('loginBtn').textContent, 'Login');
});

test('password login asks for every field before contacting the server', async () => {
  const { sidebar, dom, requests } = createSidebar();
  fillLogin(dom, { password: '' });

  await sidebar.login();

  assert.equal(dom.get('loginError').textContent, 'Please fill in all fields');
  assert.equal(requests.length, 0);
});

test('password login reports a malformed server URL', async () => {
  const { sidebar, dom, requests } = createSidebar();
  fillLogin(dom, { server: 'http:// jf.local' });

  await sidebar.login();

  assert.equal(dom.get('loginError').textContent, 'Invalid server URL format');
  assert.equal(requests.length, 0);
});

for (const [description, response, message] of [
  ['wrong credentials', { status: 401, data: '' }, 'Invalid username or password'],
  ['a forbidden user', { status: 403, data: '' }, 'Access forbidden - check user permissions'],
  [
    'a missing login endpoint',
    { status: 404, data: '' },
    'Authentication endpoint not found - check server URL',
  ],
  ['a server error', { status: 500, data: '' }, 'Authentication failed with status 500'],
  [
    'an error from the server',
    { status: 400, data: { error: 'Bad request' } },
    'Authentication failed: Bad request',
  ],
]) {
  test(`password login explains ${description} and stays signed out`, async () => {
    const { sidebar, dom, messages } = createSidebar({
      respond: (method) => (method === 'POST' ? response : { status: 200, data: {} }),
    });
    dom.get('loginSection').style.display = 'block';
    fillLogin(dom, {});

    await sidebar.login();

    assert.equal(dom.get('loginError').textContent, message);
    assert.equal(sidebar.currentServer, null);
    assert.equal(messages('store-session').length, 0);
    assert.equal(dom.get('loginSection').style.display, 'block');
    assert.equal(dom.get('loginBtn').disabled, false);
    assert.equal(dom.get('loginBtn').textContent, 'Login');
  });
}

// IINA's WebKit reports an unreachable server as "Load failed", Chromium as
// "Failed to fetch": neither contains "Network", so the status must decide.
for (const browserMessage of ['Load failed', 'Failed to fetch']) {
  test(`password login names a network error when fetch fails with "${browserMessage}"`, async () => {
    const { sidebar, dom } = createSidebar({
      respond() {
        throw networkError(browserMessage);
      },
    });
    fillLogin(dom, {});

    await sidebar.login();

    assert.equal(
      dom.get('loginError').textContent,
      'Network error - check server URL and connectivity'
    );
  });
}

test('password login reports an unreachable server without signing in', async () => {
  const { sidebar, dom, messages } = createSidebar({
    respond() {
      throw networkError();
    },
  });
  fillLogin(dom, {});

  await sidebar.login();

  assert.notEqual(dom.get('loginError').textContent, '');
  assert.equal(sidebar.currentServer, null);
  assert.equal(messages('store-session').length, 0);
  assert.equal(dom.get('loginBtn').disabled, false);
});

test('password login proceeds when the public server info is unavailable', async () => {
  const { sidebar, dom } = createSidebar({
    respond(method) {
      if (method === 'GET') throw networkError();
      return { status: 200, data: signedIn };
    },
  });
  fillLogin(dom, { server: 'https://jf.example.com/' });

  await sidebar.login();

  assert.equal(dom.get('loginError').textContent, '');
  assert.equal(sidebar.currentServer.name, 'https://jf.example.com');
  assert.equal(sidebar.currentUser.Id, 'user-1');
});

// --- Quick Connect --------------------------------------------------------

// A server with Quick Connect enabled that approves once `approve()` is called.
function quickConnectServer(overrides = {}) {
  let approved = false;
  const server = {
    approve: () => (approved = true),
    respond(method, url, options) {
      const route = `${method} ${url.replace('https://jf.example.com', '')}`;
      if (overrides[route]) return overrides[route](options);
      switch (route) {
        case 'GET /QuickConnect/Enabled':
          return { status: 200, data: true };
        case 'POST /QuickConnect/Initiate':
          return { status: 200, data: { Secret: 's3cret', Code: '123456' } };
        case 'GET /QuickConnect/Connect?secret=s3cret':
          return { status: 200, data: { Authenticated: approved } };
        case 'POST /Users/AuthenticateWithQuickConnect':
          return { status: 200, data: signedIn };
        case 'GET /System/Info/Public':
          return { status: 200, data: { ServerName: 'Home' } };
        default:
          throw new Error(`unexpected ${route}`);
      }
    },
  };
  return server;
}

async function startQuickConnect(server) {
  const env = createSidebar({ respond: server.respond });
  env.dom.get('loginSection').style.display = 'block';
  env.dom.get('qcServerUrl').value = 'https://jf.example.com/';
  await env.sidebar.startQuickConnect();
  return env;
}

const polls = (requests) => requests.filter((r) => r.url.includes('/QuickConnect/Connect'));

test('Quick Connect shows the code and signs in once the request is approved', async () => {
  const server = quickConnectServer();
  const { sidebar, dom, intervals, requests, messages, calls } = await startQuickConnect(server);

  const initiate = requests.find((r) => r.url.endsWith('/QuickConnect/Initiate'));
  assert.match(initiate.options.headers.Authorization, /DeviceId="device-1"/);
  assert.doesNotMatch(initiate.options.headers.Authorization, /Token=/);
  assert.equal(dom.get('qcCode').textContent, '123456');
  assert.equal(dom.get('qcCodeSection').style.display, 'block');
  assert.equal(dom.get('qcStartBtn').style.display, 'none');
  assert.deepEqual(
    intervals.active().map((interval) => interval.delay),
    [5000]
  );

  await intervals.tick();
  assert.equal(polls(requests).length, 1);
  assert.equal(sidebar.currentServer, null, 'still waiting for approval');

  server.approve();
  await intervals.tick();

  assert.equal(intervals.active().length, 0, 'polling stops after approval');
  const auth = requests.find((r) => r.url.endsWith('/Users/AuthenticateWithQuickConnect'));
  assert.deepEqual(JSON.parse(auth.options.data), { Secret: 's3cret' });
  assert.deepEqual(messages('store-session'), [
    {
      serverUrl: 'https://jf.example.com',
      accessToken: 'new-token',
      serverName: 'Home',
      userId: 'user-1',
      username: 'Ann',
    },
  ]);
  assert.equal(sidebar.currentServer.url, 'https://jf.example.com');
  assert.equal(sidebar.qcSecret, null);
  assert.equal(dom.get('serverStatus').textContent, 'Connected as Ann');
  assert.equal(dom.get('loginSection').style.display, 'none');
  assert.ok(calls.includes('loadHomeTab'));
});

test('a Quick Connect check slower than the interval is not overlapped by the next one', async () => {
  const pending = [];
  const server = quickConnectServer({
    'GET /QuickConnect/Connect?secret=s3cret': () =>
      new Promise((resolve) => pending.push(resolve)),
  });
  const { intervals, requests, messages } = await startQuickConnect(server);

  await intervals.tick();
  await intervals.tick();
  await intervals.tick();
  assert.equal(polls(requests).length, 1, 'no new check while the first is unanswered');

  // Answered as approved: without the guard every overlapping check would
  // see this and sign in again.
  pending.forEach((resolve) => resolve({ status: 200, data: { Authenticated: true } }));
  await intervals.tick();

  const logins = requests.filter((r) => r.url.endsWith('/Users/AuthenticateWithQuickConnect'));
  assert.equal(logins.length, 1);
  assert.equal(messages('store-session').length, 1);
});

test('a check left over from a restarted Quick Connect neither signs in nor stops the new poll', async () => {
  const pending = [];
  const server = quickConnectServer({
    'GET /QuickConnect/Connect?secret=s3cret': () =>
      new Promise((resolve) => pending.push(resolve)),
  });
  const { sidebar, dom, intervals, requests } = await startQuickConnect(server);

  await intervals.tick();
  sidebar.cancelQuickConnect();
  dom.get('qcServerUrl').value = 'https://jf.example.com/';
  await sidebar.startQuickConnect();
  assert.equal(intervals.active().length, 1);

  // The old code's check answers as approved after the restart.
  pending[0]({ status: 200, data: { Authenticated: true } });
  await flush();

  const logins = requests.filter((r) => r.url.endsWith('/Users/AuthenticateWithQuickConnect'));
  assert.equal(logins.length, 0);
  assert.equal(intervals.active().length, 1, 'the new code is still being checked');
  assert.equal(sidebar.currentServer, null);
});

test('Quick Connect checks again once a slow check has been answered', async () => {
  const pending = [];
  const server = quickConnectServer({
    'GET /QuickConnect/Connect?secret=s3cret': () =>
      new Promise((resolve) => pending.push(resolve)),
  });
  const { intervals, requests } = await startQuickConnect(server);

  await intervals.tick();
  pending[0]({ status: 200, data: { Authenticated: false } });
  await flush();
  await intervals.tick();

  assert.equal(polls(requests).length, 2);
});

test('Quick Connect keeps polling through transient poll failures', async () => {
  let failNext = true;
  const server = quickConnectServer({
    'GET /QuickConnect/Connect?secret=s3cret': () => {
      if (failNext) {
        failNext = false;
        throw networkError();
      }
      return { status: 200, data: { Authenticated: true } };
    },
  });
  const { sidebar, intervals, dom } = await startQuickConnect(server);

  await intervals.tick();
  assert.equal(intervals.active().length, 1);
  assert.equal(dom.get('qcError').textContent, '');

  await intervals.tick();
  assert.equal(sidebar.currentUser.Name, 'Ann');
});

test('Quick Connect gives up after five minutes without approval', async () => {
  const { sidebar, dom, intervals, requests } = await startQuickConnect(quickConnectServer());

  for (let i = 0; i < 60; i++) await intervals.tick();
  assert.equal(polls(requests).length, 60);
  assert.equal(dom.get('qcError').textContent, '');

  await intervals.tick();

  assert.equal(polls(requests).length, 60);
  assert.equal(intervals.active().length, 0);
  assert.equal(dom.get('qcError').textContent, 'Quick Connect timed out. Please try again.');
  assert.equal(dom.get('qcCodeSection').style.display, 'none');
  assert.equal(dom.get('qcStartBtn').style.display, 'block');
  assert.equal(sidebar.qcSecret, null);
});

test('cancelling Quick Connect stops polling and ignores an approval already in flight', async () => {
  let answerPoll;
  const server = quickConnectServer({
    'GET /QuickConnect/Connect?secret=s3cret': () =>
      new Promise((resolve) => (answerPoll = resolve)),
  });
  const { sidebar, dom, intervals, requests } = await startQuickConnect(server);

  await intervals.tick();
  sidebar.cancelQuickConnect();
  answerPoll({ status: 200, data: { Authenticated: true } });
  await flush();

  assert.equal(intervals.active().length, 0);
  assert.equal(
    requests.filter((r) => r.url.endsWith('/Users/AuthenticateWithQuickConnect')).length,
    0
  );
  assert.equal(sidebar.currentServer, null);
  assert.equal(dom.get('qcCodeSection').style.display, 'none');
  assert.equal(dom.get('qcCode').textContent, '');
  assert.equal(dom.get('qcStartBtn').disabled, false);
  assert.equal(dom.get('qcStartBtn').textContent, 'Start Quick Connect');
  assert.equal(dom.get('qcError').textContent, '');
});

test('Quick Connect reports a rejected authentication and offers to start again', async () => {
  const server = quickConnectServer({
    'POST /Users/AuthenticateWithQuickConnect': () => ({ status: 401, data: '' }),
  });
  const { sidebar, dom, intervals } = await startQuickConnect(server);
  server.approve();

  await intervals.tick();

  assert.equal(
    dom.get('qcError').textContent,
    'Quick Connect authentication failed. Please try again.'
  );
  assert.equal(sidebar.currentServer, null);
  assert.equal(dom.get('qcStartBtn').style.display, 'block');
  assert.equal(dom.get('qcCodeSection').style.display, 'none');
});

test('Quick Connect reports a failed authentication request', async () => {
  const server = quickConnectServer({
    'POST /Users/AuthenticateWithQuickConnect': () => {
      throw networkError('Load failed');
    },
  });
  const { sidebar, dom, intervals } = await startQuickConnect(server);
  server.approve();

  await intervals.tick();

  assert.equal(dom.get('qcError').textContent, 'Network error - check server URL and connectivity');
  assert.equal(sidebar.currentServer, null);
  assert.equal(dom.get('qcStartBtn').style.display, 'block');
});

test('Quick Connect asks for a server URL first', async () => {
  const { sidebar, dom, requests } = createSidebar();

  await sidebar.startQuickConnect();

  assert.equal(dom.get('qcError').textContent, 'Please enter a server URL');
  assert.equal(requests.length, 0);
});

test('Quick Connect reports a malformed server URL', async () => {
  const { sidebar, dom, requests } = createSidebar();
  dom.get('qcServerUrl').value = 'http:// jf.local';

  await sidebar.startQuickConnect();

  assert.equal(dom.get('qcError').textContent, 'Invalid server URL format');
  assert.equal(requests.length, 0);
});

for (const [description, overrides, message] of [
  [
    'is disabled on the server',
    { 'GET /QuickConnect/Enabled': () => ({ status: 200, data: false }) },
    /^Quick Connect is not enabled on this server/,
  ],
  [
    'cannot be initiated',
    { 'POST /QuickConnect/Initiate': () => ({ status: 401, data: '' }) },
    /^Failed to initiate Quick Connect/,
  ],
  [
    'server is unreachable',
    {
      'GET /QuickConnect/Enabled': () => {
        throw networkError();
      },
    },
    /^Failed to start Quick Connect\. Check your server URL\.$/,
  ],
]) {
  test(`Quick Connect explains when it ${description}`, async () => {
    const { dom, intervals } = await startQuickConnect(quickConnectServer(overrides));

    assert.match(dom.get('qcError').textContent, message);
    assert.equal(intervals.active().length, 0);
    assert.equal(dom.get('qcStartBtn').disabled, false);
    assert.equal(dom.get('qcStartBtn').textContent, 'Start Quick Connect');
  });
}

test('the Quick Connect server answering "true" as text counts as enabled', async () => {
  const server = quickConnectServer({
    'GET /QuickConnect/Enabled': () => ({ status: 200, data: 'true' }),
  });
  const { dom } = await startQuickConnect(server);

  assert.equal(dom.get('qcCode').textContent, '123456');
});

// --- Login form -----------------------------------------------------------

test('switching login method carries the server URL across and stops Quick Connect', async () => {
  const { sidebar, dom, intervals } = await startQuickConnect(quickConnectServer());
  const { methodTabs } = dom;
  dom.get('serverUrl').value = '';

  sidebar.switchLoginMethod('password');

  assert.equal(intervals.active().length, 0);
  assert.equal(dom.get('serverUrl').value, 'https://jf.example.com/');
  assert.equal(dom.get('passwordLoginForm').style.display, 'flex');
  assert.equal(dom.get('quickConnectForm').style.display, 'none');
  assert.deepEqual(
    methodTabs.map((tab) => tab.classList.contains('active')),
    [true, false]
  );

  dom.get('qcServerUrl').value = '';
  dom.get('serverUrl').value = 'https://other.example.com';
  sidebar.switchLoginMethod('quickconnect');

  assert.equal(dom.get('qcServerUrl').value, 'https://other.example.com');
  assert.equal(dom.get('passwordLoginForm').style.display, 'none');
  assert.equal(dom.get('quickConnectForm').style.display, 'flex');
  assert.deepEqual(
    methodTabs.map((tab) => tab.classList.contains('active')),
    [false, true]
  );
});

test('switching login method keeps a URL already typed in the other form', () => {
  const { sidebar, dom } = createSidebar();
  dom.get('serverUrl').value = 'https://a.example.com';
  dom.get('qcServerUrl').value = 'https://b.example.com';

  sidebar.switchLoginMethod('quickconnect');
  sidebar.switchLoginMethod('password');

  assert.equal(dom.get('serverUrl').value, 'https://a.example.com');
  assert.equal(dom.get('qcServerUrl').value, 'https://b.example.com');
});

test('opening the login form starts on password login', () => {
  const { sidebar, dom, calls } = createSidebar();

  sidebar.showLoginForm();

  assert.equal(dom.get('loginSection').style.display, 'block');
  assert.equal(dom.get('passwordLoginForm').style.display, 'flex');
  assert.ok(calls.includes('scrollToTop'));
});

// --- Logout ---------------------------------------------------------------

const serverA = {
  id: 'srv-a',
  serverUrl: 'https://a.example.com',
  serverName: 'A',
  username: 'ann',
  accessToken: 'token-a',
};
const serverB = {
  id: 'srv-b',
  serverUrl: 'https://b.example.com',
  serverName: 'B',
  accessToken: 'token-b',
};

test('logging out forgets the connected server and resets the view', () => {
  const { sidebar, dom, posted, calls } = createSidebar();
  sidebar.servers = [serverA, serverB];
  sidebar.activeServerId = 'srv-a';
  sidebar.currentServer = { name: 'A', url: serverA.serverUrl, serverId: 'srv-a' };
  sidebar.currentUser = { Name: 'Ann' };

  sidebar.logoutActiveServer();

  assert.deepEqual(
    posted.map((m) => [m.name, plain(m.data)]),
    [['remove-server', { serverId: 'srv-a' }]]
  );
  assert.deepEqual(
    sidebar.servers.map((s) => s.id),
    ['srv-b']
  );
  assert.equal(sidebar.currentServer, null);
  assert.equal(sidebar.currentUser, null);
  assert.equal(sidebar.activeServerId, null);
  assert.equal(dom.get('serverStatus').textContent, 'Not connected');
  assert.equal(dom.get('connectBtn').style.display, 'block');
  assert.equal(dom.get('logoutBtn').style.display, 'none');
  assert.ok(calls.includes('clearAllMediaContent'));
  assert.ok(calls.includes('hideMainContent'));
  assert.deepEqual(
    dom
      .get('savedServerList')
      .querySelectorAll('.saved-server-item')
      .map((item) => item.dataset.serverId),
    ['srv-b']
  );
});

test('logging out of a session without a stored id clears the stored session', () => {
  const { sidebar, dom, posted } = createSidebar();
  sidebar.currentServer = { name: 'Legacy', url: 'https://jf.example.com' };
  sidebar.currentUser = { Name: 'Ann' };

  sidebar.logoutActiveServer();

  assert.deepEqual(
    posted.map((m) => m.name),
    ['clear-session']
  );
  assert.equal(sidebar.currentServer, null);
  assert.equal(dom.get('savedServerList').style.display, 'none');
});

// --- Saved server list ----------------------------------------------------

test('the saved server list shows signed-in servers and marks the active one', () => {
  const { sidebar, dom } = createSidebar();
  sidebar.servers = [
    { ...serverA, serverName: '<img src=x onerror=alert(1)>' },
    serverB,
    { id: 'srv-c', serverUrl: 'https://c.example.com' },
  ];
  sidebar.activeServerId = 'srv-b';

  sidebar.renderServerList();

  const list = dom.get('savedServerList');
  assert.equal(list.style.display, 'flex');
  const items = list.querySelectorAll('.saved-server-item');
  assert.deepEqual(
    items.map((item) => [item.dataset.serverId, item.classList.contains('active')]),
    [
      ['srv-a', false],
      ['srv-b', true],
    ]
  );
  assert.doesNotMatch(list.innerHTML, /<img/);
  assert.match(list.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(list.innerHTML, /saved-server-user">ann</);
});

test('the saved server list is hidden when no server has credentials', () => {
  const { sidebar, dom } = createSidebar();
  sidebar.servers = [{ id: 'srv-c', serverUrl: 'https://c.example.com' }];

  sidebar.renderServerList();

  assert.equal(dom.get('savedServerList').style.display, 'none');
});

test('escaping covers every character that matters in HTML and attributes', () => {
  const { sidebar } = createSidebar();

  assert.equal(
    sidebar.escapeHtml(`<a href="x">Tom & 'Jerry'</a>`),
    '&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;'
  );
  assert.equal(sidebar.escapeHtml(null), '');
  assert.equal(sidebar.escapeHtml(undefined), '');
  assert.equal(sidebar.escapeHtml(42), '42');
});

test('clicking a saved server switches to it', () => {
  const { sidebar, dom, messages, requests } = createSidebar({
    respond: () => new Promise(() => {}),
  });
  sidebar.servers = [serverA, serverB];
  sidebar.activeServerId = 'srv-a';
  sidebar.renderServerList();

  const itemB = dom
    .get('savedServerList')
    .querySelectorAll('.saved-server-item')
    .find((item) => item.dataset.serverId === 'srv-b');
  itemB.click();

  assert.deepEqual(messages('switch-server'), [{ serverId: 'srv-b' }]);
  assert.equal(sidebar.activeServerId, 'srv-b');
  assert.equal(requests[0].url, 'https://b.example.com/System/Info');
  assert.match(requests[0].options.headers.Authorization, /Token="token-b"/);
  assert.equal(dom.get('serverStatus').textContent, 'Connecting...');
  const items = dom.get('savedServerList').querySelectorAll('.saved-server-item');
  assert.equal(items.find((item) => item.classList.contains('active')).dataset.serverId, 'srv-b');
});

test('the remove button removes a saved server without switching to it', () => {
  const { sidebar, dom, posted, requests } = createSidebar();
  sidebar.servers = [serverA, serverB];
  sidebar.activeServerId = 'srv-a';
  sidebar.renderServerList();
  const list = dom.get('savedServerList');
  const removeA = list
    .querySelectorAll('.server-remove-btn')
    .find((button) => button.dataset.serverId === 'srv-a');
  const itemA = list
    .querySelectorAll('.saved-server-item')
    .find((item) => item.dataset.serverId === 'srv-a');

  // The click bubbles from the button to its item unless stopped.
  const { stopped } = removeA.click();
  itemA.click({ target: removeA });

  assert.equal(stopped, true);
  assert.deepEqual(
    posted.map((m) => [m.name, plain(m.data)]),
    [['remove-server', { serverId: 'srv-a' }]]
  );
  assert.equal(requests.length, 0);
  assert.equal(sidebar.activeServerId, 'srv-b', 'the next server becomes active');
  assert.deepEqual(
    list.querySelectorAll('.saved-server-item').map((item) => item.dataset.serverId),
    ['srv-b']
  );
});

test('removing the connected server disconnects the view', () => {
  const { sidebar, dom } = createSidebar();
  sidebar.servers = [serverA];
  sidebar.activeServerId = 'srv-a';
  sidebar.currentServer = { name: 'A', url: serverA.serverUrl, serverId: 'srv-a' };
  sidebar.currentUser = { Name: 'Ann' };

  sidebar.removeServerFromStorage('srv-a');

  assert.equal(sidebar.currentServer, null);
  assert.equal(sidebar.activeServerId, null);
  assert.equal(dom.get('serverStatus').textContent, 'Not connected');
  assert.equal(dom.get('savedServerList').style.display, 'none');
});

// --- Restoring saved sessions ---------------------------------------------

// A Jellyfin server that accepts `validToken` for every saved server.
function savedServerResponder(validToken = /^token-/) {
  return (method, url, options) => {
    if (!validToken.test(options.headers.Authorization.match(/Token="([^"]*)"/)?.[1] ?? '')) {
      return { status: 401, data: '' };
    }
    const host = new URL(url).hostname[0].toUpperCase();
    if (url.endsWith('/System/Info'))
      return { status: 200, data: { ServerName: `Server ${host}` } };
    if (url.endsWith('/Users/Me')) return { status: 200, data: { Id: `user-${host}`, Name: host } };
    throw new Error(`unexpected ${method} ${url}`);
  };
}

test('the first server list reconnects to the active saved server once', async () => {
  const { sidebar, dom, messages, requests, calls } = createSidebar({
    respond: savedServerResponder(),
  });

  sidebar.handleServersList({ servers: [serverA, serverB], activeServerId: 'srv-b' });
  await flush();

  assert.deepEqual(
    requests.map((r) => r.url),
    ['https://b.example.com/System/Info', 'https://b.example.com/Users/Me']
  );
  assert.equal(sidebar.currentServer.serverId, 'srv-b');
  assert.equal(sidebar.currentServer.name, 'Server B');
  assert.equal(dom.get('serverStatus').textContent, 'Connected to Server B as B');
  assert.equal(dom.get('logoutBtn').style.display, 'block');
  assert.ok(calls.includes('loadHomeTab'));
  assert.deepEqual(messages('store-session'), [
    {
      serverUrl: 'https://b.example.com',
      accessToken: 'token-b',
      serverName: 'Server B',
      userId: 'user-B',
      username: 'B',
    },
  ]);

  sidebar.handleServersList({ servers: [serverA, serverB], activeServerId: 'srv-a' });
  await flush();
  assert.equal(requests.length, 2, 'later lists do not reconnect');
});

test('without an active saved server the first signed-in one is restored', async () => {
  const { sidebar, requests } = createSidebar({ respond: savedServerResponder() });

  sidebar.handleServersList({
    servers: [{ id: 'srv-c', serverUrl: 'https://c.example.com' }, serverA, serverB],
  });
  await flush();

  assert.equal(requests[0].url, 'https://a.example.com/System/Info');
  assert.equal(sidebar.currentServer.serverId, 'srv-a');
});

test('a server list without credentials does not use up the automatic reconnect', async () => {
  const { sidebar, requests } = createSidebar({ respond: savedServerResponder() });

  sidebar.handleServersList({ servers: [] });
  sidebar.handleServersList({ servers: [{ id: 'srv-c', serverUrl: 'https://c.example.com' }] });
  sidebar.handleServersList(null);
  assert.equal(requests.length, 0);

  sidebar.handleServersList({ servers: [serverA], activeServerId: 'srv-a' });
  await flush();
  assert.equal(sidebar.currentServer.serverId, 'srv-a');
});

test('an expired saved session asks the user to log in to that server again', async () => {
  const { sidebar, dom, messages } = createSidebar({
    respond: savedServerResponder(/^valid$/),
  });

  await sidebar.connectToServer(serverA);

  assert.equal(sidebar.currentServer, null);
  assert.equal(dom.get('serverStatus').textContent, 'Session expired - please login again');
  assert.equal(dom.get('serverStatus').className, 'server-status error');
  assert.equal(dom.get('loginSection').style.display, 'block');
  assert.equal(dom.get('serverUrl').value, 'https://a.example.com');
  assert.equal(dom.get('qcServerUrl').value, 'https://a.example.com');
  assert.equal(messages('store-session').length, 0);
  assert.equal(sidebar.connectingServerId, null);
});

test('a saved server that cannot be reached is reported without opening the login form', async () => {
  const { sidebar, dom } = createSidebar({
    respond() {
      throw networkError();
    },
  });

  await sidebar.connectToServer(serverA);

  assert.equal(sidebar.currentServer, null);
  assert.equal(dom.get('serverStatus').textContent, 'Connection failed - check server');
  assert.notEqual(dom.get('loginSection').style.display, 'block');
  assert.equal(sidebar.connectingServerId, null);
});

test('a legacy session reconnects only while no saved servers are known', async () => {
  const session = {
    serverUrl: 'https://a.example.com',
    accessToken: 'token-a',
    serverId: 'srv-a',
  };

  const fresh = createSidebar({ respond: savedServerResponder() });
  fresh.sidebar.handleSessionAvailable({ serverUrl: 'https://a.example.com' });
  fresh.sidebar.handleSessionAvailable(null);
  assert.equal(fresh.requests.length, 0, 'a session without a token is ignored');

  fresh.sidebar.handleSessionAvailable(session);
  await flush();
  assert.equal(fresh.sidebar.currentServer.serverId, 'srv-a');
  assert.equal(fresh.sidebar.currentUser.Name, 'A');

  const withServers = createSidebar({ respond: savedServerResponder() });
  withServers.sidebar.servers = [serverB];
  withServers.sidebar.handleSessionAvailable(session);
  withServers.sidebar.handleSessionData(session);
  assert.equal(withServers.requests.length, 0);
});

test('stored session data reconnects when the plugin has no server list', async () => {
  const { sidebar, requests } = createSidebar({ respond: savedServerResponder() });

  sidebar.handleSessionData(null);
  assert.equal(requests.length, 0);

  sidebar.handleSessionData({ serverUrl: 'https://b.example.com', accessToken: 'token-b' });
  await flush();
  assert.equal(sidebar.currentServer.url, 'https://b.example.com');
});

test('clearing the stored session disconnects and empties the server list', () => {
  const { sidebar, dom } = createSidebar();
  sidebar.servers = [serverA];
  sidebar.activeServerId = 'srv-a';
  sidebar.currentServer = { name: 'A', url: serverA.serverUrl, serverId: 'srv-a' };
  sidebar.currentUser = { Name: 'Ann' };

  sidebar.handleSessionCleared();

  assert.deepEqual(plain(sidebar.servers), []);
  assert.equal(sidebar.currentServer, null);
  assert.equal(dom.get('serverStatus').textContent, 'Not connected');
  assert.equal(dom.get('savedServerList').style.display, 'none');
});

test('a switch made in the other view is followed here', async () => {
  const { sidebar, requests } = createSidebar({ respond: savedServerResponder() });
  sidebar.servers = [serverA, serverB];
  sidebar.currentServer = { name: 'A', url: serverA.serverUrl, serverId: 'srv-a' };
  sidebar.initialAutoConnectDone = true;

  sidebar.handleServerSwitched({ server: serverA, servers: [serverA, serverB] });
  assert.equal(requests.length, 0, 'already connected to that server');

  sidebar.handleServerSwitched({ server: serverB, servers: [serverA, serverB] });
  await flush();
  assert.equal(sidebar.currentServer.serverId, 'srv-b');

  sidebar.handleServerSwitched(null);
  sidebar.handleServerSwitched({});
  assert.equal(requests.length, 2);
});
