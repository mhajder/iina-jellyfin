import assert from 'node:assert/strict';
import test from 'node:test';

import { loadCommonJs } from './helpers/load-commonjs.js';

const { createMediaActionsManager } = loadCommonJs('src/lib/media-actions.js');

function createSubtitleHarness(languages, prefs = {}) {
  const downloads = [];
  const values = { preferred_languages: 'en,eng', download_all_subtitles: false, ...prefs };
  const manager = createMediaActionsManager({
    core: { osd() {}, subtitle: { loadTrack() {} } },
    http: {
      async download(url) {
        downloads.push(url);
      },
    },
    utils: { resolvePath: (path) => path },
    preferences: { get: (key) => values[key] },
    mpv: {},
    parseJellyfinUrl() {},
    isJellyfinUrl() {},
    async fetchPlaybackInfo() {
      return {
        MediaSources: [
          {
            Id: 'source',
            MediaStreams: languages.map((Language, Index) => ({
              Type: 'Subtitle',
              IsTextSubtitleStream: true,
              IsExternal: true,
              Language,
              Index,
              Codec: 'srt',
            })),
          },
        ],
      };
    },
    async fetchItemMetadata() {},
    log() {},
  });
  return { manager, downloads };
}

function downloadedIndexes(downloads) {
  return downloads.map((url) => Number(url.match(/\/Subtitles\/(\d+)\//)[1]));
}

test('subtitle languages match whole codes, not substrings', async () => {
  const { manager, downloads } = createSubtitleHarness(['eng', 'ben', 'EN', 'gen', 'en-US']);
  await manager.downloadAllSubtitles('https://jf.example', 'item', 'key');
  assert.deepEqual(downloadedIndexes(downloads), [0, 2, 4]);
});

test('a 2-letter preference matches the 3-letter codes Jellyfin reports', async () => {
  const { manager, downloads } = createSubtitleHarness(['eng', 'ger', 'deu', 'ben', 'fre'], {
    preferred_languages: 'en, de',
  });
  await manager.downloadAllSubtitles('https://jf.example', 'item', 'key');
  assert.deepEqual(downloadedIndexes(downloads), [0, 1, 2]);
});

test('Norwegian preferences match the right variants', async () => {
  const languages = ['nob', 'nno', 'nor'];
  const plain = createSubtitleHarness(languages, { preferred_languages: 'no' });
  await plain.manager.downloadAllSubtitles('https://jf.example', 'item', 'key');
  assert.deepEqual(downloadedIndexes(plain.downloads), [0, 1, 2]);

  const nynorsk = createSubtitleHarness(languages, { preferred_languages: 'nn' });
  await nynorsk.manager.downloadAllSubtitles('https://jf.example', 'item', 'key');
  assert.deepEqual(downloadedIndexes(nynorsk.downloads), [1, 2]);
});

test('codes outside the table match the 3-letter code they start', async () => {
  const { manager, downloads } = createSubtitleHarness(['swa', 'afr', 'tat', 'ben'], {
    preferred_languages: 'sw,af,ta',
  });
  await manager.downloadAllSubtitles('https://jf.example', 'item', 'key');
  assert.deepEqual(downloadedIndexes(downloads), [0, 1]);
});

test('aliases match and listed codes do not pair with unrelated ones', async () => {
  const { manager, downloads } = createSubtitleHarness(['pob', 'iw', 'hat', 'lao', 'hau'], {
    preferred_languages: 'pt,he,ha',
  });
  await manager.downloadAllSubtitles('https://jf.example', 'item', 'key');
  assert.deepEqual(downloadedIndexes(downloads), [0, 1, 4]);
});

test('download_all_subtitles still downloads every language', async () => {
  const { manager, downloads } = createSubtitleHarness(['eng', 'ben'], {
    download_all_subtitles: true,
  });
  await manager.downloadAllSubtitles('https://jf.example', 'item', 'key');
  assert.deepEqual(downloadedIndexes(downloads), [0, 1]);
});

const { createJellyfinApi, isSameJellyfinServer } = loadCommonJs('src/lib/jellyfin-api.js');
const api = createJellyfinApi({ http: {}, preferences: { get() {} }, log() {} });

const ID = '0123456789abcdef0123456789abcdef';

test('lowercase media routes are detected and parsed', () => {
  for (const url of [
    `https://media.example.com/videos/${ID}/stream?api_key=K`,
    `https://media.example.com/jf/audio/${ID}/stream?api_key=K`,
    `https://media.example.com/items/${ID}/Download?api_key=K`,
  ]) {
    assert.equal(api.isJellyfinUrl(url), true, url);
    const parsed = api.parseJellyfinUrl(url);
    assert.equal(parsed?.itemId, ID, url);
    assert.equal(parsed.apiKey, 'K', url);
  }
  assert.equal(
    api.parseJellyfinUrl(`https://media.example.com/jf/audio/${ID}/stream?api_key=K`).serverBase,
    'https://media.example.com/jf'
  );
});

test('a lowercase route without a Jellyfin item id is not parsed', () => {
  assert.equal(api.parseJellyfinUrl('https://jellyfin.example/videos/clip.mp4?api_key=K'), null);
});

test('local files with a Videos folder are still not Jellyfin URLs', () => {
  assert.equal(api.isJellyfinUrl('/Users/me/videos/movie.mp4'), false);
});

test('plain web links with a lowercase videos path are not Jellyfin URLs', () => {
  assert.equal(api.isJellyfinUrl('https://example.com/videos/clip.mp4'), false);
  assert.equal(api.isJellyfinUrl('https://example.com/audio/song.mp3'), false);
  assert.equal(api.isJellyfinUrl('https://cdn.example.com/videos/clip.mp4?api_key=K'), false);
});

test('servers behind different subpaths of one host are different servers', () => {
  assert.equal(isSameJellyfinServer('https://host/jellyfin-a', 'https://host/jellyfin-b'), false);
  assert.equal(isSameJellyfinServer('https://host/jellyfin', 'https://host'), false);
  assert.equal(isSameJellyfinServer('https://host:8920', 'https://host:8096'), false);
});

test('scheme, case and trailing slashes do not split one server', () => {
  assert.equal(isSameJellyfinServer('https://Host/jellyfin/', 'http://host/jellyfin'), true);
  assert.equal(isSameJellyfinServer('https://host:8096', 'https://host:8096/'), true);
  assert.equal(isSameJellyfinServer('', ''), false);
  assert.equal(isSameJellyfinServer(undefined, 'https://host'), false);
});
