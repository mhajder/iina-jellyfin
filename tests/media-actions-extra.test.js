import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { loadCommonJs, runScript } from './helpers/load-commonjs.js';

const { createJellyfinApi } = loadCommonJs('src/lib/jellyfin-api.js');
const jellyfinApi = createJellyfinApi({ http: {}, preferences: { get() {} }, log() {} });

const ITEM = '0123456789abcdef0123456789abcdef';
const OTHER = 'fedcba9876543210fedcba9876543210';
const STREAM = `https://jf.example/Videos/${ITEM}/stream?static=true&ApiKey=K`;
const OTHER_STREAM = `https://jf.example/Videos/${OTHER}/stream?static=true&ApiKey=K`;

// The manager with the real URL parsing, an mpv that keeps a track list in
// step with sub-add, and a record of everything shown on screen.
function createManager({
  prefs: prefOverrides = {},
  mpv: mpvOverrides = {},
  status,
  ...deps
} = {}) {
  const context = vm.createContext({ module: { exports: {} }, setTimeout, clearTimeout });
  runScript('src/lib/media-actions.js', context);

  const prefs = { set_video_title: true, preferred_languages: 'en', ...prefOverrides };
  const osd = [];
  const logs = [];
  const downloads = [];
  const metadataRequests = [];
  const state = { title: '', titleSetLocally: false, tracks: [], nextId: 1, commands: [] };
  const mpv = {
    set(name, value) {
      if (name === 'force-media-title') state.title = value;
      if (name === 'sid') state.sid = value;
    },
    getString: (name) => (name === 'force-media-title' ? state.title : ''),
    getFlag: () => state.titleSetLocally,
    getNative: () => state.tracks.map((track) => ({ ...track })),
    command(name, args) {
      state.commands.push([name, ...args]);
      if (name === 'sub-add') {
        state.tracks.push({
          id: state.nextId++,
          type: 'sub',
          title: args[2],
          lang: args[3],
          'external-filename': args[0],
        });
      }
    },
    ...mpvOverrides,
  };
  const manager = context.module.exports.createMediaActionsManager({
    core: { osd: (text) => osd.push(text), status: status || {} },
    http: {
      download: async (url, path) => {
        downloads.push({ url, path });
      },
    },
    utils: { resolvePath: (path) => path.replace('@tmp/', '/tmp/') },
    preferences: { get: (key) => prefs[key] },
    mpv,
    parseJellyfinUrl: jellyfinApi.parseJellyfinUrl,
    isJellyfinUrl: jellyfinApi.isJellyfinUrl,
    fetchPlaybackInfo: async () => ({}),
    fetchItemMetadata: async (serverBase, itemId) => {
      metadataRequests.push(itemId);
      return { Name: 'Pilot' };
    },
    log: (message) => logs.push(message),
    ...deps,
  });
  return { manager, prefs, osd, logs, downloads, metadataRequests, state };
}

function sidecar(Index, extra = {}) {
  return {
    Type: 'Subtitle',
    IsTextSubtitleStream: true,
    IsExternal: true,
    Language: 'eng',
    Index,
    ...extra,
  };
}

function withStreams(...streams) {
  return async () => ({ MediaSources: [{ Id: 'ms', MediaStreams: streams }] });
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

test('a movie title includes its production year', async () => {
  const harness = createManager({
    prefs: { show_notifications: true },
    fetchItemMetadata: async () => ({ Name: 'Heat', Type: 'Movie', ProductionYear: 1995 }),
  });

  harness.manager.updateFromFileUrl(STREAM);
  await harness.manager.setVideoTitleFromMetadata('https://jf.example', ITEM, 'K');

  assert.equal(harness.state.title, 'Heat (1995)');
  assert.deepEqual(harness.osd, ['Title: Heat (1995)']);
});

test('a movie without a production year is titled by its name', async () => {
  const harness = createManager({
    fetchItemMetadata: async () => ({ Name: 'Heat', Type: 'Movie' }),
  });

  harness.manager.updateFromFileUrl(STREAM);
  await harness.manager.setVideoTitleFromMetadata('https://jf.example', ITEM, 'K');

  assert.equal(harness.state.title, 'Heat');
});

test('titles turned off fetch no metadata for the title', async () => {
  const harness = createManager({ prefs: { set_video_title: false } });

  await harness.manager.setVideoTitleFromMetadata('https://jf.example', ITEM, 'K');

  assert.deepEqual(harness.metadataRequests, []);
  assert.equal(harness.state.title, '');
});

test('metadata without a name sets no title', async () => {
  const harness = createManager({
    prefs: { show_notifications: true },
    fetchItemMetadata: async () => ({ Type: 'Movie' }),
  });

  harness.manager.updateFromFileUrl(STREAM);
  await harness.manager.setVideoTitleFromMetadata('https://jf.example', ITEM, 'K');

  assert.equal(harness.state.title, '');
  assert.deepEqual(harness.osd, []);
});

test('a failing metadata request for the title does not throw', async () => {
  const harness = createManager({
    fetchItemMetadata: async () => {
      throw new Error('offline');
    },
  });

  await assert.doesNotReject(
    harness.manager.setVideoTitleFromMetadata('https://jf.example', ITEM, 'K')
  );
  assert.equal(harness.state.title, '');
});

test('mpv refusing the title shows no title notification', async () => {
  const harness = createManager({
    prefs: { show_notifications: true },
    mpv: {
      set() {
        throw new Error('read-only');
      },
    },
  });

  await assert.doesNotReject(
    harness.manager.setVideoTitleFromMetadata('https://jf.example', ITEM, 'K')
  );
  assert.deepEqual(harness.osd, []);
});

test('an unreadable title does not throw when a local file follows', async () => {
  const harness = createManager({
    mpv: {
      getString() {
        throw new Error('no property');
      },
    },
  });
  harness.manager.updateFromFileUrl(STREAM);
  await harness.manager.setVideoTitleFromMetadata('https://jf.example', ITEM, 'K');

  assert.doesNotThrow(() => harness.manager.updateFromFileUrl('/Users/me/Movies/home.mp4'));
  assert.equal(harness.manager.getLastItemId(), null);
});

test('when mpv cannot say whether a title is per-file, the title is kept', async () => {
  const harness = createManager({
    mpv: {
      getFlag() {
        throw new Error('no option-info');
      },
    },
  });
  harness.manager.updateFromFileUrl(STREAM);
  await harness.manager.setVideoTitleFromMetadata('https://jf.example', ITEM, 'K');

  harness.manager.updateFromFileUrl(OTHER_STREAM);

  assert.equal(harness.state.title, 'Pilot');
});

test('a failing title lookup before loading leaves the title for after the load', async () => {
  const harness = createManager({
    fetchItemMetadata: async () => {
      throw new Error('offline');
    },
  });

  await assert.doesNotReject(harness.manager.applyTitleBeforeLoad(STREAM));
  assert.equal(harness.state.title, '');
});

test('each subtitle codec is downloaded with its own file extension', async () => {
  const codecs = ['subrip', 'webvtt', 'vtt', 'ass', 'ssa', 'srt_custom', 'x-vtt', 'mov_text'];
  const harness = createManager({
    prefs: { download_all_subtitles: true },
    fetchPlaybackInfo: withStreams(
      ...codecs.map((Codec, index) => sidecar(index, { Codec })),
      sidecar(codecs.length)
    ),
  });

  harness.manager.updateFromFileUrl(STREAM);
  await harness.manager.downloadAllSubtitles('https://jf.example', ITEM, 'K');

  assert.deepEqual(
    harness.downloads.map((download) => download.url.match(/stream\.(\w+)\?/)[1]),
    ['srt', 'vtt', 'vtt', 'ass', 'ssa', 'srt', 'vtt', 'srt', 'srt']
  );
});

test('a subtitle is saved under the item, the track and its server file name', async () => {
  const harness = createManager({
    prefs: { download_all_subtitles: true },
    fetchPlaybackInfo: withStreams(
      sidecar(3, { Path: 'C:\\Media\\Show\\Pilot (1).en.srt' }),
      sidecar(4, { Path: '/media/show/Pilot.en.srt' }),
      sidecar(5, { Language: 'en/US', Codec: 'ass' })
    ),
  });

  harness.manager.updateFromFileUrl(STREAM);
  await harness.manager.downloadAllSubtitles('https://jf.example', 'item:1', 'K');

  assert.deepEqual(
    harness.downloads.map((download) => download.path),
    [
      '@tmp/jellyfin_item_1_3_Pilot__1_.en.srt',
      '@tmp/jellyfin_item_1_4_Pilot.en.srt',
      '@tmp/jellyfin_item_1_5_en_US.ass',
    ]
  );
  assert.equal(
    harness.state.tracks[0]['external-filename'],
    '/tmp/jellyfin_item_1_3_Pilot__1_.en.srt'
  );
});

test('downloaded subtitles are announced when notifications are on', async () => {
  const harness = createManager({
    prefs: { show_notifications: true },
    fetchPlaybackInfo: withStreams(sidecar(1), sidecar(2, { Language: 'fre' })),
  });

  harness.manager.updateFromFileUrl(STREAM);
  await harness.manager.downloadAllSubtitles('https://jf.example', ITEM, 'K');

  assert.deepEqual(harness.osd, ['Loaded external eng subtitle', 'Downloaded 1 subtitle(s)']);
});

test('a failed subtitle download adds no track and the rest still load', async () => {
  const harness = createManager({
    prefs: { show_notifications: true },
    fetchPlaybackInfo: withStreams(sidecar(1), sidecar(2)),
    http: {
      download: async (url) => {
        if (url.includes('/Subtitles/1/')) throw new Error('404');
      },
    },
  });

  harness.manager.updateFromFileUrl(STREAM);
  await harness.manager.downloadAllSubtitles('https://jf.example', ITEM, 'K');

  assert.equal(harness.state.tracks.length, 1);
  assert.match(harness.state.tracks[0]['external-filename'], /_2_eng\.srt$/);
  assert.equal(harness.osd.at(-1), 'Downloaded 1 subtitle(s)');
});

test('when every download fails, no subtitles are reported found', async () => {
  const harness = createManager({
    prefs: { show_notifications: true },
    fetchPlaybackInfo: withStreams(sidecar(1)),
    http: {
      download: async () => {
        throw new Error('404');
      },
    },
  });

  harness.manager.updateFromFileUrl(STREAM);
  await harness.manager.downloadAllSubtitles('https://jf.example', ITEM, 'K');

  assert.deepEqual(harness.osd, ['No matching external subtitles found']);
});

test('playback info that arrives after the next file loaded starts no downloads', async () => {
  const info = deferred();
  const harness = createManager({ fetchPlaybackInfo: () => info.promise });

  harness.manager.updateFromFileUrl(STREAM);
  const pending = harness.manager.downloadAllSubtitles('https://jf.example', ITEM, 'K');
  harness.manager.invalidatePendingResults();
  info.resolve(await withStreams(sidecar(1))());
  await pending;

  assert.deepEqual(harness.downloads, []);
});

test('remaining subtitles are not downloaded once the next file loaded', async () => {
  const first = deferred();
  const harness = createManager({
    prefs: { download_all_subtitles: true },
    fetchPlaybackInfo: withStreams(sidecar(1), sidecar(2)),
    http: {
      download: (url) => {
        harness.downloads.push({ url });
        return first.promise;
      },
    },
  });

  harness.manager.updateFromFileUrl(STREAM);
  const pending = harness.manager.downloadAllSubtitles('https://jf.example', ITEM, 'K');
  await flush();
  harness.manager.invalidatePendingResults();
  first.resolve();
  await pending;

  assert.equal(harness.downloads.length, 1);
  assert.equal(harness.state.tracks.length, 0);
});

test('an item without media sources downloads nothing', async () => {
  const harness = createManager({ fetchPlaybackInfo: async () => ({ MediaSources: [] }) });

  harness.manager.updateFromFileUrl(STREAM);
  await harness.manager.downloadAllSubtitles('https://jf.example', ITEM, 'K');

  assert.deepEqual(harness.downloads, []);
});

test('a failing playback info request reports the failed download', async () => {
  const harness = createManager({
    prefs: { show_notifications: true },
    fetchPlaybackInfo: async () => {
      throw new Error('offline');
    },
  });

  harness.manager.updateFromFileUrl(STREAM);
  await assert.doesNotReject(harness.manager.downloadAllSubtitles('https://jf.example', ITEM, 'K'));

  assert.deepEqual(harness.osd, ['Failed to download subtitles']);
});

test('a manual download without Jellyfin media asks for a Jellyfin URL', () => {
  for (const status of [{}, { url: '/Users/me/Movies/home.mp4' }]) {
    const harness = createManager({ status });

    harness.manager.manualDownloadSubtitles();
    harness.manager.manualSetTitle();

    assert.deepEqual(harness.osd, [
      'No Jellyfin media detected. Please open a Jellyfin URL first.',
      'No Jellyfin media detected. Please open a Jellyfin URL first.',
    ]);
  }
});

test('an unreadable player status counts as no Jellyfin media', () => {
  const status = {
    get url() {
      throw new Error('no status');
    },
  };
  const harness = createManager({ status });

  harness.manager.manualDownloadSubtitles();

  assert.deepEqual(harness.osd, ['No Jellyfin media detected. Please open a Jellyfin URL first.']);
});

test('a manual download uses the Jellyfin item playing, including its version', async () => {
  const requests = [];
  const harness = createManager({
    fetchPlaybackInfo: async (serverBase, itemId, apiKey) => {
      requests.push([serverBase, itemId, apiKey]);
      return {
        MediaSources: [
          { Id: 'first', MediaStreams: [sidecar(1)] },
          { Id: 'second', MediaStreams: [sidecar(2)] },
        ],
      };
    },
  });

  harness.manager.updateFromFileUrl(`${STREAM}&MediaSourceId=second`);
  harness.manager.manualDownloadSubtitles();
  await flush();

  assert.deepEqual(harness.osd, ['Downloading subtitles...']);
  assert.deepEqual(requests, [['https://jf.example', ITEM, 'K']]);
  assert.deepEqual(
    harness.downloads.map((download) => download.url),
    [`https://jf.example/Videos/${ITEM}/second/Subtitles/2/stream.srt?ApiKey=K`]
  );
  // A manual download shows what it downloaded
  assert.equal(harness.state.sid, '1');
});

test('a manual title reads the Jellyfin URL IINA is playing when none was stored', async () => {
  const harness = createManager({ status: { url: STREAM } });

  harness.manager.manualSetTitle();
  await flush();

  assert.deepEqual(harness.osd, ['Fetching title...']);
  assert.deepEqual(harness.metadataRequests, [ITEM]);
  assert.equal(harness.state.title, 'Pilot');
  assert.equal(harness.manager.getLastItemId(), ITEM);
});

test('a manual action on a Jellyfin URL that cannot be parsed says so', () => {
  // A Jellyfin-looking stream with no api key cannot be used
  const harness = createManager({ status: { url: `https://jf.example/Videos/${ITEM}/stream` } });

  harness.manager.manualDownloadSubtitles();
  harness.manager.manualSetTitle();

  assert.deepEqual(harness.osd, [
    'Failed to parse Jellyfin URL - check console for details',
    'Failed to parse Jellyfin URL - check console for details',
  ]);
  assert.equal(harness.manager.getLastItemId(), null);
});

test('the last Jellyfin item is forgotten when a local file plays', () => {
  const harness = createManager();

  harness.manager.updateFromFileUrl(STREAM);
  assert.equal(harness.manager.getLastItemId(), ITEM);

  harness.manager.updateFromFileUrl('/Users/me/Movies/home.mp4');
  assert.equal(harness.manager.getLastItemId(), null);

  harness.manager.manualSetTitle();
  assert.deepEqual(harness.osd, ['No Jellyfin media detected. Please open a Jellyfin URL first.']);
});
