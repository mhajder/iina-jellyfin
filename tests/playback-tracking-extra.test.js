import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { runScript } from './helpers/load-commonjs.js';

const SERVER = 'https://jf.example';
const TICKS_PER_SECOND = 10000000;

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};

// Timers are collected rather than run, so each test decides when a tick or
// the resume seek happens.
function createTracker(
  overrides = {},
  { prefs: prefOverrides = {}, status: statusOverrides } = {}
) {
  const status = statusOverrides || { position: 0, duration: 3600, paused: false };
  const prefs = { sync_playback_progress: true, ...prefOverrides };
  const requests = [];
  const ticks = [];
  const timeouts = [];
  const seeks = [];
  const osd = [];
  const logs = [];
  const context = vm.createContext({
    module: { exports: {} },
    setInterval(callback) {
      ticks.push(callback);
      return ticks.length;
    },
    clearInterval() {},
    setTimeout(callback, delay) {
      timeouts.push({ callback, delay });
      return timeouts.length;
    },
    clearTimeout() {},
  });
  runScript('src/lib/playback-tracking.js', context);

  const tracker = context.module.exports.createPlaybackTrackingManager({
    core: { status, seekTo: (position) => seeks.push(position), osd: (text) => osd.push(text) },
    http: {
      async post(url, options) {
        requests.push({ url, data: options.data });
        return { statusCode: 204 };
      },
    },
    preferences: { get: (key) => prefs[key] },
    buildJellyfinHeaders: () => ({}),
    fetchPlaybackInfo: async () => ({ PlaySessionId: 'session' }),
    fetchItemMetadata: async () => null,
    secondsToTicks: (seconds) => Math.round(seconds * TICKS_PER_SECOND),
    ticksToSeconds: (ticks) => ticks / TICKS_PER_SECOND,
    log: (message) => logs.push(message),
    ...overrides,
  });

  const byPath = (path) => requests.filter((request) => request.url.includes(path));
  return {
    tracker,
    status,
    prefs,
    requests,
    seeks,
    osd,
    logs,
    timeouts,
    tick: (count = 1) => {
      for (let i = 0; i < count; i++) ticks.at(-1)();
    },
    staleTick: () => ticks[0](),
    runTimeouts: () => timeouts.splice(0).forEach(({ callback }) => callback()),
    progress: () => byPath('/Sessions/Playing/Progress'),
    stops: () => byPath('/Sessions/Playing/Stopped'),
    starts: () => byPath('/Sessions/Playing?'),
    watched: () => byPath('/UserPlayedItems/'),
  };
}

function resumeAt(seconds, userData = {}) {
  return async () => ({
    UserData: { PlaybackPositionTicks: seconds * TICKS_PER_SECOND, ...userData },
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

test('nothing is tracked with progress sync turned off', async () => {
  const harness = createTracker({}, { prefs: { sync_playback_progress: false } });

  await harness.tracker.startPlaybackTracking(SERVER, 'itemA', 'key');

  assert.equal(harness.tracker.getCurrentPlaybackSession(), null);
  assert.equal(harness.requests.length, 0);
});

test('a started item reports its start with the play session and media source', async () => {
  const harness = createTracker({
    fetchPlaybackInfo: async () => ({ PlaySessionId: 'ps-1', MediaSources: [{ Id: 'ms-1' }] }),
  });

  await harness.tracker.startPlaybackTracking(SERVER, 'itemA', 'key');

  const [start] = harness.starts();
  assert.equal(start.url, `${SERVER}/Sessions/Playing?ApiKey=key`);
  assert.equal(start.data.PlaySessionId, 'ps-1');
  assert.equal(start.data.MediaSourceId, 'ms-1');
  assert.equal(start.data.PositionTicks, 0);
  const session = harness.tracker.getCurrentPlaybackSession();
  assert.equal(session.itemId, 'itemA');
  assert.equal(session.duration, 3600);
});

test('a failed playback info request still tracks the item, using its id as source', async () => {
  const harness = createTracker({
    fetchPlaybackInfo: async () => {
      throw new Error('offline');
    },
  });

  await harness.tracker.startPlaybackTracking(SERVER, 'itemA', 'key');

  const [start] = harness.starts();
  assert.equal(start.data.PlaySessionId, null);
  assert.equal(start.data.MediaSourceId, 'itemA');
  assert.notEqual(harness.tracker.getCurrentPlaybackSession(), null);
});

test('a start stopped while its playback info was loading is never tracked', async () => {
  const info = deferred();
  const harness = createTracker({ fetchPlaybackInfo: () => info.promise });

  const starting = harness.tracker.startPlaybackTracking(SERVER, 'itemA', 'key');
  harness.tracker.stopPlaybackTracking();
  info.resolve({ PlaySessionId: 'ps-1' });
  await starting;

  assert.equal(harness.tracker.getCurrentPlaybackSession(), null);
  assert.equal(harness.requests.length, 0);
});

test('a saved position is resumed a moment after the file starts', async () => {
  const harness = createTracker(
    { fetchItemMetadata: resumeAt(20 * 60 + 5) },
    { prefs: { show_notifications: true } }
  );

  await harness.tracker.startPlaybackTracking(SERVER, 'itemA', 'key');
  await flush();
  assert.deepEqual(harness.seeks, []);
  assert.equal(harness.timeouts.at(-1).delay, 1000);

  harness.runTimeouts();

  assert.deepEqual(harness.seeks, [1205]);
  assert.deepEqual(harness.osd, ['Resuming at 20:05']);
});

test('a resume seek without notifications shows nothing', async () => {
  const harness = createTracker({ fetchItemMetadata: resumeAt(600) });

  await harness.tracker.startPlaybackTracking(SERVER, 'itemA', 'key');
  await flush();
  harness.runTimeouts();

  assert.deepEqual(harness.seeks, [600]);
  assert.deepEqual(harness.osd, []);
});

for (const [description, fetchItemMetadata] of [
  ['a position under 15 seconds', resumeAt(10)],
  ['an item already played', resumeAt(600, { Played: true })],
  ['an item without a saved position', resumeAt(0)],
  ['an item without user data', async () => ({ Name: 'Movie' })],
]) {
  test(`${description} starts from the beginning`, async () => {
    const harness = createTracker({ fetchItemMetadata });

    await harness.tracker.startPlaybackTracking(SERVER, 'itemA', 'key');
    await flush();
    harness.runTimeouts();

    assert.deepEqual(harness.seeks, []);
  });
}

test('an item already played reports 0 when stopped without playing', async () => {
  const harness = createTracker({ fetchItemMetadata: resumeAt(600, { Played: true }) });

  await harness.tracker.startPlaybackTracking(SERVER, 'itemA', 'key');
  await flush();
  harness.tracker.stopPlaybackTracking();

  const [stop] = harness.stops();
  assert.equal(stop.data.Failed, false);
  assert.equal(stop.data.PositionTicks, 0);
});

test('an item replaced while its resume point was loading is not seeked', async () => {
  const metadata = deferred();
  const harness = createTracker({
    fetchItemMetadata: (serverBase, itemId) => (itemId === 'itemA' ? metadata.promise : null),
  });

  await harness.tracker.startPlaybackTracking(SERVER, 'itemA', 'key');
  await harness.tracker.startPlaybackTracking(SERVER, 'itemB', 'key');
  metadata.resolve({ UserData: { PlaybackPositionTicks: 600 * TICKS_PER_SECOND } });
  await flush();
  harness.runTimeouts();

  assert.deepEqual(harness.seeks, []);
});

test('an item replaced before its resume seek ran is not seeked', async () => {
  const harness = createTracker({
    fetchItemMetadata: async (serverBase, itemId) =>
      itemId === 'itemA' ? { UserData: { PlaybackPositionTicks: 600 * TICKS_PER_SECOND } } : null,
  });

  await harness.tracker.startPlaybackTracking(SERVER, 'itemA', 'key');
  await flush();
  const seek = harness.timeouts.find((timeout) => timeout.delay === 1000);
  await harness.tracker.startPlaybackTracking(SERVER, 'itemB', 'key');
  seek.callback();

  assert.deepEqual(harness.seeks, []);
});

test('a failing resume seek does not throw out of the timer', async () => {
  const harness = createTracker({
    fetchItemMetadata: resumeAt(600),
    core: {
      status: { position: 0, duration: 3600 },
      seekTo() {
        throw new Error('not seekable');
      },
      osd() {},
    },
  });

  await harness.tracker.startPlaybackTracking(SERVER, 'itemA', 'key');
  await flush();

  assert.doesNotThrow(() => harness.runTimeouts());
  assert.ok(harness.logs.some((message) => message.includes('not seekable')));
});

test('progress is reported every ten ticks with the pause state', async () => {
  const harness = createTracker({ fetchPlaybackInfo: async () => ({ PlaySessionId: 'ps' }) });

  await harness.tracker.startPlaybackTracking(SERVER, 'itemA', 'key');
  harness.status.position = 120;
  harness.tick(9);
  assert.equal(harness.progress().length, 0);

  harness.status.paused = true;
  harness.tick();

  const [progress] = harness.progress();
  assert.equal(progress.data.PositionTicks, 120 * TICKS_PER_SECOND);
  assert.equal(progress.data.IsPaused, true);
  assert.equal(progress.data.PlaySessionId, 'ps');
  assert.equal(progress.data.MediaSourceId, 'itemA');
});

test('a negative or missing position is ignored', async () => {
  const harness = createTracker();

  await harness.tracker.startPlaybackTracking(SERVER, 'itemA', 'key');
  harness.status.position = 300;
  harness.tick();
  harness.status.position = -1;
  harness.tick();
  harness.status.position = null;
  harness.tracker.stopPlaybackTracking();

  assert.equal(harness.stops()[0].data.PositionTicks, 300 * TICKS_PER_SECOND);
});

test('a duration unknown at the start is read once the file reports it', async () => {
  const harness = createTracker({}, { status: { position: 0, duration: 0, paused: false } });

  await harness.tracker.startPlaybackTracking(SERVER, 'itemA', 'key');
  assert.equal(harness.tracker.getCurrentPlaybackSession().duration, null);

  harness.status.duration = 1800;
  harness.tick();

  assert.equal(harness.tracker.getCurrentPlaybackSession().duration, 1800);
});

test('an unreadable duration at the start does not stop tracking', async () => {
  const status = {
    position: 0,
    paused: false,
    get duration() {
      throw new Error('no duration');
    },
  };
  const harness = createTracker({}, { status });

  await harness.tracker.startPlaybackTracking(SERVER, 'itemA', 'key');

  assert.notEqual(harness.tracker.getCurrentPlaybackSession(), null);
  assert.equal(harness.starts().length, 1);
});

test('an unreadable position in a tick does not throw out of the timer', async () => {
  let readable = true;
  const status = {
    duration: 3600,
    paused: false,
    get position() {
      if (!readable) throw new Error('no position');
      return 300;
    },
  };
  const harness = createTracker({}, { status });

  await harness.tracker.startPlaybackTracking(SERVER, 'itemA', 'key');
  harness.tick();
  readable = false;

  assert.doesNotThrow(() => harness.tick());
  // The stop falls back to the last position the tick read
  harness.tracker.stopPlaybackTracking();
  assert.equal(harness.stops()[0].data.PositionTicks, 300 * TICKS_PER_SECOND);
});

test('a tick left over from a stopped session does nothing', async () => {
  const harness = createTracker();

  await harness.tracker.startPlaybackTracking(SERVER, 'itemA', 'key');
  harness.tracker.stopPlaybackTracking();
  const before = harness.requests.length;

  harness.status.position = 300;
  harness.staleTick();

  assert.equal(harness.requests.length, before);
});

test('reaching 95% marks the item as watched once', async () => {
  const harness = createTracker({}, { prefs: { show_notifications: true } });

  await harness.tracker.startPlaybackTracking(SERVER, 'itemA', 'key');
  harness.status.position = 3500;
  harness.tick(20);
  await flush();

  const watched = harness.watched();
  assert.equal(watched.length, 1);
  assert.equal(watched[0].url, `${SERVER}/UserPlayedItems/itemA?ApiKey=key`);
  assert.deepEqual(harness.osd, ['Marked as watched in Jellyfin']);
});

test('below 95% the item is not marked as watched', async () => {
  const harness = createTracker();

  await harness.tracker.startPlaybackTracking(SERVER, 'itemA', 'key');
  harness.status.position = 3000;
  harness.tick(10);

  assert.equal(harness.watched().length, 0);
});

test('reaching the end of the file marks it watched and stops tracking', async () => {
  const harness = createTracker({}, { status: { position: 0, duration: 100, paused: false } });

  await harness.tracker.startPlaybackTracking(SERVER, 'itemA', 'key');
  harness.status.position = 99.8;
  harness.tick();

  assert.equal(harness.watched().length, 1);
  assert.equal(harness.stops().length, 1);
  assert.equal(harness.stops()[0].data.PositionTicks, Math.round(99.8 * TICKS_PER_SECOND));
  assert.equal(harness.tracker.getCurrentPlaybackSession(), null);
});

test('the end of a file already marked watched is not marked again', async () => {
  const harness = createTracker({}, { status: { position: 0, duration: 100, paused: false } });

  await harness.tracker.startPlaybackTracking(SERVER, 'itemA', 'key');
  harness.status.position = 96;
  harness.tick(10);
  assert.equal(harness.watched().length, 1);

  harness.status.position = 100;
  harness.tick();

  assert.equal(harness.watched().length, 1);
  assert.equal(harness.stops().length, 1);
});

test('a pause change reports the position and pause state right away', async () => {
  const harness = createTracker();

  await harness.tracker.startPlaybackTracking(SERVER, 'itemA', 'key');
  harness.status.position = 42;
  harness.status.paused = true;
  harness.tracker.handlePauseChange();

  const [progress] = harness.progress();
  assert.equal(progress.data.PositionTicks, 42 * TICKS_PER_SECOND);
  assert.equal(progress.data.IsPaused, true);
});

test('a pause change restarts the count to the next progress report', async () => {
  const harness = createTracker();

  await harness.tracker.startPlaybackTracking(SERVER, 'itemA', 'key');
  harness.status.position = 42;
  harness.tick(5);
  harness.tracker.handlePauseChange();
  harness.tick(9);

  assert.equal(harness.progress().length, 1);
  harness.tick();
  assert.equal(harness.progress().length, 2);
});

test('a pause change before the saved position is known reports nothing', async () => {
  const metadata = deferred();
  const harness = createTracker({ fetchItemMetadata: () => metadata.promise });

  await harness.tracker.startPlaybackTracking(SERVER, 'itemA', 'key');
  harness.tracker.handlePauseChange();

  assert.equal(harness.progress().length, 0);
});

test('a pause change before playback starts reports the saved position', async () => {
  const harness = createTracker({ fetchItemMetadata: resumeAt(600) });

  await harness.tracker.startPlaybackTracking(SERVER, 'itemA', 'key');
  await flush();
  harness.status.paused = true;
  harness.tracker.handlePauseChange();

  assert.equal(harness.progress()[0].data.PositionTicks, 600 * TICKS_PER_SECOND);
});

test('a pause change without a session does nothing', () => {
  const harness = createTracker();

  harness.tracker.handlePauseChange();
  harness.tracker.markTrackedFileEnded();

  assert.equal(harness.requests.length, 0);
});

test('an unreadable pause state does not throw out of the handler', async () => {
  const harness = createTracker();

  await harness.tracker.startPlaybackTracking(SERVER, 'itemA', 'key');
  Object.defineProperty(harness.status, 'position', {
    get() {
      throw new Error('no position');
    },
  });

  assert.doesNotThrow(() => harness.tracker.handlePauseChange());
  assert.equal(harness.progress().length, 0);
});

test('an unreadable position at the stop uses the last one sampled', async () => {
  const harness = createTracker();

  await harness.tracker.startPlaybackTracking(SERVER, 'itemA', 'key');
  harness.status.position = 700;
  harness.tick();
  Object.defineProperty(harness.status, 'position', {
    get() {
      throw new Error('no position');
    },
  });
  harness.tracker.stopPlaybackTracking();

  assert.equal(harness.stops()[0].data.PositionTicks, 700 * TICKS_PER_SECOND);
});

test('turning progress sync off during playback sends no stop report', async () => {
  const harness = createTracker();

  await harness.tracker.startPlaybackTracking(SERVER, 'itemA', 'key');
  harness.status.position = 300;
  harness.tick(10);
  harness.prefs.sync_playback_progress = false;
  harness.tick(10);
  harness.tracker.stopPlaybackTracking();

  assert.equal(harness.progress().length, 1);
  assert.equal(harness.stops().length, 0);
  assert.equal(harness.tracker.getCurrentPlaybackSession(), null);
});

test('turning progress sync off while the resume point loads skips the resume', async () => {
  const harness = createTracker({
    fetchItemMetadata: async () => {
      throw new Error('should not be requested');
    },
    fetchPlaybackInfo: async () => {
      // Turned off right after the playback info arrives
      harness.prefs.sync_playback_progress = false;
      return { PlaySessionId: 'ps' };
    },
  });

  await harness.tracker.startPlaybackTracking(SERVER, 'itemA', 'key');
  await flush();
  harness.runTimeouts();

  assert.deepEqual(harness.seeks, []);
  assert.equal(harness.starts().length, 0);
});

for (const [description, post] of [
  ['rejected by the server', async () => ({ statusCode: 500 })],
  [
    'failing to send',
    async () => {
      throw new Error('offline');
    },
  ],
  [
    'failing with a non-error value',
    async () => {
      throw { code: 'EOFFLINE' };
    },
  ],
]) {
  test(`reports ${description} do not stop tracking`, async () => {
    const harness = createTracker({ http: { post } });

    await harness.tracker.startPlaybackTracking(SERVER, 'itemA', 'key');
    harness.status.position = 200;
    harness.tick(10);
    harness.tracker.handlePauseChange();
    await flush();
    assert.notEqual(harness.tracker.getCurrentPlaybackSession(), null);

    harness.tracker.stopPlaybackTracking();
    await flush();
    assert.equal(harness.tracker.getCurrentPlaybackSession(), null);
    assert.equal(await harness.tracker.markAsWatched(SERVER, 'itemA', 'key'), false);
  });
}

test('marking as watched succeeds on 200 and 204 only', async () => {
  for (const [statusCode, expected] of [
    [200, true],
    [204, true],
    [404, false],
  ]) {
    const harness = createTracker({ http: { post: async () => ({ statusCode }) } });

    assert.equal(await harness.tracker.markAsWatched(SERVER, 'itemA', 'key'), expected, statusCode);
  }
});

test('marking as watched with progress sync off sends nothing', async () => {
  const harness = createTracker({}, { prefs: { sync_playback_progress: false } });

  assert.equal(await harness.tracker.markAsWatched(SERVER, 'itemA', 'key'), false);
  assert.equal(harness.requests.length, 0);
});

test('a failed stop report does not hold the reopened item back', async () => {
  const events = [];
  const harness = createTracker({
    http: {
      async post(url) {
        if (url.includes('/Stopped')) {
          events.push('stop failed');
          return { statusCode: 500 };
        }
        return { statusCode: 204 };
      },
    },
    fetchItemMetadata: async () => {
      events.push('resume read');
      return null;
    },
  });

  await harness.tracker.startPlaybackTracking(SERVER, 'itemA', 'key');
  await flush();
  harness.status.position = 300;
  harness.tick();
  events.length = 0;

  await harness.tracker.startPlaybackTracking(SERVER, 'itemA', 'key');
  await flush();

  assert.deepEqual(events, ['stop failed', 'resume read']);
});
