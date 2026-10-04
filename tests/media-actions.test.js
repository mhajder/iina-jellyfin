import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function loadMediaActions(deps = {}) {
  const context = vm.createContext({ module: { exports: {} } });
  vm.runInContext(readFileSync('src/lib/media-actions.js', 'utf8'), context);

  const calls = { loadTrack: [], mpvSet: [], title: '' };
  const prefs = { set_video_title: true, preferred_languages: 'en' };
  const manager = context.module.exports.createMediaActionsManager({
    core: {
      osd() {},
      subtitle: { loadTrack: (path) => calls.loadTrack.push(path) },
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

  assert.deepEqual(calls.loadTrack, []);
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
  manager.updateFromFileUrl(E02);
  assert.equal(calls.title, 'Episode 2');

  // When E02 ends mpv restores 'Episode 1'; a local file must still clear it
  calls.title = 'Episode 1';
  manager.updateFromFileUrl('/Users/me/Movies/home.mp4');
  assert.equal(calls.title, '');
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
