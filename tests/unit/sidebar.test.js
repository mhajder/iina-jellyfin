// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bootSidebar,
  click,
  connect,
  createWebviewBridge,
  flushPromises,
  mockFetch,
} from './helpers/sidebar-dom.js';

const byId = (id) => document.getElementById(id);

describe('JellyfinSidebar bootstrap', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete globalThis.iina;
    delete globalThis.fetch;
  });

  it('constructs once, requests plugin data and shows the login form', async () => {
    const bridge = createWebviewBridge();
    const sidebar = await bootSidebar({ bridge });

    expect(sidebar).toBeInstanceOf(window.JellyfinSidebar);
    expect(bridge.postMessage.mock.calls.map((call) => call[0])).toEqual([
      'get-offline-downloads',
      'get-client-identity',
      'get-servers',
      'get-session',
    ]);
    expect(byId('loginSection').style.display).toBe('block');
    expect(Object.keys(bridge.handlers).sort()).toEqual([
      'client-identity',
      'offline-downloads',
      'server-switched',
      'servers-list',
      'servers-updated',
      'session-available',
      'session-cleared',
      'session-data',
    ]);
    expect(sidebar.offlineDownloads).toEqual([]);
  });

  it('does not construct a second instance', async () => {
    const bridge = createWebviewBridge({ debug: true });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const sidebar = await bootSidebar({ bridge });
    vi.resetModules();
    await import(/* @vite-ignore */ '../../src/ui/sidebar/sidebar.js');
    expect(window.jellyfinSidebar).toBe(sidebar);
    expect(log).toHaveBeenCalledWith('DEBUG: Jellyfin sidebar initialized');
    expect(log).toHaveBeenCalledWith('DEBUG: Jellyfin sidebar already initialized');
  });

  it('waits for DOMContentLoaded while the document is loading', async () => {
    const bridge = createWebviewBridge();
    Object.defineProperty(document, 'readyState', { value: 'loading', configurable: true });
    try {
      const sidebar = await bootSidebar({ bridge });
      expect(sidebar).toBeUndefined();
      document.dispatchEvent(new Event('DOMContentLoaded'));
      expect(window.jellyfinSidebar).toBeInstanceOf(window.JellyfinSidebar);
    } finally {
      Object.defineProperty(document, 'readyState', { value: 'complete', configurable: true });
    }
  });

  it('works without the iina bridge', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const sidebar = await bootSidebar({ bridge: null });
    expect(sidebar).toBeInstanceOf(window.JellyfinSidebar);
    expect(log).not.toHaveBeenCalled();
  });

  describe('http client', () => {
    it('performs GET and POST requests and parses JSON', async () => {
      const sidebar = await bootSidebar();
      const fetchMock = mockFetch([['/Users/Me', { Id: 'u' }]]);
      const client = sidebar.getHttpClient();

      const response = await client.get('http://jf/Users/Me', { headers: { A: 'b' } });
      expect(response).toEqual({
        data: { Id: 'u' },
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
      });
      expect(fetchMock).toHaveBeenLastCalledWith('http://jf/Users/Me', {
        method: 'GET',
        headers: { A: 'b' },
      });

      await client.post('http://jf/Users/Me', { data: '{"a":1}' });
      expect(fetchMock).toHaveBeenLastCalledWith('http://jf/Users/Me', {
        method: 'POST',
        headers: {},
        body: '{"a":1}',
      });

      await client.post('http://jf/Users/Me');
      expect(fetchMock.mock.calls[2][1]).not.toHaveProperty('body');
      await client.get('http://jf/Users/Me');
      expect(fetchMock.mock.calls[3][1]).toEqual({ method: 'GET', headers: {} });
      await sidebar.fetchHttpRequest('GET', 'http://jf/Users/Me');
      expect(fetchMock.mock.calls[4][1]).toEqual({ method: 'GET', headers: {} });
    });

    it('keeps non-JSON bodies as text', async () => {
      const sidebar = await bootSidebar();
      mockFetch([['/QuickConnect/Enabled', 'not json']]);
      const response = await sidebar.getHttpClient().get('http://jf/QuickConnect/Enabled');
      expect(response.data).toBe('not json');
    });

    it('normalises network failures', async () => {
      const sidebar = await bootSidebar();
      mockFetch([['/x', new Error('offline')]]);
      await expect(sidebar.getHttpClient().get('http://jf/x')).rejects.toEqual({
        message: 'offline',
        status: 0,
        statusText: 'Network Error',
      });
    });
  });

  describe('event listeners', () => {
    it('opens the login form from both add-server buttons and cancels it', async () => {
      const sidebar = await bootSidebar();
      const hide = vi.spyOn(sidebar, 'hideLoginForm');
      byId('loginSection').style.display = 'none';

      click(byId('connectBtn'));
      expect(byId('loginSection').style.display).toBe('block');
      byId('loginSection').style.display = 'none';
      click(byId('addServerBtn'));
      expect(byId('loginSection').style.display).toBe('block');

      click(byId('cancelLoginBtn'));
      expect(hide).toHaveBeenCalledTimes(1);
      expect(byId('loginSection').style.display).toBe('none');
    });

    it('logs out through the disconnect button', async () => {
      const sidebar = await bootSidebar();
      const logout = vi.spyOn(sidebar, 'logoutActiveServer').mockImplementation(() => {});
      click(byId('logoutBtn'));
      expect(logout).toHaveBeenCalledTimes(1);
    });

    it('submits the password form from the button and Enter key', async () => {
      const sidebar = await bootSidebar();
      const login = vi.spyOn(sidebar, 'login').mockImplementation(() => {});

      click(byId('loginBtn'));
      byId('serverUrl').dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter' }));
      byId('username').dispatchEvent(new KeyboardEvent('keypress', { key: 'a' }));
      byId('password').dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter' }));

      expect(login).toHaveBeenCalledTimes(3);
    });

    it('drives Quick Connect from its buttons and Enter key', async () => {
      const sidebar = await bootSidebar();
      const start = vi.spyOn(sidebar, 'startQuickConnect').mockImplementation(() => {});
      const cancel = vi.spyOn(sidebar, 'cancelQuickConnect');

      click(byId('qcStartBtn'));
      byId('qcServerUrl').dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter' }));
      expect(start).toHaveBeenCalledTimes(2);

      click(byId('qcCancelBtn'));
      expect(cancel).toHaveBeenCalled();
      expect(byId('loginSection').style.display).toBe('none');
    });

    it('ignores Enter wiring for missing fields', async () => {
      const sidebar = await bootSidebar();
      byId('qcServerUrl').remove();
      expect(() => sidebar.setupEventListeners()).not.toThrow();
    });

    it('switches login methods from the tabs', async () => {
      const sidebar = await bootSidebar();
      const switchMethod = vi.spyOn(sidebar, 'switchLoginMethod');
      click(document.querySelector('.login-method-tab[data-method="quickconnect"]'));
      expect(switchMethod).toHaveBeenCalledWith('quickconnect');
      expect(byId('quickConnectForm').style.display).toBe('flex');
    });

    it('debounces search input and re-runs it when chips change', async () => {
      vi.useFakeTimers();
      const sidebar = await bootSidebar();
      const search = vi.spyOn(sidebar, 'search').mockImplementation(() => {});
      const input = byId('searchInput');

      input.value = 'bat';
      input.dispatchEvent(new Event('input'));
      input.value = 'batman';
      input.dispatchEvent(new Event('input'));
      vi.advanceTimersByTime(500);
      expect(search).toHaveBeenCalledTimes(1);
      expect(search).toHaveBeenCalledWith('batman');

      const chip = document.querySelector('.search-type-chip[data-type="Movie"]');
      click(chip);
      expect(chip.classList.contains('active')).toBe(false);
      vi.advanceTimersByTime(500);
      expect(search).toHaveBeenCalledTimes(2);

      input.value = '   ';
      click(chip);
      vi.advanceTimersByTime(500);
      expect(search).toHaveBeenCalledTimes(2);
    });

    it('toggles the filter panels', async () => {
      await bootSidebar();
      for (const [button, panel] of [
        ['moviesFilterBtn', 'moviesFilterPanel'],
        ['seriesFilterBtn', 'seriesFilterPanel'],
        ['musicFilterBtn', 'musicFilterPanel'],
      ]) {
        click(byId(button));
        expect(byId(panel).style.display).toBe('block');
        click(byId(button));
        expect(byId(panel).style.display).toBe('none');
      }
    });

    it('reloads lists when filters change', async () => {
      const sidebar = await bootSidebar();
      const movies = vi.spyOn(sidebar, 'loadMovies').mockImplementation(() => {});
      const series = vi.spyOn(sidebar, 'loadSeries').mockImplementation(() => {});
      const music = vi.spyOn(sidebar, 'loadMusic').mockImplementation(() => {});

      for (const id of ['moviesSortSelect', 'moviesFilterSelect', 'moviesGenreSelect']) {
        byId(id).dispatchEvent(new Event('change'));
      }
      for (const id of ['seriesSortSelect', 'seriesFilterSelect', 'seriesGenreSelect']) {
        byId(id).dispatchEvent(new Event('change'));
      }
      for (const id of ['musicViewSelect', 'musicSortSelect', 'musicGenreSelect']) {
        byId(id).dispatchEvent(new Event('change'));
      }

      expect(movies).toHaveBeenCalledTimes(3);
      expect(series).toHaveBeenCalledTimes(3);
      expect(music).toHaveBeenCalledTimes(3);
    });

    it('wires the episode and album controls', async () => {
      const sidebar = await bootSidebar();
      const spies = {
        loadEpisodes: vi.spyOn(sidebar, 'loadEpisodes').mockImplementation(() => {}),
        playSelectedEpisode: vi.spyOn(sidebar, 'playSelectedEpisode').mockImplementation(() => {}),
        openSelectedEpisodeInJellyfin: vi
          .spyOn(sidebar, 'openSelectedEpisodeInJellyfin')
          .mockImplementation(() => {}),
        hideEpisodeSelection: vi
          .spyOn(sidebar, 'hideEpisodeSelection')
          .mockImplementation(() => {}),
        playAllAlbumTracks: vi.spyOn(sidebar, 'playAllAlbumTracks').mockImplementation(() => {}),
        openAlbumInJellyfin: vi.spyOn(sidebar, 'openAlbumInJellyfin').mockImplementation(() => {}),
        hideAlbumTracks: vi.spyOn(sidebar, 'hideAlbumTracks').mockImplementation(() => {}),
      };

      const seasonSelect = byId('seasonSelect');
      seasonSelect.innerHTML = '<option value="s1">Season 1</option>';
      seasonSelect.value = 's1';
      seasonSelect.dispatchEvent(new Event('change'));
      expect(spies.loadEpisodes).toHaveBeenCalledWith('s1');

      for (const [id, spy] of [
        ['playEpisodeBtn', 'playSelectedEpisode'],
        ['openEpisodeInJellyfinBtn', 'openSelectedEpisodeInJellyfin'],
        ['cancelEpisodeBtn', 'hideEpisodeSelection'],
        ['playAllTracksBtn', 'playAllAlbumTracks'],
        ['openAlbumInJellyfinBtn', 'openAlbumInJellyfin'],
        ['cancelAlbumTracksBtn', 'hideAlbumTracks'],
      ]) {
        byId(id).disabled = false;
        click(byId(id));
        expect(spies[spy]).toHaveBeenCalledTimes(1);
      }
    });
  });

  describe('tab navigation', () => {
    it('switches tabs and loads content only when connected', async () => {
      const sidebar = await bootSidebar();
      const loaders = {
        home: vi.spyOn(sidebar, 'loadHomeTab').mockImplementation(() => {}),
        movies: vi.spyOn(sidebar, 'loadMovies').mockImplementation(() => {}),
        series: vi.spyOn(sidebar, 'loadSeries').mockImplementation(() => {}),
        music: vi.spyOn(sidebar, 'loadMusic').mockImplementation(() => {}),
      };
      const tab = (name) => document.querySelector(`.tab-button[data-tab="${name}"]`);

      for (const name of ['movies', 'series', 'music', 'search', 'home']) {
        click(tab(name));
        expect(tab(name).classList.contains('active')).toBe(true);
        expect(byId(`${name}Tab`).classList.contains('active')).toBe(true);
      }
      for (const spy of Object.values(loaders)) {
        expect(spy).not.toHaveBeenCalled();
      }

      connect(sidebar);
      for (const name of ['home', 'movies', 'series', 'music', 'search']) {
        click(tab(name));
      }
      for (const spy of Object.values(loaders)) {
        expect(spy).toHaveBeenCalledTimes(1);
      }
      expect(document.querySelectorAll('.tab-content.active')).toHaveLength(1);
    });
  });

  describe('plugin messages', () => {
    it('routes every message to its handler', async () => {
      const bridge = createWebviewBridge({ debug: true });
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const sidebar = await bootSidebar({ bridge });
      const spies = {
        handleClientIdentity: vi.spyOn(sidebar, 'handleClientIdentity'),
        handleSessionAvailable: vi
          .spyOn(sidebar, 'handleSessionAvailable')
          .mockImplementation(() => {}),
        handleSessionData: vi.spyOn(sidebar, 'handleSessionData').mockImplementation(() => {}),
        handleSessionCleared: vi
          .spyOn(sidebar, 'handleSessionCleared')
          .mockImplementation(() => {}),
        handleServersList: vi.spyOn(sidebar, 'handleServersList').mockImplementation(() => {}),
        connectToServer: vi.spyOn(sidebar, 'connectToServer').mockImplementation(() => {}),
        handleOfflineDownloads: vi.spyOn(sidebar, 'handleOfflineDownloads'),
      };

      bridge.deliver('client-identity', { deviceId: 'd', version: '1' });
      expect(sidebar.clientIdentity).toEqual({ deviceId: 'd', version: '1' });
      bridge.deliver('session-available', { serverUrl: 'http://x', accessToken: 't' });
      bridge.deliver('session-data', null);
      bridge.deliver('session-cleared');
      bridge.deliver('servers-list', { servers: [] });
      bridge.deliver('servers-updated', { servers: [] });
      bridge.deliver('offline-downloads', { downloads: [] });

      expect(spies.handleSessionAvailable).toHaveBeenCalledTimes(1);
      expect(spies.handleSessionData).toHaveBeenCalledWith(null);
      expect(spies.handleSessionCleared).toHaveBeenCalledTimes(1);
      expect(spies.handleServersList).toHaveBeenCalledTimes(2);
      expect(spies.handleOfflineDownloads).toHaveBeenCalledTimes(1);

      bridge.deliver('server-switched', { servers: [] });
      expect(spies.connectToServer).not.toHaveBeenCalled();
      const server = { id: 's1', serverUrl: 'http://x', accessToken: 't' };
      bridge.deliver('server-switched', { server, servers: [server], activeServerId: 's1' });
      expect(spies.handleServersList).toHaveBeenCalledTimes(3);
      expect(spies.connectToServer).toHaveBeenCalledWith(server);
      bridge.deliver('server-switched', null);
      expect(spies.connectToServer).toHaveBeenCalledTimes(1);
    });

    it('skips message registration without onMessage', async () => {
      const bridge = createWebviewBridge();
      delete bridge.onMessage;
      const sidebar = await bootSidebar({ bridge });
      expect(Object.keys(bridge.handlers)).toEqual([]);
      expect(sidebar).toBeInstanceOf(window.JellyfinSidebar);
    });

    it('does not request data without postMessage', async () => {
      const bridge = createWebviewBridge();
      delete bridge.postMessage;
      const sidebar = await bootSidebar({ bridge });
      expect(sidebar).toBeInstanceOf(window.JellyfinSidebar);
      await flushPromises();
    });
  });
});
