// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bootSidebar,
  click,
  connect,
  createWebviewBridge,
  flushPromises,
  mockFetch,
} from './helpers/sidebar-dom.js';

const byId = (id) => document.getElementById(id);

/** Text that ended up directly inside container elements instead of in a child. */
function strayText(root) {
  const containers = [
    root,
    ...root.querySelectorAll('.download-item, .download-body, .media-actions'),
  ];
  return containers
    .flatMap((el) => Array.from(el.childNodes))
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent.trim())
    .join('');
}

const MOVIE = { Id: 'movie-1', Type: 'Movie', Name: 'Big Film', ProductionYear: 2020 };
const EPISODE = {
  Id: 'ep-1',
  Type: 'Episode',
  Name: 'Pilot',
  SeriesName: 'Show',
  ParentIndexNumber: 1,
  IndexNumber: 2,
};

function entry(overrides = {}) {
  return {
    itemId: 'movie-1',
    type: 'Movie',
    name: 'Big Film',
    title: 'Big Film (2020)',
    productionYear: 2020,
    status: 'completed',
    progress: 100,
    expectedBytes: 1536 * 1024 * 1024,
    subtitles: [{ language: 'eng' }],
    createdAt: 1000,
    fileMissing: false,
    ...overrides,
  };
}

describe('sidebar offline methods', () => {
  let bridge;
  let sidebar;

  beforeEach(async () => {
    bridge = createWebviewBridge();
    sidebar = await bootSidebar({ bridge });
    bridge.postMessage.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete globalThis.iina;
    delete globalThis.fetch;
  });

  describe('setup and messaging', () => {
    it('renders the empty state and asks the plugin for the list', async () => {
      expect(byId('downloadsList').textContent).toContain('No downloads yet');
      const fresh = createWebviewBridge();
      await bootSidebar({ bridge: fresh });
      expect(fresh.postMessage).toHaveBeenCalledWith('get-offline-downloads', undefined);
    });

    it('logs instead of posting when the bridge is missing', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const detached = await bootSidebar({ bridge: null });
      expect(detached.postOfflineMessage('offline-cancel', { itemId: 'x' })).toBe(false);
      expect(detached.requestOfflineDownloads()).toBeUndefined();
      expect(log).not.toHaveBeenCalled();

      globalThis.iina = { preferences: { get: () => true } };
      expect(detached.postOfflineMessage('offline-cancel')).toBe(false);
      expect(log).toHaveBeenCalledWith(
        'DEBUG: iina.postMessage not available, cannot send offline-cancel'
      );
    });

    it('stores the list pushed by the plugin and refreshes the UI', () => {
      const button = document.createElement('button');
      button.dataset.offlineItemId = 'movie-1';
      document.body.appendChild(button);

      bridge.deliver('offline-downloads', {
        downloads: [entry({ status: 'downloading', progress: 42 })],
        directory: '/Users/me/offline',
      });

      expect(sidebar.offlineDownloads).toHaveLength(1);
      expect(sidebar.offlineDirectory).toBe('/Users/me/offline');
      expect(byId('downloadsDirectory').textContent).toBe('Folder: /Users/me/offline');
      expect(byId('downloadsBadge').textContent).toBe('1');
      expect(byId('downloadsBadge').style.display).toBe('inline-block');
      expect(button.textContent).toBe('42%');
      expect(button.disabled).toBe(true);

      bridge.deliver('offline-downloads', null);
      expect(sidebar.offlineDownloads).toEqual([]);
      expect(sidebar.offlineDirectory).toBeNull();
      expect(byId('downloadsBadge').style.display).toBe('none');
      expect(byId('downloadsDirectory').textContent).toBe('');
      expect(button.textContent).toBe('⬇ Offline');

      bridge.deliver('offline-downloads', { downloads: 'junk' });
      expect(sidebar.offlineDownloads).toEqual([]);
      expect(byId('downloadsBadge').textContent).toBe('');

      bridge.deliver('offline-downloads', { downloads: [entry(), entry({ itemId: 'b' })] });
      expect(byId('downloadsList').querySelectorAll('.download-item')).toHaveLength(2);
      expect(byId('downloadsBadge').textContent).toBe('');
    });

    it('finds entries by id', () => {
      sidebar.offlineDownloads = [entry()];
      expect(sidebar.getOfflineEntry('movie-1').title).toBe('Big Film (2020)');
      expect(sidebar.getOfflineEntry('nope')).toBeNull();
    });
  });

  describe('download buttons', () => {
    it('knows which items can be downloaded', () => {
      expect(sidebar.isDownloadable(MOVIE)).toBe(true);
      expect(sidebar.isDownloadable(EPISODE)).toBe(true);
      expect(sidebar.isDownloadable({ Id: 's', Type: 'Audio' })).toBe(true);
      expect(sidebar.isDownloadable({ Id: 's', Type: 'Series' })).toBe(false);
      expect(sidebar.isDownloadable({ Type: 'Movie' })).toBe(false);
      expect(sidebar.isDownloadable(null)).toBe(false);
    });

    it('describes every entry state', () => {
      const idle = {
        label: '⬇ Offline',
        disabled: false,
        state: 'idle',
        title: 'Download for offline playback',
      };
      expect(sidebar.describeDownloadButton(null)).toEqual(idle);
      expect(sidebar.describeDownloadButton(entry({ status: 'cancelled' }))).toEqual(idle);
      expect(sidebar.describeDownloadButton(entry({ status: 'queued' }))).toEqual({
        label: 'Queued…',
        disabled: true,
        state: 'queued',
        title: 'Waiting to download',
      });
      expect(sidebar.describeDownloadButton(entry({ status: 'downloading', progress: 7 }))).toEqual(
        { label: '7%', disabled: true, state: 'downloading', title: 'Downloading' }
      );
      expect(
        sidebar.describeDownloadButton(entry({ status: 'downloading', progress: undefined })).label
      ).toBe('0%');
      expect(sidebar.describeDownloadButton(entry())).toEqual({
        label: '▶ Offline',
        disabled: false,
        state: 'completed',
        title: 'Play the offline copy',
      });
      expect(sidebar.describeDownloadButton(entry({ fileMissing: true }))).toEqual({
        label: 'Re-download',
        disabled: false,
        state: 'missing',
        title: 'The downloaded file is missing',
      });
      expect(
        sidebar.describeDownloadButton(entry({ status: 'failed', error: 'HTTP 500' }))
      ).toEqual({ label: 'Retry ⬇', disabled: false, state: 'failed', title: 'HTTP 500' });
      expect(sidebar.describeDownloadButton(entry({ status: 'failed' })).title).toBe(
        'Download failed'
      );
    });

    it('builds button markup only for downloadable items', () => {
      expect(sidebar.downloadButtonHtml({ Id: 's', Type: 'Series' }, 'x')).toBe('');
      const html = sidebar.downloadButtonHtml({ Id: 'a"b', Type: 'Movie' }, 'media-action-btn');
      expect(html).toContain('data-offline-item-id="a&quot;b"');
      expect(html).toContain('class="button secondary media-action-btn offline-download-btn"');
    });

    it('plays ready downloads and requests the others', () => {
      const play = vi.spyOn(sidebar, 'playOfflineDownload').mockReturnValue(true);
      const request = vi.spyOn(sidebar, 'requestOfflineDownload').mockReturnValue(false);

      sidebar.offlineDownloads = [entry()];
      expect(sidebar.handleDownloadButtonClick(MOVIE)).toBe(true);
      expect(play).toHaveBeenCalledWith('movie-1');

      sidebar.offlineDownloads = [entry({ fileMissing: true })];
      expect(sidebar.handleDownloadButtonClick(MOVIE)).toBe(false);
      expect(request).toHaveBeenCalledWith(MOVIE);
    });

    it('recognises ready entries', () => {
      expect(sidebar.isOfflineReady(entry())).toBe(true);
      expect(sidebar.isOfflineReady(entry({ fileMissing: true }))).toBe(false);
      expect(sidebar.isOfflineReady(entry({ status: 'failed' }))).toBe(false);
      expect(sidebar.isOfflineReady(null)).toBe(false);
    });
  });

  describe('requesting downloads', () => {
    it('refuses items that cannot be downloaded', () => {
      expect(sidebar.requestOfflineDownload({ Id: 's', Type: 'Series' })).toBe(false);
      expect(sidebar.requestOfflineDownload(undefined)).toBe(false);
      expect(byId('downloadsNotice').textContent).toBe(
        'This item cannot be downloaded for offline use'
      );
      expect(bridge.postMessage).not.toHaveBeenCalled();
    });

    it('requires a connected server', () => {
      expect(sidebar.requestOfflineDownload(MOVIE)).toBe(false);
      expect(byId('downloadsNotice').textContent).toBe(
        'Connect to a Jellyfin server to download media'
      );
    });

    it('posts the item and credentials to the plugin', () => {
      connect(sidebar);
      const item = {
        ...EPISODE,
        RunTimeTicks: 5,
        AlbumArtist: 'x',
        Artists: ['y'],
        Overview: 'not sent',
      };

      expect(sidebar.requestOfflineDownload(item)).toBe(true);

      expect(bridge.postMessage).toHaveBeenCalledWith('offline-download', {
        item: {
          Id: 'ep-1',
          Type: 'Episode',
          Name: 'Pilot',
          SeriesName: 'Show',
          ParentIndexNumber: 1,
          IndexNumber: 2,
          ProductionYear: undefined,
          RunTimeTicks: 5,
          AlbumArtist: 'x',
          Artists: ['y'],
        },
        serverUrl: 'http://jf.local:8096',
        accessToken: 'tok',
        serverId: 'srv-1',
        quality: 'original',
      });
      expect(byId('downloadsNotice').textContent).toBe('Queued for download: Pilot');

      sidebar.offlineQuality = '2000';
      sidebar.requestOfflineDownload(MOVIE);
      expect(bridge.postMessage.mock.calls[1][1].quality).toBe('2000');
    });

    it('falls back to the active server id and a placeholder name', () => {
      connect(sidebar, { serverId: undefined });
      sidebar.activeServerId = 'active-1';
      sidebar.requestOfflineDownload({ Id: 'm', Type: 'Movie' });
      expect(bridge.postMessage.mock.calls[0][1].serverId).toBe('active-1');
      expect(byId('downloadsNotice').textContent).toBe('Queued for download: Unknown Title');

      sidebar.activeServerId = null;
      sidebar.requestOfflineDownload({ Id: 'm', Type: 'Movie' });
      expect(bridge.postMessage.mock.calls[1][1].serverId).toBeNull();
    });

    it('does not show the notice when the message could not be sent', () => {
      connect(sidebar);
      delete bridge.postMessage;
      expect(sidebar.requestOfflineDownload(MOVIE)).toBe(false);
      expect(byId('downloadsNotice').style.display).toBe('none');
    });

    it('loads the full item for search hints before requesting', async () => {
      connect(sidebar);
      const fetchMock = mockFetch([['/Items/hint-1', { Id: 'hint-1', Type: 'Movie', Name: 'H' }]]);
      const request = vi.spyOn(sidebar, 'requestOfflineDownload').mockReturnValue(true);

      await expect(sidebar.requestOfflineDownloadForHint({ ItemId: 'hint-1' })).resolves.toBe(true);

      expect(fetchMock.mock.calls[0][0]).toBe('http://jf.local:8096/Items/hint-1?userId=user-1');
      expect(fetchMock.mock.calls[0][1].headers).toEqual({ 'X-Emby-Token': 'tok' });
      expect(request).toHaveBeenCalledWith({ Id: 'hint-1', Type: 'Movie', Name: 'H' });
    });

    it('reports failures to load a hint', async () => {
      connect(sidebar);
      mockFetch([['/Items/hint-1', { Name: 'no id' }]]);
      await expect(sidebar.requestOfflineDownloadForHint({ ItemId: 'hint-1' })).resolves.toBe(
        false
      );
      expect(byId('downloadsNotice').textContent).toBe('Failed to load item details for download');

      mockFetch([['/Items/hint-1', new Error('offline')]]);
      await expect(sidebar.requestOfflineDownloadForHint({ ItemId: 'hint-1' })).resolves.toBe(
        false
      );
    });

    it('requires a connection for hints', async () => {
      await expect(sidebar.requestOfflineDownloadForHint({ ItemId: 'hint-1' })).resolves.toBe(
        false
      );
      sidebar.currentServer = { url: 'http://x' };
      await expect(sidebar.requestOfflineDownloadForHint({ ItemId: 'hint-1' })).resolves.toBe(
        false
      );
      expect(byId('downloadsNotice').textContent).toBe(
        'Connect to a Jellyfin server to download media'
      );
    });

    it('downloads the selected episode', () => {
      const request = vi.spyOn(sidebar, 'requestOfflineDownload').mockReturnValue(true);
      expect(sidebar.downloadSelectedEpisode()).toBe(false);
      expect(request).not.toHaveBeenCalled();

      sidebar.selectedEpisode = EPISODE;
      expect(sidebar.downloadSelectedEpisode()).toBe(true);
      expect(request).toHaveBeenCalledWith(EPISODE);

      byId('downloadEpisodeBtn').disabled = false;
      click(byId('downloadEpisodeBtn'));
      expect(request).toHaveBeenCalledTimes(2);
    });
  });

  describe('entry actions', () => {
    it('posts play, cancel, remove, retry and reveal messages', () => {
      expect(sidebar.playOfflineDownload('a')).toBe(true);
      expect(bridge.postMessage).toHaveBeenCalledWith('play-offline', { itemId: 'a' });

      sidebar.cancelOfflineDownload('a');
      expect(bridge.postMessage).toHaveBeenCalledWith('offline-cancel', { itemId: 'a' });

      sidebar.removeOfflineDownload('a');
      expect(bridge.postMessage).toHaveBeenCalledWith('offline-remove', { itemId: 'a' });

      sidebar.revealOfflineDownload('a');
      expect(bridge.postMessage).toHaveBeenCalledWith('offline-show-in-finder', { itemId: 'a' });

      sidebar.retryOfflineDownload('a');
      expect(bridge.postMessage).toHaveBeenCalledWith('offline-retry', {
        itemId: 'a',
        serverUrl: null,
        accessToken: null,
      });

      connect(sidebar);
      sidebar.retryOfflineDownload('a');
      expect(bridge.postMessage).toHaveBeenLastCalledWith('offline-retry', {
        itemId: 'a',
        serverUrl: 'http://jf.local:8096',
        accessToken: 'tok',
      });
    });

    it('closes the episode picker when playing from it', () => {
      const hide = vi.spyOn(sidebar, 'hideEpisodeSelection');
      sidebar.playOfflineDownload('a');
      expect(hide).not.toHaveBeenCalled();

      byId('episodeSection').style.display = 'block';
      sidebar.playOfflineDownload('a');
      expect(hide).toHaveBeenCalledTimes(1);

      byId('episodeSection').style.display = 'block';
      delete bridge.postMessage;
      expect(sidebar.playOfflineDownload('a')).toBe(false);
      expect(hide).toHaveBeenCalledTimes(1);
    });
  });

  describe('downloads panel', () => {
    it('opens over the current view and returns to it', () => {
      connect(sidebar);
      byId('loginSection').style.display = 'none';
      byId('episodeSection').style.display = 'block';
      bridge.postMessage.mockClear();
      window.scrollTo.mockClear();

      click(byId('downloadsBtn'));

      expect(byId('downloadsSection').style.display).toBe('block');
      expect(byId('mainContent').style.display).toBe('none');
      expect(byId('episodeSection').style.display).toBe('none');
      expect(byId('downloadsBtn').classList.contains('active')).toBe(true);
      expect(bridge.postMessage).toHaveBeenCalledWith('get-offline-downloads', undefined);
      expect(window.scrollTo).toHaveBeenCalledTimes(1);
      expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'instant' });

      // Showing twice is a no-op
      sidebar.showDownloadsPanel();
      expect(bridge.postMessage).toHaveBeenCalledTimes(1);

      click(byId('downloadsBtn'));

      expect(byId('downloadsSection').style.display).toBe('none');
      expect(byId('mainContent').style.display).toBe('block');
      expect(byId('episodeSection').style.display).toBe('block');
      expect(byId('loginSection').style.display).toBe('none');
      expect(byId('albumTracksSection').style.display).toBe('none');
      expect(byId('downloadsBtn').classList.contains('active')).toBe(false);
      expect(sidebar.downloadsPanelReturn).toBeNull();
    });

    it('can be closed without having been opened', () => {
      click(byId('closeDownloadsBtn'));
      expect(byId('downloadsSection').style.display).toBe('none');
      expect(byId('loginSection').style.display).toBe('block');
    });

    it('asks the plugin to open or change the folder', () => {
      click(byId('openDownloadsFolderBtn'));
      expect(bridge.postMessage).toHaveBeenCalledWith('offline-open-folder', undefined);
      click(byId('changeDownloadsFolderBtn'));
      expect(bridge.postMessage).toHaveBeenCalledWith('offline-choose-folder', undefined);
    });

    it('works while disconnected', () => {
      sidebar.offlineDownloads = [entry()];
      sidebar.showDownloadsPanel();
      expect(byId('loginSection').style.display).toBe('none');
      expect(byId('downloadsList').querySelectorAll('.download-item')).toHaveLength(1);
      sidebar.hideDownloadsPanel();
      expect(byId('loginSection').style.display).toBe('block');
    });
  });

  describe('download quality', () => {
    const presets = [
      { id: 'original', label: 'Original quality' },
      { id: '2000', label: '2 Mb/s' },
      { id: '500', label: '500 Kb/s' },
    ];

    it('starts disabled and fills the picker from the plugin', () => {
      const select = byId('downloadQualitySelect');
      expect(select.disabled).toBe(true);
      expect(select.options).toHaveLength(0);

      bridge.deliver('offline-downloads', {
        downloads: [],
        quality: '2000',
        qualityPresets: presets,
      });
      expect(select.disabled).toBe(false);
      expect(
        Array.from(select.options).map((option) => [option.value, option.textContent])
      ).toEqual([
        ['original', 'Original quality'],
        ['2000', '2 Mb/s'],
        ['500', '500 Kb/s'],
      ]);
      expect(select.value).toBe('2000');
      expect(sidebar.offlineQuality).toBe('2000');

      // Repeated snapshots keep the options and update the selection only
      const firstOption = select.options[0];
      bridge.deliver('offline-downloads', {
        downloads: [],
        quality: '500',
        qualityPresets: presets,
      });
      expect(select.options[0]).toBe(firstOption);
      expect(select.value).toBe('500');

      // Missing or empty preset lists leave the picker as it was
      bridge.deliver('offline-downloads', { downloads: [], qualityPresets: [] });
      expect(select.options).toHaveLength(3);
      expect(select.value).toBe('500');
      bridge.deliver('offline-downloads', { downloads: [] });
      expect(select.value).toBe('500');
    });

    it('escapes preset labels', () => {
      bridge.deliver('offline-downloads', {
        downloads: [],
        quality: 'x',
        qualityPresets: [{ id: 'x', label: '<b>bold</b>' }],
      });
      expect(byId('downloadQualitySelect').options[0].textContent).toBe('<b>bold</b>');
    });

    it('sends the chosen quality to the plugin', () => {
      bridge.deliver('offline-downloads', {
        downloads: [],
        quality: 'original',
        qualityPresets: presets,
      });
      bridge.postMessage.mockClear();
      const select = byId('downloadQualitySelect');

      select.value = '2000';
      select.dispatchEvent(new Event('change'));

      expect(sidebar.offlineQuality).toBe('2000');
      expect(bridge.postMessage).toHaveBeenCalledWith('offline-set-quality', { quality: '2000' });
      expect(byId('downloadsNotice').textContent).toBe('New downloads will use 2 mb/s');

      sidebar.setOfflineQuality('unknown');
      expect(byId('downloadsNotice').textContent).toBe(
        'New downloads will use the selected quality'
      );
    });

    it('labels the quality of an entry', () => {
      sidebar.offlineQualityPresets = presets;
      expect(sidebar.qualityLabelFor(entry())).toBe('');
      expect(sidebar.qualityLabelFor(entry({ quality: 'original', qualityLabel: 'X' }))).toBe('');
      expect(sidebar.qualityLabelFor(entry({ quality: '2000', qualityLabel: '2 Mb/s' }))).toBe(
        '2 Mb/s'
      );
      expect(sidebar.qualityLabelFor(entry({ quality: '500' }))).toBe('500 Kb/s');
      expect(sidebar.qualityLabelFor(entry({ quality: '9' }))).toBe('9');
    });

    it('describes transcoded downloads', () => {
      sidebar.offlineQualityPresets = presets;
      expect(sidebar.describeDownloadStatus(entry({ status: 'queued', quality: '2000' }))).toBe(
        'Queued · 2 Mb/s'
      );
      expect(
        sidebar.describeDownloadStatus(
          entry({ status: 'downloading', quality: '2000', transcoded: true, expectedBytes: null })
        )
      ).toBe('Transcoding to 2 Mb/s and downloading…');
      expect(
        sidebar.describeDownloadStatus(
          entry({ status: 'downloading', quality: 'original', transcoded: true })
        )
      ).toBe('Transcoding to a smaller file and downloading…');
      expect(
        sidebar.describeDownloadStatus(
          entry({ status: 'downloading', quality: '2000', transcoded: false, progress: 4 })
        )
      ).toBe('Downloading 4% of 1.5 GB');
      expect(
        sidebar.describeDownloadStatus(
          entry({ quality: '2000', transcoded: true, expectedBytes: null, subtitles: [] })
        )
      ).toBe('Ready to play offline · transcoded to 2 Mb/s · 0 subtitles');
      expect(sidebar.describeDownloadStatus(entry({ quality: '2000', transcoded: false }))).toBe(
        'Ready to play offline · original file, already below the limit · 1.5 GB · 1 subtitle'
      );
    });

    it('shows an indeterminate bar while transcoding', () => {
      sidebar.offlineDownloads = [
        entry({ itemId: 'a', status: 'downloading', transcoded: true, progress: 0 }),
        entry({ itemId: 'b', status: 'downloading', transcoded: false, progress: 40 }),
      ];
      sidebar.renderDownloadsList();
      const bars = byId('downloadsList').querySelectorAll('.download-progress');
      expect(bars[0].className).toBe('download-progress indeterminate');
      expect(bars[0].querySelector('.download-progress-bar').style.width).toBe('100%');
      expect(bars[1].className).toBe('download-progress');
      expect(bars[1].querySelector('.download-progress-bar').style.width).toBe('40%');
    });
  });

  describe('rendering the list', () => {
    it('formats byte counts', () => {
      expect(sidebar.formatBytes(0)).toBe('');
      expect(sidebar.formatBytes(null)).toBe('');
      expect(sidebar.formatBytes('x')).toBe('');
      expect(sidebar.formatBytes(-5)).toBe('');
      expect(sidebar.formatBytes(512)).toBe('512 B');
      expect(sidebar.formatBytes(1024)).toBe('1.0 KB');
      expect(sidebar.formatBytes(1536 * 1024)).toBe('1.5 MB');
      expect(sidebar.formatBytes(3 * 1024 ** 3)).toBe('3.0 GB');
      expect(sidebar.formatBytes(2 * 1024 ** 4)).toBe('2.0 TB');
      expect(sidebar.formatBytes(5000 * 1024 ** 4)).toBe('5000.0 TB');
    });

    it('describes entry subtitles', () => {
      expect(
        sidebar.describeDownloadSubtitle(
          entry({ type: 'Episode', seriesName: 'Show', seasonNumber: 1, episodeNumber: 2 })
        )
      ).toBe('Show · S1E2');
      expect(
        sidebar.describeDownloadSubtitle(
          entry({ type: 'Episode', seriesName: null, seasonNumber: 1, episodeNumber: null })
        )
      ).toBe('');
      expect(
        sidebar.describeDownloadSubtitle(
          entry({ type: 'Episode', seriesName: 'Show', seasonNumber: null, episodeNumber: 2 })
        )
      ).toBe('Show');
      expect(
        sidebar.describeDownloadSubtitle(
          entry({ type: 'Episode', seriesName: null, seasonNumber: 1, episodeNumber: 2 })
        )
      ).toBe('S1E2');
      expect(sidebar.describeDownloadSubtitle(entry())).toBe('Movie · 2020');
      expect(sidebar.describeDownloadSubtitle(entry({ productionYear: null }))).toBe('Movie');
      expect(sidebar.describeDownloadSubtitle(entry({ type: 'Audio' }))).toBe('Song');
    });

    it('describes entry status', () => {
      expect(sidebar.describeDownloadStatus(entry({ status: 'queued' }))).toBe('Queued');
      expect(sidebar.describeDownloadStatus(entry({ status: 'downloading', progress: 5 }))).toBe(
        'Downloading 5% of 1.5 GB'
      );
      expect(
        sidebar.describeDownloadStatus(
          entry({ status: 'downloading', progress: undefined, expectedBytes: null })
        )
      ).toBe('Downloading 0%');
      expect(sidebar.describeDownloadStatus(entry({ status: 'cancelled' }))).toBe('Cancelling…');
      expect(sidebar.describeDownloadStatus(entry({ status: 'failed', error: 'boom' }))).toBe(
        'Failed: boom'
      );
      expect(sidebar.describeDownloadStatus(entry({ status: 'failed', error: null }))).toBe(
        'Failed: unknown error'
      );
      expect(sidebar.describeDownloadStatus(entry({ fileMissing: true }))).toBe(
        'File missing — it was moved or deleted'
      );
      expect(sidebar.describeDownloadStatus(entry())).toBe(
        'Ready to play offline · 1.5 GB · 1 subtitle'
      );
      expect(
        sidebar.describeDownloadStatus(entry({ expectedBytes: null, subtitles: [{}, {}] }))
      ).toBe('Ready to play offline · 2 subtitles');
      expect(
        sidebar.describeDownloadStatus(entry({ subtitles: undefined })).endsWith('0 subtitles')
      ).toBe(true);
    });

    it('offers the right actions per state', () => {
      const actions = (e) => sidebar.downloadActionsFor(e).map((action) => action.action);
      expect(actions(entry({ status: 'queued' }))).toEqual(['cancel']);
      expect(actions(entry({ status: 'downloading' }))).toEqual(['cancel']);
      expect(actions(entry({ status: 'cancelled' }))).toEqual([]);
      expect(actions(entry({ status: 'failed' }))).toEqual(['retry', 'remove']);
      expect(actions(entry({ fileMissing: true }))).toEqual(['retry', 'remove']);
      expect(sidebar.downloadActionsFor(entry({ fileMissing: true }))[0].label).toBe('Re-download');
      expect(actions(entry())).toEqual(['play', 'reveal', 'remove']);
    });

    it('renders entries with progress, sorting and summary', () => {
      sidebar.offlineDownloads = [
        entry({ itemId: 'old', createdAt: 1 }),
        entry({ itemId: 'new', createdAt: 5 }),
        entry({ itemId: 'mid', createdAt: 3, type: 'Audio' }),
        entry({ itemId: 'active', status: 'downloading', progress: 150, createdAt: 2 }),
        entry({ itemId: 'neg', status: 'downloading', progress: -3, createdAt: 3 }),
        entry({ itemId: 'nodate', createdAt: undefined, type: 'Unknown' }),
        entry({ itemId: 'nodate2', createdAt: undefined, fileMissing: true }),
        entry({ itemId: 'noprogress', status: 'downloading', progress: undefined, createdAt: 0 }),
      ];

      const inputOrder = sidebar.offlineDownloads.map((e) => e.itemId);
      sidebar.renderDownloadsList();
      // Sorting works on a copy
      expect(sidebar.offlineDownloads.map((e) => e.itemId)).toEqual(inputOrder);

      const ids = Array.from(byId('downloadsList').querySelectorAll('.download-item')).map(
        (el) => el.dataset.downloadId
      );
      expect(ids).toEqual([
        'neg',
        'active',
        'noprogress',
        'new',
        'mid',
        'old',
        'nodate',
        'nodate2',
      ]);
      expect(byId('downloadsSummary').textContent).toBe('4 ready · 3 active');
      expect(strayText(byId('downloadsList'))).toBe('');
      const bars = byId('downloadsList').querySelectorAll('.download-progress-bar');
      expect(Array.from(bars).map((bar) => bar.style.width)).toEqual(['0%', '100%', '0%']);
      expect(
        byId('downloadsList')
          .querySelector('[data-download-id="nodate2"]')
          .classList.contains('missing')
      ).toBe(true);
      expect(
        byId('downloadsList').querySelector('[data-download-id="nodate"] .download-icon')
          .textContent
      ).toBe('🎬');

      sidebar.offlineDownloads = [entry()];
      sidebar.renderDownloadsList();
      expect(byId('downloadsSummary').textContent).toBe('1 ready');
      expect(byId('downloadsList').querySelector('.media-subtitle').textContent).toBe(
        'Movie · 2020'
      );

      sidebar.offlineDownloads = [entry({ type: 'Episode', seriesName: null, seasonNumber: null })];
      sidebar.renderDownloadsList();
      expect(byId('downloadsList').querySelector('.media-subtitle')).toBeNull();
      expect(byId('downloadsList').querySelector('.download-icon').textContent).toBe('📺');

      sidebar.offlineDownloads = [entry({ name: undefined, title: 'Fallback Title' })];
      sidebar.renderDownloadsList();
      expect(byId('downloadsList').querySelector('.media-title').textContent).toBe(
        'Fallback Title'
      );

      sidebar.offlineDownloads = [];
      sidebar.renderDownloadsList();
      expect(byId('downloadsList').textContent).toContain('No downloads yet');
      expect(byId('downloadsSummary').textContent).toBe('');
    });

    it('wires the entry buttons to the plugin messages', () => {
      vi.useFakeTimers();
      sidebar.offlineDownloads = [entry()];
      sidebar.renderDownloadsList();
      const button = (action) =>
        byId('downloadsList').querySelector(`.download-action-btn[data-action="${action}"]`);

      click(button('play'));
      expect(bridge.postMessage).toHaveBeenCalledWith('play-offline', { itemId: 'movie-1' });
      click(button('reveal'));
      expect(bridge.postMessage).toHaveBeenCalledWith('offline-show-in-finder', {
        itemId: 'movie-1',
      });

      // Remove needs confirmation
      click(button('remove'));
      expect(button('remove').textContent).toBe('Confirm?');
      expect(bridge.postMessage).not.toHaveBeenCalledWith('offline-remove', expect.anything());
      vi.advanceTimersByTime(4000);
      expect(button('remove').textContent).toBe('Remove');
      expect(button('remove').dataset.confirm).toBe('false');

      click(button('remove'));
      click(button('remove'));
      expect(bridge.postMessage).toHaveBeenCalledWith('offline-remove', { itemId: 'movie-1' });

      // A detached button is not reset
      const detached = button('remove');
      detached.dataset.confirm = 'false';
      click(detached);
      detached.remove();
      vi.advanceTimersByTime(4000);
      expect(detached.textContent).toBe('Confirm?');

      sidebar.offlineDownloads = [entry({ status: 'failed' })];
      sidebar.renderDownloadsList();
      click(button('retry'));
      expect(bridge.postMessage).toHaveBeenCalledWith(
        'offline-retry',
        expect.objectContaining({ itemId: 'movie-1' })
      );

      sidebar.offlineDownloads = [entry({ status: 'downloading' })];
      sidebar.renderDownloadsList();
      click(button('cancel'));
      expect(bridge.postMessage).toHaveBeenCalledWith('offline-cancel', { itemId: 'movie-1' });

      const stray = document.createElement('button');
      stray.textContent = 'Nothing';
      bridge.postMessage.mockClear();
      sidebar.handleDownloadEntryAction('unknown', entry(), stray);
      expect(stray.textContent).toBe('Nothing');
      expect(stray.dataset.confirm).toBeUndefined();
      expect(bridge.postMessage).not.toHaveBeenCalled();
    });
  });

  describe('notices', () => {
    it('shows a notice and hides it after a while', () => {
      vi.useFakeTimers();
      sidebar.showDownloadsNotice('first');
      expect(byId('downloadsNotice').textContent).toBe('first');
      expect(byId('downloadsNotice').style.display).toBe('block');

      vi.advanceTimersByTime(2000);
      sidebar.showDownloadsNotice('second');
      vi.advanceTimersByTime(4000);
      expect(byId('downloadsNotice').textContent).toBe('second');

      vi.advanceTimersByTime(1000);
      expect(byId('downloadsNotice').textContent).toBe('');
      expect(byId('downloadsNotice').style.display).toBe('none');
      expect(sidebar.downloadsNoticeTimer).toBeNull();
    });
  });

  it('keeps working after the plugin sends progress updates', async () => {
    connect(sidebar);
    const list = byId('recentList');
    sidebar.renderMediaList([MOVIE], list);
    const button = list.querySelector('[data-offline-item-id="movie-1"]');
    expect(button.textContent).toBe('⬇ Offline');

    bridge.deliver('offline-downloads', {
      downloads: [entry({ status: 'downloading', progress: 30 })],
    });
    expect(button.textContent).toBe('30%');
    expect(button.dataset.offlineState).toBe('downloading');

    bridge.deliver('offline-downloads', { downloads: [entry()] });
    expect(button.textContent).toBe('▶ Offline');
    click(button);
    expect(bridge.postMessage).toHaveBeenCalledWith('play-offline', { itemId: 'movie-1' });
    await flushPromises();
  });
});
