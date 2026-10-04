'use strict';

// Codes that name the same language: ISO 639-1, then the 639-2 forms
// (bibliographic first where it differs). Jellyfin reports 639-2 codes, while
// the preference accepts either standard.
const LANGUAGE_CODE_GROUPS = [
  ['en', 'eng'],
  ['fr', 'fre', 'fra'],
  ['de', 'ger', 'deu'],
  ['es', 'spa'],
  ['it', 'ita'],
  // pob: Brazilian Portuguese as subtitle sites and Jellyfin tag it
  ['pt', 'por', 'pob'],
  ['nl', 'dut', 'nld'],
  ['pl', 'pol'],
  ['ru', 'rus'],
  ['uk', 'ukr'],
  ['cs', 'cze', 'ces'],
  ['sk', 'slo', 'slk'],
  ['sl', 'slv'],
  ['hr', 'hrv', 'scr'],
  ['sr', 'srp', 'scc'],
  ['bs', 'bos'],
  ['bg', 'bul'],
  ['ro', 'rum', 'ron'],
  ['hu', 'hun'],
  ['el', 'gre', 'ell'],
  ['tr', 'tur'],
  ['sv', 'swe'],
  // Bokmål and Nynorsk before plain Norwegian, which covers both.
  ['nb', 'nob'],
  ['nn', 'nno'],
  ['no', 'nor', 'nob', 'nno', 'nb', 'nn'],
  ['da', 'dan'],
  ['fi', 'fin'],
  ['is', 'ice', 'isl'],
  ['et', 'est'],
  ['lv', 'lav'],
  ['lt', 'lit'],
  ['ar', 'ara'],
  ['he', 'heb', 'iw'],
  ['fa', 'per', 'fas'],
  ['hi', 'hin'],
  ['bn', 'ben'],
  ['ta', 'tam'],
  ['te', 'tel'],
  ['ur', 'urd'],
  ['th', 'tha'],
  ['vi', 'vie'],
  ['id', 'ind', 'in'],
  ['ms', 'may', 'msa'],
  ['zh', 'chi', 'zho', 'cmn'],
  ['ja', 'jpn'],
  ['ko', 'kor'],
  ['ca', 'cat'],
  ['eu', 'baq', 'eus'],
  ['gl', 'glg'],
  ['ga', 'gle'],
  ['cy', 'wel', 'cym'],
  ['sq', 'alb', 'sqi'],
  ['mk', 'mac', 'mkd'],
  ['hy', 'arm', 'hye'],
  ['ka', 'geo', 'kat'],
  ['tl', 'tgl', 'fil'],
  ['lb', 'ltz'],
  ['se', 'sme'],
  ['kk', 'kaz'],
  // Listed so the prefix fallback cannot pair them with unrelated codes
  // ("ha" with "hat", "la" with "lao", ...).
  ['ha', 'hau'],
  ['ht', 'hat'],
  ['la', 'lat'],
  ['lo', 'lao'],
  ['ml', 'mal'],
  ['mt', 'mlt'],
  ['mg', 'mlg'],
  ['mr', 'mar'],
  ['mi', 'mao', 'mri'],
  ['as', 'asm'],
  ['st', 'sot'],
  ['so', 'som'],
  ['ch', 'cha'],
  ['ce', 'che'],
];

function primaryLanguageCode(code) {
  return String(code).trim().toLowerCase().split(/[-_]/)[0];
}

function languageCodeGroup(code) {
  return LANGUAGE_CODE_GROUPS.find((group) => group.includes(code));
}

/**
 * Whether a preferred code names the stream's language. Codes are compared
 * whole, never as substrings (which let "en" match "ben"), after dropping a
 * region suffix such as "en-US". Codes outside the table fall back to a
 * 2-letter code matching the 3-letter code it starts, e.g. "sw" and "swa".
 */
function languagesMatch(preferred, language) {
  const left = primaryLanguageCode(preferred);
  const right = primaryLanguageCode(language);
  if (!left || !right) return false;

  const leftGroup = languageCodeGroup(left);
  const rightGroup = languageCodeGroup(right);
  if (leftGroup || rightGroup) {
    return (leftGroup || [left]).includes(right) || (rightGroup || [right]).includes(left);
  }

  const [short, long] = left.length <= right.length ? [left, right] : [right, left];
  return short === long || (short.length === 2 && long.length === 3 && long.startsWith(short));
}

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
    codec
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
        .filter((lang) => lang.trim().length > 0);
      const shouldDownloadAll = preferences.get('download_all_subtitles');

      let downloadedCount = 0;

      for (const stream of subtitleStreams) {
        const language = stream.Language || 'unknown';
        const codec = stream.Codec || 'srt';

        const shouldDownload =
          shouldDownloadAll ||
          preferredLanguages.some((preferred) => languagesMatch(preferred, language));

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
            codec
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
