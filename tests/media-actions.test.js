import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { loadCommonJs, runScript } from './helpers/load-commonjs.js';

function loadMediaActions(deps = {}, globals = {}) {
  const context = vm.createContext({
    module: { exports: {} },
    setTimeout,
    clearTimeout,
    ...globals,
  });
  runScript('src/lib/media-actions.js', context);

  const calls = { mpvCommand: [], mpvSet: [], title: '', titleSetLocally: false };
  const prefs = { set_video_title: true, preferred_languages: 'en' };
  const manager = context.module.exports.createMediaActionsManager({
    core: {
      osd() {},
      status: {},
    },
    http: { download: async () => {} },
    utils: { resolvePath: (path) => path },
    preferences: { get: (key) => prefs[key] },
    mpv: {
      set(name, value) {
        calls.mpvSet.push([name, value]);
        if (name === 'force-media-title') calls.title = value;
      },
      getString: (name) => (name === 'force-media-title' ? calls.title : ''),
      getFlag: (name) =>
        name === 'option-info/force-media-title/set-locally' ? calls.titleSetLocally : false,
      getNative: () => [],
      command: (name, args) => calls.mpvCommand.push([name, args]),
    },
    parseJellyfinUrl: (url) => {
      const match = /\/Videos\/([^/]+)\//.exec(url);
      return match ? { serverBase: 'https://jf', itemId: match[1], apiKey: 'K' } : null;
    },
    isJellyfinUrl: (url) => /^https?:\/\//.test(url) && url.includes('/Videos/'),
    fetchPlaybackInfo: async () => ({}),
    fetchItemMetadata: async () => ({}),
    log() {},
    ...deps,
  });
  return { manager, calls };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

const E01 = 'https://jf/Videos/e01/stream?ApiKey=K';
const E02 = 'https://jf/Videos/e02/stream?ApiKey=K';

test('subtitles that finish after the next file loaded are not attached to it', async () => {
  const download = deferred();
  const { manager, calls } = loadMediaActions({
    http: { download: () => download.promise },
    fetchPlaybackInfo: async () => ({
      MediaSources: [
        {
          Id: 'ms',
          MediaStreams: [
            {
              Type: 'Subtitle',
              IsTextSubtitleStream: true,
              IsExternal: true,
              Language: 'en',
              Index: 2,
            },
          ],
        },
      ],
    }),
  });

  manager.updateFromFileUrl(E01);
  const pending = manager.downloadAllSubtitles('https://jf', 'e01', 'K');
  await new Promise((r) => setImmediate(r));
  manager.updateFromFileUrl(E02);
  download.resolve();
  await pending;

  assert.deepEqual(calls.mpvCommand, []);
});

test('a title that arrives after the next file loaded is not applied to it', async () => {
  const metadata = deferred();
  const { manager, calls } = loadMediaActions({
    fetchItemMetadata: () => metadata.promise,
  });

  manager.updateFromFileUrl(E01);
  const pending = manager.setVideoTitleFromMetadata('https://jf', 'e01', 'K');
  manager.updateFromFileUrl(E02);
  metadata.resolve({ Name: 'Pilot' });
  await pending;

  assert.equal(
    calls.mpvSet.some(([, value]) => value === 'Pilot'),
    false
  );
});

test('a title for the file still playing is applied', async () => {
  const { manager, calls } = loadMediaActions({
    fetchItemMetadata: async () => ({ Name: 'Pilot' }),
  });

  manager.updateFromFileUrl(E01);
  await manager.setVideoTitleFromMetadata('https://jf', 'e01', 'K');

  assert.equal(calls.title, 'Pilot');
});

test('a local file played after a Jellyfin item does not keep its title', async () => {
  const { manager, calls } = loadMediaActions({
    fetchItemMetadata: async () => ({ Name: 'Pilot' }),
  });

  manager.updateFromFileUrl(E01);
  await manager.setVideoTitleFromMetadata('https://jf', 'e01', 'K');
  manager.updateFromFileUrl('/Users/me/Movies/home.mp4');

  assert.equal(calls.title, '');
});

test('a title another script set for the next file is left alone', async () => {
  const { manager, calls } = loadMediaActions({
    fetchItemMetadata: async () => ({ Name: 'Pilot' }),
  });

  manager.updateFromFileUrl(E01);
  await manager.setVideoTitleFromMetadata('https://jf', 'e01', 'K');
  // ytdl_hook sets a file-local title while the YouTube URL loads
  calls.title = 'Some YouTube video';
  manager.updateFromFileUrl('https://www.youtube.com/watch?v=abc');
  assert.equal(calls.title, 'Some YouTube video');

  // When that file ends mpv restores the plugin's title; the next file clears it
  calls.title = 'Pilot';
  manager.updateFromFileUrl('/Users/me/Movies/home.mp4');
  assert.equal(calls.title, '');
});

test('a Jellyfin-looking URL that cannot be parsed does not keep the old title', () => {
  const { manager, calls } = loadMediaActions();

  manager.setTitleForNextItem('Pilot', E02);
  manager.updateFromFileUrl('https://jellyfin.org/Videos/demo.mp4');

  assert.equal(calls.title, '');
});

test('loading a Jellyfin stream keeps the title set before opening it', () => {
  const { manager, calls } = loadMediaActions();

  manager.setTitleForNextItem('Pilot', E02);
  manager.updateFromFileUrl(E02);

  assert.equal(calls.title, 'Pilot');
});

test('the title set before opening is set again if mpv restored an older one', () => {
  const { manager, calls } = loadMediaActions();

  manager.setTitleForNextItem('Episode 1', E01);
  manager.updateFromFileUrl(E01);
  manager.setTitleForNextItem('Episode 2', E02);
  // The old file had a per-file title, so mpv restores its backup on end
  calls.title = 'Episode 1';
  manager.updateFromFileUrl(E02);

  assert.equal(calls.title, 'Episode 2');
});

test('a title mpv restored after an autoplayed episode is still cleared', () => {
  const { manager, calls } = loadMediaActions();

  manager.setTitleForNextItem('Episode 1', E01);
  manager.updateFromFileUrl(E01);
  manager.setTitleForNextItem('Episode 2', E02);
  manager.updateFromFileUrl(E02);
  // Episode 2 played with a per-file title; mpv restored Episode 1 after it
  calls.title = 'Episode 1';
  manager.updateFromFileUrl('/Users/me/Movies/home.mp4');

  assert.equal(calls.title, '');
});

test('a queued item whose per-file title matches a plugin title keeps it', () => {
  const { manager, calls } = loadMediaActions();

  manager.setTitleForNextItem('Episode 1', E01);
  manager.updateFromFileUrl(E01);
  manager.setTitleForNextItem('Episode 2', E02);
  manager.updateFromFileUrl(E02);
  // E01 reopened, then autoplay loads E02 with per-file title 'Episode 2'
  manager.setTitleForNextItem('Episode 1', E01);
  manager.updateFromFileUrl(E01);
  calls.title = 'Episode 2';
  calls.titleSetLocally = true;
  manager.updateFromFileUrl(E02);
  assert.equal(calls.title, 'Episode 2');

  // When E02 ends mpv restores 'Episode 1'; a local file must still clear it
  calls.title = 'Episode 1';
  calls.titleSetLocally = false;
  manager.updateFromFileUrl('/Users/me/Movies/home.mp4');
  assert.equal(calls.title, '');
});

test('a Jellyfin URL opened without a title does not keep the previous one', async () => {
  const { manager, calls } = loadMediaActions({
    fetchItemMetadata: async () => {
      throw new Error('offline');
    },
  });

  manager.setTitleForNextItem('Movie A', E01);
  manager.updateFromFileUrl(E01);
  // Movie B opened from a pasted URL; its metadata request fails
  manager.updateFromFileUrl(E02);
  await manager.setVideoTitleFromMetadata('https://jf', 'e02', 'K');

  assert.equal(calls.title, '');
});

test('no title is forced before opening when titles are turned off', () => {
  const { manager, calls } = loadMediaActions({
    preferences: { get: () => false },
  });

  manager.setTitleForNextItem('Movie A', E01);
  manager.updateFromFileUrl(E01);

  assert.deepEqual(calls.mpvSet, []);
});

test('a title that arrives after its file ended is not applied to the next one', async () => {
  const metadata = deferred();
  const { manager, calls } = loadMediaActions({
    fetchItemMetadata: () => metadata.promise,
  });

  manager.updateFromFileUrl(E01);
  const pending = manager.setVideoTitleFromMetadata('https://jf', 'e01', 'K');
  // E01 ended; E02 has not loaded yet.
  manager.invalidatePendingResults();
  metadata.resolve({ Name: 'Pilot' });
  await pending;

  assert.deepEqual(calls.mpvSet, []);
});

test('loadfile titles are length-quoted so commas and non-ASCII survive', () => {
  const { mediaTitleOption } = loadCommonJs('src/lib/media-actions.js');

  assert.equal(mediaTitleOption('Hello, Goodbye'), 'force-media-title=%14%Hello, Goodbye');
  // UTF-8 bytes, not UTF-16 units: ż and ó are 2 bytes each, the emoji 4
  assert.equal(mediaTitleOption('żó 🎬'), 'force-media-title=%9%żó 🎬');
});

test('a Jellyfin URL opened directly gets its title before mpv opens it', async () => {
  const requests = [];
  const { manager, calls } = loadMediaActions({
    fetchItemMetadata: async (serverBase, itemId) => {
      requests.push(itemId);
      return {
        Name: 'Pilot',
        Type: 'Episode',
        SeriesName: 'Show',
        ParentIndexNumber: 1,
        IndexNumber: 1,
      };
    },
  });

  await manager.applyTitleBeforeLoad(E01);
  assert.equal(calls.title, 'Show S01E01 - Pilot');

  manager.updateFromFileUrl(E01);
  assert.equal(calls.title, 'Show S01E01 - Pilot');
  assert.deepEqual(requests, ['e01']);
});

test('the title passed by the browser is applied before loading without a request', async () => {
  const requests = [];
  const { manager, calls } = loadMediaActions({
    fetchItemMetadata: async (serverBase, itemId) => {
      requests.push(itemId);
      return { Name: 'Other' };
    },
  });

  manager.setTitleForNextItem('Movie A', E01);
  calls.title = 'Restored older title';
  await manager.applyTitleBeforeLoad(E01);

  assert.equal(calls.title, 'Movie A');
  assert.deepEqual(requests, []);
});

test('a queued item with its own title is not held up or retitled', async () => {
  const requests = [];
  const { manager, calls } = loadMediaActions({
    fetchItemMetadata: async (serverBase, itemId) => {
      requests.push(itemId);
      return { Name: 'Other' };
    },
  });

  calls.title = 'Track 2';
  calls.titleSetLocally = true;
  await manager.applyTitleBeforeLoad(E02);

  assert.equal(calls.title, 'Track 2');
  assert.deepEqual(requests, []);
});

test('the previous title is cleared before a local file opens', async () => {
  const { manager, calls } = loadMediaActions();

  manager.setTitleForNextItem('Movie A', E01);
  manager.updateFromFileUrl(E01);
  await manager.applyTitleBeforeLoad('/Users/me/Movies/home.mp4');

  assert.equal(calls.title, '');
});

test('a slow server does not hold the load, and its late title is not applied early', async () => {
  const metadata = deferred();
  const { manager, calls } = loadMediaActions(
    { fetchItemMetadata: () => metadata.promise },
    { setTimeout: (callback) => setImmediate(callback), clearTimeout() {} }
  );

  await manager.applyTitleBeforeLoad(E01);
  assert.equal(calls.title, '');

  metadata.resolve({ Name: 'Pilot' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.title, '');
});

test('titles turned off leave loading alone', async () => {
  const requests = [];
  const { manager, calls } = loadMediaActions({
    preferences: { get: () => false },
    fetchItemMetadata: async (serverBase, itemId) => {
      requests.push(itemId);
      return { Name: 'Pilot' };
    },
  });

  await manager.applyTitleBeforeLoad(E01);

  assert.deepEqual(calls.mpvSet, []);
  assert.deepEqual(requests, []);
});

test('an unnumbered episode still gets a title before loading', async () => {
  const { manager, calls } = loadMediaActions({
    fetchItemMetadata: async () => ({
      Name: 'Special',
      Type: 'Episode',
      SeriesName: 'Show',
      ParentIndexNumber: 0,
      IndexNumber: null,
    }),
  });

  await manager.applyTitleBeforeLoad(E01);

  assert.equal(calls.title, 'Show - Special');
});

// mpv with a fixed track list, read through getNative('track-list') like the
// real one. Records the tracks it is switched to and keeps each track's
// selected flag in step. `options` answers getString (alang/slang).
function mpvWithTracks(tracks, options = {}) {
  const selected = {};
  const list = tracks.map((track) => ({ ...track }));
  // mpv never reuses a track id, even after sub-remove.
  let nextId = Math.max(0, ...tracks.map((track) => track.id)) + 1;
  const select = (type, value) => {
    for (const track of list) {
      if (track.type === type) track.selected = String(track.id) === value;
    }
  };
  return {
    selected,
    tracks: list,
    getNative: (name) => (name === 'track-list' ? list.map((track) => ({ ...track })) : null),
    getString: (name) => options[name] ?? '',
    getFlag: () => false,
    set(name, value) {
      if (name === 'aid' || name === 'sid') {
        selected[name] = value;
        select(name === 'aid' ? 'audio' : 'sub', value);
      }
    },
    commands: [],
    command(command, args) {
      this.commands.push([command, ...args]);
      if (command === 'sub-remove') {
        list.splice(
          list.findIndex((track) => track.type === 'sub' && String(track.id) === args[0]),
          1
        );
      }
      if (command !== 'sub-add') return;
      // 'auto' adds the track without selecting it.
      assert.equal(args[1], 'auto');
      const id = nextId++;
      list.push({ id, type: 'sub', title: args[2], lang: args[3], 'external-filename': args[0] });
    },
  };
}

function selectionPreferences(preferredLanguages = 'en', extra = {}) {
  const prefs = {
    select_preferred_tracks: true,
    preferred_languages: preferredLanguages,
    ...extra,
  };
  return { get: (key) => prefs[key] };
}

test('audio follows the order of the preferred languages, not the file order', () => {
  const mpv = mpvWithTracks([
    { id: 1, type: 'audio', lang: 'eng', title: 'English', selected: true },
    { id: 2, type: 'audio', lang: 'pol', title: 'Polski' },
  ]);
  const { manager } = loadMediaActions({ mpv, preferences: selectionPreferences('pol,eng') });

  manager.selectPreferredTracks();

  assert.deepEqual(mpv.selected, { aid: '2' });
});

test('audio in a preferred language gets its signs track, not full subtitles', () => {
  const mpv = mpvWithTracks([
    { id: 1, type: 'audio', lang: 'jpn', title: 'Japanese', selected: true },
    { id: 2, type: 'audio', lang: 'eng', title: 'English' },
    { id: 3, type: 'audio', lang: 'eng', title: 'English Commentary' },
    { id: 4, type: 'sub', lang: 'eng', title: 'Signs & Songs', forced: true },
    { id: 5, type: 'sub', lang: 'eng', title: 'English' },
  ]);
  const { manager } = loadMediaActions({ mpv, preferences: selectionPreferences() });

  manager.selectPreferredTracks();

  assert.deepEqual(mpv.selected, { aid: '2', sid: '4' });
});

test('audio in a preferred language turns off a full subtitle in that language', () => {
  const mpv = mpvWithTracks([
    { id: 1, type: 'audio', lang: 'eng', title: 'English', selected: true },
    { id: 2, type: 'sub', lang: 'eng', title: 'English', selected: true },
  ]);
  const { manager } = loadMediaActions({ mpv, preferences: selectionPreferences() });

  manager.selectPreferredTracks();

  assert.deepEqual(mpv.selected, { sid: 'no' });
});

test('full subtitles are picked for audio in a language not listed', () => {
  const mpv = mpvWithTracks([
    { id: 1, type: 'audio', lang: 'jpn', title: 'Japanese', selected: true },
    { id: 2, type: 'sub', lang: 'eng', title: 'Signs', forced: true },
    { id: 3, type: 'sub', lang: 'eng', title: 'English' },
  ]);
  const { manager } = loadMediaActions({ mpv, preferences: selectionPreferences() });

  manager.selectPreferredTracks();

  assert.deepEqual(mpv.selected, { sid: '3' });
});

test('a subtitle in a language ranked above the audio is shown', () => {
  const mpv = mpvWithTracks([
    { id: 1, type: 'audio', lang: 'eng', title: 'English', selected: true },
    { id: 2, type: 'sub', lang: 'eng', title: 'English' },
    { id: 3, type: 'sub', lang: 'pol', title: 'Polski' },
  ]);
  const { manager } = loadMediaActions({ mpv, preferences: selectionPreferences('pol,eng') });

  manager.selectPreferredTracks();

  assert.deepEqual(mpv.selected, { sid: '3' });
});

test('a commentary subtitle is never picked', () => {
  const mpv = mpvWithTracks([
    { id: 1, type: 'audio', lang: 'jpn', title: 'Japanese', selected: true },
    { id: 2, type: 'sub', lang: 'eng', title: 'English Commentary' },
    { id: 3, type: 'sub', lang: 'eng', title: 'English' },
  ]);
  const { manager } = loadMediaActions({ mpv, preferences: selectionPreferences() });

  manager.selectPreferredTracks();

  assert.deepEqual(mpv.selected, { sid: '3' });
});

test('a "Full + Songs" subtitle counts as a full one', () => {
  const mpv = mpvWithTracks([
    { id: 1, type: 'audio', lang: 'jpn', title: 'Japanese', selected: true },
    { id: 2, type: 'sub', lang: 'eng', title: 'Songs' },
    { id: 3, type: 'sub', lang: 'eng', title: 'English (Full + Songs)' },
  ]);
  const { manager } = loadMediaActions({ mpv, preferences: selectionPreferences() });

  manager.selectPreferredTracks();

  assert.deepEqual(mpv.selected, { sid: '3' });
});

test('a commentary track is skipped when a plain one exists in that language', () => {
  const mpv = mpvWithTracks([
    { id: 1, type: 'audio', lang: 'eng', title: 'Director Commentary', selected: true },
    { id: 2, type: 'audio', lang: 'eng', title: 'English' },
  ]);
  const { manager } = loadMediaActions({ mpv, preferences: selectionPreferences() });

  manager.selectPreferredTracks();

  assert.deepEqual(mpv.selected, { aid: '2' });
});

test('a forced subtitle is used when it is the only one in that language', () => {
  const mpv = mpvWithTracks([
    { id: 1, type: 'audio', lang: 'eng', title: 'English', selected: true },
    { id: 2, type: 'sub', lang: 'eng', title: 'English', forced: true },
  ]);
  const { manager } = loadMediaActions({ mpv, preferences: selectionPreferences() });

  manager.selectPreferredTracks();

  assert.deepEqual(mpv.selected, { sid: '2' });
});

test('a region suffix still matches the preferred language', () => {
  const mpv = mpvWithTracks([
    { id: 1, type: 'audio', lang: 'jpn', title: 'Japanese', selected: true },
    { id: 2, type: 'audio', lang: 'en-US', title: 'English (US)' },
  ]);
  const { manager } = loadMediaActions({ mpv, preferences: selectionPreferences('eng') });

  manager.selectPreferredTracks();

  assert.deepEqual(mpv.selected, { aid: '2' });
});

test('tracks are left alone when none is in the preferred languages', () => {
  const mpv = mpvWithTracks([
    { id: 1, type: 'audio', lang: 'jpn', title: 'Japanese', selected: true },
    { id: 2, type: 'sub', lang: 'jpn', title: 'Japanese' },
  ]);
  const { manager } = loadMediaActions({ mpv, preferences: selectionPreferences() });

  manager.selectPreferredTracks();

  assert.deepEqual(mpv.selected, {});
});

test('subtitles are left alone when the audio language is unknown', () => {
  const mpv = mpvWithTracks([
    { id: 1, type: 'audio', lang: 'und', title: '', selected: true },
    { id: 2, type: 'sub', lang: 'eng', title: 'English' },
  ]);
  const { manager } = loadMediaActions({ mpv, preferences: selectionPreferences() });

  manager.selectPreferredTracks();

  assert.deepEqual(mpv.selected, {});
});

test('preferred languages set in IINA (alang/slang) are left in charge', () => {
  const mpv = mpvWithTracks(
    [
      { id: 1, type: 'audio', lang: 'jpn', title: 'Japanese', selected: true },
      { id: 2, type: 'audio', lang: 'eng', title: 'English' },
      { id: 3, type: 'sub', lang: 'eng', title: 'English' },
    ],
    { alang: 'jpn', slang: 'jpn' }
  );
  const { manager } = loadMediaActions({ mpv, preferences: selectionPreferences() });

  manager.selectPreferredTracks();

  assert.deepEqual(mpv.selected, {});
});

test('a language shown as the secondary subtitle is not shown twice', () => {
  const mpv = mpvWithTracks([
    { id: 1, type: 'audio', lang: 'jpn', title: 'Japanese', selected: true },
    { id: 2, type: 'sub', lang: 'eng', title: 'English', selected: true, 'main-selection': 1 },
    { id: 3, type: 'sub', lang: 'jpn', title: 'Japanese', selected: true, 'main-selection': 0 },
    { id: 4, type: 'sub', lang: 'eng', title: 'English (Full)' },
  ]);
  const { manager } = loadMediaActions({ mpv, preferences: selectionPreferences() });

  manager.selectPreferredTracks();

  // English already plays as the secondary subtitle; making track 4 the main
  // one would show the same dialogue twice.
  assert.deepEqual(mpv.selected, {});
});

test('a signs track playing as the secondary subtitle keeps the main one on', () => {
  const mpv = mpvWithTracks([
    { id: 1, type: 'audio', lang: 'eng', title: 'English', selected: true },
    {
      id: 2,
      type: 'sub',
      lang: 'eng',
      title: 'Signs',
      forced: true,
      selected: true,
      'main-selection': 1,
    },
    { id: 3, type: 'sub', lang: 'jpn', title: 'Japanese', selected: true, 'main-selection': 0 },
  ]);
  const { manager } = loadMediaActions({ mpv, preferences: selectionPreferences() });

  manager.selectPreferredTracks();

  assert.deepEqual(mpv.selected, {});
});

test("mpv's pick is kept among tracks in the same language", () => {
  const mpv = mpvWithTracks([
    { id: 1, type: 'audio', lang: 'eng', title: 'Stereo' },
    { id: 2, type: 'audio', lang: 'eng', title: 'TrueHD 7.1', selected: true },
  ]);
  const { manager } = loadMediaActions({ mpv, preferences: selectionPreferences() });

  manager.selectPreferredTracks();

  assert.deepEqual(mpv.selected, {});
});

test('a commentary or audio description is never a fallback for the main audio', () => {
  const mpv = mpvWithTracks([
    { id: 1, type: 'audio', lang: 'jpn', title: 'Japanese', selected: true },
    { id: 2, type: 'audio', lang: 'eng', title: 'Director Commentary' },
    { id: 3, type: 'audio', lang: 'eng', title: 'Audio Description' },
  ]);
  const { manager } = loadMediaActions({ mpv, preferences: selectionPreferences() });

  manager.selectPreferredTracks();

  assert.equal(mpv.selected.aid, undefined);
});

test('a "Full + Signs" subtitle counts as a full one', () => {
  const mpv = mpvWithTracks([
    { id: 1, type: 'audio', lang: 'jpn', title: 'Japanese', selected: true },
    { id: 2, type: 'sub', lang: 'eng', title: 'Signs & Songs' },
    { id: 3, type: 'sub', lang: 'eng', title: 'English (Full + Signs)' },
  ]);
  const { manager } = loadMediaActions({ mpv, preferences: selectionPreferences() });

  manager.selectPreferredTracks();

  assert.deepEqual(mpv.selected, { sid: '3' });
});

test('an audio description track is skipped', () => {
  const mpv = mpvWithTracks([
    { id: 1, type: 'audio', lang: 'jpn', title: 'Japanese', selected: true },
    { id: 2, type: 'audio', lang: 'eng', title: 'English', 'visual-impaired': true },
    { id: 3, type: 'audio', lang: 'eng', title: 'English (AD)' },
    { id: 4, type: 'audio', lang: 'eng', title: 'English' },
  ]);
  const { manager } = loadMediaActions({ mpv, preferences: selectionPreferences() });

  manager.selectPreferredTracks();

  assert.deepEqual(mpv.selected, { aid: '4' });
});

test('a failing track read does not throw out of the file-loaded handler', () => {
  const mpv = mpvWithTracks([]);
  mpv.getNative = () => {
    throw new Error('no track-list');
  };
  const { manager } = loadMediaActions({ mpv, preferences: selectionPreferences() });

  assert.doesNotThrow(() => manager.selectPreferredTracks());
});

function externalEnglishSubtitle(stream = {}) {
  return async () => ({
    MediaSources: [
      {
        Id: 'ms',
        MediaStreams: [
          {
            Type: 'Subtitle',
            IsTextSubtitleStream: true,
            IsExternal: true,
            Language: 'en',
            Index: 9,
            ...stream,
          },
        ],
      },
    ],
  });
}

test('a downloaded subtitle is ranked instead of replacing the choice', async () => {
  const mpv = mpvWithTracks([
    { id: 1, type: 'audio', lang: 'jpn', title: 'Japanese', selected: true },
    { id: 2, type: 'sub', lang: 'eng', title: 'Signs', forced: true },
  ]);
  const { manager } = loadMediaActions({
    mpv,
    preferences: selectionPreferences(),
    fetchPlaybackInfo: externalEnglishSubtitle(),
  });

  manager.updateFromFileUrl(E01);
  manager.selectPreferredTracks();
  assert.equal(mpv.selected.sid, '2');
  await manager.downloadAllSubtitles('https://jf', 'e01', 'K');

  assert.equal(mpv.selected.sid, '3');
});

test('a downloaded forced subtitle does not replace a full one', async () => {
  const mpv = mpvWithTracks([
    { id: 1, type: 'audio', lang: 'jpn', title: 'Japanese', selected: true },
    { id: 2, type: 'sub', lang: 'eng', title: 'English' },
  ]);
  const { manager } = loadMediaActions({
    mpv,
    preferences: selectionPreferences(),
    // Only IsForced says so; the title Jellyfin reports is plain.
    fetchPlaybackInfo: externalEnglishSubtitle({ IsForced: true, Title: 'English' }),
  });

  manager.updateFromFileUrl(E01);
  manager.selectPreferredTracks();
  await manager.downloadAllSubtitles('https://jf', 'e01', 'K');

  assert.equal(mpv.selected.sid, '2');
  assert.equal(mpv.tracks.at(-1).lang, 'en');
  assert.equal(mpv.tracks.at(-1).title, 'English (Forced)');
});

test('a subtitle picked before the downloads finish is kept', async () => {
  const mpv = mpvWithTracks([
    { id: 1, type: 'audio', lang: 'jpn', title: 'Japanese', selected: true },
    { id: 2, type: 'sub', lang: 'eng', title: 'Signs', forced: true },
    { id: 3, type: 'sub', lang: 'jpn', title: 'Japanese' },
  ]);
  const { manager } = loadMediaActions({
    mpv,
    preferences: selectionPreferences(),
    fetchPlaybackInfo: externalEnglishSubtitle(),
  });

  manager.updateFromFileUrl(E01);
  manager.selectPreferredTracks();
  mpv.set('sid', '3'); // the viewer switches to the Japanese subtitle
  await manager.downloadAllSubtitles('https://jf', 'e01', 'K');

  assert.equal(mpv.selected.sid, '3');
});

test('a pre-load title does not replace one picked in the browser meanwhile', async () => {
  const metadata = deferred();
  const { manager, calls } = loadMediaActions({ fetchItemMetadata: () => metadata.promise });

  const pending = manager.applyTitleBeforeLoad(E01);
  manager.setTitleForNextItem('Movie X', E02);
  metadata.resolve({ Name: 'Pasted Y' });
  await pending;
  assert.equal(calls.title, 'Movie X');

  await manager.applyTitleBeforeLoad(E02);
  assert.equal(calls.title, 'Movie X');
});

test('a manual download shows the subtitle even with audio in a preferred language', async () => {
  const mpv = mpvWithTracks([
    { id: 1, type: 'audio', lang: 'eng', title: 'English', selected: true },
  ]);
  const { manager } = loadMediaActions({
    mpv,
    preferences: selectionPreferences(),
    fetchPlaybackInfo: externalEnglishSubtitle(),
  });

  manager.updateFromFileUrl(E01);
  manager.selectPreferredTracks();
  await manager.downloadAllSubtitles('https://jf', 'e01', 'K', { manual: true });

  assert.equal(mpv.selected.sid, '2');
});

test('downloads are ranked when the selection did not run for the file', async () => {
  const mpv = mpvWithTracks([
    { id: 1, type: 'audio', lang: 'jpn', title: 'Japanese', selected: true },
  ]);
  const { manager } = loadMediaActions({
    mpv,
    preferences: selectionPreferences(),
    fetchPlaybackInfo: externalEnglishSubtitle(),
  });

  manager.updateFromFileUrl(E01);
  await manager.downloadAllSubtitles('https://jf', 'e01', 'K');

  assert.equal(mpv.selected.sid, '2');
});

test('with the setting off the newest download is shown, as before', async () => {
  const mpv = mpvWithTracks([
    { id: 1, type: 'audio', lang: 'eng', title: 'English', selected: true },
  ]);
  const { manager } = loadMediaActions({
    mpv,
    preferences: { get: (key) => (key === 'preferred_languages' ? 'en' : undefined) },
    fetchPlaybackInfo: externalEnglishSubtitle(),
  });

  manager.updateFromFileUrl(E01);
  await manager.downloadAllSubtitles('https://jf', 'e01', 'K');

  assert.equal(mpv.selected.sid, '2');
});

test('a subtitle downloaded again replaces the old track and keeps its labels', async () => {
  const mpv = mpvWithTracks([
    { id: 1, type: 'audio', lang: 'eng', title: 'English', selected: true },
    { id: 2, type: 'sub', lang: 'jpn', title: 'Japanese' },
  ]);
  const { manager } = loadMediaActions({
    mpv,
    preferences: selectionPreferences(),
    fetchPlaybackInfo: externalEnglishSubtitle({ IsForced: true, Title: 'English' }),
  });

  manager.updateFromFileUrl(E01);
  await manager.downloadAllSubtitles('https://jf', 'e01', 'K');
  mpv.set('sid', '2');
  await manager.downloadAllSubtitles('https://jf', 'e01', 'K', { manual: true });

  assert.deepEqual(
    mpv.commands.map(([command]) => command),
    ['sub-add', 'sub-remove', 'sub-add']
  );
  const subtitles = mpv.tracks.filter((track) => track.type === 'sub');
  assert.equal(subtitles.length, 2);
  assert.equal(subtitles.at(-1).title, 'English (Forced)');
  assert.equal(subtitles.at(-1).lang, 'en');
});

test('a subtitle downloaded again stays selected if it was playing', async () => {
  const mpv = mpvWithTracks([
    { id: 1, type: 'audio', lang: 'jpn', title: 'Japanese', selected: true },
  ]);
  const { manager } = loadMediaActions({
    mpv,
    preferences: selectionPreferences(),
    fetchPlaybackInfo: externalEnglishSubtitle(),
  });

  manager.updateFromFileUrl(E01);
  manager.selectPreferredTracks();
  await manager.downloadAllSubtitles('https://jf', 'e01', 'K');
  assert.equal(mpv.selected.sid, '2');
  await manager.downloadAllSubtitles('https://jf', 'e01', 'K');

  assert.equal(mpv.selected.sid, '3');
  assert.equal(mpv.tracks.find((track) => track.selected && track.type === 'sub').id, 3);
});

test('a manual download picks the best-ranked full subtitle among the downloads', async () => {
  const mpv = mpvWithTracks([
    { id: 1, type: 'audio', lang: 'jpn', title: 'Japanese', selected: true },
  ]);
  const prefs = {
    select_preferred_tracks: true,
    preferred_languages: 'en',
    download_all_subtitles: true,
  };
  const stream = (Index, Language, extra = {}) => ({
    Type: 'Subtitle',
    IsTextSubtitleStream: true,
    IsExternal: true,
    Index,
    Language,
    ...extra,
  });
  const { manager } = loadMediaActions({
    mpv,
    preferences: { get: (key) => prefs[key] },
    fetchPlaybackInfo: async () => ({
      MediaSources: [
        {
          Id: 'ms',
          MediaStreams: [
            stream(1, 'eng', { Title: 'English' }),
            stream(2, 'fre', { Title: 'Français' }),
            stream(3, 'eng', { IsForced: true, Title: 'English' }),
          ],
        },
      ],
    }),
  });

  manager.updateFromFileUrl(E01);
  await manager.downloadAllSubtitles('https://jf', 'e01', 'K', { manual: true });

  assert.equal(mpv.selected.sid, '2');
  assert.equal(mpv.tracks.find((track) => track.id === 2).title, 'English');
});

test('an untagged download gets no made-up language', async () => {
  const mpv = mpvWithTracks([
    { id: 1, type: 'audio', lang: 'jpn', title: 'Japanese', selected: true },
  ]);
  const prefs = { select_preferred_tracks: true, download_all_subtitles: true };
  const { manager } = loadMediaActions({
    mpv,
    preferences: { get: (key) => prefs[key] },
    fetchPlaybackInfo: externalEnglishSubtitle({ Language: undefined }),
  });

  manager.updateFromFileUrl(E01);
  await manager.downloadAllSubtitles('https://jf', 'e01', 'K');

  assert.equal(mpv.tracks.at(-1).lang, '');
});

test('subtitles are downloaded from the version playing', async () => {
  const downloads = [];
  const sidecar = (Language, Index) => ({
    Type: 'Subtitle',
    IsTextSubtitleStream: true,
    IsExternal: true,
    Language,
    Index,
  });
  const { manager } = loadMediaActions({
    http: { download: async (url) => downloads.push(url) },
    fetchPlaybackInfo: async () => ({
      MediaSources: [
        { Id: 'first', MediaStreams: [sidecar('en', 2)] },
        { Id: 'second', MediaStreams: [sidecar('en', 5)] },
      ],
    }),
  });

  manager.updateFromFileUrl(E01);
  await manager.downloadAllSubtitles('https://jf', 'e01', 'K', { mediaSourceId: 'second' });

  assert.deepEqual(downloads, ['https://jf/Videos/e01/second/Subtitles/5/stream.srt?ApiKey=K']);
});

const ALWAYS_ON = { subtitles_always_on: true };

test('always show subtitles turns them on for audio in a preferred language', () => {
  const mpv = mpvWithTracks([
    { id: 1, type: 'audio', lang: 'eng', title: 'English', selected: true },
    { id: 2, type: 'sub', lang: 'eng', title: 'Signs', forced: true },
    { id: 3, type: 'sub', lang: 'eng', title: 'English' },
  ]);
  const { manager } = loadMediaActions({ mpv, preferences: selectionPreferences('en', ALWAYS_ON) });

  manager.selectPreferredTracks();

  assert.deepEqual(mpv.selected, { sid: '3' });
});

test('always show subtitles keeps the subtitle mpv picked in the same language', () => {
  const mpv = mpvWithTracks([
    { id: 1, type: 'audio', lang: 'eng', title: 'English', selected: true },
    { id: 2, type: 'sub', lang: 'eng', title: 'English' },
    { id: 3, type: 'sub', lang: 'eng', title: 'English SDH', selected: true },
  ]);
  const { manager } = loadMediaActions({ mpv, preferences: selectionPreferences('en', ALWAYS_ON) });

  manager.selectPreferredTracks();

  assert.deepEqual(mpv.selected, {});
});

test('always show subtitles works with untagged audio', () => {
  const mpv = mpvWithTracks([
    { id: 1, type: 'audio', lang: 'und', title: '', selected: true },
    { id: 2, type: 'sub', lang: 'eng', title: 'English' },
  ]);
  const { manager } = loadMediaActions({ mpv, preferences: selectionPreferences('en', ALWAYS_ON) });

  manager.selectPreferredTracks();

  assert.deepEqual(mpv.selected, { sid: '2' });
});

test('always show subtitles does not keep a subtitle in an unlisted language', () => {
  const mpv = mpvWithTracks([
    { id: 1, type: 'audio', lang: 'eng', title: 'English', selected: true },
    { id: 2, type: 'sub', lang: 'jpn', title: 'Japanese', selected: true },
  ]);
  const { manager } = loadMediaActions({ mpv, preferences: selectionPreferences('en', ALWAYS_ON) });

  manager.selectPreferredTracks();

  assert.deepEqual(mpv.selected, { sid: 'no' });
});

test('without a full subtitle, always show subtitles uses the signs track for the audio', () => {
  const mpv = mpvWithTracks([
    { id: 1, type: 'audio', lang: 'eng', title: 'English', selected: true },
    { id: 2, type: 'sub', lang: 'pol', title: 'Napisy', forced: true },
    { id: 3, type: 'sub', lang: 'eng', title: 'Signs', forced: true },
  ]);
  const { manager } = loadMediaActions({
    mpv,
    preferences: selectionPreferences('pol,eng', ALWAYS_ON),
  });

  manager.selectPreferredTracks();

  assert.deepEqual(mpv.selected, { sid: '3' });
});

test('always show subtitles does not repeat the secondary subtitle', () => {
  const mpv = mpvWithTracks([
    { id: 1, type: 'audio', lang: 'eng', title: 'English', selected: true },
    { id: 2, type: 'sub', lang: 'eng', title: 'English SDH', selected: true, 'main-selection': 1 },
    { id: 3, type: 'sub', lang: 'eng', title: 'English' },
  ]);
  const { manager } = loadMediaActions({ mpv, preferences: selectionPreferences('en', ALWAYS_ON) });

  manager.selectPreferredTracks();

  assert.deepEqual(mpv.selected, {});
});

test('always show subtitles keeps the signs track for a dub over a lower-ranked full one', () => {
  const mpv = mpvWithTracks([
    { id: 1, type: 'audio', lang: 'pol', title: 'Polski', selected: true },
    { id: 2, type: 'sub', lang: 'pol', title: 'Napisy', forced: true },
    { id: 3, type: 'sub', lang: 'eng', title: 'English' },
  ]);
  const { manager } = loadMediaActions({
    mpv,
    preferences: selectionPreferences('pol,eng', ALWAYS_ON),
  });

  manager.selectPreferredTracks();

  assert.deepEqual(mpv.selected, { sid: '2' });
});

test('always show subtitles does not turn on a language ranked below the audio', () => {
  const mpv = mpvWithTracks([
    { id: 1, type: 'audio', lang: 'eng', title: 'English', selected: true },
    { id: 2, type: 'sub', lang: 'pol', title: 'Polski' },
  ]);
  const { manager } = loadMediaActions({
    mpv,
    preferences: selectionPreferences('en,pl', ALWAYS_ON),
  });

  manager.selectPreferredTracks();

  assert.deepEqual(mpv.selected, {});
});

test('a downloaded subtitle is shown with always show subtitles on', async () => {
  const mpv = mpvWithTracks([
    { id: 1, type: 'audio', lang: 'eng', title: 'English', selected: true },
  ]);
  const { manager } = loadMediaActions({
    mpv,
    preferences: selectionPreferences('en', ALWAYS_ON),
    fetchPlaybackInfo: externalEnglishSubtitle(),
  });

  manager.updateFromFileUrl(E01);
  manager.selectPreferredTracks();
  await manager.downloadAllSubtitles('https://jf', 'e01', 'K');

  assert.equal(mpv.selected.sid, '2');
});
