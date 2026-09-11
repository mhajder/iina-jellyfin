import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeIina, flushPromises } from './helpers/fake-iina.js';

const SERVER = 'http://jf.local:8096';
const KEY = 'urlkey12345678';
const ITEM = 'item-1';
const STREAM_URL = `${SERVER}/Videos/${ITEM}/stream?static=true&api_key=${KEY}`;

const DEFAULT_PREFS = {
  debug_logging: true,
  auto_login_enabled: true,
  auto_download_enabled: false,
  sync_playback_progress: false,
  set_video_title: false,
  autoplay_next_episode: false,
  open_in_new_window: false,
  show_notifications: false,
  jellyfin_device_id: 'device-1',
};

function jsonResponse(data) {
  return { data, statusCode: 200 };
}

/**
 * Route http.get calls by URL substring; unmatched urls resolve with no data.
 */
function routeHttp(iina, routes) {
  iina.http.get.mockImplementation(async (url) => {
    const match = routes.find(([fragment]) => url.includes(fragment));
    return match
      ? jsonResponse(typeof match[1] === 'function' ? match[1](url) : match[1])
      : { data: null };
  });
}

function storedServers(servers) {
  return { jellyfin_servers: JSON.stringify(servers) };
}

async function loadPlugin(options = {}) {
  const fake = createFakeIina({
    preferences: { ...DEFAULT_PREFS, ...(options.preferences || {}) },
    files: options.files || {},
  });
  if (options.mutate) {
    options.mutate(fake);
  }
  globalThis.iina = fake.iina;
  vi.resetModules();
  await import('../../src/index.js');
  return fake;
}

function logged(fake) {
  return fake.iina.console.log.mock.calls.map((call) => call[0]);
}

describe('plugin main entry', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete globalThis.iina;
  });

  describe('startup', () => {
    it('registers menu items, events and global replies', async () => {
      const fake = await loadPlugin();

      expect(fake.menuItems.map((item) => item.label)).toEqual([
        'Download Jellyfin Subtitles',
        'Set Jellyfin Title',
        'Show Offline Downloads Folder',
        'Show Jellyfin Browser',
      ]);
      expect(fake.menuItem('Show Jellyfin Browser').options).toEqual({
        keyBinding: 'Meta+Shift+j',
      });
      expect(Object.keys(fake.eventHandlers).sort()).toEqual([
        'iina.application-will-terminate',
        'iina.file-loaded',
        'iina.window-loaded',
        'iina.window-will-close',
        'mpv.end-file',
        'mpv.pause.changed',
      ]);
      expect(Object.keys(fake.iina.global.handlers).sort()).toEqual([
        'player-created',
        'player-creation-failed',
      ]);
      expect(logged(fake)).toContain('DEBUG: Jellyfin Subtitles Plugin loaded');
    });

    it('works without a global entry', async () => {
      const fake = await loadPlugin({
        mutate: (f) => {
          f.iina.global = undefined;
        },
      });
      expect(fake.menuItems).toHaveLength(4);
    });
  });

  describe('menu actions', () => {
    it('reports missing Jellyfin media for the manual actions', async () => {
      const fake = await loadPlugin();
      fake.menuItem('Download Jellyfin Subtitles').callback();
      fake.menuItem('Set Jellyfin Title').callback();
      expect(fake.iina.core.osd).toHaveBeenCalledTimes(2);
      expect(fake.iina.core.osd).toHaveBeenCalledWith(
        'No Jellyfin media detected. Please open a Jellyfin URL first.'
      );
    });

    it('opens the offline downloads folder', async () => {
      const fake = await loadPlugin();
      fake.menuItem('Show Offline Downloads Folder').callback();
      await flushPromises();
      expect(fake.iina.utils.exec).toHaveBeenCalledWith('mkdir', ['-p', '/abs/data/offline']);
      expect(fake.iina.file.showInFinder).toHaveBeenCalledWith('@data/offline');
    });
  });

  describe('showing the browser', () => {
    it('shows the sidebar when the player window is visible', async () => {
      const fake = await loadPlugin();
      fake.menuItem('Show Jellyfin Browser').callback();
      expect(fake.iina.sidebar.show).toHaveBeenCalledTimes(1);
      expect(fake.iina.standaloneWindow.open).not.toHaveBeenCalled();
    });

    it('falls back to a standalone window when there is no visible window', async () => {
      vi.useFakeTimers();
      const fake = await loadPlugin({
        preferences: storedServers([
          { id: 'srv-1', serverUrl: SERVER, accessToken: 'tok', serverName: 'Home' },
        ]),
      });
      fake.iina.core.window.visible = false;

      fake.menuItem('Show Jellyfin Browser').callback();

      const win = fake.iina.standaloneWindow;
      expect(win.loadFile).toHaveBeenCalledWith('src/ui/sidebar/index.html');
      expect(win.setFrame).toHaveBeenCalledWith(400, 600, 100, 100);
      expect(win.setProperty).toHaveBeenCalledWith({ title: 'Jellyfin Browser', resizable: true });
      expect(win.open).toHaveBeenCalledTimes(1);
      expect(fake.iina.core.osd).toHaveBeenCalledWith(
        'Jellyfin Browser opened in standalone window\nServer: jf.local:8096'
      );
      expect(Object.keys(win.handlers)).toEqual(
        expect.arrayContaining([
          'get-client-identity',
          'get-session',
          'play-media',
          'play-media-list',
          'clear-session',
          'store-session',
          'get-servers',
          'remove-server',
          'switch-server',
          'open-external-url',
          'get-offline-downloads',
          'offline-download',
          'play-offline',
        ])
      );

      vi.advanceTimersByTime(1000);
      expect(win.postMessage).toHaveBeenCalledWith(
        'client-identity',
        expect.objectContaining({ deviceId: 'device-1' })
      );
      expect(win.postMessage).toHaveBeenCalledWith('servers-list', {
        servers: [expect.objectContaining({ id: 'srv-1' })],
        activeServerId: null,
      });
      expect(win.postMessage).toHaveBeenCalledWith(
        'session-available',
        expect.objectContaining({ serverUrl: SERVER })
      );
    });

    it('asks to login when no session is stored', async () => {
      vi.useFakeTimers();
      const fake = await loadPlugin();
      fake.iina.core.window.loaded = false;
      fake.menuItem('Show Jellyfin Browser').callback();
      expect(fake.iina.core.osd).toHaveBeenCalledWith(
        'Jellyfin Browser opened in standalone window\nPlease login to access your media'
      );
      vi.advanceTimersByTime(1000);
      expect(fake.iina.standaloneWindow.postMessage).not.toHaveBeenCalledWith(
        'session-available',
        expect.anything()
      );
    });

    it('falls back when sidebar.show throws or the window state cannot be read', async () => {
      const fake = await loadPlugin();
      fake.iina.sidebar.show.mockImplementation(() => {
        throw new Error('no sidebar');
      });
      fake.menuItem('Show Jellyfin Browser').callback();
      expect(fake.iina.standaloneWindow.open).toHaveBeenCalledTimes(1);
      expect(logged(fake)).toContain('DEBUG: Direct sidebar.show() failed: no sidebar');

      Object.defineProperty(fake.iina.core, 'window', {
        get() {
          throw new Error('gone');
        },
      });
      fake.menuItem('Show Jellyfin Browser').callback();
      expect(logged(fake)).toContain('DEBUG: Could not read window state: gone');
      expect(fake.iina.standaloneWindow.open).toHaveBeenCalledTimes(2);
    });

    it('logs when the standalone window cannot be created', async () => {
      const fake = await loadPlugin();
      fake.iina.core.window.visible = false;
      fake.iina.standaloneWindow.loadFile.mockImplementation(() => {
        throw new Error('no window');
      });
      fake.menuItem('Show Jellyfin Browser').callback();
      expect(logged(fake)).toContain('DEBUG: Failed to create standalone window: no window');
    });
  });

  describe('standalone window messages', () => {
    async function openStandalone(options) {
      const fake = await loadPlugin(options);
      fake.iina.core.window.visible = false;
      fake.menuItem('Show Jellyfin Browser').callback();
      return fake;
    }

    it('answers identity, session and server list requests', async () => {
      const fake = await openStandalone({
        preferences: storedServers([{ id: 'srv-1', serverUrl: SERVER, accessToken: 'tok' }]),
      });
      const win = fake.iina.standaloneWindow;

      win.emit('get-client-identity');
      expect(win.postMessage).toHaveBeenCalledWith(
        'client-identity',
        expect.objectContaining({ clientName: 'IINA Jellyfin Plugin' })
      );
      win.emit('get-session');
      expect(win.postMessage).toHaveBeenCalledWith(
        'session-data',
        expect.objectContaining({ serverId: 'srv-1' })
      );
      win.emit('get-servers');
      expect(win.postMessage).toHaveBeenCalledWith('servers-list', {
        servers: [expect.objectContaining({ id: 'srv-1' })],
        activeServerId: null,
      });
      win.emit('get-offline-downloads');
      expect(win.postMessage).toHaveBeenCalledWith('offline-downloads', {
        downloads: [],
        directory: '/abs/data/offline',
      });
    });

    it('plays media and closes the window', async () => {
      const fake = await openStandalone();
      const win = fake.iina.standaloneWindow;

      win.emit('play-media', { streamUrl: STREAM_URL, title: 'Film' });
      expect(fake.iina.core.open).toHaveBeenCalledWith(STREAM_URL);
      expect(win.close).toHaveBeenCalledTimes(1);

      win.emit('play-media-list', { items: [{ streamUrl: STREAM_URL, title: 'Track' }] });
      expect(fake.iina.core.open).toHaveBeenCalledTimes(2);
      expect(win.close).toHaveBeenCalledTimes(2);
    });

    it('stores, switches, removes and clears sessions', async () => {
      const fake = await openStandalone();
      const win = fake.iina.standaloneWindow;

      win.emit('store-session', { serverUrl: SERVER });
      expect(win.postMessage).not.toHaveBeenCalledWith('servers-updated', expect.anything());

      win.emit('store-session', {
        serverUrl: `${SERVER}/`,
        accessToken: 'tok',
        serverName: 'Home',
        userId: 'u1',
        username: 'me',
      });
      const stored = JSON.parse(fake.prefs.get('jellyfin_servers'));
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ serverUrl: SERVER, userId: 'u1', username: 'me' });
      expect(win.postMessage).toHaveBeenCalledWith('servers-updated', {
        servers: [expect.objectContaining({ id: stored[0].id })],
        activeServerId: stored[0].id,
      });

      win.emit('store-session', { serverUrl: 'http://second', accessToken: 'tok2' });
      const both = JSON.parse(fake.prefs.get('jellyfin_servers'));
      expect(both).toHaveLength(2);
      expect(both[1]).toMatchObject({
        serverName: 'http://second',
        userId: '',
        username: '',
      });

      win.emit('switch-server', { serverId: stored[0].id });
      expect(fake.prefs.get('jellyfin_active_server_id')).toBe(stored[0].id);
      win.emit('switch-server', {});
      win.emit('switch-server', { serverId: 'missing' });

      win.emit('remove-server', {});
      expect(JSON.parse(fake.prefs.get('jellyfin_servers'))).toHaveLength(2);
      win.emit('remove-server', { serverId: both[1].id });
      expect(JSON.parse(fake.prefs.get('jellyfin_servers'))).toHaveLength(1);

      win.emit('clear-session');
      expect(JSON.parse(fake.prefs.get('jellyfin_servers'))).toEqual([]);
      expect(win.postMessage).toHaveBeenCalledWith('session-cleared', {});
    });

    it('does not report a server that failed to store', async () => {
      const fake = await openStandalone();
      const win = fake.iina.standaloneWindow;
      fake.iina.preferences.set.mockImplementation(() => {
        throw new Error('disk full');
      });
      win.postMessage.mockClear();

      win.emit('store-session', { serverUrl: SERVER, accessToken: 'tok' });

      expect(win.postMessage).not.toHaveBeenCalledWith('servers-updated', expect.anything());
    });

    it('opens external urls', async () => {
      const fake = await openStandalone();
      const win = fake.iina.standaloneWindow;

      win.emit('open-external-url', { url: 'http://jf.local/web' });
      expect(fake.iina.utils.open).toHaveBeenCalledWith('http://jf.local/web');

      win.emit('open-external-url', {});
      expect(fake.iina.utils.open).toHaveBeenCalledTimes(1);

      fake.iina.utils.open.mockImplementation(() => {
        throw new Error('no browser');
      });
      win.emit('open-external-url', { url: 'http://x' });
      expect(logged(fake)).toContain('DEBUG: Failed to open external URL: no browser');
    });
  });

  describe('sidebar wiring on window load', () => {
    async function loadWithSidebar(options) {
      const fake = await loadPlugin(options);
      fake.emit('iina.window-loaded');
      return fake;
    }

    it('loads the sidebar and sends the initial data', async () => {
      vi.useFakeTimers();
      const fake = await loadWithSidebar({
        preferences: {
          ...storedServers([{ id: 'srv-1', serverUrl: SERVER, accessToken: 'tok' }]),
          jellyfin_active_server_id: 'srv-1',
        },
      });
      const sidebar = fake.iina.sidebar;
      expect(sidebar.loadFile).toHaveBeenCalledWith('src/ui/sidebar/index.html');

      vi.advanceTimersByTime(500);
      expect(sidebar.postMessage).toHaveBeenCalledWith(
        'client-identity',
        expect.objectContaining({ deviceId: 'device-1' })
      );
      expect(sidebar.postMessage).toHaveBeenCalledWith('servers-list', {
        servers: [expect.objectContaining({ id: 'srv-1' })],
        activeServerId: 'srv-1',
      });
      expect(sidebar.postMessage).toHaveBeenCalledWith(
        'session-available',
        expect.objectContaining({ serverId: 'srv-1' })
      );
    });

    it('skips server messages when nothing is stored', async () => {
      vi.useFakeTimers();
      const fake = await loadWithSidebar();
      vi.advanceTimersByTime(500);
      const names = fake.iina.sidebar.postMessage.mock.calls.map((call) => call[0]);
      expect(names).toEqual(['client-identity']);
    });

    it('handles session and server messages', async () => {
      const fake = await loadWithSidebar();
      const sidebar = fake.iina.sidebar;

      sidebar.emit('get-client-identity');
      expect(sidebar.postMessage).toHaveBeenCalledWith('client-identity', expect.anything());

      sidebar.emit('get-session');
      expect(sidebar.postMessage).toHaveBeenCalledWith('session-data', null);

      sidebar.emit('store-session', { accessToken: 'only-token' });
      sidebar.emit('store-session', { serverUrl: SERVER, accessToken: 'tok', userId: 'u1' });
      const servers = JSON.parse(fake.prefs.get('jellyfin_servers'));
      expect(servers).toHaveLength(1);
      expect(sidebar.postMessage).toHaveBeenCalledWith('servers-updated', {
        servers: [expect.objectContaining({ id: servers[0].id })],
        activeServerId: servers[0].id,
      });

      sidebar.emit('get-servers');
      expect(sidebar.postMessage).toHaveBeenCalledWith('servers-list', {
        servers: [expect.objectContaining({ id: servers[0].id })],
        activeServerId: servers[0].id,
      });

      sidebar.emit('switch-server', { serverId: servers[0].id });
      expect(sidebar.postMessage).toHaveBeenCalledWith(
        'server-switched',
        expect.objectContaining({ activeServerId: servers[0].id })
      );
      sidebar.emit('switch-server', null);

      sidebar.emit('remove-server', null);
      sidebar.emit('remove-server', { serverId: servers[0].id });
      expect(JSON.parse(fake.prefs.get('jellyfin_servers'))).toEqual([]);

      sidebar.emit('clear-session');
      expect(sidebar.postMessage).toHaveBeenCalledWith('session-cleared', {});
    });

    it('ignores a store-session that could not be saved', async () => {
      const fake = await loadWithSidebar();
      fake.iina.preferences.set.mockImplementation(() => {
        throw new Error('disk full');
      });
      fake.iina.sidebar.emit('store-session', { serverUrl: SERVER, accessToken: 'tok' });
      expect(fake.iina.sidebar.postMessage).not.toHaveBeenCalledWith(
        'servers-updated',
        expect.anything()
      );
    });

    it('plays media requested by the sidebar', async () => {
      const fake = await loadWithSidebar();
      fake.iina.sidebar.emit('play-media', { streamUrl: STREAM_URL, title: 'Film' });
      expect(fake.iina.mpv.set).toHaveBeenCalledWith('force-media-title', 'Film');
      expect(fake.iina.core.open).toHaveBeenCalledWith(STREAM_URL);

      fake.iina.sidebar.emit('play-media-list', { items: [] });
      expect(fake.iina.core.osd).toHaveBeenCalledWith('Nothing to play');
    });

    it('opens external urls with feedback', async () => {
      const fake = await loadWithSidebar();
      const sidebar = fake.iina.sidebar;

      sidebar.emit('open-external-url', { url: 'http://x/details', title: 'Film' });
      expect(fake.iina.core.osd).toHaveBeenCalledWith('Opened Film in browser');

      sidebar.emit('open-external-url', { url: 'http://x/details' });
      expect(fake.iina.core.osd).toHaveBeenCalledWith('Opened Jellyfin page in browser');

      fake.iina.utils.open.mockReturnValue(false);
      sidebar.emit('open-external-url', { url: 'http://x/fail' });
      expect(fake.iina.core.osd).toHaveBeenCalledWith('Failed to open Jellyfin page in browser');
      expect(logged(fake)).toContain(
        'DEBUG: Failed to open external URL: utils.open returned false'
      );

      sidebar.emit('open-external-url', { title: 'no url' });
      expect(logged(fake)).toContain('DEBUG: Invalid open-external-url message - missing URL');
    });

    it('registers the offline download messages', async () => {
      const fake = await loadWithSidebar();
      const sidebar = fake.iina.sidebar;

      sidebar.emit('get-offline-downloads');
      expect(sidebar.postMessage).toHaveBeenCalledWith('offline-downloads', {
        downloads: [],
        directory: '/abs/data/offline',
      });

      routeHttp(fake.iina, [
        [
          '/PlaybackInfo',
          { MediaSources: [{ Id: 'src', Container: 'mkv', Size: 10, MediaStreams: [] }] },
        ],
      ]);
      fake.iina.http.download.mockImplementation(async (url, destination) => {
        fake.files.set(destination, 'media');
      });

      sidebar.emit('offline-download', {
        item: { Id: ITEM, Type: 'Movie', Name: 'Film' },
        serverUrl: SERVER,
        accessToken: 'tok',
      });
      await flushPromises(20);

      const posted = sidebar.postMessage.mock.calls.filter(
        (call) => call[0] === 'offline-downloads'
      );
      const last = posted[posted.length - 1][1];
      expect(last.downloads[0]).toMatchObject({ itemId: ITEM, status: 'completed' });
      // Both views receive the update
      expect(fake.iina.standaloneWindow.postMessage).toHaveBeenCalledWith(
        'offline-downloads',
        expect.anything()
      );

      sidebar.emit('play-offline', { itemId: ITEM });
      expect(fake.iina.core.open).toHaveBeenCalledWith('/abs/data/offline/item-1.mkv');
      expect(fake.iina.mpv.set).toHaveBeenCalledWith('force-media-title', 'Film');
    });

    it('survives views that cannot receive messages', async () => {
      const fake = await loadWithSidebar({
        mutate: (f) => {
          f.iina.standaloneWindow = undefined;
        },
      });
      fake.iina.sidebar.postMessage.mockImplementation((name) => {
        if (name === 'offline-downloads') throw new Error('view gone');
      });

      fake.iina.sidebar.emit('offline-download', {
        item: { Id: ITEM, Type: 'Movie', Name: 'Film' },
        serverUrl: SERVER,
        accessToken: 'tok',
      });
      await flushPromises(20);

      expect(logged(fake)).toContain(
        'DEBUG: Could not post offline-downloads to a view: view gone'
      );
    });
  });

  describe('file loading', () => {
    it('ignores plain local files', async () => {
      const fake = await loadPlugin();
      fake.emit('iina.file-loaded', '/Users/me/movie.mkv');
      expect(fake.iina.http.get).not.toHaveBeenCalled();
      expect(logged(fake)).toContain(
        'DEBUG: Non-Jellyfin URL loaded, clearing stored Jellyfin data'
      );
    });

    it('attaches subtitles when an offline download is loaded', async () => {
      const fake = await loadPlugin({
        files: {
          '@data/offline/manifest.json': JSON.stringify([
            {
              itemId: ITEM,
              title: 'Film (2020)',
              status: 'completed',
              mediaPath: '@data/offline/item-1.mkv',
              mediaAbsolutePath: '/abs/data/offline/item-1.mkv',
              subtitles: [
                {
                  path: '@data/offline/item-1_sub_3_eng.srt',
                  absolutePath: '/abs/data/offline/item-1_sub_3_eng.srt',
                },
              ],
            },
          ]),
          '@data/offline/item-1.mkv': 'x',
          '@data/offline/item-1_sub_3_eng.srt': 'x',
        },
      });

      fake.emit('iina.file-loaded', 'file:///abs/data/offline/item-1.mkv');

      expect(fake.iina.mpv.set).toHaveBeenCalledWith('force-media-title', 'Film (2020)');
      expect(fake.iina.core.subtitle.loadTrack).toHaveBeenCalledWith(
        '/abs/data/offline/item-1_sub_3_eng.srt'
      );
      expect(fake.iina.http.get).not.toHaveBeenCalled();
      expect(logged(fake)).toContain(
        'DEBUG: Offline download loaded, subtitles attached from local files'
      );
    });

    it('stores the url session and runs nothing else when features are off', async () => {
      const fake = await loadPlugin();
      fake.emit('iina.file-loaded', STREAM_URL);

      const servers = JSON.parse(fake.prefs.get('jellyfin_servers'));
      expect(servers[0]).toMatchObject({ serverUrl: SERVER, accessToken: KEY });
      expect(fake.iina.http.get).not.toHaveBeenCalled();
      expect(logged(fake)).toContain(
        'DEBUG: Auto download disabled, but Jellyfin URL stored for manual download'
      );
    });

    it('does not store the session when auto-login is off', async () => {
      const fake = await loadPlugin({ preferences: { auto_login_enabled: false } });
      fake.emit('iina.file-loaded', STREAM_URL);
      expect(fake.prefs.get('jellyfin_servers')).toBeUndefined();
      expect(logged(fake)).toContain(
        'DEBUG: Auto-login from Jellyfin URLs disabled, not storing the URL credentials'
      );
    });

    it('runs every feature for a Jellyfin url', async () => {
      const fake = await loadPlugin({
        preferences: {
          sync_playback_progress: true,
          set_video_title: true,
          autoplay_next_episode: true,
          auto_download_enabled: true,
        },
      });
      routeHttp(fake.iina, [
        ['/PlaybackInfo', { PlaySessionId: 'ps', MediaSources: [{ Id: 'src', MediaStreams: [] }] }],
        [`/Items/${ITEM}?`, { Name: 'Film', Type: 'Movie', ProductionYear: 2020, UserData: {} }],
      ]);

      fake.emit('iina.file-loaded', STREAM_URL);
      await flushPromises(10);

      expect(fake.iina.mpv.set).toHaveBeenCalledWith('force-media-title', 'Film (2020)');
      expect(fake.iina.http.post).toHaveBeenCalledWith(
        `${SERVER}/Sessions/Playing?api_key=${KEY}`,
        expect.objectContaining({ data: expect.objectContaining({ ItemId: ITEM }) })
      );
      const urls = fake.iina.http.get.mock.calls.map((call) => call[0]);
      expect(urls.some((url) => url.includes('/PlaybackInfo'))).toBe(true);
      expect(logged(fake)).toContain(`DEBUG: Auto-downloading subtitles for: ${ITEM}`);
      expect(logged(fake)).toContain(`DEBUG: Setting up autoplay for episode (itemId): ${ITEM}`);
    });

    describe('connected account reporting', () => {
      const session = [
        {
          id: 'srv-1',
          serverUrl: 'https://JF.local:8096',
          accessToken: 'account-token',
          userId: 'u1',
          username: 'me',
        },
      ];

      it('reports to the connected account on the same host', async () => {
        const fake = await loadPlugin({
          preferences: {
            use_connected_account: true,
            sync_playback_progress: true,
            ...storedServers(session),
          },
        });
        routeHttp(fake.iina, [['/PlaybackInfo', { MediaSources: [] }]]);

        fake.emit('iina.file-loaded', STREAM_URL);
        await flushPromises(10);

        expect(fake.iina.http.post).toHaveBeenCalledWith(
          'https://JF.local:8096/Sessions/Playing?api_key=account-token',
          expect.anything()
        );
        expect(logged(fake)).toContain(
          'DEBUG: Connected-account mode: reporting as me @ https://JF.local:8096 (ignoring URL api_key)'
        );
        // The URL credentials are not stored in this mode
        expect(JSON.parse(fake.prefs.get('jellyfin_servers'))).toHaveLength(1);
      });

      it('names the server when the account has no username', async () => {
        const fake = await loadPlugin({
          preferences: {
            use_connected_account: true,
            ...storedServers([{ ...session[0], username: '', serverName: 'Home' }]),
          },
        });
        fake.emit('iina.file-loaded', STREAM_URL);
        expect(logged(fake)).toContain(
          'DEBUG: Connected-account mode: reporting as Home @ https://JF.local:8096 (ignoring URL api_key)'
        );
      });

      it('keeps the url credentials for a different host', async () => {
        const fake = await loadPlugin({
          preferences: {
            use_connected_account: true,
            sync_playback_progress: true,
            ...storedServers([{ ...session[0], serverUrl: 'http://other:8096' }]),
          },
        });
        routeHttp(fake.iina, [['/PlaybackInfo', { MediaSources: [] }]]);

        fake.emit('iina.file-loaded', STREAM_URL);
        await flushPromises(10);

        expect(fake.iina.http.post).toHaveBeenCalledWith(
          `${SERVER}/Sessions/Playing?api_key=${KEY}`,
          expect.anything()
        );
        expect(logged(fake)).toContain(
          `DEBUG: Connected-account mode ON but the logged-in server (http://other:8096) is not the one in the URL (${SERVER}); using URL api_key`
        );
      });

      it('falls back without a logged-in server', async () => {
        const fake = await loadPlugin({ preferences: { use_connected_account: true } });
        fake.emit('iina.file-loaded', STREAM_URL);
        expect(logged(fake)).toContain(
          'DEBUG: Connected-account mode ON but no logged-in server; falling back to URL api_key'
        );
      });
    });
  });

  describe('playing media', () => {
    it('opens in a new instance through the global entry', async () => {
      const fake = await loadPlugin({ preferences: { open_in_new_window: true } });
      fake.emit('iina.window-loaded');

      fake.iina.sidebar.emit('play-media', { streamUrl: STREAM_URL, title: 'Film' });

      expect(fake.iina.global.postMessage).toHaveBeenCalledWith('create-player', {
        url: STREAM_URL,
        title: 'Film',
      });
      expect(fake.iina.core.osd).toHaveBeenCalledWith('Opening in new window: Film');
      expect(fake.iina.core.open).not.toHaveBeenCalled();
    });

    it('opens in the current window when the global entry is unavailable', async () => {
      const fake = await loadPlugin({
        preferences: { open_in_new_window: true },
        mutate: (f) => {
          f.iina.global = { onMessage: vi.fn() };
        },
      });
      fake.emit('iina.window-loaded');

      fake.iina.sidebar.emit('play-media', { streamUrl: STREAM_URL, title: 'Film' });

      expect(fake.iina.core.open).toHaveBeenCalledWith(STREAM_URL);
      expect(logged(fake)).toContain(
        'DEBUG: Global entry not available, opening in current window'
      );
    });

    it('clears the playlist and sets the title before opening in the current window', async () => {
      const fake = await loadPlugin();
      fake.emit('iina.window-loaded');

      fake.iina.sidebar.emit('play-media', { streamUrl: STREAM_URL, title: 'Film' });

      expect(fake.iina.mpv.command).toHaveBeenCalledWith('playlist-clear', []);
      expect(fake.iina.mpv.set).toHaveBeenCalledWith('force-media-title', 'Film');
      expect(fake.iina.core.open).toHaveBeenCalledWith(STREAM_URL);
      expect(fake.iina.core.osd).toHaveBeenCalledWith('Opening: Film');

      fake.iina.mpv.set.mockClear();
      fake.iina.sidebar.emit('play-media', { streamUrl: STREAM_URL });
      expect(fake.iina.mpv.set).not.toHaveBeenCalled();
    });

    it('keeps going when the playlist cannot be cleared', async () => {
      const fake = await loadPlugin();
      fake.emit('iina.window-loaded');
      fake.iina.mpv.command.mockImplementation(() => {
        throw new Error('no mpv');
      });

      fake.iina.sidebar.emit('play-media', { streamUrl: STREAM_URL, title: 'Film' });

      expect(logged(fake)).toContain('DEBUG: Could not clear playlist before opening: no mpv');
      expect(fake.iina.core.open).toHaveBeenCalledWith(STREAM_URL);
    });

    it('reports failures to open media', async () => {
      const fake = await loadPlugin();
      fake.emit('iina.window-loaded');
      fake.iina.core.open.mockImplementation(() => {
        throw new Error('cannot open');
      });

      fake.iina.sidebar.emit('play-media', { streamUrl: STREAM_URL, title: 'Film' });

      expect(fake.iina.core.osd).toHaveBeenCalledWith('Failed to open media');
      expect(logged(fake)).toContain(
        `DEBUG: URL that failed to open: ${STREAM_URL.replace(KEY, '[redacted]')}`
      );

      fake.iina.sidebar.emit('play-media-list', {
        items: [{ streamUrl: STREAM_URL, title: 'Track' }],
      });
      expect(fake.iina.core.osd).toHaveBeenCalledWith('Failed to play tracks');
    });

    it('handles the global entry replies', async () => {
      const fake = await loadPlugin();
      const global = fake.iina.global;

      global.emit('player-created', { playerId: 1, title: 'Film', url: STREAM_URL });
      expect(fake.iina.core.osd).toHaveBeenCalledWith('Opened in new window: Film');
      global.emit('player-created', undefined);
      expect(fake.iina.core.osd).toHaveBeenCalledTimes(1);

      global.emit('player-creation-failed', { error: 'nope', url: STREAM_URL });
      expect(fake.iina.core.osd).toHaveBeenCalledWith(
        'Failed to open new window - opening in current window'
      );
      expect(fake.iina.core.open).toHaveBeenCalledWith(STREAM_URL);
      global.emit('player-creation-failed', undefined);
      expect(fake.iina.core.open).toHaveBeenCalledTimes(1);
    });
  });

  describe('playing lists', () => {
    const items = [
      { streamUrl: `${SERVER}/Audio/t1/stream?static=true&api_key=${KEY}`, title: 'One' },
      { streamUrl: `${SERVER}/Audio/t2/stream?static=true&api_key=${KEY}` },
      { streamUrl: `${SERVER}/Audio/t3/stream?static=true&api_key=${KEY}`, title: 'Three' },
      { title: 'no url' },
      null,
    ];

    it('plays the first item and appends the rest once it has loaded', async () => {
      const fake = await loadPlugin();
      fake.emit('iina.window-loaded');

      fake.iina.sidebar.emit('play-media-list', { items });

      expect(fake.iina.core.osd).toHaveBeenCalledWith('Playing 3 tracks, starting with: One');
      expect(fake.iina.core.open).toHaveBeenCalledWith(items[0].streamUrl);
      expect(fake.iina.mpv.command).not.toHaveBeenCalledWith('loadfile', expect.anything());

      fake.emit('iina.file-loaded', items[0].streamUrl.replace(KEY, encodeURIComponent(KEY)));

      expect(fake.iina.mpv.command).toHaveBeenCalledWith('loadfile', [
        items[1].streamUrl,
        'append',
      ]);
      expect(fake.iina.mpv.command).toHaveBeenCalledWith('loadfile', [
        items[2].streamUrl,
        'append',
        '-1',
        'force-media-title=Three',
      ]);
      expect(logged(fake)).toContain('DEBUG: Appended 2 queued item(s) to the playlist');

      // The queue is consumed
      fake.iina.mpv.command.mockClear();
      fake.emit('iina.file-loaded', items[0].streamUrl);
      expect(fake.iina.mpv.command).not.toHaveBeenCalledWith('loadfile', expect.anything());
    });

    it('drops the queue when another file loads first', async () => {
      const fake = await loadPlugin();
      fake.emit('iina.window-loaded');
      fake.iina.sidebar.emit('play-media-list', { items });

      fake.emit('iina.file-loaded', '/Users/me/other.mkv');

      expect(fake.iina.mpv.command).not.toHaveBeenCalledWith('loadfile', expect.anything());
      expect(logged(fake)).toContain(
        "DEBUG: Loaded file is not the queued list's first item (t1), dropping the queue"
      );
    });

    it('drops a stale queue', async () => {
      const fake = await loadPlugin();
      fake.emit('iina.window-loaded');
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);
      fake.iina.sidebar.emit('play-media-list', { items });

      Date.now.mockReturnValue(now + 61000);
      fake.emit('iina.file-loaded', items[0].streamUrl);

      expect(fake.iina.mpv.command).not.toHaveBeenCalledWith('loadfile', expect.anything());
      expect(logged(fake)).toContain('DEBUG: Queued playlist items are stale, not appending them');
    });

    it('appends regardless of the file when the first item id is unknown', async () => {
      const fake = await loadPlugin();
      fake.emit('iina.window-loaded');
      fake.iina.sidebar.emit('play-media-list', {
        items: [{ streamUrl: 'http://jf.local/other/path', title: 'A' }, items[2]],
      });

      fake.emit('iina.file-loaded', '/Users/me/anything.mkv');

      expect(fake.iina.mpv.command).toHaveBeenCalledWith('loadfile', [
        items[2].streamUrl,
        'append',
        '-1',
        'force-media-title=Three',
      ]);
    });

    it('logs when appending fails', async () => {
      const fake = await loadPlugin();
      fake.emit('iina.window-loaded');
      fake.iina.sidebar.emit('play-media-list', { items });
      fake.iina.mpv.command.mockImplementation((command) => {
        if (command === 'loadfile') throw new Error('mpv busy');
      });

      fake.emit('iina.file-loaded', items[0].streamUrl);

      expect(logged(fake)).toContain('DEBUG: Could not append queued items: Error: mpv busy');
    });

    it('holds no queue for a single item', async () => {
      const fake = await loadPlugin();
      fake.emit('iina.window-loaded');
      fake.iina.sidebar.emit('play-media-list', { items: [items[0]] });
      expect(fake.iina.core.osd).toHaveBeenCalledWith('Opening: One');
      fake.emit('iina.file-loaded', items[0].streamUrl);
      expect(fake.iina.mpv.command).not.toHaveBeenCalledWith('loadfile', expect.anything());
    });

    it('tolerates a missing message', async () => {
      const fake = await loadPlugin();
      fake.emit('iina.window-loaded');
      fake.iina.sidebar.emit('play-media-list', undefined);
      expect(fake.iina.core.osd).toHaveBeenCalledWith('Nothing to play');
    });
  });

  describe('playback lifecycle', () => {
    async function loadWithSession(preferences = {}) {
      const fake = await loadPlugin({
        preferences: { sync_playback_progress: true, ...preferences },
      });
      routeHttp(fake.iina, [
        ['/PlaybackInfo', { PlaySessionId: 'ps', MediaSources: [{ Id: 'src' }] }],
        [`/Items/${ITEM}?`, { Name: 'Film', Type: 'Movie', UserData: {} }],
      ]);
      fake.emit('iina.window-loaded');
      fake.emit('iina.file-loaded', STREAM_URL);
      await flushPromises(10);
      fake.iina.http.post.mockClear();
      return fake;
    }

    it('reports stop when the file ends', async () => {
      const fake = await loadWithSession();
      fake.emit('mpv.end-file');
      await flushPromises();
      expect(fake.iina.http.post).toHaveBeenCalledWith(
        `${SERVER}/Sessions/Playing/Stopped?api_key=${KEY}`,
        expect.anything()
      );
    });

    it('skips the stop report while replacing the playing file', async () => {
      const fake = await loadWithSession();

      fake.iina.sidebar.emit('play-media', { streamUrl: STREAM_URL, title: 'Next' });
      fake.emit('mpv.end-file');
      await flushPromises();

      expect(fake.iina.http.post).not.toHaveBeenCalledWith(
        expect.stringContaining('/Stopped'),
        expect.anything()
      );
      expect(logged(fake)).toContain('DEBUG: File replacement in progress, skipping stop report');
    });

    it('ignores an expired replacement guard', async () => {
      const fake = await loadWithSession();
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);
      fake.iina.sidebar.emit('play-media', { streamUrl: STREAM_URL, title: 'Next' });

      Date.now.mockReturnValue(now + 20000);
      fake.emit('mpv.end-file');
      await flushPromises();

      expect(logged(fake)).toContain('DEBUG: Ignoring replacement guard set 20000ms ago (expired)');
      expect(fake.iina.http.post).toHaveBeenCalledWith(
        expect.stringContaining('/Stopped'),
        expect.anything()
      );
    });

    it('does not arm the guard without a playback session', async () => {
      const fake = await loadPlugin();
      fake.emit('iina.window-loaded');
      fake.iina.sidebar.emit('play-media', { streamUrl: STREAM_URL, title: 'Film' });
      fake.emit('mpv.end-file');
      expect(logged(fake)).toContain(
        'DEBUG: mpv.end-file triggered, isReplacingPlayback=false, autoplayQueued=false'
      );
    });

    it('keeps the session when autoplay queued the next episode', async () => {
      const fake = await loadPlugin({
        preferences: { sync_playback_progress: true, autoplay_next_episode: true },
      });
      routeHttp(fake.iina, [
        ['/PlaybackInfo', { PlaySessionId: 'ps', MediaSources: [{ Id: 'src' }] }],
        [
          `/Items/${ITEM}?`,
          {
            Type: 'Episode',
            Name: 'Ep 1',
            SeriesId: 'series',
            SeasonId: 'season',
            SeriesName: 'Show',
            ParentIndexNumber: 1,
            IndexNumber: 1,
            UserData: {},
          },
        ],
        [
          '/Shows/series/Episodes',
          {
            Items: [
              { Id: ITEM, Name: 'Ep 1', IndexNumber: 1, MediaSources: [{}] },
              { Id: 'ep-2', Name: 'Ep 2', IndexNumber: 2, MediaSources: [{}] },
            ],
          },
        ],
      ]);

      fake.emit('iina.file-loaded', STREAM_URL);
      await flushPromises(20);
      expect(fake.iina.mpv.command).toHaveBeenCalledWith(
        'loadfile',
        expect.arrayContaining(['insert-next'])
      );
      fake.iina.http.post.mockClear();

      fake.emit('mpv.end-file');
      await flushPromises();

      expect(logged(fake)).toContain(
        'DEBUG: Autoplay queued, mpv will play next episode — skipping stop cleanup'
      );
      expect(fake.iina.http.post).not.toHaveBeenCalled();
    });

    it('stops tracking when the window closes or the app terminates', async () => {
      const fake = await loadWithSession();
      fake.emit('iina.window-will-close');
      await flushPromises();
      expect(fake.iina.http.post).toHaveBeenCalledTimes(1);

      fake.emit('iina.application-will-terminate');
      await flushPromises();
      expect(fake.iina.http.post).toHaveBeenCalledTimes(1);
      expect(logged(fake)).toContain('DEBUG: Application terminating, stopping playback tracking');
    });

    it('reports pause changes', async () => {
      const fake = await loadWithSession();
      fake.iina.core.status.paused = true;
      fake.emit('mpv.pause.changed');
      await flushPromises();
      expect(fake.iina.http.post).toHaveBeenCalledWith(
        `${SERVER}/Sessions/Playing/Progress?api_key=${KEY}`,
        expect.objectContaining({ data: expect.objectContaining({ IsPaused: true }) })
      );
    });
  });
});
