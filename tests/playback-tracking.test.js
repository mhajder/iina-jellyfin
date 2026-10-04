import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function createTracker() {
  const status = { position: 0, duration: 3600, paused: false };
  const requests = [];
  const ticks = [];
  const context = vm.createContext({
    module: { exports: {} },
    setInterval(callback) {
      ticks.push(callback);
      return ticks.length;
    },
    clearInterval() {},
    setTimeout() {},
  });
  vm.runInContext(readFileSync('src/lib/playback-tracking.js', 'utf8'), context);

  const tracker = context.module.exports.createPlaybackTrackingManager({
    core: { status, seekTo() {}, osd() {} },
    http: {
      async post(url, options) {
        requests.push({ url, data: options.data });
        return { statusCode: 204 };
      },
    },
    preferences: { get: (key) => key === 'sync_playback_progress' },
    buildJellyfinHeaders: () => ({}),
    fetchPlaybackInfo: async () => ({ PlaySessionId: 'session' }),
    fetchItemMetadata: async () => null,
    secondsToTicks: (seconds) => Math.round(seconds * 10000000),
    ticksToSeconds: (ticks) => ticks / 10000000,
    log() {},
  });

  return { tracker, status, requests, tick: () => ticks.at(-1)() };
}

test('a replaced item is stopped at its own position, not the next file', async () => {
  const { tracker, status, requests, tick } = createTracker();

  await tracker.startPlaybackTracking('https://jf.example', 'itemA', 'key');
  status.position = 2400;
  tick();

  // mpv ends item A; the stop waits until item B has loaded at position 0
  tracker.markTrackedFileEnded();
  status.position = 0;
  tracker.stopPlaybackTracking();

  const stop = requests.find((request) => request.url.includes('/Sessions/Playing/Stopped'));
  assert.equal(stop.data.ItemId, 'itemA');
  assert.equal(stop.data.PositionTicks, 2400 * 10000000);
});

test('a pause change after the file ended does not overwrite its position', async () => {
  const { tracker, status, requests, tick } = createTracker();

  await tracker.startPlaybackTracking('https://jf.example', 'itemA', 'key');
  status.position = 2400;
  tick();

  tracker.markTrackedFileEnded();
  status.position = 0;
  status.paused = true;
  tracker.handlePauseChange();
  tracker.stopPlaybackTracking();

  const progress = requests.filter((request) => request.url.includes('/Sessions/Playing/Progress'));
  assert.equal(progress.length, 0);
  const stop = requests.find((request) => request.url.includes('/Sessions/Playing/Stopped'));
  assert.equal(stop.data.PositionTicks, 2400 * 10000000);
});
