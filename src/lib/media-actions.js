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

  async function setVideoTitleFromMetadata(serverBase, itemId, apiKey) {
    try {
      if (!preferences.get('set_video_title')) {
        log('Video title setting is disabled in preferences');
        return;
      }

      const metadata = await fetchItemMetadata(serverBase, itemId, apiKey);

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
          mpv.set('force-media-title', title);
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

  async function downloadSubtitle(serverBase, itemId, streamIndex, apiKey, language, codec) {
    try {
      const subtitleUrl = `${serverBase}/Videos/${itemId}/${streamIndex}/Subtitles.${codec}?api_key=${apiKey}`;
      const sanitizedItemId = String(itemId).replace(/[^a-zA-Z0-9_-]/g, '_');
      const sanitizedLanguage = String(language).replace(/[^a-zA-Z0-9_-]/g, '_');
      const sanitizedCodec = String(codec).replace(/[^a-zA-Z0-9_-]/g, '_');
      const fileName = `jellyfin_${sanitizedItemId}_${streamIndex}_${sanitizedLanguage}.${sanitizedCodec}`;
      const localPath = `@tmp/${fileName}`;

      log(`Downloading subtitle: ${subtitleUrl}`);

      await http.download(subtitleUrl, localPath);

      const resolvedPath = utils.resolvePath(localPath);
      core.subtitle.loadTrack(resolvedPath);

      log(`Subtitle loaded: ${resolvedPath}`);

      if (preferences.get('show_notifications')) {
        core.osd(`Loaded ${language} subtitle`);
      }

      return true;
    } catch (error) {
      log(`Error downloading subtitle: ${error.message}`);
      return false;
    }
  }

  async function downloadExternalSubtitle(
    serverBase,
    itemId,
    streamIndex,
    subtitlePath,
    apiKey,
    language,
    codec
  ) {
    try {
      let extension = 'srt';
      if (codec === 'subrip') extension = 'srt';
      else if (codec === 'webvtt') extension = 'vtt';
      else if (codec === 'ass') extension = 'ass';
      else if (codec === 'ssa') extension = 'ssa';
      else if (codec === 'vtt') extension = 'vtt';
      else if (codec && codec.toLowerCase().includes('srt')) extension = 'srt';
      else if (codec && codec.toLowerCase().includes('vtt')) extension = 'vtt';

      const subtitleUrl = `${serverBase}/Videos/${itemId}/${itemId}/Subtitles/${streamIndex}/stream.${extension}?api_key=${apiKey}`;

      let fileName;
      if (subtitlePath) {
        const pathParts = subtitlePath.split(/[/\\]/);
        const originalName = pathParts[pathParts.length - 1];
        fileName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
        log(`Using sanitized filename: ${fileName}`);
      } else {
        const sanitizedItemId = String(itemId).replace(/[^a-zA-Z0-9_-]/g, '_');
        const sanitizedLanguage = String(language).replace(/[^a-zA-Z0-9_-]/g, '_');
        fileName = `jellyfin_external_${sanitizedItemId}_${streamIndex}_${sanitizedLanguage}.${extension}`;
        log(`Using generated filename: ${fileName}`);
      }

      const localPath = `@tmp/${fileName}`;

      log(`Downloading external subtitle: ${subtitleUrl}`);
      log(`External subtitle path: ${subtitlePath}`);
      log(`Stream index: ${streamIndex}`);
      log(`Language: ${language}`);
      log(`Codec: ${codec} -> Extension: ${extension}`);
      log(`Local filename: ${fileName}`);

      await http.download(subtitleUrl, localPath);

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
    try {
      const playbackInfo = await fetchPlaybackInfo(serverBase, itemId, apiKey);

      if (!playbackInfo.MediaSources || playbackInfo.MediaSources.length === 0) {
        log('No media sources found');
        return;
      }

      const mediaSource = playbackInfo.MediaSources[0];
      const mediaStreams = mediaSource.MediaStreams || [];

      const subtitleStreams = mediaStreams.filter(
        (stream) => stream.Type === 'Subtitle' && stream.IsTextSubtitleStream
      );

      log(`Found ${subtitleStreams.length} subtitle streams`);

      const preferredLanguages = (preferences.get('preferred_languages') || 'en,eng')
        .split(',')
        .map((lang) => lang.trim().toLowerCase())
        .filter((lang) => lang.length > 0);
      const shouldDownloadAll = preferences.get('download_all_subtitles');

      let downloadedCount = 0;

      for (const stream of subtitleStreams) {
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

        log(
          `Processing subtitle: ${language} (${codec}) - Index: ${stream.Index}, External: ${stream.IsExternal}`
        );

        try {
          if (stream.IsExternal && stream.Path) {
            await downloadExternalSubtitle(
              serverBase,
              itemId,
              stream.Index,
              stream.Path,
              apiKey,
              language,
              codec
            );
          } else {
            await downloadSubtitle(serverBase, itemId, stream.Index, apiKey, language, codec);
          }
          downloadedCount++;
        } catch (error) {
          log(`Failed to download subtitle ${language}: ${error.message}`);
        }
      }

      if (downloadedCount > 0 && preferences.get('show_notifications')) {
        core.osd(`Downloaded ${downloadedCount} subtitle(s)`);
      } else if (downloadedCount === 0) {
        log('No subtitles downloaded');
        if (preferences.get('show_notifications')) {
          core.osd('No matching subtitles found');
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
        log('No stored URL, checking core.status');
        const currentFile = core.status.url || core.status.path;
        log(`core.status.url = "${core.status.url}"`);
        log(`core.status.path = "${core.status.path}"`);
        log(`currentFile = "${currentFile}"`);

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
    if (isJellyfinUrl(fileUrl)) {
      const jellyfinInfo = parseJellyfinUrl(fileUrl);
      if (jellyfinInfo) {
        lastJellyfinUrl = fileUrl;
        lastItemId = jellyfinInfo.itemId;
        log(`Stored Jellyfin media for manual download: ${jellyfinInfo.itemId}`);
        return jellyfinInfo;
      }
      log('Failed to parse Jellyfin URL');
      return null;
    }

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
    getLastItemId,
  };
}

module.exports = {
  createMediaActionsManager,
};
