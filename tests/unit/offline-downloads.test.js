import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createOfflineDownloadManager,
  buildDisplayTitle,
  pickContainer,
  normalizeLoadedPath,
  normalizeServerUrl,
  sanitizeId,
  STATUS,
  DOWNLOADABLE_TYPES,
} from '../../src/lib/offline-downloads.js';

const SERVER = 'http://jf.local:8096';
const TOKEN = 'token-123';

const MOVIE = {
  Id: 'movie-1',
  Type: 'Movie',
  Name: 'Big Film',
  ProductionYear: 2020,
  RunTimeTicks: 60000000000,
};

const EPISODE = {
  Id: 'ep-1',
  Type: 'Episode',
  Name: 'Pilot',
  SeriesName: 'Show',
  ParentIndexNumber: 1,
  IndexNumber: 2,
};

const SONG = { Id: 'song-1', Type: 'Audio', Name: 'Tune', AlbumArtist: 'Band' };

function playbackInfo({
  streams = [],
  container = 'mkv,webm',
  size = 2048,
  sourceId = 'src-1',
} = {}) {
  return {
    MediaSources: [{ Id: sourceId, Container: container, Size: size, MediaStreams: streams }],
  };
}

const EXTERNAL_SUB = {
  Type: 'Subtitle',
  IsTextSubtitleStream: true,
  IsExternal: true,
  Index: 3,
  Language: 'eng',
  Codec: 'subrip',
  DisplayTitle: 'English',
};
const EMBEDDED_SUB = { ...EXTERNAL_SUB, Index: 4, IsExternal: false };
const IMAGE_SUB = { ...EXTERNAL_SUB, Index: 5, IsTextSubtitleStream: false, Codec: 'pgssub' };

/**
 * Wait until the predicate holds (the manager runs downloads without awaiting).
 */
async function waitFor(predicate, attempts = 200) {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Condition not met in time');
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createEnv(options = {}) {
  const files = new Map();
  const prefs = new Map(Object.entries(options.preferences || {}));
  const toIinaPath = (absolute) => absolute.replace('/abs/data', '@data');

  const file = {
    exists: vi.fn((path) => files.has(path)),
    read: vi.fn((path) => files.get(path)),
    write: vi.fn((path, content) => files.set(path, content)),
    delete: vi.fn((path) => files.delete(path)),
    showInFinder: vi.fn(),
  };
  const utils = {
    resolvePath: vi.fn((path) => String(path).replace(/^@data/, '/abs/data')),
    exec: vi.fn(async (command, args) => {
      if (command === 'mkdir' && !options.mkdirFails) {
        files.set(toIinaPath(args[1]), '<dir>');
      }
      return { status: 0, stdout: '', stderr: '' };
    }),
  };
  const transport = {
    download: vi.fn(async (url, destination) => {
      files.set(destination, `content:${url}`);
    }),
    cancel: vi.fn(async () => true),
  };
  const core = { osd: vi.fn(), subtitle: { loadTrack: vi.fn() } };
  const mpv = { set: vi.fn() };
  const deps = {
    file,
    utils,
    core,
    mpv,
    preferences: { get: vi.fn((key) => prefs.get(key)) },
    fetchPlaybackInfo: vi.fn(async () => playbackInfo()),
    buildJellyfinHeaders: vi.fn((token) => ({ Authorization: `MediaBrowser Token="${token}"` })),
    loadStoredServers: vi.fn(() => []),
    transport,
    notifyViews: vi.fn(),
    openMedia: vi.fn(),
    log: vi.fn(),
  };
  const manager = createOfflineDownloadManager(deps);
  const lastSnapshot = () => {
    const calls = deps.notifyViews.mock.calls;
    return calls.length ? calls[calls.length - 1][1] : null;
  };
  const entry = (itemId) => manager.listDownloads().find((item) => item.itemId === itemId);
  const manifest = () => JSON.parse(files.get('@data/offline/manifest.json'));
  return { ...deps, files, prefs, manager, lastSnapshot, entry, manifest };
}

const request = (item, extra = {}) => ({
  item,
  serverUrl: SERVER,
  accessToken: TOKEN,
  serverId: 'srv-1',
  ...extra,
});

describe('pure helpers', () => {
  it('exposes the status and type constants', () => {
    expect(STATUS.COMPLETED).toBe('completed');
    expect(DOWNLOADABLE_TYPES).toEqual(['Movie', 'Episode', 'Audio']);
  });

  it('normalizes server urls', () => {
    expect(normalizeServerUrl('http://a/')).toBe('http://a');
    expect(normalizeServerUrl('http://a//')).toBe('http://a');
    expect(normalizeServerUrl(undefined)).toBe('');
    expect(normalizeServerUrl(null)).toBe('');
  });

  it('sanitizes ids', () => {
    expect(sanitizeId('ab-c_1')).toBe('ab-c_1');
    expect(sanitizeId('a b/c.d')).toBe('a_b_c_d');
    expect(sanitizeId(42)).toBe('42');
  });

  describe('buildDisplayTitle', () => {
    it('formats episodes with season and episode numbers', () => {
      expect(buildDisplayTitle(EPISODE)).toBe('Show S01E02 - Pilot');
    });

    it('formats episodes without numbers', () => {
      expect(buildDisplayTitle({ ...EPISODE, IndexNumber: undefined })).toBe('Show - Pilot');
      expect(buildDisplayTitle({ ...EPISODE, ParentIndexNumber: undefined })).toBe('Show - Pilot');
    });

    it('falls back to the plain name for episodes without a series', () => {
      expect(buildDisplayTitle({ ...EPISODE, SeriesName: undefined })).toBe('Pilot');
    });

    it('applies the episode, movie and song formats only to their own types', () => {
      expect(buildDisplayTitle({ ...MOVIE, SeriesName: 'Not a show' })).toBe('Big Film (2020)');
      expect(buildDisplayTitle({ ...SONG, ProductionYear: 1999 })).toBe('Band - Tune');
      expect(buildDisplayTitle({ Type: 'Movie', Name: 'X', AlbumArtist: 'Y' })).toBe('X');
      expect(
        buildDisplayTitle({ Type: 'Series', Name: 'S', SeriesName: 'S', ProductionYear: 1 })
      ).toBe('S');
    });

    it('formats movies with and without a year', () => {
      expect(buildDisplayTitle(MOVIE)).toBe('Big Film (2020)');
      expect(buildDisplayTitle({ ...MOVIE, ProductionYear: undefined })).toBe('Big Film');
    });

    it('formats songs with the artist', () => {
      expect(buildDisplayTitle(SONG)).toBe('Band - Tune');
      expect(buildDisplayTitle({ ...SONG, AlbumArtist: undefined, Artists: ['A', 'B'] })).toBe(
        'A, B - Tune'
      );
      expect(buildDisplayTitle({ ...SONG, AlbumArtist: undefined, Artists: 'nope' })).toBe('Tune');
      expect(buildDisplayTitle({ ...SONG, AlbumArtist: undefined })).toBe('Tune');
    });

    it('uses a placeholder for unnamed items', () => {
      expect(buildDisplayTitle({ Type: 'Movie' })).toBe('Unknown Title');
    });
  });

  describe('pickContainer', () => {
    it('takes the first reported container alias', () => {
      expect(pickContainer({ Container: 'mov,mp4,m4a' }, 'Movie')).toBe(
        'mp4'.replace('mp4', 'mov')
      );
      expect(pickContainer({ Container: ' MKV ' }, 'Movie')).toBe('mkv');
      expect(pickContainer({ Container: 'm4a!' }, 'Audio')).toBe('m4a');
    });

    it('falls back by item type', () => {
      expect(pickContainer({ Container: '' }, 'Movie')).toBe('mkv');
      expect(pickContainer({}, 'Episode')).toBe('mkv');
      expect(pickContainer(null, 'Audio')).toBe('mp3');
      expect(pickContainer({ Container: '!!!' }, 'Audio')).toBe('mp3');
    });
  });

  describe('normalizeLoadedPath', () => {
    it('strips file:// prefixes and decodes percent encoding', () => {
      expect(normalizeLoadedPath('file:///Users/me/a%20b.mkv')).toBe('/Users/me/a b.mkv');
      expect(normalizeLoadedPath('FILE://localhost/Users/me/x.mkv')).toBe('/Users/me/x.mkv');
      expect(normalizeLoadedPath('/Users/me/x.mkv')).toBe('/Users/me/x.mkv');
    });

    it('keeps malformed encodings as they are', () => {
      expect(normalizeLoadedPath('/Users/me/100%.mkv')).toBe('/Users/me/100%.mkv');
    });

    it('only strips the scheme at the start of the value', () => {
      expect(normalizeLoadedPath('/mnt/file://weird/x.mkv')).toBe('/mnt/file://weird/x.mkv');
      expect(normalizeLoadedPath('file://localhost')).toBe('');
    });

    it('handles empty values', () => {
      expect(normalizeLoadedPath(null)).toBe('');
      expect(normalizeLoadedPath(undefined)).toBe('');
    });
  });
});

describe('createOfflineDownloadManager', () => {
  let env;

  beforeEach(() => {
    env = createEnv();
  });

  describe('directory and manifest', () => {
    it('defaults to the plugin data folder', () => {
      expect(env.manager.getDirectory()).toBe('@data/offline');
      expect(env.manager.snapshot()).toEqual({ downloads: [], directory: '/abs/data/offline' });
    });

    it('uses the preference when set, without trailing slashes', () => {
      env.prefs.set('offline_download_dir', '  ~/Movies/Offline// ');
      expect(env.manager.getDirectory()).toBe('~/Movies/Offline');
    });

    it('starts empty when no manifest exists', () => {
      expect(env.manager.listDownloads()).toEqual([]);
      expect(env.log).toHaveBeenCalledWith('Loaded 0 offline download entries from @data/offline');
    });

    it('reads entries from the manifest and marks interrupted ones failed', () => {
      env.files.set(
        '@data/offline/manifest.json',
        JSON.stringify([
          { itemId: 'a', status: 'completed', mediaPath: '@data/offline/a.mkv' },
          { itemId: 'b', status: 'downloading', progress: 40 },
          { itemId: 'c', status: 'queued' },
          { status: 'completed' },
          null,
          'junk',
        ])
      );
      env.files.set('@data/offline/a.mkv', 'x');

      const list = env.manager.listDownloads();
      expect(list.map((entry) => entry.itemId)).toEqual(['a', 'b', 'c']);
      expect(list[0]).toMatchObject({ status: 'completed', fileMissing: false });
      expect(list[1]).toMatchObject({
        status: 'failed',
        progress: 0,
        error: 'Interrupted before the download finished',
      });
      expect(list[2].status).toBe('failed');
    });

    it('flags completed entries whose file is gone', () => {
      env.files.set(
        '@data/offline/manifest.json',
        JSON.stringify([{ itemId: 'a', status: 'completed', mediaPath: '@data/offline/a.mkv' }])
      );
      expect(env.manager.listDownloads()[0].fileMissing).toBe(true);
    });

    it('ignores a manifest that is not a list', () => {
      env.files.set('@data/offline/manifest.json', JSON.stringify({ itemId: 'a' }));
      expect(env.manager.listDownloads()).toEqual([]);
      expect(env.log).toHaveBeenCalledWith('Offline manifest is not a list, ignoring it');
    });

    it('ignores a corrupt manifest', () => {
      env.files.set('@data/offline/manifest.json', '{not json');
      expect(env.manager.listDownloads()).toEqual([]);
      expect(env.log).toHaveBeenCalledWith(
        expect.stringMatching(/^Could not read offline manifest: /)
      );
    });

    it('treats an empty manifest file as empty', () => {
      env.files.set('@data/offline/manifest.json', '');
      expect(env.manager.listDownloads()).toEqual([]);
    });

    it('reloads when the directory preference changes', () => {
      env.files.set(
        '@data/offline/manifest.json',
        JSON.stringify([{ itemId: 'a', status: 'completed', mediaPath: null }])
      );
      expect(env.manager.listDownloads()).toHaveLength(1);
      expect(env.manager.listDownloads()).toHaveLength(1);
      expect(env.file.read).toHaveBeenCalledTimes(1);

      env.prefs.set('offline_download_dir', '/Volumes/Ext/jf');
      expect(env.manager.listDownloads()).toEqual([]);
      expect(env.file.read).toHaveBeenCalledTimes(1);
    });

    it('reports file checks that throw as missing', () => {
      env.files.set(
        '@data/offline/manifest.json',
        JSON.stringify([{ itemId: 'a', status: 'completed', mediaPath: '@data/offline/a.mkv' }])
      );
      env.file.exists.mockImplementation((path) => {
        if (path === '@data/offline/a.mkv') throw new Error('io');
        return env.files.has(path);
      });
      expect(env.manager.listDownloads()[0].fileMissing).toBe(true);
      expect(env.log).toHaveBeenCalledWith('Could not check @data/offline/a.mkv: io');
    });
  });

  describe('isDownloadable', () => {
    it('accepts movies, episodes and songs with ids', () => {
      expect(env.manager.isDownloadable(MOVIE)).toBe(true);
      expect(env.manager.isDownloadable(EPISODE)).toBe(true);
      expect(env.manager.isDownloadable(SONG)).toBe(true);
    });

    it('rejects other types and incomplete items', () => {
      expect(env.manager.isDownloadable({ Id: 's', Type: 'Series' })).toBe(false);
      expect(env.manager.isDownloadable({ Type: 'Movie' })).toBe(false);
      expect(env.manager.isDownloadable(null)).toBe(false);
    });
  });

  describe('startDownload', () => {
    it('rejects items that cannot be downloaded', async () => {
      await expect(env.manager.startDownload(request({ Id: 's1', Type: 'Series' }))).resolves.toBe(
        null
      );
      await expect(env.manager.startDownload()).resolves.toBe(null);
      expect(env.core.osd).toHaveBeenCalledWith('This item cannot be downloaded for offline use');
      expect(env.log).toHaveBeenCalledWith('Item is not downloadable: Series s1');
      expect(env.log).toHaveBeenCalledWith('Item is not downloadable: missing');
      expect(env.transport.download).not.toHaveBeenCalled();
    });

    it('rejects requests without credentials', async () => {
      await expect(env.manager.startDownload({ item: MOVIE, serverUrl: SERVER })).resolves.toBe(
        null
      );
      await expect(env.manager.startDownload({ item: MOVIE, accessToken: TOKEN })).resolves.toBe(
        null
      );
      expect(env.core.osd).toHaveBeenCalledWith('Connect to a Jellyfin server before downloading');
      expect(env.manager.listDownloads()).toEqual([]);
    });

    it('downloads the media and its external text subtitles', async () => {
      env.fetchPlaybackInfo.mockResolvedValue(
        playbackInfo({ streams: [EXTERNAL_SUB, EMBEDDED_SUB, IMAGE_SUB, { Type: 'Video' }] })
      );

      const queued = await env.manager.startDownload(request(MOVIE, { serverUrl: `${SERVER}/` }));
      expect(queued).toMatchObject({
        itemId: 'movie-1',
        type: 'Movie',
        title: 'Big Film (2020)',
        name: 'Big Film',
        productionYear: 2020,
        runTimeTicks: 60000000000,
        serverUrl: SERVER,
        serverId: 'srv-1',
        seriesName: null,
        seasonNumber: null,
        episodeNumber: null,
      });
      expect(env.core.osd).toHaveBeenCalledWith('Queued for download: Big Film (2020)');

      await waitFor(() => env.entry('movie-1')?.status === 'completed');

      const done = env.entry('movie-1');
      expect(done).toMatchObject({
        status: 'completed',
        progress: 100,
        container: 'mkv',
        expectedBytes: 2048,
        mediaPath: '@data/offline/movie-1.mkv',
        mediaAbsolutePath: '/abs/data/offline/movie-1.mkv',
        fileMissing: false,
        error: null,
      });
      expect(typeof done.completedAt).toBe('number');
      expect(done.subtitles).toEqual([
        {
          index: 3,
          language: 'eng',
          title: 'English',
          codec: 'subrip',
          path: '@data/offline/movie-1_sub_3_eng.srt',
          absolutePath: '/abs/data/offline/movie-1_sub_3_eng.srt',
        },
      ]);

      expect(env.fetchPlaybackInfo).toHaveBeenCalledWith(SERVER, 'movie-1', TOKEN);
      expect(env.transport.download).toHaveBeenCalledTimes(2);
      expect(env.transport.download.mock.calls[0][0]).toBe(
        `${SERVER}/Videos/movie-1/stream?static=true&mediaSourceId=src-1`
      );
      expect(env.transport.download.mock.calls[0][1]).toBe('@data/offline/movie-1.mkv');
      expect(env.transport.download.mock.calls[0][2].headers).toEqual({
        Authorization: `MediaBrowser Token="${TOKEN}"`,
      });
      expect(env.transport.download.mock.calls[1][0]).toBe(
        `${SERVER}/Videos/movie-1/src-1/Subtitles/3/stream.srt`
      );
      expect(env.transport.download.mock.calls[1][1]).toBe('@data/offline/movie-1_sub_3_eng.srt');
      expect(env.transport.download.mock.calls[1][2]).toEqual({
        headers: { Authorization: `MediaBrowser Token="${TOKEN}"` },
      });

      expect(env.core.osd).toHaveBeenCalledWith('Downloaded for offline: Big Film (2020)');
      expect(env.manifest()).toHaveLength(1);
      expect(JSON.stringify(env.manifest())).not.toContain(TOKEN);
      expect(env.utils.exec).toHaveBeenCalledWith('mkdir', ['-p', '/abs/data/offline']);
      expect(env.lastSnapshot()).toEqual({
        downloads: [expect.objectContaining({ status: 'completed' })],
        directory: '/abs/data/offline',
      });
    });

    it('downloads songs from the audio route with fallbacks for missing data', async () => {
      env.fetchPlaybackInfo.mockResolvedValue({
        MediaSources: [{ Container: '', Size: 'n/a', MediaStreams: undefined }],
      });

      await env.manager.startDownload(request(SONG));
      await waitFor(() => env.entry('song-1')?.status === 'completed');

      expect(env.transport.download.mock.calls[0][0]).toBe(
        `${SERVER}/Audio/song-1/stream?static=true&mediaSourceId=song-1`
      );
      expect(env.entry('song-1')).toMatchObject({
        container: 'mp3',
        expectedBytes: null,
        mediaPath: '@data/offline/song-1.mp3',
        subtitles: [],
      });
    });

    it('records episode numbering and unknown subtitle metadata', async () => {
      env.fetchPlaybackInfo.mockResolvedValue(
        playbackInfo({
          streams: [{ Type: 'Subtitle', IsTextSubtitleStream: true, IsExternal: true, Index: 9 }],
        })
      );

      await env.manager.startDownload(request(EPISODE));
      await waitFor(() => env.entry('ep-1')?.status === 'completed');

      expect(env.entry('ep-1')).toMatchObject({
        title: 'Show S01E02 - Pilot',
        seriesName: 'Show',
        seasonNumber: 1,
        episodeNumber: 2,
        runTimeTicks: null,
        productionYear: null,
      });
      expect(env.entry('ep-1').subtitles).toEqual([
        {
          index: 9,
          language: 'unknown',
          title: 'unknown',
          codec: null,
          path: '@data/offline/ep-1_sub_9_unknown.srt',
          absolutePath: '/abs/data/offline/ep-1_sub_9_unknown.srt',
        },
      ]);
    });

    it('fills in defaults for nameless items and missing server ids', async () => {
      await env.manager.startDownload({
        item: { Id: 'x-1', Type: 'Movie' },
        serverUrl: SERVER,
        accessToken: TOKEN,
      });
      await waitFor(() => env.entry('x-1')?.status === 'completed');
      expect(env.entry('x-1')).toMatchObject({
        name: 'Unknown Title',
        title: 'Unknown Title',
        serverId: null,
      });
    });

    it('uses the stream title when there is no display title', async () => {
      env.fetchPlaybackInfo.mockResolvedValue(
        playbackInfo({ streams: [{ ...EXTERNAL_SUB, DisplayTitle: undefined, Title: 'Forced' }] })
      );

      await env.manager.startDownload(request(MOVIE));
      await waitFor(() => env.entry('movie-1')?.status === 'completed');

      expect(env.entry('movie-1').subtitles[0].title).toBe('Forced');
    });

    it('reports progress as whole percentages and only when it changes', async () => {
      const gate = deferred();
      env.transport.download.mockImplementationOnce(async (url, destination, { onProgress }) => {
        onProgress(12.7);
        onProgress(12.9);
        onProgress(-5);
        onProgress(250);
        await gate.promise;
        env.files.set(destination, 'media');
      });

      await env.manager.startDownload(request(MOVIE));
      await waitFor(() => env.entry('movie-1')?.progress === 100);

      const progressValues = env.notifyViews.mock.calls
        .map((call) => call[1].downloads[0]?.progress)
        .filter((value) => value !== undefined);
      // 12.7 -> 12, 12.9 -> 12 (no change), -5 -> 0, 250 -> 100
      expect(progressValues).toContain(12);
      expect(progressValues.filter((value) => value === 12)).toHaveLength(1);
      expect(env.entry('movie-1').status).toBe('downloading');

      gate.resolve();
      await waitFor(() => env.entry('movie-1')?.status === 'completed');
    });

    it('does not start the same download twice', async () => {
      const gate = deferred();
      env.transport.download.mockImplementationOnce(async (url, destination) => {
        await gate.promise;
        env.files.set(destination, 'media');
      });

      await env.manager.startDownload(request(MOVIE));
      await waitFor(() => env.entry('movie-1')?.status === 'downloading');

      const again = await env.manager.startDownload(request(MOVIE));
      expect(again.status).toBe('downloading');
      expect(env.core.osd).toHaveBeenCalledWith('Already downloading: Big Film (2020)');
      expect(env.manager.listDownloads()).toHaveLength(1);

      gate.resolve();
      await waitFor(() => env.entry('movie-1')?.status === 'completed');

      const completed = await env.manager.startDownload(request(MOVIE));
      expect(completed.status).toBe('completed');
      expect(env.core.osd).toHaveBeenCalledWith('Already downloaded: Big Film (2020)');
      expect(env.transport.download).toHaveBeenCalledTimes(1);
    });

    it('reports a queued duplicate while another download runs', async () => {
      const gate = deferred();
      env.transport.download.mockImplementationOnce(async (url, destination) => {
        await gate.promise;
        env.files.set(destination, 'media');
      });

      await env.manager.startDownload(request(MOVIE));
      await env.manager.startDownload(request(SONG));
      expect(env.entry('song-1').status).toBe('queued');

      const again = await env.manager.startDownload(request(SONG));
      expect(again.status).toBe('queued');
      expect(env.core.osd).toHaveBeenCalledWith('Already downloading: Band - Tune');

      gate.resolve();
      await waitFor(() => env.entry('song-1')?.status === 'completed');
      expect(env.entry('movie-1').status).toBe('completed');
    });

    it('starts over after a failure', async () => {
      env.fetchPlaybackInfo.mockRejectedValueOnce(new Error('first attempt'));
      await env.manager.startDownload(request(MOVIE));
      await waitFor(() => env.entry('movie-1')?.status === 'failed');

      await env.manager.startDownload(request(MOVIE));
      await waitFor(() => env.entry('movie-1')?.status === 'completed');
      expect(env.core.osd).not.toHaveBeenCalledWith('Already downloaded: Big Film (2020)');
      expect(env.manager.listDownloads()).toHaveLength(1);
    });

    it('starts over when the completed file went missing', async () => {
      env.fetchPlaybackInfo.mockResolvedValue(playbackInfo({ streams: [EXTERNAL_SUB] }));
      await env.manager.startDownload(request(MOVIE));
      await waitFor(() => env.entry('movie-1')?.status === 'completed');

      env.files.delete('@data/offline/movie-1.mkv');
      expect(env.entry('movie-1').fileMissing).toBe(true);

      await env.manager.startDownload(request(MOVIE));
      await waitFor(
        () => env.entry('movie-1')?.status === 'completed' && !env.entry('movie-1').fileMissing
      );

      expect(env.file.delete).toHaveBeenCalledWith('@data/offline/movie-1_sub_3_eng.srt');
      expect(env.manager.listDownloads()).toHaveLength(1);
      expect(env.transport.download).toHaveBeenCalledTimes(4);
    });

    it('fails cleanly when playback info cannot be fetched', async () => {
      env.fetchPlaybackInfo.mockRejectedValue(new Error('HTTP 500'));

      await env.manager.startDownload(request(MOVIE));
      await waitFor(() => env.entry('movie-1')?.status === 'failed');

      expect(env.entry('movie-1')).toMatchObject({
        status: 'failed',
        error: 'HTTP 500',
        progress: 0,
        mediaPath: null,
      });
      expect(env.core.osd).toHaveBeenCalledWith('Download failed: Big Film (2020)');
      expect(env.transport.download).not.toHaveBeenCalled();
      expect(env.manifest()[0].status).toBe('failed');
    });

    it('fails when the item has no media source', async () => {
      env.fetchPlaybackInfo.mockResolvedValue({ MediaSources: [] });
      await env.manager.startDownload(request(MOVIE));
      await waitFor(() => env.entry('movie-1')?.status === 'failed');
      expect(env.entry('movie-1').error).toBe('No media source available for this item');

      env.fetchPlaybackInfo.mockResolvedValue(null);
      await env.manager.startDownload(request(SONG));
      await waitFor(() => env.entry('song-1')?.status === 'failed');
      expect(env.entry('song-1').error).toBe('No media source available for this item');
    });

    it('fails and removes the partial file when the transfer fails', async () => {
      env.transport.download.mockImplementationOnce(async (url, destination) => {
        env.files.set(destination, 'partial');
        throw new Error('curl exited with status 18');
      });

      await env.manager.startDownload(request(MOVIE));
      await waitFor(() => env.entry('movie-1')?.status === 'failed');

      expect(env.entry('movie-1').error).toBe('curl exited with status 18');
      expect(env.file.delete).toHaveBeenCalledWith('@data/offline/movie-1.mkv');
      expect(env.files.has('@data/offline/movie-1.mkv')).toBe(false);
    });

    it('stringifies failures without a message', async () => {
      env.transport.download.mockRejectedValueOnce('plain failure');

      await env.manager.startDownload(request(MOVIE));
      await waitFor(() => env.entry('movie-1')?.status === 'failed');

      expect(env.entry('movie-1').error).toBe('plain failure');
    });

    it('keeps the media when a subtitle download fails', async () => {
      env.fetchPlaybackInfo.mockResolvedValue(
        playbackInfo({ streams: [EXTERNAL_SUB, { ...EXTERNAL_SUB, Index: 7, Language: 'pol' }] })
      );
      env.transport.download.mockImplementation(async (url, destination) => {
        if (url.includes('/Subtitles/3/')) {
          env.files.set(destination, 'partial');
          throw new Error('404');
        }
        env.files.set(destination, 'ok');
      });

      await env.manager.startDownload(request(MOVIE));
      await waitFor(() => env.entry('movie-1')?.status === 'completed');

      expect(env.entry('movie-1').subtitles.map((subtitle) => subtitle.language)).toEqual(['pol']);
      expect(env.file.delete).toHaveBeenCalledWith('@data/offline/movie-1_sub_3_eng.srt');
      expect(env.log).toHaveBeenCalledWith('Subtitle eng (3) failed: 404');
    });

    it('fails when the download directory cannot be created', async () => {
      env = createEnv({ mkdirFails: true });

      await env.manager.startDownload(request(MOVIE));
      await waitFor(() => env.entry('movie-1')?.status === 'failed');

      expect(env.entry('movie-1').error).toBe(
        'Could not create download directory /abs/data/offline'
      );
      expect(env.log).toHaveBeenCalledWith(
        'Could not save offline manifest: Could not create download directory /abs/data/offline'
      );
      expect(env.files.has('@data/offline/manifest.json')).toBe(false);
    });

    it('does not create the directory again once it exists', async () => {
      env.files.set('@data/offline', '<dir>');
      await env.manager.startDownload(request(MOVIE));
      await waitFor(() => env.entry('movie-1')?.status === 'completed');
      expect(env.utils.exec).not.toHaveBeenCalled();
    });

    it('logs when the OSD cannot be shown', async () => {
      env.core.osd.mockImplementation(() => {
        throw new Error('no window');
      });
      await env.manager.startDownload(request(MOVIE));
      expect(env.log).toHaveBeenCalledWith('Could not show OSD: no window');
      await waitFor(() => env.entry('movie-1')?.status === 'completed');
    });

    it('logs when a file cannot be deleted', async () => {
      env.transport.download.mockImplementationOnce(async (url, destination) => {
        env.files.set(destination, 'partial');
        throw new Error('boom');
      });
      env.file.delete.mockImplementation(() => {
        throw new Error('locked');
      });

      await env.manager.startDownload(request(MOVIE));
      await waitFor(() => env.entry('movie-1')?.status === 'failed');

      expect(env.log).toHaveBeenCalledWith('Could not delete @data/offline/movie-1.mkv: locked');
    });
  });

  describe('cancelDownload', () => {
    it('returns false for unknown or finished downloads', async () => {
      await expect(env.manager.cancelDownload('nope')).resolves.toBe(false);
      expect(env.log).toHaveBeenCalledWith('Cannot cancel unknown download: nope');

      await env.manager.startDownload(request(MOVIE));
      await waitFor(() => env.entry('movie-1')?.status === 'completed');
      await expect(env.manager.cancelDownload('movie-1')).resolves.toBe(false);
      expect(env.log).toHaveBeenCalledWith('Download movie-1 is completed, nothing to cancel');
    });

    it('drops a queued download immediately', async () => {
      const gate = deferred();
      env.transport.download.mockImplementationOnce(async (url, destination) => {
        await gate.promise;
        env.files.set(destination, 'media');
      });
      await env.manager.startDownload(request(MOVIE));
      await env.manager.startDownload(request(SONG));

      await expect(env.manager.cancelDownload('song-1')).resolves.toBe(true);
      expect(env.entry('song-1')).toBeUndefined();
      expect(env.transport.cancel).not.toHaveBeenCalled();
      expect(env.log).toHaveBeenCalledWith('Removed queued download: Band - Tune');

      gate.resolve();
      await waitFor(() => env.entry('movie-1')?.status === 'completed');
      expect(env.fetchPlaybackInfo).toHaveBeenCalledTimes(1);
    });

    it('aborts the running transfer and removes the entry', async () => {
      const gate = deferred();
      env.transport.download.mockImplementationOnce(async (url, destination) => {
        env.files.set(destination, 'partial');
        await gate.promise;
      });
      await env.manager.startDownload(request(MOVIE));
      await waitFor(() => env.transport.download.mock.calls.length === 1);

      await expect(env.manager.cancelDownload('movie-1')).resolves.toBe(true);
      expect(env.entry('movie-1').status).toBe('cancelled');
      expect(env.lastSnapshot().downloads[0].status).toBe('cancelled');
      expect(env.transport.cancel).toHaveBeenCalledWith('@data/offline/movie-1.mkv');

      gate.reject(new Error('killed'));
      await waitFor(() => env.entry('movie-1') === undefined);

      expect(env.files.has('@data/offline/movie-1.mkv')).toBe(false);
      expect(env.log).toHaveBeenCalledWith('Offline download cancelled: Big Film (2020)');
      expect(env.core.osd).not.toHaveBeenCalledWith('Download failed: Big Film (2020)');
      expect(env.manifest()).toEqual([]);
    });

    it('discards a transfer that completes after cancellation', async () => {
      const gate = deferred();
      env.transport.download.mockImplementationOnce(async (url, destination, { onProgress }) => {
        await gate.promise;
        onProgress(80);
        env.files.set(destination, 'media');
      });
      await env.manager.startDownload(request(MOVIE));
      await waitFor(() => env.transport.download.mock.calls.length === 1);

      await env.manager.cancelDownload('movie-1');
      gate.resolve();
      await waitFor(() => env.entry('movie-1') === undefined);
      expect(env.files.has('@data/offline/movie-1.mkv')).toBe(false);
    });

    it('cancels before the media path is known', async () => {
      const gate = deferred();
      env.fetchPlaybackInfo.mockImplementationOnce(async () => {
        await gate.promise;
        return playbackInfo();
      });
      await env.manager.startDownload(request(MOVIE));
      await waitFor(() => env.entry('movie-1')?.status === 'downloading');

      await expect(env.manager.cancelDownload('movie-1')).resolves.toBe(true);
      expect(env.transport.cancel).not.toHaveBeenCalled();

      gate.resolve();
      await waitFor(() => env.entry('movie-1') === undefined);
      expect(env.transport.download).not.toHaveBeenCalled();
    });

    it('stops fetching subtitles once cancelled', async () => {
      env.fetchPlaybackInfo.mockResolvedValue(
        playbackInfo({ streams: [EXTERNAL_SUB, { ...EXTERNAL_SUB, Index: 7, Language: 'pol' }] })
      );
      const gate = deferred();
      env.transport.download.mockImplementation(async (url, destination) => {
        env.files.set(destination, 'ok');
        if (url.includes('/Subtitles/3/')) {
          await gate.promise;
        }
      });
      await env.manager.startDownload(request(MOVIE));
      await waitFor(() => env.transport.download.mock.calls.length === 2);

      await env.manager.cancelDownload('movie-1');
      gate.resolve();
      await waitFor(() => env.entry('movie-1') === undefined);

      expect(env.transport.download).toHaveBeenCalledTimes(2);
      expect(env.files.has('@data/offline/movie-1_sub_3_eng.srt')).toBe(false);
    });
  });

  describe('removeDownload', () => {
    it('returns false for unknown downloads', async () => {
      await expect(env.manager.removeDownload('nope')).resolves.toBe(false);
      expect(env.log).toHaveBeenCalledWith('Cannot remove unknown download: nope');
    });

    it('cancels active downloads instead', async () => {
      const gate = deferred();
      env.transport.download.mockImplementationOnce(async (url, destination) => {
        await gate.promise;
        env.files.set(destination, 'media');
      });
      await env.manager.startDownload(request(MOVIE));
      await env.manager.startDownload(request(SONG));

      await expect(env.manager.removeDownload('song-1')).resolves.toBe(true);
      expect(env.entry('song-1')).toBeUndefined();

      gate.resolve();
      await waitFor(() => env.entry('movie-1')?.status === 'completed');
    });

    it('deletes the files of a completed download', async () => {
      env.fetchPlaybackInfo.mockResolvedValue(playbackInfo({ streams: [EXTERNAL_SUB] }));
      await env.manager.startDownload(request(MOVIE));
      await waitFor(() => env.entry('movie-1')?.status === 'completed');

      await expect(env.manager.removeDownload('movie-1')).resolves.toBe(true);

      expect(env.files.has('@data/offline/movie-1.mkv')).toBe(false);
      expect(env.files.has('@data/offline/movie-1_sub_3_eng.srt')).toBe(false);
      expect(env.manager.listDownloads()).toEqual([]);
      expect(env.manifest()).toEqual([]);
      expect(env.log).toHaveBeenCalledWith('Removed offline download: Big Film (2020)');
    });

    it('removes manifest entries that have no subtitle list', async () => {
      env.files.set(
        '@data/offline/manifest.json',
        JSON.stringify([
          { itemId: 'a', title: 'A', status: 'completed', mediaPath: '@data/offline/a.mkv' },
        ])
      );
      env.files.set('@data/offline/a.mkv', 'x');

      await expect(env.manager.removeDownload('a')).resolves.toBe(true);
      expect(env.files.has('@data/offline/a.mkv')).toBe(false);
      expect(env.manager.listDownloads()).toEqual([]);
    });

    it('removes an entry that is being cancelled by deleting its files', async () => {
      env.files.set(
        '@data/offline/manifest.json',
        JSON.stringify([
          { itemId: 'c', title: 'C', status: 'cancelled', mediaPath: '@data/offline/c.mkv' },
        ])
      );
      env.files.set('@data/offline/c.mkv', 'x');
      await expect(env.manager.removeDownload('c')).resolves.toBe(true);
      expect(env.files.has('@data/offline/c.mkv')).toBe(false);
    });

    it('removes failed entries without files', async () => {
      env.fetchPlaybackInfo.mockRejectedValue(new Error('nope'));
      await env.manager.startDownload(request(MOVIE));
      await waitFor(() => env.entry('movie-1')?.status === 'failed');

      await expect(env.manager.removeDownload('movie-1')).resolves.toBe(true);
      expect(env.file.delete).not.toHaveBeenCalled();
    });
  });

  describe('retryDownload', () => {
    async function failedMovie() {
      env.fetchPlaybackInfo.mockRejectedValueOnce(new Error('first attempt'));
      await env.manager.startDownload(request(MOVIE));
      await waitFor(() => env.entry('movie-1')?.status === 'failed');
    }

    it('returns false for unknown, active and complete downloads', async () => {
      await expect(env.manager.retryDownload({ itemId: 'nope' })).resolves.toBe(false);
      await expect(env.manager.retryDownload()).resolves.toBe(false);

      const gate = deferred();
      env.transport.download.mockImplementationOnce(async (url, destination) => {
        await gate.promise;
        env.files.set(destination, 'media');
      });
      await env.manager.startDownload(request(MOVIE));
      await waitFor(() => env.entry('movie-1')?.status === 'downloading');
      await expect(env.manager.retryDownload({ itemId: 'movie-1' })).resolves.toBe(false);
      expect(env.log).toHaveBeenCalledWith('Download movie-1 is already downloading');

      gate.resolve();
      await waitFor(() => env.entry('movie-1')?.status === 'completed');
      await expect(env.manager.retryDownload({ itemId: 'movie-1' })).resolves.toBe(false);
      expect(env.log).toHaveBeenCalledWith('Download movie-1 is complete, nothing to retry');
    });

    it('retries with the credentials of the connected server', async () => {
      await failedMovie();

      await expect(
        env.manager.retryDownload({
          itemId: 'movie-1',
          serverUrl: `${SERVER}/`,
          accessToken: 'new',
        })
      ).resolves.toBe(true);
      await waitFor(() => env.entry('movie-1')?.status === 'completed');

      expect(env.fetchPlaybackInfo).toHaveBeenLastCalledWith(SERVER, 'movie-1', 'new');
      expect(env.entry('movie-1')).toMatchObject({ error: null, progress: 100 });
      expect(env.log).toHaveBeenCalledWith('Retrying offline download: Big Film (2020)');
    });

    it('falls back to stored credentials, preferring signed-in accounts', async () => {
      await failedMovie();
      env.loadStoredServers.mockReturnValue([
        { serverUrl: 'http://other', accessToken: 'x', userId: 'u' },
        { serverUrl: `${SERVER}/`, accessToken: 'url-token' },
        { serverUrl: SERVER, accessToken: 'user-token', userId: 'u1' },
      ]);

      await expect(
        env.manager.retryDownload({
          itemId: 'movie-1',
          serverUrl: 'http://other',
          accessToken: 'x',
        })
      ).resolves.toBe(true);
      await waitFor(() => env.entry('movie-1')?.status === 'completed');
      expect(env.fetchPlaybackInfo).toHaveBeenLastCalledWith(SERVER, 'movie-1', 'user-token');
    });

    it('uses a url session when no account is signed in', async () => {
      await failedMovie();
      env.loadStoredServers.mockReturnValue([{ serverUrl: SERVER, accessToken: 'url-token' }]);

      await expect(env.manager.retryDownload({ itemId: 'movie-1' })).resolves.toBe(true);
      await waitFor(() => env.entry('movie-1')?.status === 'completed');
      expect(env.fetchPlaybackInfo).toHaveBeenLastCalledWith(SERVER, 'movie-1', 'url-token');
    });

    it('refuses without any credentials', async () => {
      await failedMovie();
      env.loadStoredServers.mockReturnValue(null);
      await expect(env.manager.retryDownload({ itemId: 'movie-1' })).resolves.toBe(false);

      env.loadStoredServers.mockReturnValue([
        { serverUrl: 'http://elsewhere', accessToken: 'x', userId: 'u' },
        { serverUrl: 'http://elsewhere', accessToken: 'y' },
      ]);
      await expect(env.manager.retryDownload({ itemId: 'movie-1' })).resolves.toBe(false);

      env.loadStoredServers.mockReturnValue([{ serverUrl: SERVER, userId: 'u' }]);
      await expect(env.manager.retryDownload({ itemId: 'movie-1' })).resolves.toBe(false);

      expect(env.core.osd).toHaveBeenCalledWith(
        `Cannot retry Big Film (2020): not connected to ${SERVER}`
      );
      expect(env.entry('movie-1').status).toBe('failed');
    });

    it('re-downloads a completed entry whose file is missing', async () => {
      env.fetchPlaybackInfo.mockResolvedValue(playbackInfo({ streams: [EXTERNAL_SUB] }));
      await env.manager.startDownload(request(MOVIE));
      await waitFor(() => env.entry('movie-1')?.status === 'completed');
      env.files.delete('@data/offline/movie-1.mkv');

      await expect(
        env.manager.retryDownload({ itemId: 'movie-1', serverUrl: SERVER, accessToken: TOKEN })
      ).resolves.toBe(true);
      expect(env.file.delete).toHaveBeenCalledWith('@data/offline/movie-1_sub_3_eng.srt');
      await waitFor(
        () => env.entry('movie-1')?.status === 'completed' && !env.entry('movie-1').fileMissing
      );
    });
  });

  describe('playDownload', () => {
    it('refuses unknown or unfinished downloads', async () => {
      expect(env.manager.playDownload('nope')).toBe(false);
      expect(env.log).toHaveBeenCalledWith('Cannot play download nope: unknown');

      env.fetchPlaybackInfo.mockRejectedValue(new Error('x'));
      await env.manager.startDownload(request(MOVIE));
      await waitFor(() => env.entry('movie-1')?.status === 'failed');
      expect(env.manager.playDownload('movie-1')).toBe(false);
      expect(env.log).toHaveBeenCalledWith('Cannot play download movie-1: failed');
      expect(env.core.osd).toHaveBeenCalledWith('This download is not ready to play');
      expect(env.openMedia).not.toHaveBeenCalled();
    });

    it('opens the local file with the display title', async () => {
      await env.manager.startDownload(request(EPISODE));
      await waitFor(() => env.entry('ep-1')?.status === 'completed');

      expect(env.manager.playDownload('ep-1')).toBe(true);
      expect(env.openMedia).toHaveBeenCalledWith({
        streamUrl: '/abs/data/offline/ep-1.mkv',
        title: 'Show S01E02 - Pilot',
      });
    });

    it('resolves the path for manifests without an absolute path', () => {
      env.files.set(
        '@data/offline/manifest.json',
        JSON.stringify([
          { itemId: 'a', title: 'A', status: 'completed', mediaPath: '@data/offline/a.mkv' },
        ])
      );
      env.files.set('@data/offline/a.mkv', 'x');

      expect(env.manager.playDownload('a')).toBe(true);
      expect(env.openMedia).toHaveBeenCalledWith({
        streamUrl: '/abs/data/offline/a.mkv',
        title: 'A',
      });
    });

    it('reports a missing file', async () => {
      await env.manager.startDownload(request(MOVIE));
      await waitFor(() => env.entry('movie-1')?.status === 'completed');
      env.files.delete('@data/offline/movie-1.mkv');
      env.notifyViews.mockClear();

      expect(env.manager.playDownload('movie-1')).toBe(false);
      expect(env.core.osd).toHaveBeenCalledWith('Downloaded file is missing: Big Film (2020)');
      expect(env.lastSnapshot().downloads[0].fileMissing).toBe(true);
      expect(env.openMedia).not.toHaveBeenCalled();
    });
  });

  describe('handleFileLoaded', () => {
    async function completedMovie(streams = [EXTERNAL_SUB]) {
      env.fetchPlaybackInfo.mockResolvedValue(playbackInfo({ streams }));
      await env.manager.startDownload(request(MOVIE));
      await waitFor(() => env.entry('movie-1')?.status === 'completed');
    }

    it('ignores remote urls and empty values', async () => {
      await completedMovie();
      expect(env.manager.handleFileLoaded('http://jf.local/Videos/movie-1/stream')).toBe(false);
      expect(env.manager.handleFileLoaded('HTTPS://x')).toBe(false);
      expect(env.manager.handleFileLoaded('')).toBe(false);
      expect(env.manager.handleFileLoaded(undefined)).toBe(false);
      expect(env.mpv.set).not.toHaveBeenCalled();
      // Remote urls are never looked up in the manifest, even if a path matched
      env.utils.resolvePath.mockReturnValue('http://jf.local/Videos/movie-1/stream');
      expect(env.manager.handleFileLoaded('http://jf.local/Videos/movie-1/stream')).toBe(false);
    });

    it('ignores local files that are not downloads', async () => {
      await completedMovie();
      expect(env.manager.handleFileLoaded('/Users/me/other.mkv')).toBe(false);
    });

    it('sets the title and loads the subtitles of a download', async () => {
      await completedMovie([EXTERNAL_SUB, { ...EXTERNAL_SUB, Index: 7, Language: 'pol' }]);

      expect(env.manager.handleFileLoaded('file:///abs/data/offline/movie-1.mkv')).toBe(true);

      expect(env.mpv.set).toHaveBeenCalledWith('force-media-title', 'Big Film (2020)');
      expect(env.core.subtitle.loadTrack.mock.calls.map((call) => call[0])).toEqual([
        '/abs/data/offline/movie-1_sub_3_eng.srt',
        '/abs/data/offline/movie-1_sub_7_pol.srt',
      ]);
      expect(env.core.osd).not.toHaveBeenCalledWith('Loaded 2 offline subtitle(s)');
    });

    it('matches plain paths and shows a notification when enabled', async () => {
      env.prefs.set('show_notifications', true);
      await completedMovie();

      expect(env.manager.handleFileLoaded('/abs/data/offline/movie-1.mkv')).toBe(true);
      expect(env.core.osd).toHaveBeenCalledWith('Loaded 1 offline subtitle(s)');
    });

    it('skips missing subtitles and survives loadTrack errors', async () => {
      env.prefs.set('show_notifications', true);
      await completedMovie([EXTERNAL_SUB, { ...EXTERNAL_SUB, Index: 7, Language: 'pol' }]);
      env.files.delete('@data/offline/movie-1_sub_3_eng.srt');
      env.core.subtitle.loadTrack.mockImplementation(() => {
        throw new Error('bad track');
      });
      env.core.osd.mockClear();

      expect(env.manager.handleFileLoaded('/abs/data/offline/movie-1.mkv')).toBe(true);

      expect(env.log).toHaveBeenCalledWith(
        'Offline subtitle missing: /abs/data/offline/movie-1_sub_3_eng.srt'
      );
      expect(env.log).toHaveBeenCalledWith(
        'Could not load subtitle /abs/data/offline/movie-1_sub_7_pol.srt: bad track'
      );
      expect(env.core.osd).not.toHaveBeenCalled();
    });

    it('logs when the title cannot be set', async () => {
      await completedMovie([]);
      env.mpv.set.mockImplementation(() => {
        throw new Error('no mpv');
      });
      expect(env.manager.handleFileLoaded('/abs/data/offline/movie-1.mkv')).toBe(true);
      expect(env.log).toHaveBeenCalledWith('Could not set title: no mpv');
    });

    it('works with manifests written without absolute paths', () => {
      env.files.set(
        '@data/offline/manifest.json',
        JSON.stringify([
          {
            itemId: 'a',
            title: 'A',
            status: 'completed',
            mediaPath: '@data/offline/a.mkv',
            subtitles: [{ path: '@data/offline/a_sub_1_eng.srt' }],
          },
          { itemId: 'b', title: 'B', status: 'failed', mediaPath: '@data/offline/b.mkv' },
          { itemId: 'c', title: 'C', status: 'completed', mediaPath: null },
        ])
      );
      env.files.set('@data/offline/a_sub_1_eng.srt', 'x');

      expect(env.manager.handleFileLoaded('/abs/data/offline/b.mkv')).toBe(false);
      expect(env.manager.handleFileLoaded('/abs/data/offline/a.mkv')).toBe(true);
      expect(env.core.subtitle.loadTrack).toHaveBeenCalledWith('/abs/data/offline/a_sub_1_eng.srt');
    });

    it('handles entries without a subtitles list', () => {
      env.files.set(
        '@data/offline/manifest.json',
        JSON.stringify([
          { itemId: 'a', title: 'A', status: 'completed', mediaPath: '@data/offline/a.mkv' },
        ])
      );
      expect(env.manager.handleFileLoaded('/abs/data/offline/a.mkv')).toBe(true);
      expect(env.core.subtitle.loadTrack).not.toHaveBeenCalled();
    });
  });

  describe('Finder integration', () => {
    it('reveals the downloads folder, creating it first', async () => {
      await expect(env.manager.showDownloadsFolder()).resolves.toBe(true);
      expect(env.utils.exec).toHaveBeenCalledWith('mkdir', ['-p', '/abs/data/offline']);
      expect(env.file.showInFinder).toHaveBeenCalledWith('@data/offline');
    });

    it('reports when the folder cannot be created', async () => {
      env = createEnv({ mkdirFails: true });
      await expect(env.manager.showDownloadsFolder()).resolves.toBe(false);
      expect(env.core.osd).toHaveBeenCalledWith('Could not open the offline downloads folder');
    });

    it('reveals a downloaded file', async () => {
      await env.manager.startDownload(request(MOVIE));
      await waitFor(() => env.entry('movie-1')?.status === 'completed');

      expect(env.manager.showInFinder('movie-1')).toBe(true);
      expect(env.file.showInFinder).toHaveBeenCalledWith('@data/offline/movie-1.mkv');

      env.file.showInFinder.mockImplementation(() => {
        throw new Error('gone');
      });
      expect(env.manager.showInFinder('movie-1')).toBe(false);
      expect(env.log).toHaveBeenCalledWith('Could not reveal @data/offline/movie-1.mkv: gone');
    });

    it('refuses to reveal unknown or missing files', async () => {
      expect(env.manager.showInFinder('nope')).toBe(false);
      await env.manager.startDownload(request(MOVIE));
      await waitFor(() => env.entry('movie-1')?.status === 'completed');
      env.files.delete('@data/offline/movie-1.mkv');
      expect(env.manager.showInFinder('movie-1')).toBe(false);
      expect(env.log).toHaveBeenCalledWith('Cannot reveal download movie-1: file not available');
    });
  });

  describe('registerMessageHandlers', () => {
    function createView() {
      const handlers = {};
      return {
        handlers,
        onMessage: vi.fn((name, callback) => {
          handlers[name] = callback;
        }),
        postMessage: vi.fn(),
      };
    }

    it('answers list requests with a snapshot', () => {
      const view = createView();
      env.manager.registerMessageHandlers(view);
      view.handlers['get-offline-downloads']();
      expect(view.postMessage).toHaveBeenCalledWith('offline-downloads', {
        downloads: [],
        directory: '/abs/data/offline',
      });
    });

    it('routes every offline message to the manager', async () => {
      const view = createView();
      env.manager.registerMessageHandlers(view);

      view.handlers['offline-download'](request(MOVIE));
      await waitFor(() => env.entry('movie-1')?.status === 'completed');

      view.handlers['play-offline']({ itemId: 'movie-1' });
      expect(env.openMedia).toHaveBeenCalledTimes(1);

      view.handlers['offline-show-in-finder']({ itemId: 'movie-1' });
      expect(env.file.showInFinder).toHaveBeenCalledWith('@data/offline/movie-1.mkv');

      view.handlers['offline-open-folder']();
      await waitFor(() => env.file.showInFinder.mock.calls.length === 2);

      view.handlers['offline-remove']({ itemId: 'movie-1' });
      await waitFor(() => env.entry('movie-1') === undefined);

      view.handlers['offline-retry']({ itemId: 'movie-1' });
      expect(env.log).toHaveBeenCalledWith('Cannot retry unknown download: movie-1');

      view.handlers['offline-cancel']({ itemId: 'movie-1' });
      expect(env.log).toHaveBeenCalledWith('Cannot cancel unknown download: movie-1');
    });

    it('tolerates messages without data', () => {
      const view = createView();
      env.manager.registerMessageHandlers(view);

      view.handlers['offline-download']();
      view.handlers['offline-cancel']();
      view.handlers['offline-remove']();
      view.handlers['offline-retry']();
      view.handlers['play-offline']();
      view.handlers['offline-show-in-finder']();

      expect(env.log).toHaveBeenCalledWith('Item is not downloadable: missing');
      expect(env.log).toHaveBeenCalledWith('Cannot cancel unknown download: undefined');
      expect(env.log).toHaveBeenCalledWith('Cannot remove unknown download: undefined');
      expect(env.log).toHaveBeenCalledWith('Cannot retry unknown download: undefined');
      expect(env.log).toHaveBeenCalledWith('Cannot play download undefined: unknown');
      expect(env.log).toHaveBeenCalledWith('Cannot reveal download undefined: file not available');
    });
  });
});
