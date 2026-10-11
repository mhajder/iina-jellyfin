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

/**
 * A force-media-title entry for loadfile's per-file option list. mpv splits
 * that list on commas, so the value goes in its %bytes% quoted form: a title
 * such as "Hello, Goodbye" would otherwise make the whole loadfile fail.
 */
function mediaTitleOption(title) {
  let bytes = 0;
  for (const char of String(title)) {
    const code = char.codePointAt(0);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return `force-media-title=%${bytes}%${title}`;
}

// How long opening a file may wait for its Jellyfin title. A slow server must
// not hold up playback, and the title still follows once the file has loaded.
const TITLE_BEFORE_LOAD_TIMEOUT_MS = 3000;

function titleFromMetadata(metadata) {
  if (!metadata || !metadata.Name) return null;

  if (metadata.Type === 'Episode' && metadata.SeriesName) {
    const seasonNumber = metadata.ParentIndexNumber;
    const episodeNumber = metadata.IndexNumber;
    let title = metadata.SeriesName;
    // Jellyfin sends null, not just nothing, for an unnumbered episode.
    const isNumber = (value) => value !== undefined && value !== null;
    if (isNumber(seasonNumber) && isNumber(episodeNumber)) {
      title += ` S${String(seasonNumber).padStart(2, '0')}E${String(episodeNumber).padStart(2, '0')}`;
    }
    return `${title} - ${metadata.Name}`;
  }

  if (metadata.Type === 'Movie' && metadata.ProductionYear) {
    return `${metadata.Name} (${metadata.ProductionYear})`;
  }

  return metadata.Name;
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
    if (!preferences.get('set_video_title')) {
      titleForNextItem = null;
      return;
    }
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

  /**
   * Whether the file now loading brought its own title, as loadfile's per-file
   * options do for queued and autoplayed items. When mpv cannot say, assume it
   * did: keeping a stale title is better than wiping a correct one.
   */
  function hasPerFileTitle() {
    try {
      return Boolean(mpv.getFlag('option-info/force-media-title/set-locally'));
    } catch (error) {
      log(`Could not read whether the title is per-file: ${error.message}`);
      return true;
    }
  }

  /**
   * Called from mpv's on_load hook, before the file is opened. mpv names the
   * playlist entry after the first title it sees and never renames it, so a
   * title set only after file-loaded reaches the window but not the playlist,
   * which keeps the file's embedded title, the previous item's or the URL.
   */
  async function applyTitleBeforeLoad(url) {
    if (!preferences.get('set_video_title') || hasPerFileTitle()) return;

    const jellyfinInfo = isJellyfinUrl(url) ? parseJellyfinUrl(url) : null;
    if (titleForNextItem && jellyfinInfo && titleForNextItem.itemId === jellyfinInfo.itemId) {
      setPluginTitle(titleForNextItem.title);
      return;
    }

    // Whatever title is still in effect belongs to the previous item.
    clearPluginTitle();
    if (!jellyfinInfo) return;

    const { serverBase, itemId, apiKey } = jellyfinInfo;
    // Picking another item while this waits sets a new titleForNextItem, and
    // ending this load bumps the generation; either way this title is stale.
    const generation = fileGeneration;
    const pendingTitle = titleForNextItem;
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), TITLE_BEFORE_LOAD_TIMEOUT_MS);
    });
    let metadata = null;
    try {
      metadata = await Promise.race([fetchItemMetadata(serverBase, itemId, apiKey), timeout]);
    } catch (error) {
      log(`Could not fetch the title before loading: ${error.message}`);
    } finally {
      clearTimeout(timer);
    }

    if (isStale(generation) || titleForNextItem !== pendingTitle) {
      log(`Title for ${itemId} arrived after another item was opened, not applying it`);
      return;
    }

    const title = titleFromMetadata(metadata);
    if (!title) {
      log(`No title for ${itemId} before loading, it is set once the file has loaded`);
      return;
    }

    log(`Setting video title before loading: "${title}"`);
    setPluginTitle(title);
    titleForNextItem = { title, itemId };
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

      const title = titleFromMetadata(metadata);
      if (!title) {
        log('No title found in metadata');
        return;
      }

      log(`Setting video title to: "${title}"`);

      try {
        setPluginTitle(title);
        log(`Video title set via mpv property: ${title}`);
      } catch (error) {
        log(`mpv.set('force-media-title') failed, title would be: ${title} (${error.message})`);
        return;
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
        .filter((lang) => lang.trim().length > 0);
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
        if (expectedTitle && expectedTitle.itemId === jellyfinInfo.itemId) {
          setPluginTitle(expectedTitle.title);
        } else if (!hasPerFileTitle()) {
          // Opened some other way (a pasted URL, IINA's history): the previous
          // item's title must not stay on this one while its own is fetched,
          // or for good if that fails. An autoplayed or queued item carries a
          // per-file title that may equal one of the plugin's, so it is kept.
          clearPluginTitle();
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
    applyTitleBeforeLoad,
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
  mediaTitleOption,
};
