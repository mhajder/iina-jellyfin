'use strict';

const { subtitleExtensionForCodec, isExternalTextSubtitle } = require('./subtitle-utils.js');

const DEFAULT_DIRECTORY = '@data/offline';
const MANIFEST_FILE = 'manifest.json';
const DOWNLOADABLE_TYPES = ['Movie', 'Episode', 'Audio'];

const STATUS = {
  QUEUED: 'queued',
  DOWNLOADING: 'downloading',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

function sanitizeId(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function normalizeServerUrl(url) {
  return String(url || '').replace(/\/+$/, '');
}

function padNumber(value) {
  return String(value).padStart(2, '0');
}

/**
 * Title used for the player window and the downloads list, mirroring what
 * the streaming flow puts into force-media-title.
 */
function buildDisplayTitle(item) {
  const name = item.Name || 'Unknown Title';
  if (item.Type === 'Episode' && item.SeriesName) {
    const hasNumbers = item.ParentIndexNumber !== undefined && item.IndexNumber !== undefined;
    const code = hasNumbers
      ? ` S${padNumber(item.ParentIndexNumber)}E${padNumber(item.IndexNumber)}`
      : '';
    return `${item.SeriesName}${code} - ${name}`;
  }
  if (item.Type === 'Movie' && item.ProductionYear) {
    return `${name} (${item.ProductionYear})`;
  }
  if (item.Type === 'Audio') {
    const artist = item.AlbumArtist || (Array.isArray(item.Artists) ? item.Artists.join(', ') : '');
    return artist ? `${artist} - ${name}` : name;
  }
  return name;
}

/**
 * Container extension for the downloaded file. Jellyfin reports containers as
 * a comma separated list of aliases ("mov,mp4,m4a"); the first one is used.
 */
function pickContainer(source, itemType) {
  const reported = String((source && source.Container) || '')
    .split(',')[0]
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  if (reported) return reported;
  return itemType === 'Audio' ? 'mp3' : 'mkv';
}

/**
 * Local path notation of a loaded file, so it can be compared with the paths
 * stored in the manifest. IINA reports local files both as plain paths and as
 * percent-encoded file:// URLs.
 */
function normalizeLoadedPath(fileUrl) {
  const path = String(fileUrl || '').replace(/^file:\/\/(localhost)?/i, '');
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function createOfflineDownloadManager({
  file,
  utils,
  core,
  mpv,
  preferences,
  fetchPlaybackInfo,
  buildJellyfinHeaders,
  loadStoredServers,
  transport,
  notifyViews,
  openMedia,
  log,
}) {
  let entries = [];
  let loadedFromDirectory = null;
  let activeItemId = null;
  // Access tokens for queued downloads live in memory only; the manifest on
  // disk never contains credentials.
  const credentials = {};

  function getDirectory() {
    const custom = String(preferences.get('offline_download_dir') || '').trim();
    return normalizeServerUrl(custom || DEFAULT_DIRECTORY);
  }

  function manifestPath() {
    return `${getDirectory()}/${MANIFEST_FILE}`;
  }

  function osd(message) {
    try {
      core.osd(message);
    } catch (error) {
      log(`Could not show OSD: ${error.message}`);
    }
  }

  function readManifest() {
    const path = manifestPath();
    try {
      if (!file.exists(path)) {
        return [];
      }
      const parsed = JSON.parse(file.read(path));
      if (!Array.isArray(parsed)) {
        log('Offline manifest is not a list, ignoring it');
        return [];
      }
      return parsed.filter((entry) => entry && entry.itemId);
    } catch (error) {
      log(`Could not read offline manifest: ${error.message}`);
      return [];
    }
  }

  function getEntries() {
    const directory = getDirectory();
    if (loadedFromDirectory !== directory) {
      entries = readManifest();
      loadedFromDirectory = directory;
      // A download that was still running when IINA quit cannot be resumed.
      for (const entry of entries) {
        if (entry.status === STATUS.QUEUED || entry.status === STATUS.DOWNLOADING) {
          entry.status = STATUS.FAILED;
          entry.error = 'Interrupted before the download finished';
          entry.progress = 0;
        }
      }
      log(`Loaded ${entries.length} offline download entries from ${directory}`);
    }
    return entries;
  }

  async function ensureDirectory() {
    const directory = getDirectory();
    if (file.exists(directory)) {
      return directory;
    }
    const resolved = utils.resolvePath(directory);
    log(`Creating offline download directory: ${resolved}`);
    await utils.exec('mkdir', ['-p', resolved]);
    if (!file.exists(directory)) {
      throw new Error(`Could not create download directory ${resolved}`);
    }
    return directory;
  }

  async function saveManifest() {
    try {
      await ensureDirectory();
      file.write(manifestPath(), JSON.stringify(getEntries(), null, 2));
    } catch (error) {
      log(`Could not save offline manifest: ${error.message}`);
    }
  }

  function fileExists(path) {
    try {
      return Boolean(path) && file.exists(path);
    } catch (error) {
      log(`Could not check ${path}: ${error.message}`);
      return false;
    }
  }

  function publicEntry(entry) {
    return {
      ...entry,
      fileMissing: entry.status === STATUS.COMPLETED && !fileExists(entry.mediaPath),
    };
  }

  function listDownloads() {
    return getEntries().map(publicEntry);
  }

  function snapshot() {
    return {
      downloads: listDownloads(),
      directory: utils.resolvePath(getDirectory()),
    };
  }

  function broadcast() {
    notifyViews('offline-downloads', snapshot());
  }

  async function persistAndBroadcast() {
    await saveManifest();
    broadcast();
  }

  function findEntry(itemId) {
    return getEntries().find((entry) => entry.itemId === itemId) || null;
  }

  function removeEntry(itemId) {
    entries = getEntries().filter((entry) => entry.itemId !== itemId);
  }

  function deleteFile(path) {
    try {
      if (fileExists(path)) {
        file.delete(path);
      }
    } catch (error) {
      log(`Could not delete ${path}: ${error.message}`);
    }
  }

  function deleteEntryFiles(entry) {
    deleteFile(entry.mediaPath);
    for (const subtitle of entry.subtitles || []) {
      deleteFile(subtitle.path);
    }
  }

  function resolveStoredToken(serverUrl) {
    const wanted = normalizeServerUrl(serverUrl);
    const servers = loadStoredServers() || [];
    const match =
      servers.find((server) => server.userId && normalizeServerUrl(server.serverUrl) === wanted) ||
      servers.find((server) => normalizeServerUrl(server.serverUrl) === wanted);
    return match && match.accessToken ? match.accessToken : null;
  }

  function isDownloadable(item) {
    return Boolean(item && item.Id && DOWNLOADABLE_TYPES.includes(item.Type));
  }

  function createEntry(item, serverUrl, serverId) {
    return {
      itemId: item.Id,
      type: item.Type,
      title: buildDisplayTitle(item),
      name: item.Name || 'Unknown Title',
      seriesName: item.SeriesName || null,
      seasonNumber: item.ParentIndexNumber ?? null,
      episodeNumber: item.IndexNumber ?? null,
      productionYear: item.ProductionYear || null,
      runTimeTicks: item.RunTimeTicks || null,
      serverUrl: normalizeServerUrl(serverUrl),
      serverId: serverId || null,
      status: STATUS.QUEUED,
      progress: 0,
      error: null,
      container: null,
      expectedBytes: null,
      mediaPath: null,
      mediaAbsolutePath: null,
      subtitles: [],
      createdAt: Date.now(),
      completedAt: null,
    };
  }

  async function startDownload({ item, serverUrl, accessToken, serverId } = {}) {
    if (!isDownloadable(item)) {
      log(`Item is not downloadable: ${item ? `${item.Type} ${item.Id}` : 'missing'}`);
      osd('This item cannot be downloaded for offline use');
      return null;
    }
    if (!serverUrl || !accessToken) {
      log('Offline download requested without server credentials');
      osd('Connect to a Jellyfin server before downloading');
      return null;
    }

    const existing = findEntry(item.Id);
    if (existing) {
      if (existing.status === STATUS.QUEUED || existing.status === STATUS.DOWNLOADING) {
        log(`Download already in progress for ${item.Id}`);
        osd(`Already downloading: ${existing.title}`);
        return existing;
      }
      if (existing.status === STATUS.COMPLETED && fileExists(existing.mediaPath)) {
        log(`Item already downloaded: ${item.Id}`);
        osd(`Already downloaded: ${existing.title}`);
        return existing;
      }
      // A failed download or one whose file went missing starts over.
      deleteEntryFiles(existing);
      removeEntry(item.Id);
    }

    const entry = createEntry(item, serverUrl, serverId);
    credentials[entry.itemId] = accessToken;
    getEntries().push(entry);
    log(`Queued offline download: ${entry.title}`);
    osd(`Queued for download: ${entry.title}`);

    await persistAndBroadcast();
    processQueue();
    return entry;
  }

  function processQueue() {
    if (activeItemId) {
      return;
    }
    const next = getEntries().find((entry) => entry.status === STATUS.QUEUED);
    if (!next) {
      return;
    }
    runDownload(next);
  }

  function updateProgress(entry, percent) {
    if (entry.status !== STATUS.DOWNLOADING) {
      return;
    }
    const rounded = Math.max(0, Math.min(100, Math.floor(percent)));
    if (rounded !== entry.progress) {
      entry.progress = rounded;
      broadcast();
    }
  }

  async function downloadSubtitles(entry, source, headers) {
    const streams = (source.MediaStreams || []).filter(isExternalTextSubtitle);
    log(`Found ${streams.length} external subtitle stream(s) for ${entry.itemId}`);
    const downloaded = [];
    const directory = getDirectory();
    const mediaSourceId = source.Id || entry.itemId;

    for (const stream of streams) {
      if (entry.status !== STATUS.DOWNLOADING) {
        break;
      }
      const language = stream.Language || 'unknown';
      const extension = subtitleExtensionForCodec(stream.Codec);
      const url = `${entry.serverUrl}/Videos/${entry.itemId}/${mediaSourceId}/Subtitles/${stream.Index}/stream.${extension}`;
      const path = `${directory}/${sanitizeId(entry.itemId)}_sub_${stream.Index}_${sanitizeId(language)}.${extension}`;
      try {
        await transport.download(url, path, { headers });
        downloaded.push({
          index: stream.Index,
          language,
          title: stream.DisplayTitle || stream.Title || language,
          codec: stream.Codec || null,
          path,
          absolutePath: utils.resolvePath(path),
        });
        log(`Downloaded subtitle ${language} (${stream.Index}) for ${entry.itemId}`);
      } catch (error) {
        log(`Subtitle ${language} (${stream.Index}) failed: ${error.message}`);
        deleteFile(path);
      }
    }
    return downloaded;
  }

  async function runDownload(entry) {
    activeItemId = entry.itemId;
    entry.status = STATUS.DOWNLOADING;
    entry.progress = 0;
    entry.error = null;

    // The user can cancel while any of the awaits below is pending.
    const assertStillDownloading = () => {
      if (entry.status !== STATUS.DOWNLOADING) {
        throw new Error('Download cancelled');
      }
    };

    try {
      await persistAndBroadcast();
      // Set by startDownload/retryDownload; never read from the manifest.
      const headers = buildJellyfinHeaders(credentials[entry.itemId]);

      const directory = await ensureDirectory();
      const playbackInfo = await fetchPlaybackInfo(
        entry.serverUrl,
        entry.itemId,
        credentials[entry.itemId]
      );
      assertStillDownloading();
      const source = playbackInfo && playbackInfo.MediaSources && playbackInfo.MediaSources[0];
      if (!source) {
        throw new Error('No media source available for this item');
      }

      entry.container = pickContainer(source, entry.type);
      entry.expectedBytes = Number(source.Size) || null;
      entry.mediaPath = `${directory}/${sanitizeId(entry.itemId)}.${entry.container}`;
      entry.mediaAbsolutePath = utils.resolvePath(entry.mediaPath);
      await persistAndBroadcast();

      const route = entry.type === 'Audio' ? 'Audio' : 'Videos';
      const mediaSourceId = source.Id || entry.itemId;
      const mediaUrl = `${entry.serverUrl}/${route}/${entry.itemId}/stream?static=true&mediaSourceId=${encodeURIComponent(mediaSourceId)}`;
      log(`Downloading ${entry.title} to ${entry.mediaAbsolutePath}`);

      await transport.download(mediaUrl, entry.mediaPath, {
        headers,
        onProgress: (percent) => updateProgress(entry, percent),
      });
      assertStillDownloading();

      entry.subtitles = await downloadSubtitles(entry, source, headers);
      assertStillDownloading();

      entry.status = STATUS.COMPLETED;
      entry.progress = 100;
      entry.completedAt = Date.now();
      log(`Offline download completed: ${entry.title} (${entry.subtitles.length} subtitle(s))`);
      osd(`Downloaded for offline: ${entry.title}`);
    } catch (error) {
      if (entry.status === STATUS.CANCELLED) {
        log(`Offline download cancelled: ${entry.title}`);
        deleteEntryFiles(entry);
        removeEntry(entry.itemId);
      } else {
        entry.status = STATUS.FAILED;
        entry.error = error.message || String(error);
        entry.progress = 0;
        log(`Offline download failed: ${entry.title}: ${entry.error}`);
        deleteEntryFiles(entry);
        osd(`Download failed: ${entry.title}`);
      }
    } finally {
      delete credentials[entry.itemId];
      activeItemId = null;
      await persistAndBroadcast();
      processQueue();
    }
  }

  async function cancelDownload(itemId) {
    const entry = findEntry(itemId);
    if (!entry) {
      log(`Cannot cancel unknown download: ${itemId}`);
      return false;
    }
    if (entry.status === STATUS.QUEUED) {
      delete credentials[itemId];
      removeEntry(itemId);
      log(`Removed queued download: ${entry.title}`);
      await persistAndBroadcast();
      return true;
    }
    if (entry.status !== STATUS.DOWNLOADING) {
      log(`Download ${itemId} is ${entry.status}, nothing to cancel`);
      return false;
    }
    entry.status = STATUS.CANCELLED;
    broadcast();
    if (entry.mediaPath) {
      await transport.cancel(entry.mediaPath);
    }
    log(`Cancel requested for ${entry.title}`);
    return true;
  }

  async function removeDownload(itemId) {
    const entry = findEntry(itemId);
    if (!entry) {
      log(`Cannot remove unknown download: ${itemId}`);
      return false;
    }
    if (entry.status === STATUS.QUEUED || entry.status === STATUS.DOWNLOADING) {
      return cancelDownload(itemId);
    }
    deleteEntryFiles(entry);
    removeEntry(itemId);
    log(`Removed offline download: ${entry.title}`);
    await persistAndBroadcast();
    return true;
  }

  async function retryDownload({ itemId, serverUrl, accessToken } = {}) {
    const entry = findEntry(itemId);
    if (!entry) {
      log(`Cannot retry unknown download: ${itemId}`);
      return false;
    }
    if (entry.status === STATUS.QUEUED || entry.status === STATUS.DOWNLOADING) {
      log(`Download ${itemId} is already ${entry.status}`);
      return false;
    }
    if (entry.status === STATUS.COMPLETED && fileExists(entry.mediaPath)) {
      log(`Download ${itemId} is complete, nothing to retry`);
      return false;
    }

    const sameServer =
      serverUrl && normalizeServerUrl(serverUrl) === entry.serverUrl ? accessToken : null;
    const token = sameServer || resolveStoredToken(entry.serverUrl);
    if (!token) {
      osd(`Cannot retry ${entry.title}: not connected to ${entry.serverUrl}`);
      return false;
    }

    deleteEntryFiles(entry);
    credentials[itemId] = token;
    entry.status = STATUS.QUEUED;
    entry.progress = 0;
    entry.error = null;
    entry.subtitles = [];
    entry.completedAt = null;
    log(`Retrying offline download: ${entry.title}`);
    await persistAndBroadcast();
    processQueue();
    return true;
  }

  function playDownload(itemId) {
    const entry = findEntry(itemId);
    if (!entry || entry.status !== STATUS.COMPLETED) {
      log(`Cannot play download ${itemId}: ${entry ? entry.status : 'unknown'}`);
      osd('This download is not ready to play');
      return false;
    }
    if (!fileExists(entry.mediaPath)) {
      log(`Downloaded file is missing: ${entry.mediaPath}`);
      osd(`Downloaded file is missing: ${entry.title}`);
      broadcast();
      return false;
    }
    log(`Playing offline download: ${entry.title}`);
    openMedia({
      streamUrl: entry.mediaAbsolutePath || utils.resolvePath(entry.mediaPath),
      title: entry.title,
    });
    return true;
  }

  /**
   * Called for every file IINA loads. When the file is one of the downloads,
   * its subtitles are attached and the title set. Returns whether it matched.
   */
  function handleFileLoaded(fileUrl) {
    const loadedPath = normalizeLoadedPath(fileUrl);
    if (!loadedPath || /^https?:\/\//i.test(loadedPath)) {
      return false;
    }

    const entry = getEntries().find(
      (candidate) =>
        candidate.status === STATUS.COMPLETED &&
        candidate.mediaPath &&
        utils.resolvePath(candidate.mediaPath) === loadedPath
    );
    if (!entry) {
      return false;
    }

    log(`Loaded offline download: ${entry.title}`);
    try {
      mpv.set('force-media-title', entry.title);
    } catch (error) {
      log(`Could not set title: ${error.message}`);
    }

    let loaded = 0;
    for (const subtitle of entry.subtitles || []) {
      const path = subtitle.absolutePath || utils.resolvePath(subtitle.path);
      if (!fileExists(subtitle.path)) {
        log(`Offline subtitle missing: ${path}`);
        continue;
      }
      try {
        core.subtitle.loadTrack(path);
        loaded++;
      } catch (error) {
        log(`Could not load subtitle ${path}: ${error.message}`);
      }
    }

    if (loaded > 0 && preferences.get('show_notifications')) {
      osd(`Loaded ${loaded} offline subtitle(s)`);
    }
    return true;
  }

  async function showDownloadsFolder() {
    try {
      const directory = await ensureDirectory();
      file.showInFinder(directory);
      return true;
    } catch (error) {
      log(`Could not open downloads folder: ${error.message}`);
      osd('Could not open the offline downloads folder');
      return false;
    }
  }

  function showInFinder(itemId) {
    const entry = findEntry(itemId);
    if (!entry || !fileExists(entry.mediaPath)) {
      log(`Cannot reveal download ${itemId}: file not available`);
      return false;
    }
    try {
      file.showInFinder(entry.mediaPath);
      return true;
    } catch (error) {
      log(`Could not reveal ${entry.mediaPath}: ${error.message}`);
      return false;
    }
  }

  /**
   * Wire the offline messages of a webview (sidebar or standalone window).
   */
  function registerMessageHandlers(view) {
    view.onMessage('get-offline-downloads', () => {
      view.postMessage('offline-downloads', snapshot());
    });
    view.onMessage('offline-download', (data) => {
      startDownload(data || {});
    });
    view.onMessage('offline-cancel', (data) => {
      cancelDownload(data && data.itemId);
    });
    view.onMessage('offline-remove', (data) => {
      removeDownload(data && data.itemId);
    });
    view.onMessage('offline-retry', (data) => {
      retryDownload(data || {});
    });
    view.onMessage('play-offline', (data) => {
      playDownload(data && data.itemId);
    });
    view.onMessage('offline-show-in-finder', (data) => {
      showInFinder(data && data.itemId);
    });
    view.onMessage('offline-open-folder', () => {
      showDownloadsFolder();
    });
  }

  return {
    STATUS,
    getDirectory,
    isDownloadable,
    listDownloads,
    snapshot,
    startDownload,
    cancelDownload,
    removeDownload,
    retryDownload,
    playDownload,
    handleFileLoaded,
    showDownloadsFolder,
    showInFinder,
    registerMessageHandlers,
  };
}

module.exports = {
  createOfflineDownloadManager,
  buildDisplayTitle,
  pickContainer,
  normalizeLoadedPath,
  normalizeServerUrl,
  sanitizeId,
  STATUS,
  DOWNLOADABLE_TYPES,
};
