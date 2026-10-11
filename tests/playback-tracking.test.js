import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function createTracker(overrides = {}, globals = {}) {
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
    clearTimeout() {},
    ...globals,
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
    ...overrides,
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

test('progress before playback starts does not overwrite the resume point with 0', async () => {
  const { tracker, status, requests, tick } = createTracker();

  await tracker.startPlaybackTracking('https://jf.example', 'itemA', 'key');
  // Still buffering at 0 for longer than one report interval, then paused
  for (let i = 0; i < 10; i++) tick();
  status.paused = true;
  tracker.handlePauseChange();

  const progress = requests.filter((request) => request.url.includes('/Sessions/Playing/Progress'));
  assert.equal(progress.length, 0);
});

test('progress after playback starts reports the real position, including a rewind to 0', async () => {
  const { tracker, status, requests, tick } = createTracker();

  await tracker.startPlaybackTracking('https://jf.example', 'itemA', 'key');
  status.position = 30;
  tick();
  status.position = 0;
  for (let i = 0; i < 9; i++) tick();

  const progress = requests.filter((request) => request.url.includes('/Sessions/Playing/Progress'));
  assert.equal(progress.length, 1);
  assert.equal(progress[0].data.PositionTicks, 0);
});

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

test('a failed resume lookup is not reported as position 0', async () => {
  const { tracker, requests, tick } = createTracker({
    fetchItemMetadata: async () => {
      throw new Error('offline');
    },
  });

  await tracker.startPlaybackTracking('https://jf.example', 'itemA', 'key');
  await flush();
  for (let i = 0; i < 10; i++) tick();
  tracker.stopPlaybackTracking();

  const progress = requests.filter((request) => request.url.includes('/Sessions/Playing/Progress'));
  assert.equal(progress.length, 0);
  const stop = requests.find((request) => request.url.includes('/Sessions/Playing/Stopped'));
  // Failed makes Jellyfin end the session without saving any position
  assert.equal(stop.data.Failed, true);
});

test('stopping without playback reports the stored position back', async () => {
  const { tracker, requests } = createTracker({
    fetchItemMetadata: async () => ({ UserData: { PlaybackPositionTicks: 1200 * 10000000 } }),
  });

  await tracker.startPlaybackTracking('https://jf.example', 'itemA', 'key');
  await flush();
  tracker.stopPlaybackTracking();

  const stop = requests.find((request) => request.url.includes('/Sessions/Playing/Stopped'));
  assert.equal(stop.data.Failed, false);
  assert.equal(stop.data.PositionTicks, 1200 * 10000000);
});

test('reopening an item reads its resume point after the stop report landed', async () => {
  const events = [];
  let landStop;
  const { tracker, status, tick } = createTracker({
    http: {
      post(url) {
        if (!url.includes('/Stopped')) return Promise.resolve({ statusCode: 204 });
        events.push('stop sent');
        return new Promise((resolve) => {
          landStop = () => {
            events.push('stop landed');
            resolve({ statusCode: 204 });
          };
        });
      },
    },
    fetchItemMetadata: async () => {
      events.push('resume read');
      return null;
    },
  });

  await tracker.startPlaybackTracking('https://jf.example', 'itemA', 'key');
  await flush();
  status.position = 2400;
  tick();
  events.length = 0;

  // Reopened: the old session stops, the new one starts right away
  await tracker.startPlaybackTracking('https://jf.example', 'itemA', 'key');
  await flush();
  assert.deepEqual(events, ['stop sent']);

  landStop();
  await flush();
  assert.deepEqual(events, ['stop sent', 'stop landed', 'resume read']);
});

function trackerWithSlowStop(globals) {
  const events = [];
  const tracker = createTracker(
    {
      http: {
        post(url) {
          if (!url.includes('/Stopped')) return Promise.resolve({ statusCode: 204 });
          // A stop report that never lands
          return new Promise(() => {});
        },
      },
      fetchItemMetadata: async (serverBase, itemId) => {
        events.push(`resume read ${itemId}`);
        return null;
      },
    },
    globals
  );
  return { ...tracker, events };
}

async function reopenAfterPlaying(nextItemId, globals) {
  const { tracker, status, tick, events } = trackerWithSlowStop(globals);
  await tracker.startPlaybackTracking('https://jf.example', 'itemA', 'key');
  await flush();
  status.position = 2400;
  tick();
  events.length = 0;

  await tracker.startPlaybackTracking('https://jf.example', nextItemId, 'key');
  await flush();
  return events;
}

test('opening a different item does not wait for the previous stop report', async () => {
  assert.deepEqual(await reopenAfterPlaying('itemB'), ['resume read itemB']);
});

test('a stop report that never lands holds the resume read back only until the cap', async () => {
  // Timers fire at once here, standing in for the cap running out
  const instantTimers = { setTimeout: (callback) => setImmediate(callback) };
  assert.deepEqual(await reopenAfterPlaying('itemA', instantTimers), ['resume read itemA']);
});
