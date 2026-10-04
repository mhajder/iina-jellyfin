'use strict';

function createMediaActionsManager({
  core,
  http,
  utils,
  preferences,
  mpv,
  parseJellyfinUrl,
  isJellyfinUrl,
  fetchPlaybackInfo,
  fetchItemMetadata,
  log,
}) {
  let lastJellyfinUrl = null;
  let lastItemId = null;
  // Bumped on every file load. Metadata and subtitle requests capture it before
  // awaiting and drop their result if another file has loaded in the meantime.
  let fileGeneration = 0;

  // Every title this plugin forced. force-media-title is a global mpv option,
  // so it would stay on every file played after a Jellyfin item, and mpv can
  // restore any older one of them when a file with its own per-file title (an
  // autoplayed episode) ends, so none of them is forgotten.
  const pluginTitles = new Set();
  // The title set right before core.open, for the item about to load.
  let titleForNextItem = null;

  function isStale(generation) {
    return generation !== fileGeneration;
  }

  /**
   * The file that was playing has ended. Results still in flight for it must
   * not reach whatever loads next, even before that file finishes loading.
   */
  function invalidatePendingResults() {
    fileGeneration++;
  }

  function setPluginTitle(title) {
    mpv.set('force-media-title', title);
    pluginTitles.add(title);
  }

  /**
   * Set before core.open so the title is there while the item loads. Ending
   * the old file can make mpv restore an older title over it, so it is set
   * again once that item has loaded.
   */
  function setTitleForNextItem(title, streamUrl) {
    const info = parseJellyfinUrl(streamUrl);
    titleForNextItem = info ? { title, itemId: info.itemId } : null;
    setPluginTitle(title);
  }

  /**
   * Clear the title this plugin forced, but only while it is still the one in
   * effect: a title another script set for the new file (e.g. ytdl_hook's
   * file-local YouTube title) must stay. mpv restores the plugin's title when
   * that file ends, so the next non-Jellyfin file clears it then.
   */
  function clearPluginTitle() {
    if (pluginTitles.size === 0) return;

    try {
      if (pluginTitles.has(mpv.getString('force-media-title'))) {
        mpv.set('force-media-title', '');
      }
    } catch (error) {
      log(`Could not clear force-media-title: ${error.message}`);
    }
  }

  async function setVideoTitleFromMetadata(serverBase, itemId, apiKey) {
    const generation = fileGeneration;
    try {
      if (!preferences.get('set_video_title')) {
        log('Video title setting is disabled in preferences');
        return;
      }

      const metadata = await fetchItemMetadata(serverBase, itemId, apiKey);

      if (isStale(generation)) {
        log(`Title for ${itemId} is stale, another file has loaded`);
        return;
      }

      if (!metadata || !metadata.Name) {
        log('No title found in metadata');
        return;
      }

      let title = metadata.Name;

      if (metadata.Type === 'Episode') {
        const seriesName = metadata.SeriesName;
        const seasonNumber = metadata.ParentIndexNumber;
        const episodeNumber = metadata.IndexNumber;

        if (seriesName) {
          let episodeTitle = seriesName;
          if (seasonNumber !== undefined && episodeNumber !== undefined) {
            episodeTitle += ` S${seasonNumber.toString().padStart(2, '0')}E${episodeNumber.toString().padStart(2, '0')}`;
          }
          episodeTitle += ` - ${metadata.Name}`;
          title = episodeTitle;
        }
      } else if (metadata.Type === 'Movie' && metadata.ProductionYear) {
        title = `${metadata.Name} (${metadata.ProductionYear})`;
      }

      log(`Setting video title to: "${title}"`);

      let titleSet = false;
      if (!titleSet && typeof mpv !== 'undefined' && typeof mpv.set === 'function') {
        try {
          setPluginTitle(title);
          titleSet = true;
          log(`Video title set via mpv property: ${title}`);
        } catch (error) {
          log(`mpv.set('force-media-title') failed: ${error.message}`);
        }
      }

      if (!titleSet) {
        log(`Could not set title via IINA API, title would be: ${title}`);
      }

      if (preferences.get('show_notifications')) {
        core.osd(`Title: ${title}`);
      }
    } catch (error) {
      log(`Error setting video title: ${error.message}`);
    }
  }

  function subtitleExtensionForCodec(codec) {
    if (codec === 'subrip') return 'srt';
    if (codec === 'webvtt' || codec === 'vtt') return 'vtt';
    if (codec === 'ass') return 'ass';
    if (codec === 'ssa') return 'ssa';
    if (codec && codec.toLowerCase().includes('srt')) return 'srt';
    if (codec && codec.toLowerCase().includes('vtt')) return 'vtt';
    return 'srt';
  }

  async function downloadExternalSubtitle(
    serverBase,
    itemId,
    mediaSourceId,
    streamIndex,
    subtitlePath,
    apiKey,
    language,
    codec,
    generation
  ) {
    try {
      const extension = subtitleExtensionForCodec(codec);

      const subtitleUrl = `${serverBase}/Videos/${itemId}/${mediaSourceId || itemId}/Subtitles/${streamIndex}/stream.${extension}?ApiKey=${apiKey}`;

      // Everything lands in one @tmp directory, so the name has to identify the
      // item and the track. Server-side names like "English.srt" repeat across
      // the library and would otherwise overwrite each other.
      const sanitizedItemId = String(itemId).replace(/[^a-zA-Z0-9_-]/g, '_');
      let suffix;
      if (subtitlePath) {
        const pathParts = subtitlePath.split(/[/\\]/);
        suffix = pathParts[pathParts.length - 1].replace(/[^a-zA-Z0-9._-]/g, '_');
      } else {
        const sanitizedLanguage = String(language).replace(/[^a-zA-Z0-9_-]/g, '_');
        suffix = `${sanitizedLanguage}.${extension}`;
      }

      const fileName = `jellyfin_${sanitizedItemId}_${streamIndex}_${suffix}`;
      log(`Using filename: ${fileName}`);

      const localPath = `@tmp/${fileName}`;

      log(`Downloading external subtitle: ${subtitleUrl}`);
      log(`External subtitle path: ${subtitlePath}`);
      log(`Stream index: ${streamIndex}`);
      log(`Language: ${language}`);
      log(`Codec: ${codec} -> Extension: ${extension}`);
      log(`Local filename: ${fileName}`);

      await http.download(subtitleUrl, localPath);

      if (isStale(generation)) {
        log(`Subtitle for ${itemId} is stale, another file has loaded`);
        return false;
      }

      const resolvedPath = utils.resolvePath(localPath);
      core.subtitle.loadTrack(resolvedPath);

      log(`External subtitle loaded successfully: ${resolvedPath}`);

      if (preferences.get('show_notifications')) {
        core.osd(`Loaded external ${language} subtitle`);
      }

      return true;
    } catch (error) {
      log(`Error downloading external subtitle: ${error.message}`);
      return false;
    }
  }

  async function downloadAllSubtitles(serverBase, itemId, apiKey) {
    const generation = fileGeneration;
    try {
      const playbackInfo = await fetchPlaybackInfo(serverBase, itemId, apiKey);

      if (isStale(generation)) {
        log(`Subtitles for ${itemId} are stale, another file has loaded`);
        return;
      }

      if (!playbackInfo.MediaSources || playbackInfo.MediaSources.length === 0) {
        log('No media sources found');
        return;
      }

      const mediaSource = playbackInfo.MediaSources[0];
      const mediaStreams = mediaSource.MediaStreams || [];

      // External sidecar files only. Embedded tracks would have to be extracted
      // by the server on demand, which takes minutes for large remuxes, and
      // mpv already exposes them from the file itself.
      const subtitleStreams = mediaStreams.filter(
        // IsExternal is what identifies a sidecar file. Path is only used to
        // name the download and Jellyfin omits it for non-admin accounts, so
        // requiring it here would hide every subtitle from those users.
        (stream) => stream.Type === 'Subtitle' && stream.IsTextSubtitleStream && stream.IsExternal
      );

      log(`Found ${subtitleStreams.length} external subtitle stream(s)`);

      const preferredLanguages = (preferences.get('preferred_languages') || 'en,eng')
        .split(',')
        .map((lang) => lang.trim().toLowerCase())
        .filter((lang) => lang.length > 0);
      const shouldDownloadAll = preferences.get('download_all_subtitles');

      let downloadedCount = 0;

      for (const stream of subtitleStreams) {
        if (isStale(generation)) {
          log(`Subtitles for ${itemId} are stale, another file has loaded`);
          return;
        }

        const language = stream.Language || 'unknown';
        const codec = stream.Codec || 'srt';

        const shouldDownload =
          shouldDownloadAll ||
          preferredLanguages.some(
            (prefLang) =>
              language.toLowerCase().includes(prefLang) || prefLang.includes(language.toLowerCase())
          );

        if (!shouldDownload) {
          log(`Skipping subtitle: ${language} (not in preferred languages)`);
          continue;
        }

        log(`Processing external subtitle: ${language} (${codec}) - Index: ${stream.Index}`);

        try {
          const downloaded = await downloadExternalSubtitle(
            serverBase,
            itemId,
            mediaSource.Id,
            stream.Index,
            stream.Path,
            apiKey,
            language,
            codec,
            generation
          );
          if (downloaded) {
            downloadedCount++;
          }
        } catch (error) {
          log(`Failed to download subtitle ${language}: ${error.message}`);
        }
      }

      if (downloadedCount > 0 && preferences.get('show_notifications')) {
        core.osd(`Downloaded ${downloadedCount} subtitle(s)`);
      } else if (downloadedCount === 0) {
        log('No external subtitles downloaded');
        if (preferences.get('show_notifications')) {
          core.osd('No matching external subtitles found');
        }
      }
    } catch (error) {
      log(`Error downloading subtitles: ${error.message}`);
      if (preferences.get('show_notifications')) {
        core.osd('Failed to download subtitles');
      }
    }
  }

  function updateLastFromCurrentUrl(currentUrl) {
    const jellyfinInfo = parseJellyfinUrl(currentUrl);
    if (!jellyfinInfo) {
      log(`Failed to parse Jellyfin URL: ${currentUrl}`);
      return null;
    }

    lastJellyfinUrl = currentUrl;
    lastItemId = jellyfinInfo.itemId;
    return jellyfinInfo;
  }

  function resolveCurrentJellyfinUrl() {
    let currentUrl = lastJellyfinUrl;

    if (!currentUrl) {
      try {
        // core.status has no "path"; url is the only file location it exposes,
        // and IINA returns it percent-decoded.
        const currentFile = core.status.url;
        log(`No stored URL, core.status.url = "${currentFile}"`);

        if (currentFile && isJellyfinUrl(currentFile)) {
          currentUrl = currentFile;
          log(`Using current file URL: ${currentUrl}`);
        } else {
          log('Current file is not a Jellyfin URL or is empty');
        }
      } catch (error) {
        log(`Error getting current file URL: ${error.message}`);
      }
    }

    return currentUrl;
  }

  function manualDownloadSubtitles() {
    log('Manual download requested');
    log(`lastJellyfinUrl = "${lastJellyfinUrl}"`);

    const currentUrl = resolveCurrentJellyfinUrl();
    if (!currentUrl) {
      log('No Jellyfin URL found - checking for Jellyfin URL in current file');
      core.osd('No Jellyfin media detected. Please open a Jellyfin URL first.');
      return;
    }

    log(`Attempting to download subtitles for: ${currentUrl}`);

    if (!isJellyfinUrl(currentUrl)) {
      log(`URL is not a Jellyfin URL: ${currentUrl}`);
      core.osd('Current media is not from Jellyfin');
      return;
    }

    const jellyfinInfo = updateLastFromCurrentUrl(currentUrl);
    if (!jellyfinInfo) {
      core.osd('Failed to parse Jellyfin URL - check console for details');
      return;
    }

    log(`Downloading subtitles for item: ${jellyfinInfo.itemId}`);
    core.osd('Downloading subtitles...');
    downloadAllSubtitles(jellyfinInfo.serverBase, jellyfinInfo.itemId, jellyfinInfo.apiKey);
  }

  function manualSetTitle() {
    log('Manual title setting requested');
    log(`lastJellyfinUrl = "${lastJellyfinUrl}"`);

    const currentUrl = resolveCurrentJellyfinUrl();
    if (!currentUrl) {
      log('No Jellyfin URL found - checking for Jellyfin URL in current file');
      core.osd('No Jellyfin media detected. Please open a Jellyfin URL first.');
      return;
    }

    log(`Attempting to set title for: ${currentUrl}`);

    if (!isJellyfinUrl(currentUrl)) {
      log(`URL is not a Jellyfin URL: ${currentUrl}`);
      core.osd('Current media is not from Jellyfin');
      return;
    }

    const jellyfinInfo = updateLastFromCurrentUrl(currentUrl);
    if (!jellyfinInfo) {
      core.osd('Failed to parse Jellyfin URL - check console for details');
      return;
    }

    log(`Setting title for item: ${jellyfinInfo.itemId}`);
    core.osd('Fetching title...');
    setVideoTitleFromMetadata(jellyfinInfo.serverBase, jellyfinInfo.itemId, jellyfinInfo.apiKey);
  }

  function updateFromFileUrl(fileUrl) {
    fileGeneration++;
    const expectedTitle = titleForNextItem;
    titleForNextItem = null;

    if (isJellyfinUrl(fileUrl)) {
      const jellyfinInfo = parseJellyfinUrl(fileUrl);
      if (jellyfinInfo) {
        // Never cleared here: an autoplayed or queued item carries a per-file
        // title that may equal one of the plugin's, and clearing would wipe it.
        if (expectedTitle && expectedTitle.itemId === jellyfinInfo.itemId) {
          setPluginTitle(expectedTitle.title);
        }
        lastJellyfinUrl = fileUrl;
        lastItemId = jellyfinInfo.itemId;
        log(`Stored Jellyfin media for manual download: ${jellyfinInfo.itemId}`);
        return jellyfinInfo;
      }
      log('Failed to parse Jellyfin URL');
      clearPluginTitle();
      return null;
    }

    clearPluginTitle();
    log('Non-Jellyfin URL loaded, clearing stored Jellyfin data');
    lastJellyfinUrl = null;
    lastItemId = null;
    log('Not a Jellyfin URL, skipping subtitle download');
    return null;
  }

  function getLastItemId() {
    return lastItemId;
  }

  return {
    setVideoTitleFromMetadata,
    downloadAllSubtitles,
    manualDownloadSubtitles,
    manualSetTitle,
    updateFromFileUrl,
    invalidatePendingResults,
    setTitleForNextItem,
    getLastItemId,
  };
}

module.exports = {
  createMediaActionsManager,
};
