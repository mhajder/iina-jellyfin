import assert from 'node:assert/strict';
import test from 'node:test';
import { loadCommonJs } from './helpers/load-commonjs.js';

const { createJellyfinApi } = loadCommonJs('src/lib/jellyfin-api.js');

function createApi({ response, prefs = {} } = {}) {
  const requests = [];
  const syncs = [];
  const logs = [];
  const api = createJellyfinApi({
    http: {
      get: async (url, options) => {
        requests.push({ url, options });
        return typeof response === 'function' ? response(url) : response;
      },
    },
    preferences: {
      get: (key) => prefs[key],
      set: (key, value) => (prefs[key] = value),
      sync: () => syncs.push(true),
    },
    log: (message) => logs.push(message),
  });
  return { api, prefs, requests, syncs, logs };
}

const ITEM = '0123456789abcdef0123456789abcdef';

test('a device id is created once and reused for every request', () => {
  const { api, prefs, syncs } = createApi();

  const first = api.getClientIdentity();
  const second = api.getClientIdentity();

  assert.match(first.deviceId, /^iina-jellyfin-\d+-\d+$/);
  assert.equal(second.deviceId, first.deviceId);
  assert.equal(prefs.jellyfin_device_id, first.deviceId);
  assert.equal(syncs.length, 1);
});

test('the client identity matches the Authorization header', () => {
  const { api } = createApi({ prefs: { jellyfin_device_id: 'device-1' } });

  const identity = api.getClientIdentity();
  const header = api.buildJellyfinHeaders('token').Authorization;

  assert.equal(identity.clientName, 'IINA Jellyfin Plugin');
  assert.equal(identity.deviceName, 'IINA');
  assert.equal(identity.deviceId, 'device-1');
  assert.match(identity.version, /^\d+\.\d+\.\d+/);
  assert.equal(
    header,
    `MediaBrowser Client="IINA Jellyfin Plugin", Device="IINA", DeviceId="device-1", Version="${identity.version}", Token="token"`
  );
});

test('headers without a token leave it out and keep the extra headers', () => {
  const { api } = createApi({ prefs: { jellyfin_device_id: 'device-1' } });

  const headers = api.buildJellyfinHeaders(null, { Accept: 'application/json' });

  assert.doesNotMatch(headers.Authorization, /Token=/);
  assert.equal(headers.Accept, 'application/json');
  assert.deepEqual([...Object.keys(api.buildJellyfinHeaders('t'))], ['Authorization']);
});

test('URLs that are empty or not http are not parsed', () => {
  const { api } = createApi();

  assert.equal(api.parseJellyfinUrl(''), null);
  assert.equal(api.parseJellyfinUrl(null), null);
  assert.equal(api.parseJellyfinUrl(`file:///Videos/${ITEM}/stream?api_key=K`), null);
});

test('a Jellyfin URL without an api key is not parsed', () => {
  const { api } = createApi();

  assert.equal(api.parseJellyfinUrl(`https://jf.example/Videos/${ITEM}/stream`), null);
  assert.equal(api.parseJellyfinUrl(`https://jf.example/Videos/${ITEM}/stream?static=true`), null);
});

test('a URL without a media route is not parsed', () => {
  const { api } = createApi();

  assert.equal(api.parseJellyfinUrl('https://jf.example/web/index.html?api_key=K'), null);
});

test('an api key spelled any of the accepted ways is read and decoded', () => {
  const { api } = createApi();
  const base = `https://jf.example/Videos/${ITEM}/stream?static=true`;

  for (const param of ['api_key', 'ApiKey', 'api-key', 'X-Emby-Token']) {
    assert.equal(api.parseJellyfinUrl(`${base}&${param}=a%2Fb`).apiKey, 'a/b', param);
  }
  assert.equal(
    api.parseJellyfinUrl(`https://jf.example/Items/${ITEM}/Download?api_key=K`).apiKey,
    'K'
  );
});

test('a malformed escape in the URL is not parsed and does not throw', () => {
  const { api } = createApi();

  assert.equal(
    api.parseJellyfinUrl(`https://jf.example/Videos/${ITEM}/stream?api_key=%E0%A4%A`),
    null
  );
});

test('URLs on a Jellyfin host or with Jellyfin routes count as Jellyfin', () => {
  const { api } = createApi();

  assert.equal(api.isJellyfinUrl('https://jellyfin.example/anything'), true);
  assert.equal(api.isJellyfinUrl('https://media.example/Audio/song/stream'), true);
  assert.equal(api.isJellyfinUrl('https://media.example/Videos/movie/stream'), true);
  assert.equal(api.isJellyfinUrl('https://media.example/Items/abc/Download?ApiKey=K'), true);
  assert.equal(api.isJellyfinUrl('https://media.example/Items/abc/Download'), false);
  assert.equal(api.isJellyfinUrl(''), false);
  assert.equal(api.isJellyfinUrl(undefined), false);
});

for (const [name, fetch] of [
  ['playback info', 'fetchPlaybackInfo'],
  ['item metadata', 'fetchItemMetadata'],
]) {
  test(`${name} already parsed by IINA is returned as is`, async () => {
    const data = { Name: 'Movie', MediaSources: [{ Id: 'ms' }] };
    const { api } = createApi({ response: { statusCode: 200, data } });

    assert.equal(await api[fetch]('https://jf', 'item', 'key'), data);
  });

  test(`${name} received as text is parsed`, async () => {
    const { api } = createApi({ response: { statusCode: 200, data: '{"Name":"Movie"}' } });

    const result = await api[fetch]('https://jf', 'item', 'key');

    assert.equal(result.Name, 'Movie');
  });

  test(`${name} with an empty response is a failed request`, async () => {
    const { api } = createApi({ response: { statusCode: 200, data: '' } });

    await assert.rejects(api[fetch]('https://jf', 'item', 'key'), /No (data|metadata) received/);
  });

  test(`${name} that is not valid JSON is a failed request`, async () => {
    const { api } = createApi({ response: { statusCode: 200, data: '<html>' } });

    await assert.rejects(api[fetch]('https://jf', 'item', 'key'), { name: 'SyntaxError' });
  });

  test(`${name} that fails to send is a failed request`, async () => {
    const { api } = createApi({
      response: () => {
        throw new Error('offline');
      },
    });

    await assert.rejects(api[fetch]('https://jf', 'item', 'key'), /offline/);
  });
}

test('playback info and metadata are requested for the item with its key', async () => {
  const { api, requests } = createApi({
    response: { statusCode: 200, data: {} },
    prefs: { jellyfin_device_id: 'device-1' },
  });

  await api.fetchPlaybackInfo('https://jf/sub', 'item-1', 'key-1');
  await api.fetchItemMetadata('https://jf/sub', 'item-1', 'key-1');

  assert.deepEqual(
    requests.map((request) => request.url),
    [
      'https://jf/sub/Items/item-1/PlaybackInfo?ApiKey=key-1',
      'https://jf/sub/Items/item-1?ApiKey=key-1',
    ]
  );
  for (const request of requests) {
    assert.match(request.options.headers.Authorization, /Token="key-1"/);
    assert.equal(request.options.headers.Accept, 'application/json');
  }
});

test('seconds and Jellyfin ticks convert both ways', () => {
  const { api } = createApi();

  assert.equal(api.secondsToTicks(1.5), 15000000);
  assert.equal(api.secondsToTicks(0.00000001), 0);
  assert.equal(api.ticksToSeconds(15000000), 1.5);
  assert.equal(api.ticksToSeconds(api.secondsToTicks(2400)), 2400);
});
