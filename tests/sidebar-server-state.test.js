import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function createClient(globals = {}) {
  const context = vm.createContext({ window: {}, ...globals });
  vm.runInContext(readFileSync('src/ui/sidebar/lib/auth-server-methods.js', 'utf8'), context);
  const methods = context.window.createSidebarAuthServerMethods(() => {});
  return {
    ...methods,
    servers: [],
    activeServerId: null,
    currentServer: null,
    disconnects: 0,
    renderServerList() {},
    disconnectFromServer() {
      this.disconnects++;
      this.currentServer = null;
    },
  };
}

test('removing a server signed in by password disconnects it', () => {
  const posted = [];
  const client = createClient({
    iina: { postMessage: (name, data) => posted.push({ name, data }) },
  });

  // State left by login() / authenticateWithQuickConnect(): no stored id yet.
  client.currentServer = {
    name: 'Home',
    url: 'https://jf.example.com',
    userId: 'user-1',
    accessToken: 'token',
  };

  // The plugin saves the session and answers with the stored entry.
  client.handleServersList({
    servers: [
      {
        id: 'srv-other',
        serverUrl: 'https://other.example.com',
        userId: 'user-1',
        accessToken: 'b',
      },
      { id: 'srv-1', serverUrl: 'https://jf.example.com/', userId: 'user-1', accessToken: 'token' },
    ],
    activeServerId: 'srv-1',
  });

  assert.equal(client.currentServer.serverId, 'srv-1');

  client.removeServerFromStorage('srv-1');

  assert.equal(client.disconnects, 1);
  assert.deepEqual(
    posted.map((message) => message.name),
    ['remove-server']
  );
});

test('a stored entry for another user on the same server is not adopted', () => {
  const client = createClient();
  client.currentServer = { url: 'https://jf.example.com', userId: 'user-1' };

  client.handleServersList({
    servers: [
      { id: 'srv-2', serverUrl: 'https://jf.example.com', userId: 'user-2', accessToken: 'x' },
    ],
    activeServerId: 'srv-2',
  });

  assert.equal(client.currentServer.serverId, undefined);
});

function createConnectingClient() {
  const pending = [];
  const posted = [];
  const client = createClient({
    iina: { postMessage: (name, data) => posted.push({ name, data }) },
  });
  Object.assign(client, {
    homeLoads: 0,
    updateServerStatus() {},
    hideLoginForm() {},
    showMainContent() {},
    showLogoutButton() {},
    showLoginFormWithServer() {},
    loadHomeTab() {
      this.homeLoads++;
    },
    getHttpClient() {
      return {
        get(url) {
          return new Promise((resolve) => pending.push({ url, resolve }));
        },
      };
    },
  });
  return { client, pending, posted };
}

const serverA = { id: 'srv-a', serverUrl: 'https://a.example.com', accessToken: 'token-a' };
const serverB = { id: 'srv-b', serverUrl: 'https://b.example.com', accessToken: 'token-b' };

async function respond(pending, urlPrefix, data) {
  const index = pending.findIndex((request) => request.url.startsWith(urlPrefix));
  assert.ok(index >= 0, `no pending request for ${urlPrefix}`);
  const [request] = pending.splice(index, 1);
  request.resolve({ status: 200, data });
  // Let connectToServer continue past its await.
  await new Promise((resolve) => setImmediate(resolve));
}

test('a slower response for the previous server does not override a switch', async () => {
  const { client, pending, posted } = createConnectingClient();
  client.servers = [serverA, serverB];

  client.switchToServer('srv-a');
  client.switchToServer('srv-b');

  await respond(pending, 'https://b.example.com/System/Info', { ServerName: 'B' });
  await respond(pending, 'https://b.example.com/Users/Me', { Id: 'user-b', Name: 'Bea' });
  await respond(pending, 'https://a.example.com/System/Info', { ServerName: 'A' });

  assert.equal(client.currentServer.serverId, 'srv-b');
  assert.equal(client.currentUser.Name, 'Bea');
  assert.equal(client.homeLoads, 1);
  assert.equal(pending.length, 0, 'the stale attempt must not continue to /Users/Me');
  assert.deepEqual(
    posted
      .filter((message) => message.name === 'store-session')
      .map((message) => message.data.serverUrl),
    ['https://b.example.com']
  );
});

test('the plugin echo of a switch does not start a second connection', async () => {
  const { client, pending } = createConnectingClient();
  client.servers = [serverA, serverB];

  client.switchToServer('srv-b');
  client.handleServerSwitched({
    server: serverB,
    servers: [serverA, serverB],
    activeServerId: 'srv-b',
  });

  assert.equal(pending.length, 1);

  await respond(pending, 'https://b.example.com/System/Info', { ServerName: 'B' });
  await respond(pending, 'https://b.example.com/Users/Me', { Id: 'user-b', Name: 'Bea' });

  // The other browser view, connected elsewhere, still follows the switch.
  const other = createConnectingClient();
  other.client.currentServer = { serverId: 'srv-a', url: serverA.serverUrl, userId: 'user-a' };
  other.client.handleServerSwitched({
    server: serverB,
    servers: [serverA, serverB],
    activeServerId: 'srv-b',
  });
  assert.equal(other.pending.length, 1);
  assert.ok(other.pending[0].url.startsWith('https://b.example.com/'));
});

test('the other view follows a switch back while it is still connecting', async () => {
  const { client, pending, posted } = createConnectingClient();
  client.servers = [serverA, serverB];
  client.currentServer = { serverId: 'srv-a', url: serverA.serverUrl, userId: 'user-a' };

  // The user picks B and then A again in the other view.
  client.handleServerSwitched({
    server: serverB,
    servers: [serverA, serverB],
    activeServerId: 'srv-b',
  });
  client.handleServerSwitched({
    server: serverA,
    servers: [serverA, serverB],
    activeServerId: 'srv-a',
  });

  await respond(pending, 'https://b.example.com/System/Info', { ServerName: 'B' });
  await respond(pending, 'https://a.example.com/System/Info', { ServerName: 'A' });
  await respond(pending, 'https://a.example.com/Users/Me', { Id: 'user-a', Name: 'Ann' });

  assert.equal(client.currentServer.serverId, 'srv-a');
  assert.deepEqual(
    posted
      .filter((message) => message.name === 'store-session')
      .map((message) => message.data.serverUrl),
    ['https://a.example.com']
  );
});

test('removing a server that is still connecting disconnects it', () => {
  const { client } = createConnectingClient();
  client.servers = [serverA, serverB];
  client.currentServer = { serverId: 'srv-a', url: serverA.serverUrl, userId: 'user-a' };

  client.switchToServer('srv-b');
  client.removeServerFromStorage('srv-b');

  assert.equal(client.disconnects, 1);
});

test('the view that switched twice ignores the echoes of both switches', async () => {
  const { client, pending, posted } = createConnectingClient();
  client.servers = [serverA, serverB];
  client.currentServer = { serverId: 'srv-a', url: serverA.serverUrl, userId: 'user-a' };

  client.switchToServer('srv-b');
  client.switchToServer('srv-a');
  const list = { servers: [serverA, serverB] };
  client.handleServerSwitched({ ...list, server: serverB, activeServerId: 'srv-b' });
  client.handleServerSwitched({ ...list, server: serverA, activeServerId: 'srv-a' });

  await respond(pending, 'https://b.example.com/System/Info', { ServerName: 'B' });
  await respond(pending, 'https://a.example.com/System/Info', { ServerName: 'A' });
  await respond(pending, 'https://a.example.com/Users/Me', { Id: 'user-a', Name: 'Ann' });

  assert.equal(pending.length, 0, 'no echo may start another connection');
  assert.equal(client.currentServer.serverId, 'srv-a');
  assert.deepEqual(
    posted.filter((m) => m.name === 'store-session').map((m) => m.data.serverUrl),
    ['https://a.example.com']
  );
});

test('removing a server still connecting keeps the server already connected', async () => {
  const { client, pending } = createConnectingClient();
  const statuses = [];
  client.updateServerStatus = (message) => statuses.push(message);
  client.servers = [serverA, serverB];
  client.currentServer = { name: 'A', serverId: 'srv-a', url: serverA.serverUrl, userId: 'user-a' };
  client.currentUser = { Name: 'Ann' };

  client.switchToServer('srv-b');
  client.removeServerFromStorage('srv-b');
  await respond(pending, 'https://b.example.com/System/Info', { ServerName: 'B' });

  assert.equal(client.disconnects, 0);
  assert.equal(client.currentServer.serverId, 'srv-a');
  assert.equal(pending.length, 0, 'the cancelled connect must not continue');
  assert.equal(statuses.at(-1), 'Connected to A as Ann');
});

test('a login only cancels connects that started before it', () => {
  const { client } = createConnectingClient();
  client.servers = [serverA, serverB];

  client.switchToServer('srv-a');
  const connectsAtStart = client.connectRequestCounter;
  client.cancelConnectsStartedBefore(connectsAtStart);
  assert.equal(client.connectingServerId, null);

  client.switchToServer('srv-b');
  const loginStart = client.connectRequestCounter;
  client.switchToServer('srv-a');
  client.cancelConnectsStartedBefore(loginStart);
  assert.equal(client.connectingServerId, 'srv-a');
});

test("another view's older switch does not override this view's newer one", async () => {
  const { client, pending } = createConnectingClient();
  const serverZ = { id: 'srv-z', serverUrl: 'https://z.example.com', accessToken: 'token-z' };
  const servers = [serverA, serverB, serverZ];
  client.servers = servers;
  client.currentServer = { serverId: 'srv-a', url: serverA.serverUrl, userId: 'user-a' };

  // The other view switched to Z just before this view switched to B.
  client.switchToServer('srv-b');
  client.handleServerSwitched({ servers, server: serverZ, activeServerId: 'srv-z' });
  client.handleServerSwitched({ servers, server: serverB, activeServerId: 'srv-b' });

  assert.equal(client.activeServerId, 'srv-b');
  assert.deepEqual(
    pending.map((request) => request.url),
    ['https://b.example.com/System/Info']
  );
});

test('removing a server still connecting points the plugin back at the connected one', () => {
  const { client, posted } = createConnectingClient();
  const serverC = { id: 'srv-c', serverUrl: 'https://c.example.com', accessToken: 'token-c' };
  client.servers = [serverC, serverA, serverB];
  client.currentServer = { name: 'A', serverId: 'srv-a', url: serverA.serverUrl, userId: 'user-a' };
  client.currentUser = { Name: 'Ann' };

  client.switchToServer('srv-b');
  client.removeServerFromStorage('srv-b');
  // The plugin falls back to its first server when the active one is removed.
  client.handleServersList({ servers: [serverC, serverA], activeServerId: 'srv-c' });

  assert.equal(client.activeServerId, 'srv-a');
  assert.deepEqual(
    posted.filter((m) => m.name === 'switch-server').map((m) => m.data.serverId),
    ['srv-b', 'srv-a']
  );
});

test('a server removed in the other view while connecting is not stored again', async () => {
  const { client, pending, posted } = createConnectingClient();
  client.servers = [serverA, serverB];

  client.switchToServer('srv-b');
  // The other browser view removed B; the plugin broadcasts the new list.
  client.handleServersList({ servers: [serverA], activeServerId: 'srv-a' });
  await respond(pending, 'https://b.example.com/System/Info', { ServerName: 'B' });

  assert.equal(pending.length, 0, 'the connect to the removed server must stop');
  assert.equal(posted.filter((m) => m.name === 'store-session').length, 0);
  assert.equal(client.disconnects, 1);
});

test('removing the connected server keeps the connect to the newly picked one', async () => {
  const { client, pending } = createConnectingClient();
  Object.assign(client, { clearAllMediaContent() {}, hideMainContent() {} });
  client.servers = [serverA, serverB];
  client.currentServer = { name: 'A', serverId: 'srv-a', url: serverA.serverUrl, userId: 'user-a' };
  client.currentUser = { Name: 'Ann' };

  client.switchToServer('srv-b');
  client.removeServerFromStorage('srv-a');
  await respond(pending, 'https://b.example.com/System/Info', { ServerName: 'B' });
  await respond(pending, 'https://b.example.com/Users/Me', { Id: 'user-b', Name: 'Bea' });

  assert.equal(client.disconnects, 0);
  assert.equal(client.currentServer.serverId, 'srv-b');
});

test('a fresh login is identified before a removed connect is abandoned', () => {
  const { client, posted } = createConnectingClient();
  client.servers = [serverA, serverB];
  client.switchToServer('srv-b');
  // A password login to A finished meanwhile; its stored id arrives with the list.
  client.currentServer = { name: 'A', url: serverA.serverUrl, userId: 'user-a' };
  client.currentUser = { Name: 'Ann' };
  const storedA = { ...serverA, userId: 'user-a' };
  const serverC = { id: 'srv-c', serverUrl: 'https://c.example.com', accessToken: 'token-c' };

  client.handleServersList({ servers: [serverC, storedA], activeServerId: 'srv-c' });

  assert.equal(client.currentServer.serverId, 'srv-a');
  assert.equal(client.activeServerId, 'srv-a');
  assert.equal(posted.filter((m) => m.name === 'switch-server').at(-1).data.serverId, 'srv-a');
});
