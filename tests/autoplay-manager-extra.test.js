import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { loadCommonJs, runScript } from './helpers/load-commonjs.js';

const { mediaTitleOption } = loadCommonJs('src/lib/media-actions.js');

const SERVER = 'https://jf.example';

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

function episode(number, extra = {}) {
  return {
    Id: `E${number}`,
    Name: `Episode ${number}`,
    IndexNumber: number,
    MediaSources: [{}],
    ...extra,
  };
}

// A series served by a fake Jellyfin. `seasons` maps a season id to the
// episodes response for it; `seasonList` is the /Seasons response.
function createHarness({
  metadata = {
    Type: 'Episode',
    SeriesId: 'series',
    SeasonId: 'S1',
    SeriesName: 'Show',
    ParentIndexNumber: 1,
    IndexNumber: 1,
  },
  seasons = {},
  seasonList = { Items: [] },
  playlist = { count: 1, pos: 0 },
  prefs = {},
  mpv = {},
  http,
} = {}) {
  const loadfiles = [];
  const removed = [];
  const osd = [];
  const requests = [];
  const logs = [];
  const context = vm.createContext({ module: { exports: {} } });
  runScript('src/lib/autoplay-manager.js', context);
  const manager = context.module.exports.createAutoplayManager({
    http: http || {
      get: async (url) => {
        requests.push(url);
        if (url.includes('/Seasons?')) return { data: seasonList };
        const seasonId = decodeURIComponent(/seasonId=([^&]+)/.exec(url)[1]);
        return { data: seasons[seasonId] };
      },
    },
    mpv: {
      getNumber: (name) => (name === 'playlist-count' ? playlist.count : playlist.pos),
      command(name, args) {
        if (name === 'loadfile') {
          loadfiles.push([...args]);
          playlist.count++;
        }
        if (name === 'playlist-remove') removed.push(args[0]);
      },
      ...mpv,
    },
    core: { osd: (message) => osd.push(message) },
    preferences: { get: (key) => prefs[key] },
    buildJellyfinHeaders: () => ({}),
    fetchItemMetadata: typeof metadata === 'function' ? metadata : async () => metadata,
    mediaTitleOption,
    log: (message) => logs.push(message),
  });
  return { manager, loadfiles, removed, osd, requests, logs, playlist };
}

async function play(harness, episodeId = 'E1') {
  harness.manager.resetForNewFile(episodeId);
  harness.manager.setupAutoplayForEpisode(SERVER, episodeId, 'key');
  await flush();
}

test('the next episode in the season is queued after the current one', async () => {
  const harness = createHarness({
    seasons: { S1: { Items: [episode(2), episode(1), episode(3)] } },
  });

  await play(harness);

  assert.deepEqual(harness.loadfiles, [
    [`${SERVER}/Videos/E2/stream?static=true&ApiKey=key`, 'insert-next'],
  ]);
  assert.equal(harness.manager.isQueued(), true);
});

test('episodes without a media source are never queued', async () => {
  const harness = createHarness({
    seasons: { S1: { Items: [episode(1), episode(2, { MediaSources: [] }), episode(3)] } },
  });

  await play(harness);

  assert.match(harness.loadfiles[0][0], /\/Videos\/E3\//);
});

test('an episode list sent as text is parsed', async () => {
  const harness = createHarness({
    seasons: { S1: JSON.stringify({ Items: [episode(1), episode(2)] }) },
  });

  await play(harness);

  assert.match(harness.loadfiles[0][0], /\/Videos\/E2\//);
});

test('after the last episode of a season the next season starts', async () => {
  const harness = createHarness({
    prefs: { set_video_title: true },
    seasons: {
      S1: { Items: [episode(1)] },
      S2: {
        Items: [
          episode(5, { Id: 'S2E5', Name: 'Return' }),
          episode(4, { Id: 'S2E4', Name: 'Back' }),
        ],
      },
    },
    seasonList: JSON.stringify({
      Items: [
        { Id: 'S2', Name: 'Season 2', IndexNumber: 2 },
        { Id: 'extras', Name: 'Unnumbered', IndexNumber: null },
        { Id: 'S1', Name: 'Season 1', IndexNumber: 1 },
        { Id: 'S0', Name: 'Specials', IndexNumber: 0 },
      ],
    }),
  });

  await play(harness);

  assert.equal(harness.loadfiles.length, 1);
  assert.match(harness.loadfiles[0][0], /\/Videos\/S2E4\//);
  assert.equal(harness.loadfiles[0][3], mediaTitleOption('Show S02E04 - Back'));
});

test('the last episode of the last season queues nothing', async () => {
  const harness = createHarness({
    seasons: { S1: { Items: [episode(1)] } },
    seasonList: { Items: [{ Id: 'S1', Name: 'Season 1', IndexNumber: 1 }] },
  });

  await play(harness);

  assert.equal(harness.loadfiles.length, 0);
  assert.equal(harness.manager.isQueued(), false);
});

test('a season missing from the season list queues nothing', async () => {
  const harness = createHarness({
    seasons: { S1: { Items: [episode(1)] } },
    seasonList: { Items: [{ Id: 'S2', Name: 'Season 2', IndexNumber: 2 }] },
  });

  await play(harness);

  assert.equal(harness.loadfiles.length, 0);
});

test('a next season without playable episodes queues nothing', async () => {
  const harness = createHarness({
    seasons: { S1: { Items: [episode(1)] }, S2: { Items: [episode(1, { MediaSources: [] })] } },
    seasonList: {
      Items: [
        { Id: 'S1', Name: 'Season 1', IndexNumber: 1 },
        { Id: 'S2', Name: 'Season 2', IndexNumber: 2 },
      ],
    },
  });

  await play(harness);

  assert.equal(harness.loadfiles.length, 0);
});

for (const [description, seasonList] of [
  ['an empty season response', ''],
  ['a season list without seasons', { Items: [] }],
  ['a season response without a list', {}],
]) {
  test(`${description} at the end of a season queues nothing`, async () => {
    const harness = createHarness({ seasons: { S1: { Items: [episode(1)] } }, seasonList });

    await play(harness);

    assert.equal(harness.loadfiles.length, 0);
  });
}

test('a failing season request queues nothing', async () => {
  const harness = createHarness({
    http: {
      get: async (url) => {
        if (url.includes('/Seasons?')) throw new Error('offline');
        return { data: { Items: [episode(1)] } };
      },
    },
  });

  await play(harness);

  assert.equal(harness.loadfiles.length, 0);
});

test('an episode response without a list is treated as a season with no episodes', async () => {
  const harness = createHarness({ seasons: { S1: {} } });

  await play(harness);

  assert.equal(harness.loadfiles.length, 0);
  assert.ok(harness.requests.some((url) => url.includes('/Seasons?')));
});

test('an item that is not an episode gets no autoplay', async () => {
  const harness = createHarness({ metadata: { Type: 'Movie' } });

  await play(harness);

  assert.equal(harness.requests.length, 0);
});

test('an episode without its series or season gets no autoplay', async () => {
  for (const metadata of [
    { Type: 'Episode', SeasonId: 'S1', IndexNumber: 1 },
    { Type: 'Episode', SeriesId: 'series', IndexNumber: 1 },
  ]) {
    const harness = createHarness({ metadata });

    await play(harness);

    assert.equal(harness.requests.length, 0);
  }
});

test('a failing metadata lookup gets no autoplay', async () => {
  const harness = createHarness({
    metadata: async () => {
      throw new Error('offline');
    },
  });

  await play(harness);

  assert.equal(harness.requests.length, 0);
  assert.equal(harness.loadfiles.length, 0);
});

test('an episode title without a series name is just the code and the name', async () => {
  const harness = createHarness({
    prefs: { set_video_title: true },
    metadata: {
      Type: 'Episode',
      SeriesId: 'series',
      SeasonId: 'S1',
      ParentIndexNumber: 0,
      IndexNumber: 1,
    },
    seasons: { S1: { Items: [episode(1), episode(2)] } },
  });

  await play(harness);

  // Specials keep season 0
  assert.equal(harness.loadfiles[0][3], mediaTitleOption('S00E02 - Episode 2'));
});

test('an episode without a season number is labelled season 1', async () => {
  const harness = createHarness({
    prefs: { set_video_title: true },
    metadata: { Type: 'Episode', SeriesId: 'series', SeasonId: 'S1', SeriesName: 'Show' },
    seasons: { S1: { Items: [episode(1), episode(2)] } },
  });

  await play(harness);

  // No IndexNumber counts as episode 0, so the first episode is next
  assert.equal(harness.loadfiles[0][3], mediaTitleOption('Show S01E01 - Episode 1'));
});

test('notifications announce the queued episode', async () => {
  const harness = createHarness({
    prefs: { show_notifications: true },
    seasons: { S1: { Items: [episode(1), episode(2)] } },
  });

  await play(harness);

  assert.deepEqual(harness.osd, ['Up next: Show S01E02 - Episode 2']);
});

test('stale entries after the current one are removed before queuing', async () => {
  const harness = createHarness({
    playlist: { count: 4, pos: 1 },
    seasons: { S1: { Items: [episode(1), episode(2)] } },
  });

  await play(harness);

  assert.deepEqual(harness.removed, ['3', '2']);
  assert.equal(harness.loadfiles.length, 1);
});

test('a failing playlist removal does not stop the episode from being queued', async () => {
  const harness = createHarness({
    playlist: { count: 3, pos: 0 },
    seasons: { S1: { Items: [episode(1), episode(2)] } },
    mpv: {
      command(name, args) {
        if (name === 'playlist-remove') throw new Error('busy');
        if (name === 'loadfile') harness.loadfiles.push([...args]);
      },
    },
  });

  await play(harness);

  assert.equal(harness.loadfiles.length, 1);
  assert.equal(harness.manager.isQueued(), true);
});

test('an unknown playlist position leaves the playlist alone and still queues', async () => {
  const harness = createHarness({
    playlist: { count: 3, pos: -1 },
    seasons: { S1: { Items: [episode(1), episode(2)] } },
  });

  await play(harness);

  assert.deepEqual(harness.removed, []);
  assert.equal(harness.loadfiles.length, 1);
});

test('an unreadable playlist still queues the next episode', async () => {
  const harness = createHarness({
    seasons: { S1: { Items: [episode(1), episode(2)] } },
    mpv: {
      getNumber() {
        throw new Error('no playlist');
      },
    },
  });

  await play(harness);

  assert.equal(harness.loadfiles.length, 1);
  assert.equal(harness.manager.isQueued(), true);
});

test('a failing loadfile leaves nothing marked as queued', async () => {
  const harness = createHarness({
    seasons: { S1: { Items: [episode(1), episode(2)] } },
    mpv: {
      command(name) {
        if (name === 'loadfile') throw new Error('mpv refused');
      },
    },
  });

  await play(harness);

  assert.equal(harness.manager.isQueued(), false);
});

test('an episode switched away from while its next one was resolving queues nothing', async () => {
  const pending = [];
  const harness = createHarness({
    http: {
      get: (url) =>
        new Promise((resolve) => {
          pending.push(() => resolve({ data: { Items: [episode(1), episode(2), episode(3)] } }));
          harness.requests.push(url);
        }),
    },
  });

  harness.manager.resetForNewFile('E1');
  harness.manager.setupAutoplayForEpisode(SERVER, 'E1', 'key');
  await flush();
  assert.equal(pending.length, 1);

  // The viewer opens another episode before the first episode list arrives
  harness.manager.resetForNewFile('E2');
  harness.manager.setupAutoplayForEpisode(SERVER, 'E2', 'key');
  await flush();

  pending[0]();
  await flush();
  assert.equal(harness.loadfiles.length, 0);

  pending[1]();
  await flush();
  assert.equal(harness.loadfiles.length, 1);
});

test('an unreadable playlist on a repeated load sets the episode up again', async () => {
  let readable = true;
  const requests = [];
  const harness = createHarness({
    metadata: async (serverBase, itemId) => {
      requests.push(itemId);
      return { Type: 'Movie' };
    },
    mpv: {
      getNumber(name) {
        if (!readable) throw new Error('no playlist');
        return name === 'playlist-count' ? 2 : 0;
      },
    },
  });

  await play(harness, 'E1');
  readable = false;
  await play(harness, 'E1');

  assert.deepEqual(requests, ['E1', 'E1']);
});

test('clearing the queued flag marks nothing as queued', async () => {
  const harness = createHarness({ seasons: { S1: { Items: [episode(1), episode(2)] } } });

  await play(harness);
  assert.equal(harness.manager.isQueued(), true);

  harness.manager.clearQueuedFlag();

  assert.equal(harness.manager.isQueued(), false);
});
