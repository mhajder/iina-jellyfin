import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function loadAutoplayManager(playlist) {
  const context = vm.createContext({ module: { exports: {} } });
  vm.runInContext(readFileSync('src/lib/autoplay-manager.js', 'utf8'), context);
  const metadataRequests = [];
  const manager = context.module.exports.createAutoplayManager({
    http: {},
    mpv: {
      getNumber: (name) => (name === 'playlist-count' ? playlist.count : playlist.pos),
      command() {},
    },
    core: {},
    preferences: { get: () => false },
    buildJellyfinHeaders: () => ({}),
    fetchItemMetadata: async (serverBase, itemId) => {
      metadataRequests.push(itemId);
      return { Type: 'Movie' };
    },
    log() {},
  });
  return { manager, metadataRequests };
}

function loadEpisode(manager, episodeId) {
  manager.resetForNewFile(episodeId);
  manager.setupAutoplayForEpisode('https://jf.example', episodeId, 'key');
}

test('a repeated load of an episode with the next one still queued is not set up twice', () => {
  const playlist = { count: 2, pos: 0 };
  const { manager, metadataRequests } = loadAutoplayManager(playlist);

  loadEpisode(manager, 'E01');
  loadEpisode(manager, 'E01');

  assert.deepEqual(metadataRequests, ['E01']);
});

test('reopening an episode after the playlist was cleared queues the next one again', () => {
  const playlist = { count: 2, pos: 0 };
  const { manager, metadataRequests } = loadAutoplayManager(playlist);

  loadEpisode(manager, 'E01');
  // openInCurrentWindow runs playlist-clear, dropping the queued E02
  playlist.count = 1;
  loadEpisode(manager, 'E01');

  assert.deepEqual(metadataRequests, ['E01', 'E01']);
});

test('a repeated load keeps the next episode marked as queued', async () => {
  const playlist = { count: 1, pos: 0 };
  const context = vm.createContext({ module: { exports: {} } });
  vm.runInContext(readFileSync('src/lib/autoplay-manager.js', 'utf8'), context);
  const manager = context.module.exports.createAutoplayManager({
    http: {
      get: async () => ({
        data: {
          Items: [1, 2].map((n) => ({
            Id: `E0${n}`,
            Name: `Ep ${n}`,
            IndexNumber: n,
            MediaSources: [{}],
          })),
        },
      }),
    },
    mpv: {
      getNumber: (name) => (name === 'playlist-count' ? playlist.count : playlist.pos),
      command(name) {
        if (name === 'loadfile') playlist.count++;
      },
    },
    core: {},
    preferences: { get: () => false },
    buildJellyfinHeaders: () => ({}),
    fetchItemMetadata: async () => ({
      Type: 'Episode',
      SeriesId: 'series',
      SeasonId: 'season',
      SeriesName: 'Show',
      ParentIndexNumber: 1,
      IndexNumber: 1,
    }),
    log() {},
  });

  loadEpisode(manager, 'E01');
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.isQueued(), true);

  // IINA reports the same file as loaded again
  loadEpisode(manager, 'E01');
  assert.equal(manager.isQueued(), true);
});
