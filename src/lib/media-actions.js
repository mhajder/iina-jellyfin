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
 * The preferred_languages preference as a list of codes, highest priority
 * first. Shared by the subtitle downloads and the track selection so both
 * agree on what the viewer prefers.
 */
function parsePreferredLanguages(value) {
  return String(value || 'en,eng')
    .split(',')
    .map((code) => code.trim())
    .filter((code) => code.length > 0);
}

/** False for a missing or "und" (undetermined) track language. */
function isKnownLanguage(language) {
  return Boolean(language) && primaryLanguageCode(language) !== 'und';
}

/**
 * Position of the first preferred code naming this language, or Infinity
 * when none does or the language is unknown.
 */
function preferenceRank(preferred, language) {
  if (!isKnownLanguage(language)) return Infinity;
  const index = preferred.findIndex((code) => languagesMatch(code, language));
  return index === -1 ? Infinity : index;
}

/**
 * Whether mpv plays this track as the main one. A secondary subtitle
 * (secondary-sid) is "selected" too, with main-selection 1.
 */
function isMainSelection(track) {
  return Boolean(track.selected) && track['main-selection'] !== 1;
}

/**
 * The track whose language ranks highest. On a tie the track playing now
 * wins, so mpv's pick among same-language tracks (e.g. the default 7.1 mix
 * over a 2.0 one) is kept; otherwise the file order decides.
 */
function bestRankedTrack(tracks, preferred) {
  let best = null;
  let bestRank = Infinity;
  for (const track of tracks) {
    const rank = preferenceRank(preferred, track.lang);
    const winsTie = rank === bestRank && rank !== Infinity && isMainSelection(track);
    if (rank < bestRank || winsTie) {
      best = track;
      bestRank = rank;
    }
  }
  return best;
}

function isCommentaryTrack(track) {
  return /commentar/i.test(track.title || '');
}

function isAudioDescription(track) {
  const title = track.title || '';
  return (
    Boolean(track['visual-impaired']) ||
    /audio description|descriptive/i.test(title) ||
    /\bAD\b/.test(title)
  );
}

/**
 * Whether a subtitle covers only signs/songs/foreign dialogue. "Signs" or
 * "Songs" on their own mean just that, but "Full + Signs" or "Dialogue &
 * Songs" is a full subtitle.
 */
function isForcedSubtitle(track) {
  const title = String(track.title || '').toLowerCase();
  if (track.forced || /\bforced\b/.test(title)) return true;
  return /\b(signs|songs)\b/.test(title) && !/\b(full|dialog(ue)?)\b/.test(title);
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
    stream,
    apiKey,
    generation
  ) {
    const streamIndex = stream.Index;
    const subtitlePath = stream.Path;
    const language = stream.Language || 'unknown';
    const codec = stream.Codec || 'srt';
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
      addSubtitleTrack(resolvedPath, stream);

      log(`External subtitle loaded successfully: ${resolvedPath}`);

      if (preferences.get('show_notifications')) {
        core.osd(`Loaded external ${language} subtitle`);
      }

      return resolvedPath;
    } catch (error) {
      log(`Error downloading external subtitle: ${error.message}`);
      return null;
    }
  }

  /**
   * Title for a downloaded subtitle track. Jellyfin's IsForced has no mpv flag
   * to land in, so it goes into the title, where isForcedSubtitle finds it.
   */
  function subtitleTrackTitle(stream) {
    const title = stream.Title || stream.DisplayTitle || stream.Language || '';
    return stream.IsForced && !/forced/i.test(title) ? `${title} (Forced)`.trim() : title;
  }

  /**
   * Add a downloaded subtitle without selecting it. mpv sub-add (and so
   * core.subtitle.loadTrack) selects by default, which would let whichever
   * download finished last win; selectAfterDownloads picks once all are in.
   *
   * A track already loaded from this path is removed and added again, as the
   * file was just rewritten. sub-reload is not used: it selects the track and
   * drops the title and language given here. If the old track was playing,
   * the new one takes its place.
   */
  function addSubtitleTrack(path, stream) {
    const existing = findTrackByPath(readTracks(), path);
    if (existing) mpv.command('sub-remove', [String(existing.id)]);

    // The language is passed on: mpv only guesses one from a "name.en.srt"
    // file name, which this one is not when Jellyfin omits the Path.
    mpv.command('sub-add', [path, 'auto', subtitleTrackTitle(stream), stream.Language || '']);

    if (!existing || !isMainSelection(existing)) return;
    const added = findTrackByPath(readTracks(), path);
    if (!added) return;
    mpv.set('sid', String(added.id));
    if (autoSubtitle.id === existing.id) autoSubtitle = { ...autoSubtitle, id: added.id };
  }

  function findTrackByPath(tracks, path) {
    return (
      tracks.find((track) => track.type === 'sub' && track['external-filename'] === path) || null
    );
  }

  /**
   * Choose the subtitle once every download is in. When the plugin manages
   * subtitles they are ranked, unless the viewer changed the subtitle since the
   * automatic selection.
   *
   * A manual download always shows one of the downloads, as the viewer asked
   * for them: the best-ranked full one, then the best-ranked forced one, when
   * the plugin manages subtitles. Otherwise, or if none is in a preferred
   * language, the newest download, as loadTrack used to.
   */
  function selectAfterDownloads(generation, paths, manual) {
    if (isStale(generation)) return;
    const tracks = readTracks();
    const current = selectedTrack(tracks, 'sub');
    const currentId = current ? current.id : null;

    if (!manual && managesSubtitles()) {
      if (autoSubtitle.generation === generation && currentId !== autoSubtitle.id) {
        log('Subtitle changed since the automatic selection, keeping it');
        return;
      }
      const preferred = parsePreferredLanguages(preferences.get('preferred_languages'));
      const id = applySubtitle(tracks, preferred, selectedTrack(tracks, 'audio'));
      log(`Subtitle selection after downloads: sid=${id}`);
      return;
    }

    const downloaded = paths.map((path) => findTrackByPath(tracks, path)).filter(Boolean);
    let choice = downloaded[downloaded.length - 1] || null;
    if (managesSubtitles()) {
      const preferred = parsePreferredLanguages(preferences.get('preferred_languages'));
      const usable = downloaded.filter((track) => !isCommentaryTrack(track));
      choice =
        bestRankedTrack(
          usable.filter((track) => !isForcedSubtitle(track)),
          preferred
        ) ||
        bestRankedTrack(usable.filter(isForcedSubtitle), preferred) ||
        choice;
    }
    if (choice && choice.id !== currentId) mpv.set('sid', String(choice.id));
  }

  async function downloadAllSubtitles(serverBase, itemId, apiKey, { manual = false } = {}) {
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

      const preferredLanguages = parsePreferredLanguages(preferences.get('preferred_languages'));
      const shouldDownloadAll = preferences.get('download_all_subtitles');

      const loadedPaths = [];

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
          const loadedPath = await downloadExternalSubtitle(
            serverBase,
            itemId,
            mediaSource.Id,
            stream,
            apiKey,
            generation
          );
          if (loadedPath) {
            loadedPaths.push(loadedPath);
          }
        } catch (error) {
          log(`Failed to download subtitle ${language}: ${error.message}`);
        }
      }

      const downloadedCount = loadedPaths.length;
      if (downloadedCount > 0) {
        selectAfterDownloads(generation, loadedPaths, manual);
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
    downloadAllSubtitles(jellyfinInfo.serverBase, jellyfinInfo.itemId, jellyfinInfo.apiKey, {
      manual: true,
    });
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

  // The subtitle selectPreferredTracks left selected for the current file.
  // selectAfterDownloads only ranks again while it is still the selected one,
  // so a track the viewer picked in the meantime is kept.
  let autoSubtitle = { generation: -1, id: null };

  /** mpv's track list, read fresh in one call (IINA's copy can lag behind). */
  function readTracks() {
    const tracks = mpv.getNative('track-list');
    return Array.isArray(tracks) ? tracks : [];
  }

  function selectedTrack(tracks, type) {
    return tracks.find((track) => track.type === type && isMainSelection(track)) || null;
  }

  /**
   * Whether this plugin picks the subtitle. A preferred subtitle language set
   * in IINA (mpv's slang) is the viewer's own choice and mpv has already
   * applied it, so the plugin then stays out of subtitle selection entirely.
   */
  function managesSubtitles() {
    return Boolean(preferences.get('select_preferred_tracks')) && !mpv.getString('slang');
  }

  /**
   * The highest-ranked main-programme audio track. Commentaries and audio
   * description are never picked: when only those are in a preferred
   * language, mpv's choice (the real programme) is kept.
   */
  function pickAudio(tracks, preferred) {
    const main = tracks.filter(
      (track) => track.type === 'audio' && !isCommentaryTrack(track) && !isAudioDescription(track)
    );
    return bestRankedTrack(main, preferred);
  }

  const KEEP_SUBTITLE = { action: 'keep' };
  const SUBTITLE_OFF = { action: 'off' };

  /**
   * What to do with the subtitle for this audio track: keep mpv's choice,
   * turn subtitles off, or select a track.
   *
   * A full subtitle is only picked in a language ranked above the audio's, so
   * a viewer who gets audio in a language they prefer is not given subtitles
   * for it, only the signs/songs track in that language when there is one.
   */
  function pickSubtitle(tracks, preferred, audio) {
    // Untagged audio could be in any language, so there is no basis to choose.
    if (!audio || !isKnownLanguage(audio.lang)) return KEEP_SUBTITLE;

    const audioRank = preferenceRank(preferred, audio.lang);
    const subtitles = tracks.filter((track) => track.type === 'sub' && !isCommentaryTrack(track));
    const full = subtitles.filter((track) => !isForcedSubtitle(track));
    const forced = subtitles.filter(isForcedSubtitle);

    const betterFull = full.filter((track) => preferenceRank(preferred, track.lang) < audioRank);
    const bestFull = bestRankedTrack(betterFull, preferred);
    if (bestFull) return { action: 'select', track: bestFull };

    if (audioRank !== Infinity) {
      const signs = forced.find((track) => track.lang && languagesMatch(audio.lang, track.lang));
      return signs ? { action: 'select', track: signs } : SUBTITLE_OFF;
    }
    // Audio in a language the viewer did not list and no full subtitle for
    // it: a signs-only subtitle is still better than nothing.
    const fallback = bestRankedTrack(forced, preferred);
    return fallback ? { action: 'select', track: fallback } : KEEP_SUBTITLE;
  }

  /** Apply pickSubtitle's decision; returns the selected subtitle id or null. */
  function applySubtitle(tracks, preferred, audio) {
    const current = selectedTrack(tracks, 'sub');
    const currentId = current ? current.id : null;
    const decision = pickSubtitle(tracks, preferred, audio);

    let id = currentId;
    if (decision.action === 'off') id = null;
    if (decision.action === 'select') id = decision.track.id;
    if (id !== currentId) mpv.set('sid', id === null ? 'no' : String(id));

    autoSubtitle = { generation: fileGeneration, id };
    return id;
  }

  /**
   * Switch to the preferred-language audio and subtitle tracks. Jellyfin
   * direct-play hands mpv the raw file, so mpv falls back to the container's
   * default-flagged tracks — often the original language, not the viewer's.
   * Languages are ranked in the order of preferred_languages. A preferred
   * audio or subtitle language set in IINA (mpv's alang/slang) takes over the
   * matching half, since mpv has already applied it.
   */
  function selectPreferredTracks() {
    // Runs inside the file-loaded handler, ahead of progress sync, the title,
    // autoplay and the subtitle downloads; a failure here must not stop them.
    try {
      const preferred = parsePreferredLanguages(preferences.get('preferred_languages'));
      const tracks = readTracks();

      let audio = selectedTrack(tracks, 'audio');
      if (mpv.getString('alang')) {
        log('Audio track left to the IINA/mpv alang setting');
      } else {
        const choice = pickAudio(tracks, preferred);
        if (choice) {
          if (!audio || audio.id !== choice.id) mpv.set('aid', String(choice.id));
          audio = choice;
        }
        log(`Preferred audio track: aid=${audio ? audio.id : null}`);
      }

      if (managesSubtitles()) {
        log(`Preferred subtitle track: sid=${applySubtitle(tracks, preferred, audio)}`);
      } else {
        log('Subtitle track left to the IINA/mpv slang setting');
      }
    } catch (error) {
      log(`Preferred track selection failed: ${error.message}`);
    }
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
    selectPreferredTracks,
    getLastItemId,
  };
}

module.exports = {
  createMediaActionsManager,
  mediaTitleOption,
};
