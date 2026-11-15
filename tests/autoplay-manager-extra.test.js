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
    // With playlist.entries, the playlist's file names are tracked too.
    mpv: {
      getNumber: (name) => (name === 'playlist-count' ? playlist.count : playlist.pos),
      getString(name) {
        const match = /^playlist\/(\d+)\/filename$/.exec(name);
        if (!match || !playlist.entries) throw new Error(`no ${name}`);
        return playlist.entries[Number(match[1])];
      },
      command(name, args) {
        if (name === 'loadfile') {
          loadfiles.push([...args]);
          playlist.count++;
          if (playlist.entries) playlist.entries.splice(playlist.pos + 1, 0, args[0]);
        }
        if (name === 'playlist-remove') {
          removed.push(args[0]);
          if (playlist.entries) {
            playlist.entries.splice(Number(args[0]), 1);
            playlist.count--;
          }
        }
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
    seasons: { S1: { Items: [episode(1), episode(2), episode(3)] } },
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
          episode(4, { Id: 'S2E4', Name: 'Back' }),
          episode(5, { Id: 'S2E5', Name: 'Return' }),
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

// A failed request says nothing about the season, so autoplay must not read it
// as the end of the season and skip the remaining episodes.
for (const [description, get] of [
  [
    'a failing episode request',
    async () => {
      throw new Error('offline');
    },
  ],
  ['an error status for the episode list', async () => ({ statusCode: 500, data: { Items: [] } })],
  ['an empty episode response', async () => ({ statusCode: 200, data: undefined })],
]) {
  test(`${description} does not skip to the next season`, async () => {
    const requests = [];
    const harness = createHarness({
      http: {
        get: async (url) => {
          requests.push(url);
          if (url.includes('/Seasons?')) {
            return {
              data: {
                Items: [
                  { Id: 'S1', Name: 'Season 1', IndexNumber: 1 },
                  { Id: 'S2', Name: 'Season 2', IndexNumber: 2 },
                ],
              },
            };
          }
          if (url.includes('seasonId=S2')) return { data: { Items: [episode(1, { Id: 'S2E1' })] } };
          return get(url);
        },
      },
    });

    await play(harness);

    assert.deepEqual(harness.loadfiles, []);
    assert.equal(harness.manager.isQueued(), false);
    assert.ok(!requests.some((url) => url.includes('/Seasons?')));
  });
}

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

  // Not in the season list: its missing IndexNumber counts as episode 0, so
  // the first episode is next.
  await play(harness, 'unlisted');

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

test('a next episode queued earlier is replaced, not queued twice', async () => {
  const harness = createHarness({
    playlist: { count: 1, pos: 0, entries: ['E1-url'] },
    seasons: { S1: { Items: [episode(1), episode(2), episode(3)] } },
  });

  await play(harness);
  // Played again (e.g. reopened from IINA's history) with E2 still queued,
  // but now with a different next episode.
  harness.manager.resetForNewFile('other');
  await play(harness, 'E2');

  assert.deepEqual(harness.removed, ['1']);
  assert.deepEqual(harness.playlist.entries, [
    'E1-url',
    `${SERVER}/Videos/E3/stream?static=true&ApiKey=key`,
  ]);
});

test("the viewer's own playlist plays as built: nothing removed, nothing pushed in front", async () => {
  const harness = createHarness({
    playlist: { count: 3, pos: 0, entries: ['E1-url', 'a.mkv', `${SERVER}/Videos/E7/stream`] },
    seasons: { S1: { Items: [episode(1), episode(2)] } },
  });

  await play(harness);

  assert.deepEqual(harness.removed, []);
  assert.deepEqual(harness.loadfiles, []);
  assert.equal(harness.manager.isQueued(), false);
});

test('an unreadable playlist entry after the current one is left alone', async () => {
  const harness = createHarness({
    playlist: { count: 2, pos: 0 },
    seasons: { S1: { Items: [episode(1), episode(2)] } },
  });

  await play(harness);

  assert.deepEqual(harness.loadfiles, []);
});

test('an episode the viewer already put next is not queued again', async () => {
  const harness = createHarness({
    playlist: { count: 2, pos: 0, entries: ['E1-url', `${SERVER}/Items/E2/Download?api_key=x`] },
    seasons: { S1: { Items: [episode(1), episode(2)] } },
  });

  await play(harness);

  assert.deepEqual(harness.loadfiles, []);
  assert.equal(harness.manager.isQueued(), true);
});

test('a special shown inside a season keeps its place and its own label', async () => {
  const harness = createHarness({
    prefs: { set_video_title: true },
    seasons: {
      // Airing order, as Jellyfin sends it: the special airs after E1.
      S1: {
        Items: [
          episode(1, { ParentIndexNumber: 1 }),
          episode(3, { Id: 'SP3', Name: 'Special', ParentIndexNumber: 0 }),
          episode(2, { ParentIndexNumber: 1 }),
        ],
      },
    },
  });

  await play(harness);

  assert.equal(harness.loadfiles[0][3], mediaTitleOption('Show S00E03 - Special'));
});

test('after a special played from inside a season, that season continues', async () => {
  const metadata = {
    E1: { SeasonId: 'S1', ParentIndexNumber: 1, IndexNumber: 1 },
    SP3: { SeasonId: 'specials', ParentIndexNumber: 0, IndexNumber: 3 },
  };
  const harness = createHarness({
    metadata: async (serverBase, itemId) => ({
      Type: 'Episode',
      SeriesId: 'series',
      SeriesName: 'Show',
      ...metadata[itemId],
    }),
    seasons: {
      S1: {
        Items: [
          episode(1, { ParentIndexNumber: 1 }),
          episode(3, { Id: 'SP3', ParentIndexNumber: 0 }),
          episode(2, { ParentIndexNumber: 1 }),
        ],
      },
      specials: { Items: [episode(3, { Id: 'SP3' }), episode(4, { Id: 'SP4' })] },
    },
  });

  await play(harness, 'E1');
  harness.playlist.pos = 1; // SP3 is playing now
  await play(harness, 'SP3');

  assert.match(harness.loadfiles[1][0], /\/Videos\/E2\//);
});

test('a season with nothing playable is skipped on the way to the next one', async () => {
  const harness = createHarness({
    seasons: {
      S1: { Items: [episode(1)] },
      S2: { Items: [episode(1, { Id: 'S2E1', MediaSources: [] })] },
      S3: { Items: [episode(1, { Id: 'S3E1', ParentIndexNumber: 3 })] },
    },
    seasonList: {
      Items: [
        { Id: 'S1', Name: 'Season 1', IndexNumber: 1 },
        { Id: 'S2', Name: 'Season 2', IndexNumber: 2 },
        { Id: 'S3', Name: 'Season 3', IndexNumber: 3 },
      ],
    },
  });

  await play(harness);

  assert.equal(harness.loadfiles.length, 1);
  assert.match(harness.loadfiles[0][0], /\/Videos\/S3E1\//);
});

test('the last special does not continue into season 1', async () => {
  const harness = createHarness({
    metadata: {
      Type: 'Episode',
      SeriesId: 'series',
      SeasonId: 'S0',
      ParentIndexNumber: 0,
      IndexNumber: 1,
    },
    seasons: { S0: { Items: [episode(1)] }, S1: { Items: [episode(1, { Id: 'S1E1' })] } },
    seasonList: {
      Items: [
        { Id: 'S0', Name: 'Specials', IndexNumber: 0 },
        { Id: 'S1', Name: 'Season 1', IndexNumber: 1 },
      ],
    },
  });

  await play(harness);

  assert.equal(harness.loadfiles.length, 0);
});

test('a lookup still running when its file ends queues nothing', async () => {
  const pending = [];
  const harness = createHarness({
    http: {
      get: (url) =>
        new Promise((resolve) => {
          pending.push(() => resolve({ data: { Items: [episode(1), episode(2)] } }));
          harness.requests.push(url);
        }),
    },
  });

  harness.manager.resetForNewFile('E1');
  harness.manager.setupAutoplayForEpisode(SERVER, 'E1', 'key');
  await flush();

  // The episode ends and a local file plays before the episode list arrives.
  harness.manager.cancelPendingSetup();
  pending[0]();
  await flush();

  assert.deepEqual(harness.loadfiles, []);
  assert.deepEqual(harness.removed, []);
});

test('a failing playlist removal still leaves the next episode queued', async () => {
  const entries = ['E1-url'];
  const loads = [];
  let failRemoval = false;
  const harness = createHarness({
    seasons: { S1: { Items: [episode(1), episode(2)] } },
    mpv: {
      getNumber: (name) => (name === 'playlist-count' ? entries.length : 0),
      getString: (name) => entries[Number(/^playlist\/(\d+)\//.exec(name)[1])],
      command(name, args) {
        if (name === 'playlist-remove') {
          if (failRemoval) throw new Error('busy');
          entries.splice(Number(args[0]), 1);
        }
        if (name === 'loadfile') {
          loads.push(args[0]);
          entries.splice(1, 0, args[0]);
        }
      },
    },
  });

  await play(harness);
  failRemoval = true;
  harness.manager.resetForNewFile('other');
  await play(harness);

  // The stale E2 could not be removed, but it is the next episode anyway.
  assert.equal(loads.length, 1);
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
