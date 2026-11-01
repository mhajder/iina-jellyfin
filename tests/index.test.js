import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { runScript } from './helpers/load-commonjs.js';

const SERVER = 'https://jf.example';
const MOVIE = '0123456789abcdef0123456789abcdef';
const OTHER = 'fedcba9876543210fedcba9876543210';
const TRACK_2 = '22222222222222222222222222222222';
const TRACK_3 = '33333333333333333333333333333333';

const videoUrl = (itemId, query = '') =>
  `${SERVER}/Videos/${itemId}/stream?static=true&api_key=urlkey${query}`;
const audioUrl = (itemId) => `${SERVER}/Audio/${itemId}/stream?static=true&api_key=urlkey`;

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};

function defaultRespond(url) {
  const playbackInfo = url.match(/\/Items\/([^/?]+)\/PlaybackInfo/);
  if (playbackInfo) {
    return {
      statusCode: 200,
      data: { PlaySessionId: 'ps', MediaSources: [{ Id: playbackInfo[1] }] },
    };
  }
  if (/\/Items\/[^/?]+\?/.test(url)) {
    return {
      statusCode: 200,
      data: { Name: 'Movie', Type: 'Movie', ProductionYear: 2020, UserData: {} },
    };
  }
  return { statusCode: 404, data: null };
}

function createView() {
  return {
    handlers: {},
    posted: [],
    loaded: [],
    shown: 0,
    opened: 0,
    closed: 0,
    onMessage(name, callback) {
      this.handlers[name] = callback;
    },
    postMessage(name, data) {
      this.posted.push({ name, data });
    },
    loadFile(file) {
      this.loaded.push(file);
    },
    show() {
      this.shown++;
    },
    open() {
      this.opened++;
    },
    close() {
      this.closed++;
    },
    setFrame() {},
    setProperty() {},
  };
}

// Load src/index.js with a fake `iina` that records what the plugin does.
function loadPlugin({ prefs = {}, respond = defaultRespond, window, openResult = true } = {}) {
  const clock = { now: Date.now() };
  class TestDate extends Date {
    static now() {
      return clock.now;
    }
  }

  const pendingTimers = new Map();
  let nextTimerId = 1;
  const timers = {
    setTimeout(callback) {
      const id = nextTimerId++;
      pendingTimers.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      pendingTimers.delete(id);
    },
    setInterval() {
      return nextTimerId++;
    },
    clearInterval() {},
  };
  const runTimers = () => {
    for (const [id, callback] of [...pendingTimers]) {
      pendingTimers.delete(id);
      callback();
    }
  };

  const store = new Map(Object.entries(prefs));
  const preferences = {
    get: (key) => store.get(key),
    set: (key, value) => store.set(key, value),
    sync() {},
  };

  const gets = [];
  const posts = [];
  const downloads = [];
  const http = {
    async download(url, path) {
      downloads.push({ url, path });
    },
    async get(url) {
      gets.push(url);
      return respond(url);
    },
    async post(url, options) {
      posts.push({ url, data: options.data });
      return { statusCode: 204 };
    },
  };

  const opened = [];
  const osd = [];
  const seeks = [];
  const core = {
    status: { position: 0, duration: 3600, paused: false, url: '' },
    window: window ?? { loaded: true, visible: true },
    open: (url) => opened.push(url),
    osd: (text) => osd.push(text),
    seekTo: (position) => seeks.push(position),
  };

  const mpvProps = new Map();
  const commands = [];
  const hooks = {};
  const mpv = {
    getString: (name) => mpvProps.get(name) ?? '',
    getNumber: (name) => mpvProps.get(name) ?? 0,
    getFlag: () => false,
    getNative: (name) => mpvProps.get(name) ?? [],
    set: (name, value) => mpvProps.set(name, value),
    command: (name, args) => commands.push([name, ...args]),
    addHook: (name, priority, callback) => {
      hooks[name] = callback;
    },
  };

  const menuState = { items: [], forceUpdates: 0 };
  const menu = {
    item: (title, action, options = {}) => ({
      title,
      action,
      options,
      subItems: [],
      addSubMenuItem(item) {
        this.subItems.push(item);
      },
    }),
    addItem: (item) => menuState.items.push(item),
    removeAllItems: () => {
      menuState.items = [];
    },
    forceUpdate: () => menuState.forceUpdates++,
  };

  const events = {};
  const externalOpens = [];
  const sidebar = createView();
  const standaloneWindow = createView();
  const global = createView();

  const iina = {
    core,
    console: { log() {} },
    menu,
    event: {
      on: (name, callback) => {
        events[name] = callback;
      },
    },
    http,
    utils: {
      resolvePath: (path) => path.replace('@tmp/', '/tmp/'),
      open(url) {
        externalOpens.push(url);
        if (openResult instanceof Error) throw openResult;
        return openResult;
      },
    },
    preferences,
    mpv,
    sidebar,
    global,
    standaloneWindow,
  };

  // The lib files are CommonJS; they get the same fake timers as the plugin.
  const requireLib = (path) => {
    const module = { exports: {} };
    const file = `src/lib/${path.replace('./lib/', '')}`;
    runScript(file, vm.createContext({ module, exports: module.exports, URL, ...timers }));
    return module.exports;
  };

  runScript(
    'src/index.js',
    vm.createContext({ iina, require: requireLib, URL, Date: TestDate, ...timers })
  );

  const emit = (name, ...args) => events[name](...args);
  const findMenuItem = (title) => menuState.items.find((item) => item.title === title);

  return {
    clock,
    runTimers,
    store,
    gets,
    posts,
    downloads,
    core,
    opened,
    osd,
    seeks,
    mpvProps,
    commands,
    hooks,
    menuState,
    findMenuItem,
    externalOpens,
    sidebar,
    standaloneWindow,
    global,
    emit,
    servers: () => JSON.parse(store.get('jellyfin_servers') || '[]'),
    postsTo: (path) => posts.filter((post) => post.url.includes(path)),
    loadSidebar: () => emit('iina.window-loaded'),
  };
}

const signedInServer = (overrides = {}) => ({
  id: 'srv-1',
  serverUrl: SERVER,
  serverName: 'Home',
  accessToken: 'accounttoken',
  userId: 'user-1',
  username: 'me',
  ...overrides,
});

const withServers = (servers, activeId = servers[0]?.id) => ({
  jellyfin_servers: JSON.stringify(servers),
  jellyfin_active_server_id: activeId,
});

// Menu

test('the plugin menu offers subtitles, title and the browser on Cmd+Shift+J', () => {
  const plugin = loadPlugin();

  assert.deepEqual(
    plugin.menuState.items.map((item) => item.title),
    ['Download Jellyfin Subtitles', 'Set Jellyfin Title', 'Show Jellyfin Browser']
  );
  assert.equal(plugin.findMenuItem('Show Jellyfin Browser').options.keyBinding, 'Meta+Shift+j');
});

test('downloading subtitles from the menu without Jellyfin media says so', () => {
  const plugin = loadPlugin();

  plugin.findMenuItem('Download Jellyfin Subtitles').action();

  assert.deepEqual(plugin.osd, ['No Jellyfin media detected. Please open a Jellyfin URL first.']);
  assert.equal(plugin.gets.length, 0);
});

test('setting the title from the menu asks the server again instead of reusing the loaded response', async () => {
  const plugin = loadPlugin({ prefs: { set_video_title: true } });
  const metadataRequests = () => plugin.gets.filter((url) => url.includes(`/Items/${MOVIE}?`));

  plugin.emit('iina.file-loaded', videoUrl(MOVIE));
  await flush();
  assert.equal(metadataRequests().length, 1);

  plugin.findMenuItem('Set Jellyfin Title').action();
  await flush();

  assert.equal(metadataRequests().length, 2);
  assert.ok(plugin.osd.includes('Fetching title...'));
  assert.equal(plugin.mpvProps.get('force-media-title'), 'Movie (2020)');
});

test('the browser opens in the sidebar while the player window is visible', () => {
  const plugin = loadPlugin();

  plugin.findMenuItem('Show Jellyfin Browser').action();

  assert.equal(plugin.sidebar.shown, 1);
  assert.equal(plugin.standaloneWindow.opened, 0);
});

test('without a visible player window the browser opens in a standalone window with the stored server', () => {
  const plugin = loadPlugin({
    window: { loaded: true, visible: false },
    prefs: withServers([signedInServer()]),
  });

  plugin.findMenuItem('Show Jellyfin Browser').action();

  assert.equal(plugin.sidebar.shown, 0);
  assert.deepEqual(plugin.standaloneWindow.loaded, ['src/ui/sidebar/index.html']);
  assert.equal(plugin.standaloneWindow.opened, 1);
  assert.deepEqual(plugin.osd, [
    'Jellyfin Browser opened in standalone window\nServer: jf.example',
  ]);

  plugin.runTimers();
  const posted = plugin.standaloneWindow.posted;
  assert.deepEqual(
    posted.map((message) => message.name),
    ['client-identity', 'servers-list', 'session-available']
  );
  assert.equal(posted[1].data.activeServerId, 'srv-1');
  assert.equal(posted[2].data.accessToken, 'accounttoken');
});

test('the standalone window asks to log in when no server is stored', () => {
  const plugin = loadPlugin({ window: { loaded: false, visible: false } });

  plugin.findMenuItem('Show Jellyfin Browser').action();
  plugin.runTimers();

  assert.deepEqual(plugin.osd, [
    'Jellyfin Browser opened in standalone window\nPlease login to access your media',
  ]);
  assert.ok(
    !plugin.standaloneWindow.posted.some((message) => message.name === 'session-available')
  );
});

test('playing from the standalone window starts playback and closes the window', () => {
  const plugin = loadPlugin({ window: { loaded: true, visible: false } });
  plugin.findMenuItem('Show Jellyfin Browser').action();

  plugin.standaloneWindow.handlers['play-media']({ streamUrl: videoUrl(MOVIE), title: 'Movie' });
  assert.deepEqual(plugin.opened, [videoUrl(MOVIE)]);
  assert.equal(plugin.standaloneWindow.closed, 1);

  plugin.standaloneWindow.handlers['play-media-list']({
    items: [{ streamUrl: audioUrl(TRACK_2), title: 'Track 2' }],
  });
  assert.deepEqual(plugin.opened, [videoUrl(MOVIE), audioUrl(TRACK_2)]);
  assert.equal(plugin.standaloneWindow.closed, 2);
});

// File loading

test('a played Jellyfin URL is remembered as a server for auto-login', () => {
  const plugin = loadPlugin({ prefs: { auto_login_enabled: true } });

  plugin.emit('iina.file-loaded', videoUrl(MOVIE));

  const servers = plugin.servers();
  assert.equal(servers.length, 1);
  assert.equal(servers[0].serverUrl, SERVER);
  assert.equal(servers[0].accessToken, 'urlkey');
  const available = plugin.sidebar.posted.find((message) => message.name === 'session-available');
  assert.equal(available.data.accessToken, 'urlkey');
});

test('with auto-login off a played URL leaves its credentials unstored', () => {
  const plugin = loadPlugin();

  plugin.emit('iina.file-loaded', videoUrl(MOVIE));

  assert.equal(plugin.store.get('jellyfin_servers'), undefined);
});

test('a local file is not treated as Jellyfin media', async () => {
  const plugin = loadPlugin({
    prefs: {
      auto_login_enabled: true,
      sync_playback_progress: true,
      set_video_title: true,
      auto_download_enabled: true,
    },
  });

  plugin.emit('iina.file-loaded', '/Users/me/Videos/movie.mp4');
  await flush();

  assert.equal(plugin.gets.length, 0);
  assert.equal(plugin.posts.length, 0);
  assert.equal(plugin.store.get('jellyfin_servers'), undefined);
});

test('playback is reported with the api key from the URL by default', async () => {
  const plugin = loadPlugin({ prefs: { sync_playback_progress: true } });

  plugin.emit('iina.file-loaded', videoUrl(MOVIE));
  await flush();

  const [start] = plugin.postsTo('/Sessions/Playing?');
  assert.equal(start.url, `${SERVER}/Sessions/Playing?ApiKey=urlkey`);
  assert.equal(start.data.ItemId, MOVIE);
  assert.equal(start.data.PlaySessionId, 'ps');
});

test('connected-account mode reports playback to the account signed in on the same server', async () => {
  const plugin = loadPlugin({
    prefs: {
      use_connected_account: true,
      auto_login_enabled: true,
      sync_playback_progress: true,
      ...withServers([signedInServer()]),
    },
  });

  plugin.emit('iina.file-loaded', videoUrl(MOVIE));
  await flush();

  const [start] = plugin.postsTo('/Sessions/Playing?');
  assert.equal(start.url, `${SERVER}/Sessions/Playing?ApiKey=accounttoken`);
  assert.equal(start.data.ItemId, MOVIE);
  // The URL's key is not stored next to the account
  assert.equal(plugin.servers().length, 1);
});

test('connected-account mode keeps the URL api key when the account is on another server', async () => {
  const plugin = loadPlugin({
    prefs: {
      use_connected_account: true,
      sync_playback_progress: true,
      ...withServers([signedInServer({ serverUrl: 'https://other.example' })]),
    },
  });

  plugin.emit('iina.file-loaded', videoUrl(MOVIE));
  await flush();

  const [start] = plugin.postsTo('/Sessions/Playing?');
  assert.equal(start.url, `${SERVER}/Sessions/Playing?ApiKey=urlkey`);
});

test('connected-account mode without a signed-in server uses the URL api key', async () => {
  const plugin = loadPlugin({
    prefs: { use_connected_account: true, sync_playback_progress: true },
  });

  plugin.emit('iina.file-loaded', videoUrl(MOVIE));
  await flush();

  const [start] = plugin.postsTo('/Sessions/Playing?');
  assert.equal(start.url, `${SERVER}/Sessions/Playing?ApiKey=urlkey`);
});

test('preferred tracks are selected on load only when that option is on', async () => {
  for (const enabled of [true, false]) {
    const plugin = loadPlugin({
      prefs: { select_preferred_tracks: enabled, preferred_languages: 'pl' },
    });
    plugin.mpvProps.set('track-list', [
      { type: 'audio', id: 1, lang: 'eng', selected: true, 'main-selection': 0 },
      { type: 'audio', id: 2, lang: 'pol', selected: false },
    ]);

    plugin.emit('iina.file-loaded', videoUrl(MOVIE));
    await flush();

    assert.equal(plugin.mpvProps.get('aid'), enabled ? '2' : undefined, `enabled=${enabled}`);
  }
});

test('subtitles in a preferred language are downloaded on load only when that option is on', async () => {
  const respond = (url) =>
    /\/PlaybackInfo/.test(url)
      ? {
          statusCode: 200,
          data: {
            PlaySessionId: 'ps',
            MediaSources: [
              {
                Id: MOVIE,
                MediaStreams: [
                  {
                    Type: 'Subtitle',
                    Index: 3,
                    Language: 'eng',
                    Codec: 'srt',
                    IsExternal: true,
                    IsTextSubtitleStream: true,
                  },
                  {
                    Type: 'Subtitle',
                    Index: 4,
                    Language: 'fre',
                    Codec: 'srt',
                    IsExternal: true,
                    IsTextSubtitleStream: true,
                  },
                ],
              },
            ],
          },
        }
      : defaultRespond(url);

  for (const enabled of [true, false]) {
    const plugin = loadPlugin({
      prefs: { auto_download_enabled: enabled, preferred_languages: 'en' },
      respond,
    });

    plugin.emit('iina.file-loaded', videoUrl(MOVIE));
    await flush();

    if (!enabled) {
      assert.deepEqual(plugin.downloads, []);
      assert.ok(!plugin.commands.some(([name]) => name === 'sub-add'));
      continue;
    }
    assert.deepEqual(
      plugin.downloads.map((download) => download.url),
      [`${SERVER}/Videos/${MOVIE}/${MOVIE}/Subtitles/3/stream.srt?ApiKey=urlkey`]
    );
    const added = plugin.commands.filter(([name]) => name === 'sub-add');
    assert.equal(added.length, 1);
    assert.equal(added[0][1], `/tmp/jellyfin_${MOVIE}_3_eng.srt`);
  }
});

test('the title set before loading is reused once the file has loaded', async () => {
  const plugin = loadPlugin({ prefs: { set_video_title: true } });
  plugin.mpvProps.set('stream-open-filename', videoUrl(MOVIE));
  let released = false;

  await plugin.hooks.on_load(() => {
    released = true;
  });

  assert.ok(released, 'the load continues');
  assert.equal(plugin.mpvProps.get('force-media-title'), 'Movie (2020)');

  plugin.emit('iina.file-loaded', videoUrl(MOVIE));
  await flush();

  assert.equal(plugin.gets.filter((url) => url.includes(`/Items/${MOVIE}?`)).length, 1);
  assert.equal(plugin.mpvProps.get('force-media-title'), 'Movie (2020)');
});

test('the on_load hook lets the file load when the title lookup fails', async () => {
  const plugin = loadPlugin({
    prefs: { set_video_title: true },
    respond: () => {
      throw new Error('offline');
    },
  });
  plugin.mpvProps.set('stream-open-filename', videoUrl(MOVIE));
  let released = false;

  await plugin.hooks.on_load(() => {
    released = true;
  });

  assert.ok(released);
  assert.equal(plugin.mpvProps.get('force-media-title'), undefined);
});

// Sidebar

test('the sidebar gets the client identity, servers and session once the window loads', () => {
  const plugin = loadPlugin({
    prefs: { debug_logging: true, ...withServers([signedInServer()]) },
  });

  plugin.loadSidebar();
  assert.deepEqual(plugin.sidebar.loaded, ['src/ui/sidebar/index.html']);
  assert.equal(plugin.sidebar.posted.length, 0, 'nothing is sent before the webview is ready');

  plugin.runTimers();
  const posted = plugin.sidebar.posted;
  assert.deepEqual(
    posted.map((message) => message.name),
    ['client-identity', 'servers-list', 'session-available']
  );
  assert.equal(posted[0].data.debugLogging, true);
  assert.equal(typeof posted[0].data.deviceId, 'string');
  assert.equal(posted[1].data.servers[0].id, 'srv-1');
  assert.equal(posted[2].data.serverUrl, SERVER);
});

test('the sidebar of a fresh install only gets the client identity', () => {
  const plugin = loadPlugin();

  plugin.loadSidebar();
  plugin.runTimers();

  assert.deepEqual(
    plugin.sidebar.posted.map((message) => message.name),
    ['client-identity']
  );
  assert.equal(plugin.sidebar.posted[0].data.debugLogging, false);
});

test('the sidebar can ask for the client identity and the session again', () => {
  const plugin = loadPlugin({ prefs: withServers([signedInServer()]) });
  plugin.loadSidebar();

  plugin.sidebar.handlers['get-client-identity']();
  plugin.sidebar.handlers['get-session']();

  const [identity, session] = plugin.sidebar.posted;
  assert.equal(identity.name, 'client-identity');
  assert.equal(identity.data.clientName, 'IINA Jellyfin Plugin');
  assert.equal(session.name, 'session-data');
  assert.equal(session.data.accessToken, 'accounttoken');
  assert.equal(session.data.username, 'me');
});

test('a sign-in from the sidebar becomes the active server', () => {
  const plugin = loadPlugin();
  plugin.loadSidebar();

  plugin.sidebar.handlers['store-session']({
    serverUrl: `${SERVER}/`,
    accessToken: 'token',
    serverName: 'Home',
    userId: 'user-1',
    username: 'me',
  });

  const [server] = plugin.servers();
  assert.equal(server.serverUrl, SERVER);
  assert.equal(server.username, 'me');
  assert.equal(plugin.store.get('jellyfin_active_server_id'), server.id);
  const updated = plugin.sidebar.posted.at(-1);
  assert.equal(updated.name, 'servers-updated');
  assert.equal(updated.data.activeServerId, server.id);
  assert.equal(updated.data.servers.length, 1);
});

test('an incomplete sign-in from the sidebar is ignored', () => {
  const plugin = loadPlugin();
  plugin.loadSidebar();

  plugin.sidebar.handlers['store-session']({ serverUrl: SERVER });
  plugin.sidebar.handlers['store-session']();

  assert.equal(plugin.store.get('jellyfin_servers'), undefined);
  assert.equal(plugin.sidebar.posted.length, 0);
});

test('the sidebar can list, switch and remove servers', () => {
  const second = signedInServer({ id: 'srv-2', serverUrl: 'https://two.example' });
  const plugin = loadPlugin({ prefs: withServers([signedInServer(), second]) });
  plugin.loadSidebar();

  plugin.sidebar.handlers['get-servers']();
  let message = plugin.sidebar.posted.at(-1);
  assert.equal(message.name, 'servers-list');
  assert.deepEqual(
    Array.from(message.data.servers, (server) => server.id),
    ['srv-1', 'srv-2']
  );
  assert.equal(message.data.activeServerId, 'srv-1');

  plugin.sidebar.handlers['switch-server']({ serverId: 'srv-2' });
  assert.equal(plugin.store.get('jellyfin_active_server_id'), 'srv-2');
  message = plugin.sidebar.posted.at(-1);
  assert.equal(message.name, 'server-switched');
  assert.equal(message.data.server.id, 'srv-2');

  plugin.sidebar.handlers['remove-server']({ serverId: 'srv-2' });
  assert.deepEqual(
    plugin.servers().map((server) => server.id),
    ['srv-1']
  );
  assert.equal(plugin.store.get('jellyfin_active_server_id'), 'srv-1');
  message = plugin.sidebar.posted.at(-1);
  assert.equal(message.name, 'servers-updated');
  assert.equal(message.data.activeServerId, 'srv-1');

  // Messages without a server id change nothing
  const before = plugin.sidebar.posted.length;
  plugin.sidebar.handlers['switch-server']({});
  plugin.sidebar.handlers['remove-server']();
  assert.equal(plugin.sidebar.posted.length, before);
  assert.equal(plugin.servers().length, 1);
});

test('clearing the session from the sidebar forgets every server', () => {
  const plugin = loadPlugin({ prefs: withServers([signedInServer()]) });
  plugin.loadSidebar();

  plugin.sidebar.handlers['clear-session']();

  assert.deepEqual(plugin.servers(), []);
  assert.equal(plugin.store.get('jellyfin_active_server_id'), '');
  assert.equal(plugin.sidebar.posted.at(-1).name, 'session-cleared');
});

test('an external link opened from the sidebar reports the outcome on the OSD', () => {
  const opens = loadPlugin();
  opens.loadSidebar();
  opens.sidebar.handlers['open-external-url']({ url: 'https://jf.example/web', title: 'Movie' });
  opens.sidebar.handlers['open-external-url']({ url: 'https://jf.example/web' });
  assert.deepEqual(opens.osd, ['Opened Movie in browser', 'Opened Jellyfin page in browser']);

  const refuses = loadPlugin({ openResult: false });
  refuses.loadSidebar();
  refuses.sidebar.handlers['open-external-url']({ url: 'https://jf.example/web' });
  assert.deepEqual(refuses.osd, ['Failed to open Jellyfin page in browser']);

  const throws = loadPlugin({ openResult: new Error('no browser') });
  throws.loadSidebar();
  throws.sidebar.handlers['open-external-url']({ url: 'https://jf.example/web' });
  assert.deepEqual(throws.osd, ['Failed to open Jellyfin page in browser']);
});

test('an external link request without a URL is ignored', () => {
  const plugin = loadPlugin();
  plugin.loadSidebar();

  plugin.sidebar.handlers['open-external-url']({ title: 'Movie' });

  assert.deepEqual(plugin.externalOpens, []);
  assert.deepEqual(plugin.osd, []);
});

test('the standalone window opens external links without an OSD message', () => {
  const plugin = loadPlugin({ window: { loaded: true, visible: false } });
  plugin.findMenuItem('Show Jellyfin Browser').action();
  plugin.osd.length = 0;

  plugin.standaloneWindow.handlers['open-external-url']({ url: 'https://jf.example/web' });

  assert.deepEqual(plugin.externalOpens, ['https://jf.example/web']);
  assert.deepEqual(plugin.osd, []);
});

// Playback requests

test('playing from the sidebar replaces the current file and titles it', () => {
  const plugin = loadPlugin({ prefs: { set_video_title: true } });
  plugin.loadSidebar();

  plugin.sidebar.handlers['play-media']({ streamUrl: videoUrl(MOVIE), title: 'Movie (2020)' });

  assert.deepEqual(plugin.commands, [['playlist-clear']]);
  assert.deepEqual(plugin.opened, [videoUrl(MOVIE)]);
  assert.deepEqual(plugin.osd, ['Opening: Movie (2020)']);
  assert.equal(plugin.mpvProps.get('force-media-title'), 'Movie (2020)');
});

test('with open in new window the sidebar asks the global entry for a new player', () => {
  const plugin = loadPlugin({ prefs: { open_in_new_window: true } });
  plugin.loadSidebar();

  plugin.sidebar.handlers['play-media']({ streamUrl: videoUrl(MOVIE), title: 'Movie' });

  assert.equal(plugin.global.posted.length, 1);
  const [request] = plugin.global.posted;
  assert.equal(request.name, 'create-player');
  assert.deepEqual({ ...request.data }, { url: videoUrl(MOVIE), title: 'Movie' });
  assert.deepEqual(plugin.opened, []);
  assert.deepEqual(plugin.osd, ['Opening in new window: Movie']);
});

test('a new player that cannot be created falls back to the current window', () => {
  const plugin = loadPlugin();

  plugin.global.handlers['player-created']({ playerId: 2, title: 'Movie', url: videoUrl(MOVIE) });
  assert.deepEqual(plugin.osd, ['Opened in new window: Movie']);

  plugin.global.handlers['player-creation-failed']({ error: 'boom', url: videoUrl(MOVIE) });
  assert.deepEqual(plugin.opened, [videoUrl(MOVIE)]);
  assert.equal(plugin.osd.at(-1), 'Failed to open new window - opening in current window');
});

test('an album plays its first track and appends the rest once that track has loaded', () => {
  const plugin = loadPlugin({ prefs: { set_video_title: true } });
  plugin.loadSidebar();

  plugin.sidebar.handlers['play-media-list']({
    items: [
      { streamUrl: audioUrl(MOVIE), title: 'Track 1' },
      { streamUrl: audioUrl(TRACK_2), title: 'Track 2' },
      { title: 'Not playable' },
      { streamUrl: audioUrl(TRACK_3), title: 'Hello, Goodbye' },
    ],
  });

  assert.deepEqual(plugin.opened, [audioUrl(MOVIE)]);
  assert.deepEqual(plugin.osd, ['Playing 3 tracks, starting with: Track 1']);
  assert.ok(!plugin.commands.some(([name]) => name === 'loadfile'), 'nothing appended yet');

  plugin.emit('iina.file-loaded', audioUrl(MOVIE));

  assert.deepEqual(
    plugin.commands.filter(([name]) => name === 'loadfile'),
    [
      ['loadfile', audioUrl(TRACK_2), 'append', '-1', 'force-media-title=%7%Track 2'],
      ['loadfile', audioUrl(TRACK_3), 'append', '-1', 'force-media-title=%14%Hello, Goodbye'],
    ]
  );

  // The queue is used once
  plugin.emit('iina.file-loaded', audioUrl(MOVIE));
  assert.equal(plugin.commands.filter(([name]) => name === 'loadfile').length, 2);
});

test('a single track from a list is opened without queueing anything', () => {
  const plugin = loadPlugin();
  plugin.loadSidebar();

  plugin.sidebar.handlers['play-media-list']({
    items: [{ streamUrl: audioUrl(MOVIE), title: 'Track 1' }],
  });
  plugin.emit('iina.file-loaded', audioUrl(MOVIE));

  assert.deepEqual(plugin.osd, ['Opening: Track 1']);
  assert.ok(!plugin.commands.some(([name]) => name === 'loadfile'));
});

test('queued tracks are dropped when a different file loads first', () => {
  const plugin = loadPlugin();
  plugin.loadSidebar();

  plugin.sidebar.handlers['play-media-list']({
    items: [
      { streamUrl: audioUrl(MOVIE), title: 'Track 1' },
      { streamUrl: audioUrl(TRACK_2), title: 'Track 2' },
    ],
  });
  plugin.emit('iina.file-loaded', videoUrl(OTHER));

  assert.ok(!plugin.commands.some(([name]) => name === 'loadfile'));
});

test('queued tracks older than a minute are not appended', () => {
  const plugin = loadPlugin();
  plugin.loadSidebar();

  plugin.sidebar.handlers['play-media-list']({
    items: [
      { streamUrl: audioUrl(MOVIE), title: 'Track 1' },
      { streamUrl: audioUrl(TRACK_2), title: 'Track 2' },
    ],
  });
  plugin.clock.now += 61000;
  plugin.emit('iina.file-loaded', audioUrl(MOVIE));

  assert.ok(!plugin.commands.some(([name]) => name === 'loadfile'));
});

test('a list without playable items shows Nothing to play', () => {
  const plugin = loadPlugin();
  plugin.loadSidebar();

  plugin.sidebar.handlers['play-media-list']({ items: [{ title: 'No stream' }, null] });
  plugin.sidebar.handlers['play-media-list']({});

  assert.deepEqual(plugin.osd, ['Nothing to play', 'Nothing to play']);
  assert.deepEqual(plugin.opened, []);
});

// Stop reports

async function playTracked(plugin, url = videoUrl(MOVIE)) {
  plugin.emit('iina.file-loaded', url);
  await flush();
}

test('a tracked file that ends on its own sends its stop report', async () => {
  const plugin = loadPlugin({ prefs: { sync_playback_progress: true } });
  await playTracked(plugin);

  plugin.emit('mpv.end-file');

  const stops = plugin.postsTo('/Sessions/Playing/Stopped');
  assert.equal(stops.length, 1);
  assert.equal(stops[0].data.ItemId, MOVIE);
});

test('closing the window stops tracking the file', async () => {
  const plugin = loadPlugin({ prefs: { sync_playback_progress: true } });
  await playTracked(plugin);

  plugin.emit('iina.window-will-close');

  assert.equal(plugin.postsTo('/Sessions/Playing/Stopped').length, 1);
});

test('pausing reports progress at the current position', async () => {
  const plugin = loadPlugin({ prefs: { sync_playback_progress: true } });
  await playTracked(plugin);

  plugin.core.status.position = 42;
  plugin.core.status.paused = true;
  plugin.emit('mpv.pause.changed');

  const [progress] = plugin.postsTo('/Sessions/Playing/Progress');
  assert.equal(progress.data.PositionTicks, 42 * 10000000);
  assert.equal(progress.data.IsPaused, true);
});

test('opening another item from the sidebar sends the stop report once the new file loads', async () => {
  const plugin = loadPlugin({ prefs: { sync_playback_progress: true } });
  plugin.loadSidebar();
  await playTracked(plugin);
  plugin.core.status.position = 120;
  plugin.emit('mpv.pause.changed');

  plugin.sidebar.handlers['play-media']({ streamUrl: videoUrl(OTHER), title: 'Other' });
  plugin.emit('mpv.end-file');
  assert.equal(plugin.postsTo('/Sessions/Playing/Stopped').length, 0);

  // The next file now plays from 0; the stop still carries the old position
  plugin.core.status.position = 0;
  await playTracked(plugin, videoUrl(OTHER));

  const stops = plugin.postsTo('/Sessions/Playing/Stopped');
  assert.equal(stops.length, 1);
  assert.equal(stops[0].data.ItemId, MOVIE);
  assert.equal(stops[0].data.PositionTicks, 120 * 10000000);
});

test('a replacement guard older than ten seconds no longer holds back the stop report', async () => {
  const plugin = loadPlugin({ prefs: { sync_playback_progress: true } });
  plugin.loadSidebar();
  await playTracked(plugin);

  plugin.sidebar.handlers['play-media']({ streamUrl: videoUrl(OTHER), title: 'Other' });
  plugin.clock.now += 11000;
  plugin.emit('mpv.end-file');

  const stops = plugin.postsTo('/Sessions/Playing/Stopped');
  assert.equal(stops.length, 1);
  assert.equal(stops[0].data.ItemId, MOVIE);
});

test('an episode with the next one queued keeps its stop report until the next episode loads', async () => {
  const episode = (id, number, name) => ({
    Id: id,
    Name: name,
    IndexNumber: number,
    MediaSources: [{ Id: id }],
  });
  const plugin = loadPlugin({
    prefs: { sync_playback_progress: true, autoplay_next_episode: true },
    respond(url) {
      if (url.includes('/Shows/series-1/Episodes')) {
        return {
          statusCode: 200,
          data: { Items: [episode(MOVIE, 1, 'Pilot'), episode(OTHER, 2, 'Second')] },
        };
      }
      if (url.includes(`/Items/${MOVIE}?`)) {
        return {
          statusCode: 200,
          data: {
            Name: 'Pilot',
            Type: 'Episode',
            SeriesId: 'series-1',
            SeasonId: 'season-1',
            SeriesName: 'Show',
            ParentIndexNumber: 1,
            IndexNumber: 1,
            UserData: {},
          },
        };
      }
      return defaultRespond(url);
    },
  });

  await playTracked(plugin);
  const queued = plugin.commands.find(([name]) => name === 'loadfile');
  assert.equal(queued[1], `${SERVER}/Videos/${OTHER}/stream?static=true&ApiKey=urlkey`);
  assert.equal(queued[2], 'insert-next');

  plugin.emit('mpv.end-file');
  assert.equal(plugin.postsTo('/Sessions/Playing/Stopped').length, 0);

  await playTracked(plugin, queued[1]);
  const stops = plugin.postsTo('/Sessions/Playing/Stopped');
  assert.equal(stops.length, 1);
  assert.equal(stops[0].data.ItemId, MOVIE);
});

// Versions

test('an item with several versions can be switched from the menu at the current position', async () => {
  const plugin = loadPlugin({
    prefs: { sync_playback_progress: true, show_notifications: false },
    respond(url) {
      if (url.includes('/PlaybackInfo')) {
        return {
          statusCode: 200,
          data: {
            PlaySessionId: 'ps',
            MediaSources: [
              { Id: 'v1', Name: '4K' },
              { Id: 'v2', Name: '1080p' },
            ],
          },
        };
      }
      return {
        statusCode: 200,
        data: { Name: 'Movie', Type: 'Movie', UserData: { PlaybackPositionTicks: 1000 * 1e7 } },
      };
    },
  });

  await playTracked(plugin);
  plugin.runTimers();
  assert.deepEqual(plugin.seeks, [1000], 'a normal load resumes at the stored position');

  const versionMenu = () => plugin.findMenuItem('Jellyfin Version');
  assert.deepEqual(
    versionMenu().subItems.map((item) => [item.title, item.options.selected]),
    [
      ['4K', true],
      ['1080p', false],
    ]
  );
  assert.ok(plugin.menuState.forceUpdates > 0);

  // Picking the version already playing does nothing
  versionMenu().subItems[0].action();
  assert.deepEqual(plugin.opened, []);

  plugin.core.status.position = 600;
  plugin.mpvProps.set('media-title', 'Movie');
  versionMenu().subItems[1].action();

  const switchedUrl = videoUrl(MOVIE, '&MediaSourceId=v2');
  assert.deepEqual(plugin.opened, [switchedUrl]);
  assert.equal(plugin.osd.at(-1), 'Switching to 1080p');

  plugin.emit('mpv.end-file');
  plugin.mpvProps.set('stream-open-filename', switchedUrl);
  await plugin.hooks.on_load(() => {});
  assert.equal(plugin.mpvProps.get('file-local-options/start'), '600');

  plugin.seeks.length = 0;
  await playTracked(plugin, switchedUrl);
  plugin.runTimers();

  const starts = plugin.postsTo('/Sessions/Playing?');
  assert.equal(starts.at(-1).data.MediaSourceId, 'v2');
  assert.deepEqual(plugin.seeks, [], 'the switched version does not seek to the resume point');
  assert.deepEqual(
    versionMenu().subItems.map((item) => item.options.selected),
    [false, true]
  );
});

test('a file that is not a Jellyfin item removes the version submenu', async () => {
  const plugin = loadPlugin({
    respond(url) {
      if (url.includes('/PlaybackInfo')) {
        return { statusCode: 200, data: { MediaSources: [{ Id: 'v1' }, { Id: 'v2' }] } };
      }
      return defaultRespond(url);
    },
  });

  await playTracked(plugin);
  assert.ok(plugin.findMenuItem('Jellyfin Version'));

  plugin.emit('iina.file-loaded', '/Users/me/Videos/movie.mp4');

  assert.equal(plugin.findMenuItem('Jellyfin Version'), undefined);
  assert.equal(plugin.menuState.items.length, 3);
});
