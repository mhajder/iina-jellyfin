/**
 * IINA Jellyfin Plugin
 */

const {
  core,
  console,
  menu,
  event,
  http,
  utils,
  preferences,
  mpv,
  sidebar,
  global,
  standaloneWindow,
  playlist,
} = iina;

// Plugin state
let lastJellyfinUrl = null;
let lastItemId = null;
let lastProcessedEpisodeId = null; // Track last processed episode to prevent duplicates
let lastProcessedSeriesId = null; // Track last series to detect series changes
const addedEpisodeIds = new Set(); // Track episodes already added to playlist

/**
 * Debug logging helper function
 * Only logs if debug logging is enabled in preferences
 */
function debugLog(message) {
  if (preferences.get('debug_logging')) {
    console.log(`DEBUG: ${message}`);
  }
}

debugLog('Jellyfin Subtitles Plugin loaded');

/**
 * Parse Jellyfin URL to extract server info and item ID
 */
function parseJellyfinUrl(url) {
  try {
    debugLog(`Attempting to parse URL: "${url}"`);

    if (!url) {
      debugLog(`URL is null or undefined`);
      return null;
    }

    // Manual URL parsing since URL constructor is not available in IINA
    // Extract protocol and host
    const protocolMatch = url.match(/^(https?):\/\/([^\/]+)/);
    if (!protocolMatch) {
      debugLog(`Invalid URL format - no protocol/host found`);
      return null;
    }

    const protocol = protocolMatch[1];
    const host = protocolMatch[2];
    const serverBase = `${protocol}://${host}`;

    debugLog(`Extracted serverBase: ${serverBase}`);

    // Extract pathname and query string
    const urlParts = url.split('?');
    const pathname = urlParts[0].replace(/^https?:\/\/[^\/]+/, '');
    const queryString = urlParts[1] || '';

    debugLog(`Extracted pathname: ${pathname}`);
    debugLog(`Extracted queryString: ${queryString}`);

    // Extract item ID from path
    const pathMatch = pathname.match(/\/Items\/([^\/]+)/);
    debugLog(`Path match result: ${pathMatch ? pathMatch[0] : 'no match'}`);

    if (!pathMatch) {
      debugLog(`No /Items/ pattern found in pathname: ${pathname}`);
      return null;
    }

    const itemId = pathMatch[1];

    // Extract API key from query string
    let apiKey = null;
    if (queryString) {
      const apiKeyMatch = queryString.match(/(?:^|&)api_key=([^&]+)/);
      if (apiKeyMatch) {
        apiKey = decodeURIComponent(apiKeyMatch[1]);
      }
    }

    debugLog(
      `Extracted - itemId: ${itemId}, apiKey: ${apiKey ? 'present' : 'missing'}, serverBase: ${serverBase}`
    );

    if (!apiKey) {
      debugLog(`No API key found in URL parameters`);
      return null;
    }

    return {
      serverBase,
      itemId,
      apiKey,
    };
  } catch (error) {
    debugLog(`Error parsing Jellyfin URL: ${error.message}`);
    debugLog(`Failed URL was: "${url}"`);
    return null;
  }
}

/**
 * Check if URL looks like a Jellyfin URL
 */
function isJellyfinUrl(url) {
  return (
    url &&
    ((url.includes('/Items/') && url.includes('api_key=')) ||
      url.includes('jellyfin') ||
      url.includes('/Audio/') ||
      url.includes('/Videos/'))
  );
}

/**
 * Fetch playback info from Jellyfin API
 */
async function fetchPlaybackInfo(serverBase, itemId, apiKey) {
  try {
    const playbackUrl = `${serverBase}/Items/${itemId}/PlaybackInfo?api_key=${apiKey}`;
    debugLog(`Fetching playback info from: ${playbackUrl}`);

    const response = await http.get(playbackUrl, {
      headers: {
        Accept: 'application/json',
      },
    });

    debugLog(`Response received`);

    if (!response.data) {
      throw new Error('No data received from Jellyfin API');
    }

    // IINA automatically parses JSON responses, so response.data is already an object
    if (typeof response.data === 'object') {
      debugLog(`Response data is already parsed object`);
      debugLog(
        `MediaSources found: ${response.data.MediaSources ? response.data.MediaSources.length : 'none'}`
      );
      return response.data;
    } else {
      // Fallback: if it's still a string, parse it manually
      debugLog(`Response data is string, parsing manually`);
      debugLog(`Response.data preview: ${response.data.substring(0, 200)}`);
      return JSON.parse(response.data);
    }
  } catch (error) {
    debugLog(`Error fetching playback info: ${error.message}`);
    throw error;
  }
}

/**
 * Fetch item metadata from Jellyfin API for title information
 */
async function fetchItemMetadata(serverBase, itemId, apiKey) {
  try {
    const metadataUrl = `${serverBase}/Items/${itemId}?api_key=${apiKey}`;
    debugLog(`Fetching item metadata from: ${metadataUrl}`);

    const response = await http.get(metadataUrl, {
      headers: {
        Accept: 'application/json',
      },
    });

    debugLog(`Metadata response received`);

    if (!response.data) {
      throw new Error('No metadata received from Jellyfin API');
    }

    // IINA automatically parses JSON responses, so response.data is already an object
    if (typeof response.data === 'object') {
      debugLog(`Metadata is already parsed object`);
      debugLog(`Item name: ${response.data.Name}`);
      debugLog(`Item type: ${response.data.Type}`);
      return response.data;
    } else {
      // Fallback: if it's still a string, parse it manually
      debugLog(`Metadata is string, parsing manually`);
      debugLog(`Metadata preview: ${response.data.substring(0, 200)}`);
      return JSON.parse(response.data);
    }
  } catch (error) {
    debugLog(`Error fetching item metadata: ${error.message}`);
    throw error;
  }
}

/**
 * Construct and set the video title from Jellyfin metadata
 */
async function setVideoTitleFromMetadata(serverBase, itemId, apiKey) {
  try {
    if (!preferences.get('set_video_title')) {
      debugLog('Video title setting is disabled in preferences');
      return;
    }

    const metadata = await fetchItemMetadata(serverBase, itemId, apiKey);

    if (!metadata || !metadata.Name) {
      debugLog('No title found in metadata');
      return;
    }

    let title = metadata.Name;

    // For TV episodes, construct a more informative title
    if (metadata.Type === 'Episode') {
      const seriesName = metadata.SeriesName;
      const seasonNumber = metadata.ParentIndexNumber;
      const episodeNumber = metadata.IndexNumber;

      if (seriesName) {
        let episodeTitle = seriesName;

        // Add season and episode numbers if available
        if (seasonNumber !== undefined && episodeNumber !== undefined) {
          episodeTitle += ` S${seasonNumber.toString().padStart(2, '0')}E${episodeNumber.toString().padStart(2, '0')}`;
        }

        // Add episode name
        episodeTitle += ` - ${metadata.Name}`;
        title = episodeTitle;
      }
    }
    // For movies, just use the name (potentially with year)
    else if (metadata.Type === 'Movie') {
      if (metadata.ProductionYear) {
        title = `${metadata.Name} (${metadata.ProductionYear})`;
      }
    }

    debugLog(`Setting video title to: "${title}"`);

    // Try to set the title in IINA
    let titleSet = false;

    // Try mpv property if available
    if (!titleSet && typeof mpv !== 'undefined' && typeof mpv.set === 'function') {
      try {
        mpv.set('force-media-title', title);
        titleSet = true;
        debugLog(`Video title set via mpv property: ${title}`);
      } catch (error) {
        debugLog(`mpv.set('force-media-title') failed: ${error.message}`);
      }
    }

    if (!titleSet) {
      debugLog(`Could not set title via IINA API, title would be: ${title}`);
    }

    if (preferences.get('show_notifications')) {
      core.osd(`Title: ${title}`);
    }
  } catch (error) {
    debugLog(`Error setting video title: ${error.message}`);
  }
}

/**
 * Fetch all episodes for a given series and current season
 * Returns array of episode URLs that can be added to the playlist
 */
async function fetchSeriesEpisodes(serverBase, seriesId, seasonId, apiKey) {
  try {
    debugLog(`Fetching episodes for series: ${seriesId}, season: ${seasonId}`);

    const queryParams = [
      'seasonId=' + encodeURIComponent(seasonId),
      'fields=' + encodeURIComponent('MediaSources,Path,LocationType,IsFolder,CanDownload'),
    ].join('&');

    const response = await http.get(
      `${serverBase}/Shows/${seriesId}/Episodes?${queryParams}&api_key=${apiKey}`,
      {
        headers: {
          Accept: 'application/json',
        },
      }
    );

    if (!response.data) {
      throw new Error('No data received from Jellyfin API');
    }

    const episodeData =
      typeof response.data === 'string' ? JSON.parse(response.data) : response.data;

    if (!episodeData.Items) {
      debugLog('No episodes found in response');
      return [];
    }

    // Filter out unavailable episodes (those without MediaSources or with CanDownload=false)
    const episodes = episodeData.Items.filter((ep) => {
      const hasMediaSources = ep.MediaSources && ep.MediaSources.length > 0;
      const canDownload = ep.CanDownload !== false; // Default to true if not explicitly set to false
      return hasMediaSources && canDownload;
    }).map((ep) => ({
      id: ep.Id,
      name: ep.Name,
      indexNumber: Number(ep.IndexNumber) || 0, // Ensure it's a number
      duration: ep.RunTimeTicks,
      playUrl: `${serverBase}/Items/${ep.Id}/Download?api_key=${apiKey}`,
    }));

    // Sort episodes by index number for consistent ordering
    episodes.sort((a, b) => a.indexNumber - b.indexNumber);

    debugLog(
      `Fetched ${episodes.length} episodes from series: ${episodes.map((e) => `E${e.indexNumber}`).join(', ')}`
    );
    return episodes;
  } catch (error) {
    debugLog(`Error fetching series episodes: ${error.message}`);
    return [];
  }
}

/**
 * Get series info from episode metadata
 * Returns the series ID and season ID
 */
async function getSeriesInfoFromEpisode(serverBase, episodeId, apiKey) {
  try {
    debugLog(`Getting series info from episode: ${episodeId}`);

    const metadata = await fetchItemMetadata(serverBase, episodeId, apiKey);

    if (metadata.Type !== 'Episode') {
      debugLog(`Item ${episodeId} is not an episode, it's a ${metadata.Type}`);
      return null;
    }

    const seriesId = metadata.SeriesId;
    const seasonId = metadata.SeasonId;
    const seasonNumber = Number(metadata.ParentIndexNumber) || 1;
    const episodeIndexNumber = Number(metadata.IndexNumber) || 0;

    if (!seriesId || !seasonId) {
      debugLog(`Missing series info - SeriesId: ${seriesId}, SeasonId: ${seasonId}`);
      return null;
    }

    debugLog(
      `Series info: SeriesId=${seriesId}, SeasonId=${seasonId}, SeasonNumber=${seasonNumber}, EpisodeNumber=${episodeIndexNumber}`
    );

    return {
      seriesId,
      seasonId,
      seasonNumber,
      currentEpisodeNumber: episodeIndexNumber,
    };
  } catch (error) {
    debugLog(`Error getting series info from episode: ${error.message}`);
    return null;
  }
}

/**
 * Add episodes to the IINA playlist starting from the next episode
 * This creates a playlist of remaining episodes in the series
 */
async function addEpisodesToPlaylist(
  serverBase,
  seriesId,
  seasonId,
  seasonNumber,
  currentEpisodeNumber,
  apiKey
) {
  try {
    debugLog(`Adding episodes to playlist AFTER episode ${currentEpisodeNumber}`);

    // Ensure currentEpisodeNumber is a number
    const currentEpNum = Number(currentEpisodeNumber);
    debugLog(`Current episode number (type: ${typeof currentEpNum}): ${currentEpNum}`);

    // Fetch all episodes for this season
    const episodes = await fetchSeriesEpisodes(serverBase, seriesId, seasonId, apiKey);

    if (episodes.length === 0) {
      debugLog('No episodes found to add to playlist');
      return 0;
    }

    debugLog(`Total episodes fetched: ${episodes.length}, current episode: ${currentEpNum}`);
    debugLog(`Episode index numbers available: ${episodes.map((e) => e.indexNumber).join(', ')}`);

    // Filter to episodes AFTER the current one (not including current)
    const remainingEpisodes = episodes.filter((ep) => {
      const include = ep.indexNumber > currentEpNum;
      if (ep.indexNumber >= currentEpNum - 1 && ep.indexNumber <= currentEpNum + 1) {
        debugLog(
          `Filtering: E${ep.indexNumber} (${typeof ep.indexNumber}) > ${currentEpNum} (${typeof currentEpNum}) = ${include}`
        );
      }
      return include;
    });

    debugLog(
      `After filtering (indexNumber > ${currentEpisodeNumber}): ${remainingEpisodes.map((e) => `E${e.indexNumber}`).join(', ')}`
    );

    if (remainingEpisodes.length === 0) {
      debugLog('No remaining episodes after the current one');
      return 0;
    }

    // Clear existing playlist items for this series to avoid stale titles
    // This ensures we rebuild the playlist from scratch when moving to a new episode
    try {
      if (playlist && typeof playlist.clear === 'function') {
        debugLog('Clearing existing playlist');
        playlist.clear();
        addedEpisodeIds.clear(); // Clear our tracking too
      }
    } catch (error) {
      debugLog(`Could not clear playlist (API might not support it): ${error.message}`);
      // Continue anyway - we'll just skip already-added items
    }

    debugLog(`Adding ${remainingEpisodes.length} episodes to playlist`);

    let addedCount = 0;
    for (const episode of remainingEpisodes) {
      try {
        // Skip if already added in this session (in case clear didn't work)
        if (addedEpisodeIds.has(episode.id)) {
          debugLog(`Episode ${episode.indexNumber} (${episode.id}) already in playlist, skipping`);
          continue;
        }

        debugLog(`Adding episode ${episode.indexNumber}: ${episode.name} to playlist`);

        // Add to playlist - IINA will display whatever it can extract from the URL
        // Note: IINA's playlist UI has limitations and may only show URLs regardless of title parameter
        try {
          playlist.add(episode.playUrl);
          debugLog(`Added episode: ${episode.playUrl}`);
        } catch (error) {
          debugLog(`Failed to add episode: ${error.message}`);
        }

        // Track this episode as added
        addedEpisodeIds.add(episode.id);
        addedCount++;
      } catch (error) {
        debugLog(`Failed to add episode ${episode.indexNumber} to playlist: ${error.message}`);
      }
    }

    if (addedCount > 0 && preferences.get('show_notifications')) {
      core.osd(`Added ${addedCount} episodes to playlist`);
    }

    return addedCount;
  } catch (error) {
    debugLog(`Error adding episodes to playlist: ${error.message}`);
    return 0;
  }
}

/**
 * Store the current episode info for autoplay handling
 */
function storeCurrentEpisodeInfo(episodeId, seriesInfo) {
  try {
    if (!seriesInfo) {
      debugLog('Series info is null, clearing stored episode info');
      preferences.set('last_episode_id', '');
      preferences.set('last_series_id', '');
      preferences.set('last_season_id', '');
      preferences.set('last_episode_number', 0);
      return;
    }

    debugLog(
      `Storing episode info for autoplay - Episode: ${episodeId}, Series: ${seriesInfo.seriesId}`
    );
    preferences.set('last_episode_id', episodeId);
    preferences.set('last_series_id', seriesInfo.seriesId);
    preferences.set('last_season_id', seriesInfo.seasonId);
    preferences.set('last_episode_number', seriesInfo.currentEpisodeNumber);
    preferences.sync();
  } catch (error) {
    debugLog(`Error storing episode info: ${error.message}`);
  }
}

/**
 * Download subtitle file from Jellyfin
 */
async function downloadSubtitle(serverBase, itemId, streamIndex, apiKey, language, codec) {
  try {
    const subtitleUrl = `${serverBase}/Videos/${itemId}/${streamIndex}/Subtitles.${codec}?api_key=${apiKey}`;
    // Sanitize filename components to prevent path traversal
    const sanitizedItemId = String(itemId).replace(/[^a-zA-Z0-9_-]/g, '_');
    const sanitizedLanguage = String(language).replace(/[^a-zA-Z0-9_-]/g, '_');
    const sanitizedCodec = String(codec).replace(/[^a-zA-Z0-9_-]/g, '_');
    const fileName = `jellyfin_${sanitizedItemId}_${streamIndex}_${sanitizedLanguage}.${sanitizedCodec}`;
    const localPath = `@tmp/${fileName}`;

    debugLog(`Downloading subtitle: ${subtitleUrl}`);

    await http.download(subtitleUrl, localPath);

    // Load the subtitle track in IINA
    const resolvedPath = utils.resolvePath(localPath);
    core.subtitle.loadTrack(resolvedPath);

    debugLog(`Subtitle loaded: ${resolvedPath}`);

    if (preferences.get('show_notifications')) {
      core.osd(`Loaded ${language} subtitle`);
    }

    return true;
  } catch (error) {
    debugLog(`Error downloading subtitle: ${error.message}`);
    return false;
  }
}

/**
 * Process external subtitle file
 */
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
    // Determine the proper file extension based on codec
    let extension = 'srt'; // default
    if (codec === 'subrip') extension = 'srt';
    else if (codec === 'webvtt') extension = 'vtt';
    else if (codec === 'ass') extension = 'ass';
    else if (codec === 'ssa') extension = 'ssa';
    else if (codec === 'vtt') extension = 'vtt';
    else if (codec && codec.toLowerCase().includes('srt')) extension = 'srt';
    else if (codec && codec.toLowerCase().includes('vtt')) extension = 'vtt';

    // Use the correct Jellyfin API endpoint for subtitle download
    // Format: /Videos/{itemId}/{mediaSourceId}/Subtitles/{streamIndex}/stream.{extension}
    const subtitleUrl = `${serverBase}/Videos/${itemId}/${itemId}/Subtitles/${streamIndex}/stream.${extension}?api_key=${apiKey}`;

    // Try to extract the original filename from the subtitle path
    let fileName;
    if (subtitlePath) {
      // Extract just the filename from the full path and sanitize it
      const pathParts = subtitlePath.split(/[/\\]/); // Handle both / and \ separators
      const originalName = pathParts[pathParts.length - 1];
      // Sanitize filename to prevent path traversal and invalid characters
      fileName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
      debugLog(`Using sanitized filename: ${fileName}`);
    } else {
      // Fallback to generated name with sanitized components
      const sanitizedItemId = String(itemId).replace(/[^a-zA-Z0-9_-]/g, '_');
      const sanitizedLanguage = String(language).replace(/[^a-zA-Z0-9_-]/g, '_');
      fileName = `jellyfin_external_${sanitizedItemId}_${streamIndex}_${sanitizedLanguage}.${extension}`;
      debugLog(`Using generated filename: ${fileName}`);
    }

    const localPath = `@tmp/${fileName}`;

    debugLog(`Downloading external subtitle: ${subtitleUrl}`);
    debugLog(`External subtitle path: ${subtitlePath}`);
    debugLog(`Stream index: ${streamIndex}`);
    debugLog(`Language: ${language}`);
    debugLog(`Codec: ${codec} -> Extension: ${extension}`);
    debugLog(`Local filename: ${fileName}`);

    await http.download(subtitleUrl, localPath);

    // Load the subtitle track in IINA
    const resolvedPath = utils.resolvePath(localPath);
    core.subtitle.loadTrack(resolvedPath);

    debugLog(`External subtitle loaded successfully: ${resolvedPath}`);

    if (preferences.get('show_notifications')) {
      core.osd(`Loaded external ${language} subtitle`);
    }

    return true;
  } catch (error) {
    debugLog(`Error downloading external subtitle: ${error.message}`);
    return false;
  }
}

/**
 * Download all available subtitles for a Jellyfin item
 */
async function downloadAllSubtitles(serverBase, itemId, apiKey) {
  try {
    const playbackInfo = await fetchPlaybackInfo(serverBase, itemId, apiKey);

    if (!playbackInfo.MediaSources || playbackInfo.MediaSources.length === 0) {
      debugLog('No media sources found');
      return;
    }

    const mediaSource = playbackInfo.MediaSources[0];
    const mediaStreams = mediaSource.MediaStreams || [];

    const subtitleStreams = mediaStreams.filter(
      (stream) => stream.Type === 'Subtitle' && stream.IsTextSubtitleStream
    );

    debugLog(`Found ${subtitleStreams.length} subtitle streams`);

    const preferredLanguages = (preferences.get('preferred_languages') || 'en,eng')
      .split(',')
      .map((lang) => lang.trim().toLowerCase())
      .filter((lang) => lang.length > 0);
    const downloadAll = preferences.get('download_all_subtitles');

    let downloadedCount = 0;

    for (const stream of subtitleStreams) {
      const language = stream.Language || 'unknown';
      const codec = stream.Codec || 'srt';

      // Check if we should download this subtitle
      const shouldDownload =
        downloadAll ||
        preferredLanguages.some(
          (prefLang) =>
            language.toLowerCase().includes(prefLang) || prefLang.includes(language.toLowerCase())
        );

      if (!shouldDownload) {
        debugLog(`Skipping subtitle: ${language} (not in preferred languages)`);
        continue;
      }

      debugLog(
        `Processing subtitle: ${language} (${codec}) - Index: ${stream.Index}, External: ${stream.IsExternal}`
      );

      try {
        if (stream.IsExternal && stream.Path) {
          // Handle external subtitle files
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
          // Handle embedded subtitle streams
          await downloadSubtitle(serverBase, itemId, stream.Index, apiKey, language, codec);
        }
        downloadedCount++;
      } catch (error) {
        debugLog(`Failed to download subtitle ${language}: ${error.message}`);
      }
    }

    if (downloadedCount > 0 && preferences.get('show_notifications')) {
      core.osd(`Downloaded ${downloadedCount} subtitle(s)`);
    } else if (downloadedCount === 0) {
      debugLog('No subtitles downloaded');
      if (preferences.get('show_notifications')) {
        core.osd('No matching subtitles found');
      }
    }
  } catch (error) {
    debugLog(`Error downloading subtitles: ${error.message}`);
    if (preferences.get('show_notifications')) {
      core.osd('Failed to download subtitles');
    }
  }
}

/**
 * Store Jellyfin session data for auto-login
 */
function storeJellyfinSession(serverBase, apiKey) {
  try {
    if (!preferences.get('auto_login_enabled')) {
      debugLog('Auto-login disabled, not storing session data');
      return;
    }

    debugLog(`Storing Jellyfin session data for: ${serverBase}`);

    // Store session data in preferences
    preferences.set('jellyfin_session_server', serverBase);
    preferences.set('jellyfin_session_token', apiKey);
    preferences.set('jellyfin_session_timestamp', Date.now());
    preferences.sync();

    debugLog('Jellyfin session data stored successfully');

    // Notify sidebar about available session
    if (sidebar && sidebar.postMessage) {
      sidebar.postMessage('session-available', {
        serverUrl: serverBase,
        accessToken: apiKey,
        timestamp: Date.now(),
      });
    }
  } catch (error) {
    debugLog(`Error storing Jellyfin session: ${error.message}`);
  }
}

/**
 * Clear stored Jellyfin session data
 */
function clearJellyfinSession() {
  try {
    debugLog('Clearing Jellyfin session data');
    preferences.set('jellyfin_session_server', '');
    preferences.set('jellyfin_session_token', '');
    preferences.set('jellyfin_session_timestamp', 0);
    preferences.sync();

    // Notify sidebar about cleared session
    if (sidebar && sidebar.postMessage) {
      sidebar.postMessage('session-cleared', {});
    }
  } catch (error) {
    debugLog(`Error clearing Jellyfin session: ${error.message}`);
  }
}

/**
 * Get stored Jellyfin session data if valid
 */
function getStoredJellyfinSession() {
  try {
    if (!preferences.get('auto_login_enabled')) {
      debugLog('Auto-login disabled, not retrieving session data');
      return null;
    }

    const serverUrl = preferences.get('jellyfin_session_server');
    const accessToken = preferences.get('jellyfin_session_token');
    const timestamp = preferences.get('jellyfin_session_timestamp') || 0;

    if (!serverUrl || !accessToken) {
      debugLog('No valid session data found');
      return null;
    }

    // Check if session is not too old (24 hours)
    const maxAge = preferences.get('session_max_age_hours') || 24;
    const sessionAge = (Date.now() - timestamp) / (1000 * 60 * 60); // hours

    if (sessionAge > maxAge) {
      debugLog(`Session too old (${sessionAge.toFixed(1)} hours), clearing`);
      clearJellyfinSession();
      return null;
    }

    debugLog(`Retrieved valid session data for: ${serverUrl}`);
    return {
      serverUrl,
      accessToken,
      timestamp,
    };
  } catch (error) {
    debugLog(`Error retrieving Jellyfin session: ${error.message}`);
    return null;
  }
}

/**
 * Handle file loaded event
 */
function onFileLoaded(fileUrl) {
  debugLog(`File loaded: ${fileUrl}`);

  // Always check if it's a Jellyfin URL and store it for manual download
  if (isJellyfinUrl(fileUrl)) {
    const jellyfinInfo = parseJellyfinUrl(fileUrl);
    if (jellyfinInfo) {
      // Store for manual download option
      lastJellyfinUrl = fileUrl;
      lastItemId = jellyfinInfo.itemId;
      debugLog(`Stored Jellyfin media for manual download: ${jellyfinInfo.itemId}`);

      // Store session data for auto-login if enabled
      storeJellyfinSession(jellyfinInfo.serverBase, jellyfinInfo.apiKey);

      // Set video title from metadata if enabled
      if (preferences.get('set_video_title')) {
        debugLog(`Setting video title from metadata for: ${jellyfinInfo.itemId}`);
        setVideoTitleFromMetadata(
          jellyfinInfo.serverBase,
          jellyfinInfo.itemId,
          jellyfinInfo.apiKey
        );
      }

      // Setup autoplay for TV episodes if enabled
      if (preferences.get('autoplay_next_episode')) {
        debugLog(`Setting up autoplay for episode (itemId): ${jellyfinInfo.itemId}`);
        // Reset lastProcessedEpisodeId to allow processing new episode
        lastProcessedEpisodeId = null;
        setupAutoplayForEpisode(jellyfinInfo.serverBase, jellyfinInfo.itemId, jellyfinInfo.apiKey);
      }

      // Only auto-download if enabled
      if (preferences.get('auto_download_enabled')) {
        debugLog(`Auto-downloading subtitles for: ${jellyfinInfo.itemId}`);
        downloadAllSubtitles(jellyfinInfo.serverBase, jellyfinInfo.itemId, jellyfinInfo.apiKey);
      } else {
        debugLog('Auto download disabled, but Jellyfin URL stored for manual download');
      }
    } else {
      debugLog('Failed to parse Jellyfin URL');
    }
  } else {
    // Clear stored Jellyfin URL when loading non-Jellyfin content
    debugLog('Non-Jellyfin URL loaded, clearing stored Jellyfin data');
    lastJellyfinUrl = null;
    lastItemId = null;
    debugLog('Not a Jellyfin URL, skipping subtitle download');
  }
}

/**
 * Setup autoplay for a TV episode
 * This fetches series info and adds remaining episodes to the playlist
 */
function setupAutoplayForEpisode(serverBase, episodeId, apiKey) {
  // Check if we're already processing this episode (prevents duplicates)
  if (lastProcessedEpisodeId === episodeId) {
    debugLog(`Episode ${episodeId} already being processed, skipping duplicate setup`);
    return;
  }

  // Mark this episode as being processed
  lastProcessedEpisodeId = episodeId;

  // Run async operation without blocking
  (async () => {
    try {
      debugLog(`Setting up autoplay for episode: ${episodeId}`);

      // Get series and season info from episode metadata
      const seriesInfo = await getSeriesInfoFromEpisode(serverBase, episodeId, apiKey);

      if (!seriesInfo) {
        debugLog('Could not get series info, autoplay not available');
        return;
      }

      debugLog(
        `Got series info: series=${seriesInfo.seriesId}, season=${seriesInfo.seasonId}, seasonNum=${seriesInfo.seasonNumber}, currentEp=${seriesInfo.currentEpisodeNumber}`
      );

      // If we switched to a different series, clear the episode tracking
      if (lastProcessedSeriesId !== seriesInfo.seriesId) {
        debugLog(
          `Series changed from ${lastProcessedSeriesId} to ${seriesInfo.seriesId}, clearing episode tracking`
        );
        addedEpisodeIds.clear();
        lastProcessedSeriesId = seriesInfo.seriesId;
      }

      // Store episode info for later reference
      storeCurrentEpisodeInfo(episodeId, seriesInfo);

      // Add remaining episodes to playlist (pass season number for proper formatting)
      const addedCount = await addEpisodesToPlaylist(
        serverBase,
        seriesInfo.seriesId,
        seriesInfo.seasonId,
        seriesInfo.seasonNumber,
        seriesInfo.currentEpisodeNumber,
        apiKey
      );

      debugLog(`Autoplay setup complete, added ${addedCount} episodes to playlist`);
    } catch (error) {
      debugLog(`Error setting up autoplay: ${error.message}`);
    }
  })();
}

/**
 * Manual subtitle download function
 */
function manualDownloadSubtitles() {
  debugLog(`Manual download requested`);
  debugLog(`lastJellyfinUrl = "${lastJellyfinUrl}"`);

  let currentUrl = lastJellyfinUrl;

  // If no stored URL, try to get the current file URL from IINA
  if (!currentUrl) {
    try {
      debugLog(`No stored URL, checking core.status`);
      // Try to get the current file path/URL from IINA core
      const currentFile = core.status.url || core.status.path;
      debugLog(`core.status.url = "${core.status.url}"`);
      debugLog(`core.status.path = "${core.status.path}"`);
      debugLog(`currentFile = "${currentFile}"`);

      if (currentFile && isJellyfinUrl(currentFile)) {
        currentUrl = currentFile;
        debugLog(`Using current file URL: ${currentUrl}`);
      } else {
        debugLog(`Current file is not a Jellyfin URL or is empty`);
      }
    } catch (error) {
      debugLog(`Error getting current file URL: ${error.message}`);
    }
  }

  if (!currentUrl) {
    debugLog('No Jellyfin URL found - checking for Jellyfin URL in current file');
    core.osd('No Jellyfin media detected. Please open a Jellyfin URL first.');
    return;
  }

  debugLog(`Attempting to download subtitles for: ${currentUrl}`);

  if (!isJellyfinUrl(currentUrl)) {
    debugLog(`URL is not a Jellyfin URL: ${currentUrl}`);
    core.osd('Current media is not from Jellyfin');
    return;
  }

  const jellyfinInfo = parseJellyfinUrl(currentUrl);
  if (!jellyfinInfo) {
    debugLog(`Failed to parse Jellyfin URL: ${currentUrl}`);
    core.osd('Failed to parse Jellyfin URL - check console for details');
    return;
  }

  // Store the URL for future use
  lastJellyfinUrl = currentUrl;
  lastItemId = jellyfinInfo.itemId;

  debugLog(`Downloading subtitles for item: ${jellyfinInfo.itemId}`);
  core.osd('Downloading subtitles...');
  downloadAllSubtitles(jellyfinInfo.serverBase, jellyfinInfo.itemId, jellyfinInfo.apiKey);
}

/**
 * Manual title setting function
 */
function manualSetTitle() {
  debugLog(`Manual title setting requested`);
  debugLog(`lastJellyfinUrl = "${lastJellyfinUrl}"`);

  let currentUrl = lastJellyfinUrl;

  // If no stored URL, try to get the current file URL from IINA
  if (!currentUrl) {
    try {
      debugLog(`No stored URL, checking core.status`);
      // Try to get the current file path/URL from IINA core
      const currentFile = core.status.url || core.status.path;
      debugLog(`core.status.url = "${core.status.url}"`);
      debugLog(`core.status.path = "${core.status.path}"`);
      debugLog(`currentFile = "${currentFile}"`);

      if (currentFile && isJellyfinUrl(currentFile)) {
        currentUrl = currentFile;
        debugLog(`Using current file URL: ${currentUrl}`);
      } else {
        debugLog(`Current file is not a Jellyfin URL or is empty`);
      }
    } catch (error) {
      debugLog(`Error getting current file URL: ${error.message}`);
    }
  }

  if (!currentUrl) {
    debugLog('No Jellyfin URL found - checking for Jellyfin URL in current file');
    core.osd('No Jellyfin media detected. Please open a Jellyfin URL first.');
    return;
  }

  debugLog(`Attempting to set title for: ${currentUrl}`);

  if (!isJellyfinUrl(currentUrl)) {
    debugLog(`URL is not a Jellyfin URL: ${currentUrl}`);
    core.osd('Current media is not from Jellyfin');
    return;
  }

  const jellyfinInfo = parseJellyfinUrl(currentUrl);
  if (!jellyfinInfo) {
    debugLog(`Failed to parse Jellyfin URL: ${currentUrl}`);
    core.osd('Failed to parse Jellyfin URL - check console for details');
    return;
  }

  // Store the URL for future use
  lastJellyfinUrl = currentUrl;
  lastItemId = jellyfinInfo.itemId;

  debugLog(`Setting title for item: ${jellyfinInfo.itemId}`);
  core.osd('Fetching title...');
  setVideoTitleFromMetadata(jellyfinInfo.serverBase, jellyfinInfo.itemId, jellyfinInfo.apiKey);
}

/**
 * Show Jellyfin Browser - handles the case when no window is available
 */
function showJellyfinBrowser() {
  try {
    debugLog('Attempting to show Jellyfin browser');

    // Try to show sidebar directly first
    if (sidebar && sidebar.show) {
      sidebar.show();
      debugLog('Sidebar shown successfully');
      return;
    }
  } catch (error) {
    debugLog(`Direct sidebar.show() failed: ${error.message}`);

    // Check if we have stored session data that could be useful
    const sessionData = getStoredJellyfinSession();

    // Always open in standalone window when sidebar isn't available
    debugLog('Opening Jellyfin browser in standalone window');
    openJellyfinStandaloneWindow(sessionData);
  }
}

/**
 * Open Jellyfin browser in a standalone window
 */
function openJellyfinStandaloneWindow(sessionData) {
  try {
    debugLog('Creating standalone Jellyfin browser window');

    // Load the same sidebar HTML in standalone window
    standaloneWindow.loadFile('src/ui/sidebar/index.html');

    // Set window properties
    standaloneWindow.setFrame({ x: 100, y: 100, width: 400, height: 600 });
    standaloneWindow.setProperty('title', 'Jellyfin Browser');
    standaloneWindow.setProperty('resizable', true);
    standaloneWindow.setProperty('minimizable', true);

    // Set up message handlers for standalone window
    standaloneWindow.onMessage('get-session', () => {
      standaloneWindow.postMessage('session-data', sessionData);
    });

    standaloneWindow.onMessage('play-media', (data) => {
      handlePlayMedia(data);
      // Close standalone window after starting playback
      standaloneWindow.close();
    });

    standaloneWindow.onMessage('clear-session', () => {
      clearJellyfinSession();
    });

    standaloneWindow.onMessage('store-session', (data) => {
      if (data && data.serverUrl && data.accessToken) {
        storeJellyfinSession(data.serverUrl, data.accessToken);
      }
    });

    // Open the window
    standaloneWindow.open();

    // Send session data after a brief delay
    setTimeout(() => {
      standaloneWindow.postMessage('session-available', sessionData);
    }, 1000);

    debugLog('Standalone Jellyfin browser window opened successfully');
    if (sessionData) {
      core.osd(
        `Jellyfin Browser opened in standalone window\nServer: ${sessionData.serverUrl.replace(/^https?:\/\//, '')}`
      );
    } else {
      core.osd('Jellyfin Browser opened in standalone window\nPlease login to access your media');
    }
  } catch (error) {
    debugLog(`Failed to create standalone window: ${error.message}`);
  }
}

// Menu items
menu.addItem(menu.item('Download Jellyfin Subtitles', manualDownloadSubtitles));
menu.addItem(menu.item('Set Jellyfin Title', manualSetTitle));
menu.addItem(
  menu.item(
    'Show Jellyfin Browser',
    () => {
      showJellyfinBrowser();
    },
    { keyBinding: 'Cmd+Shift+J' }
  )
);

/**
 * Open media in a new IINA instance
 */
function openInNewInstance(streamUrl, title) {
  if (typeof global !== 'undefined' && global.postMessage) {
    debugLog('Requesting new player instance from global entry');

    // Listen for response from global entry
    const messageHandler = (name, data) => {
      if (name === 'player-created') {
        debugLog('New player instance created: ' + JSON.stringify(data));
        core.osd(`Opened in new window: ${data.title}`);
      } else if (name === 'player-creation-failed') {
        debugLog('Failed to create new player instance: ' + data.error);
        core.osd('Failed to open new window - opening in current window');
        // Fallback to current window
        core.open(streamUrl);
      }
    };

    // Set up temporary listener (IINA doesn't have off() so we use this pattern)
    const originalHandler = global.onMessage;
    global.onMessage = (name, callback) => {
      if (name === 'player-created' || name === 'player-creation-failed') {
        return messageHandler(name, callback);
      }
      return originalHandler?.call(global, name, callback);
    };

    // Request new instance creation
    global.postMessage('create-player', { url: streamUrl, title: title });

    // Clean up listener after 5 seconds
    setTimeout(() => {
      global.onMessage = originalHandler;
    }, 5000);
  } else {
    debugLog('Global entry not available, opening in current window');
    core.open(streamUrl);
  }
}

/**
 * Handle media playback requests from sidebar
 */
function handlePlayMedia(message) {
  debugLog('HANDLE PLAY MEDIA CALLED');
  debugLog('handlePlayMedia called with message: ' + JSON.stringify(message));
  const { streamUrl, title } = message;
  debugLog(`Opening media: ${title} - ${streamUrl}`);

  try {
    const openInNewWindow = preferences.get('open_in_new_window');
    debugLog('open_in_new_window preference: ' + openInNewWindow);

    if (openInNewWindow) {
      debugLog('Opening media in new instance: ' + streamUrl);
      core.osd(`Opening in new window: ${title}`);
      openInNewInstance(streamUrl, title);
    } else {
      debugLog('Opening media in current window: ' + streamUrl);
      core.osd(`Opening: ${title}`);
      core.open(streamUrl);
    }

    debugLog('Successfully initiated media opening: ' + streamUrl);
  } catch (error) {
    debugLog('Error opening media: ' + error);
    core.osd('Failed to open media');

    // Fallback: copy to clipboard as backup
    try {
      if (typeof core !== 'undefined' && core.setClipboard) {
        core.setClipboard(streamUrl);
        core.osd('Error opening - URL copied to clipboard');
      } else if (typeof utils !== 'undefined' && utils.setClipboard) {
        utils.setClipboard(streamUrl);
        core.osd('Error opening - URL copied to clipboard');
      } else {
        core.osd('Failed to open - check console for URL');
      }
    } catch (clipboardError) {
      debugLog('Both open and clipboard failed: ' + clipboardError);
      core.osd('Failed to open media - check console');
    }
  }
}

// Event handlers
event.on('iina.file-loaded', onFileLoaded);

// Initialize sidebar when window is loaded
event.on('iina.window-loaded', () => {
  sidebar.loadFile('src/ui/sidebar/index.html');

  // Set up message handler for sidebar playback requests
  sidebar.onMessage('play-media', handlePlayMedia);

  // Handle session requests from sidebar
  sidebar.onMessage('get-session', () => {
    const sessionData = getStoredJellyfinSession();
    sidebar.postMessage('session-data', sessionData);
  });

  // Handle session clear requests from sidebar
  sidebar.onMessage('clear-session', () => {
    clearJellyfinSession();
  });

  // Handle session storage requests from sidebar (manual login)
  sidebar.onMessage('store-session', (data) => {
    if (data && data.serverUrl && data.accessToken) {
      storeJellyfinSession(data.serverUrl, data.accessToken);
    }
  });

  // Handle external URL opening requests from sidebar
  sidebar.onMessage('open-external-url', (data) => {
    if (data && data.url) {
      debugLog(`Opening external URL: ${data.url}`);
      try {
        // Use IINA's utils.open to open in default browser
        const success = utils.open(data.url);
        if (success) {
          debugLog('Successfully opened URL in browser');
          if (data.title) {
            core.osd(`Opened ${data.title} in browser`);
          } else {
            core.osd('Opened Jellyfin page in browser');
          }
        } else {
          throw new Error('utils.open returned false');
        }
      } catch (error) {
        debugLog(`Failed to open external URL: ${error.message}`);

        // Show error message
        core.osd('Failed to open Jellyfin page in browser');
        debugLog(`URL that failed to open: ${data.url}`);
      }
    } else {
      debugLog('Invalid open-external-url message - missing URL');
    }
  });

  // Also expose a global method for sidebar communication
  global.playMedia = (streamUrl, title) => {
    debugLog('Global playMedia called with:', streamUrl, title);
    handlePlayMedia({ streamUrl, title });
  };

  // Send initial session data to sidebar after a brief delay
  setTimeout(() => {
    const sessionData = getStoredJellyfinSession();
    if (sessionData) {
      sidebar.postMessage('session-available', sessionData);
    }
  }, 500);
});
