import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function loadSidebarMethods(file, factoryName, globals = {}) {
  const context = vm.createContext({ window: {}, ...globals });
  vm.runInContext(readFileSync(file, 'utf8'), context);
  return context.window[factoryName](() => {});
}

test('saved sessions reconnect with Jellyfin 12 authorization', async () => {
  const requests = [];
  const methods = loadSidebarMethods(
    'src/ui/sidebar/lib/auth-server-methods.js',
    'createSidebarAuthServerMethods'
  );
  const client = {
    ...methods,
    clientIdentity: {
      clientName: 'IINA Jellyfin Plugin',
      deviceName: 'IINA',
      deviceId: 'test-device',
      version: '0.7.2',
    },
    getHttpClient() {
      return {
        async get(url, options) {
          requests.push({ url, options });
          if (url.endsWith('/System/Info')) {
            return { status: 200, data: { ServerName: 'Test Jellyfin' } };
          }
          return { status: 200, data: { Id: 'user-id', Name: 'Test User' } };
        },
      };
    },
    updateServerStatus() {},
    hideLoginForm() {},
    showMainContent() {},
    showLogoutButton() {},
    loadHomeTab() {},
  };

  await client.connectToServer({
    id: 'server-id',
    serverUrl: 'https://media.example.com',
    accessToken: 'secret-token',
  });

  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.match(request.options.headers.Authorization, /^MediaBrowser /);
    assert.match(request.options.headers.Authorization, /Token="secret-token"/);
    assert.equal(request.options.headers['X-Emby-Token'], undefined);
  }
});

test('sidebar lists and media URLs use Jellyfin 12 credentials', async () => {
  const container = { innerHTML: '' };
  const requests = [];
  const authMethods = loadSidebarMethods(
    'src/ui/sidebar/lib/auth-server-methods.js',
    'createSidebarAuthServerMethods'
  );
  const mediaMethods = loadSidebarMethods(
    'src/ui/sidebar/lib/media-methods.js',
    'createSidebarMediaMethods',
    {
      document: {
        getElementById() {
          return container;
        },
      },
      URLSearchParams,
    }
  );
  const client = {
    ...authMethods,
    ...mediaMethods,
    clientIdentity: {
      clientName: 'IINA Jellyfin Plugin',
      deviceName: 'IINA',
      deviceId: 'test-device',
      version: '0.7.2',
    },
    currentServer: {
      url: 'https://media.example.com',
      accessToken: 'secret-token',
    },
    currentUser: { Id: 'user-id', Name: 'Test User' },
    getHttpClient() {
      return {
        async get(url, options) {
          requests.push({ url, options });
          return { status: 200, data: [] };
        },
      };
    },
    renderMediaList() {},
  };

  await client.loadRecentItems();

  assert.match(requests[0].options.headers.Authorization, /^MediaBrowser /);
  assert.match(requests[0].options.headers.Authorization, /Token="secret-token"/);
  assert.equal(requests[0].options.headers['X-Emby-Token'], undefined);
  assert.match(client.buildStreamUrl({ Id: 'item-id', Type: 'Episode' }), /[?&]ApiKey=/);
  assert.doesNotMatch(client.buildStreamUrl({ Id: 'item-id', Type: 'Episode' }), /api_key=/);
});

test('source contains no legacy Jellyfin credential transport', () => {
  const sourceFiles = [
    'src/lib/autoplay-manager.js',
    'src/lib/jellyfin-api.js',
    'src/lib/media-actions.js',
    'src/lib/playback-tracking.js',
    'src/ui/sidebar/lib/auth-server-methods.js',
    'src/ui/sidebar/lib/media-methods.js',
  ];

  for (const file of sourceFiles) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /X-Emby-Token/);
    assert.doesNotMatch(source, /[?&]api_key=/);
  }
});
