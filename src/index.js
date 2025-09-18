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
} = iina;

// Plugin state
let lastJellyfinUrl = null;
let lastItemId = null;

/**
 * Debug logging helper function
 * Only logs if debug logging is enabled in preferences
 */
function debugLog(message) {
  if (preferences.get("debug_logging")) {
    console.log(`DEBUG: ${message}`);
  }
}

debugLog("Jellyfin Subtitles Plugin loaded");

/**
 * Parse Jellyfin URL to extract server info and item ID
 */
function parseJellyfinUrl(url) {
  try {
    debugLog(`Attempting to parse URL: "${url}"`);
    debugLog(`URL type: ${typeof url}`);
    debugLog(`URL length: ${url ? url.length : "undefined"}`);

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
    const urlParts = url.split("?");
    const pathname = urlParts[0].replace(/^https?:\/\/[^\/]+/, "");
    const queryString = urlParts[1] || "";

    debugLog(`Extracted pathname: ${pathname}`);
    debugLog(`Extracted queryString: ${queryString}`);

    // Extract item ID from path
    const pathMatch = pathname.match(/\/Items\/([^\/]+)/);
    debugLog(`Path match result: ${pathMatch ? pathMatch[0] : "no match"}`);

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
      `Extracted - itemId: ${itemId}, apiKey: ${apiKey ? "present" : "missing"}, serverBase: ${serverBase}`,
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
    ((url.includes("/Items/") && url.includes("api_key=")) ||
      url.includes("jellyfin") ||
      url.includes("/Audio/") ||
      url.includes("/Videos/"))
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
        Accept: "application/json",
      },
    });

    debugLog(`Response received`);
    debugLog(`Response type: ${typeof response}`);
    debugLog(`Response keys: ${Object.keys(response)}`);
    debugLog(`Response.data type: ${typeof response.data}`);

    if (!response.data) {
      throw new Error("No data received from Jellyfin API");
    }

    // IINA automatically parses JSON responses, so response.data is already an object
    if (typeof response.data === "object") {
      debugLog(`Response data is already parsed object`);
      debugLog(
        `MediaSources found: ${response.data.MediaSources ? response.data.MediaSources.length : "none"}`,
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
        Accept: "application/json",
      },
    });

    debugLog(`Metadata response received`);
    debugLog(`Metadata response type: ${typeof response}`);
    debugLog(`Metadata response.data type: ${typeof response.data}`);

    if (!response.data) {
      throw new Error("No metadata received from Jellyfin API");
    }

    // IINA automatically parses JSON responses, so response.data is already an object
    if (typeof response.data === "object") {
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
    if (!preferences.get("set_video_title")) {
      debugLog("Video title setting is disabled in preferences");
      return;
    }

    const metadata = await fetchItemMetadata(serverBase, itemId, apiKey);

    if (!metadata || !metadata.Name) {
      debugLog("No title found in metadata");
      return;
    }

    let title = metadata.Name;

    // For TV episodes, construct a more informative title
    if (metadata.Type === "Episode") {
      const seriesName = metadata.SeriesName;
      const seasonNumber = metadata.ParentIndexNumber;
      const episodeNumber = metadata.IndexNumber;

      if (seriesName) {
        let episodeTitle = seriesName;

        // Add season and episode numbers if available
        if (seasonNumber !== undefined && episodeNumber !== undefined) {
          episodeTitle += ` S${seasonNumber.toString().padStart(2, "0")}E${episodeNumber.toString().padStart(2, "0")}`;
        }

        // Add episode name
        episodeTitle += ` - ${metadata.Name}`;
        title = episodeTitle;
      }
    }
    // For movies, just use the name (potentially with year)
    else if (metadata.Type === "Movie") {
      if (metadata.ProductionYear) {
        title = `${metadata.Name} (${metadata.ProductionYear})`;
      }
    }

    debugLog(`Setting video title to: "${title}"`);

    // Try multiple approaches to set the title in IINA
    let titleSet = false;

    // Method 1: Try core.setTitle (if it exists)
    if (typeof core.setTitle === "function") {
      try {
        core.setTitle(title);
        titleSet = true;
        debugLog(`Video title set via core.setTitle: ${title}`);
      } catch (error) {
        debugLog(`core.setTitle failed: ${error.message}`);
      }
    }

    // Method 2: Try mpv property if available
    if (
      !titleSet &&
      typeof mpv !== "undefined" &&
      typeof mpv.set === "function"
    ) {
      try {
        mpv.set("force-media-title", title);
        titleSet = true;
        debugLog(`Video title set via mpv property: ${title}`);
      } catch (error) {
        debugLog(`mpv.set('force-media-title') failed: ${error.message}`);
      }
    }

    // Method 3: Try mpv command if available
    if (
      !titleSet &&
      typeof mpv !== "undefined" &&
      typeof mpv.command === "function"
    ) {
      try {
        mpv.command(["set", "force-media-title", title]);
        titleSet = true;
        debugLog(`Video title set via mpv command: ${title}`);
      } catch (error) {
        debugLog(
          `mpv.command(['set', 'force-media-title']) failed: ${error.message}`,
        );
      }
    }

    if (!titleSet) {
      debugLog(`Could not set title via IINA API, title would be: ${title}`);
      debugLog(
        "Available core methods: " +
          (core ? Object.keys(core).join(", ") : "core undefined"),
      );
      debugLog("Available iina properties: " + Object.keys(iina).join(", "));
    }

    if (preferences.get("show_notifications")) {
      core.osd(`Title: ${title}`);
    }
  } catch (error) {
    debugLog(`Error setting video title: ${error.message}`);
  }
}

/**
 * Download subtitle file from Jellyfin
 */
async function downloadSubtitle(
  serverBase,
  itemId,
  streamIndex,
  apiKey,
  language,
  codec,
) {
  try {
    const subtitleUrl = `${serverBase}/Videos/${itemId}/${streamIndex}/Subtitles.${codec}?api_key=${apiKey}`;
    // Sanitize filename components to prevent path traversal
    const sanitizedItemId = String(itemId).replace(/[^a-zA-Z0-9_-]/g, "_");
    const sanitizedLanguage = String(language).replace(/[^a-zA-Z0-9_-]/g, "_");
    const sanitizedCodec = String(codec).replace(/[^a-zA-Z0-9_-]/g, "_");
    const fileName = `jellyfin_${sanitizedItemId}_${streamIndex}_${sanitizedLanguage}.${sanitizedCodec}`;
    const localPath = `@tmp/${fileName}`;

    debugLog(`Downloading subtitle: ${subtitleUrl}`);

    await http.download(subtitleUrl, localPath);

    // Load the subtitle track in IINA
    const resolvedPath = utils.resolvePath(localPath);
    core.subtitle.loadTrack(resolvedPath);

    debugLog(`Subtitle loaded: ${resolvedPath}`);

    if (preferences.get("show_notifications")) {
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
  codec,
) {
  try {
    // Determine the proper file extension based on codec
    let extension = "srt"; // default
    if (codec === "subrip") extension = "srt";
    else if (codec === "webvtt") extension = "vtt";
    else if (codec === "ass") extension = "ass";
    else if (codec === "ssa") extension = "ssa";
    else if (codec === "vtt") extension = "vtt";
    else if (codec && codec.toLowerCase().includes("srt")) extension = "srt";
    else if (codec && codec.toLowerCase().includes("vtt")) extension = "vtt";

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
      fileName = originalName.replace(/[^a-zA-Z0-9._-]/g, "_");
      debugLog(`Using sanitized filename: ${fileName}`);
    } else {
      // Fallback to generated name with sanitized components
      const sanitizedItemId = String(itemId).replace(/[^a-zA-Z0-9_-]/g, "_");
      const sanitizedLanguage = String(language).replace(
        /[^a-zA-Z0-9_-]/g,
        "_",
      );
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

    if (preferences.get("show_notifications")) {
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
      debugLog("No media sources found");
      return;
    }

    const mediaSource = playbackInfo.MediaSources[0];
    const mediaStreams = mediaSource.MediaStreams || [];

    const subtitleStreams = mediaStreams.filter(
      (stream) => stream.Type === "Subtitle" && stream.IsTextSubtitleStream,
    );

    debugLog(`Found ${subtitleStreams.length} subtitle streams`);

    const preferredLanguages = (
      preferences.get("preferred_languages") || "en,eng"
    )
      .split(",")
      .map((lang) => lang.trim().toLowerCase())
      .filter((lang) => lang.length > 0);
    const downloadAll = preferences.get("download_all_subtitles");

    let downloadedCount = 0;

    for (const stream of subtitleStreams) {
      const language = stream.Language || "unknown";
      const codec = stream.Codec || "srt";

      // Check if we should download this subtitle
      const shouldDownload =
        downloadAll ||
        preferredLanguages.some(
          (prefLang) =>
            language.toLowerCase().includes(prefLang) ||
            prefLang.includes(language.toLowerCase()),
        );

      if (!shouldDownload) {
        debugLog(`Skipping subtitle: ${language} (not in preferred languages)`);
        continue;
      }

      debugLog(
        `Processing subtitle: ${language} (${codec}) - Index: ${stream.Index}, External: ${stream.IsExternal}`,
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
            codec,
          );
        } else {
          // Handle embedded subtitle streams
          await downloadSubtitle(
            serverBase,
            itemId,
            stream.Index,
            apiKey,
            language,
            codec,
          );
        }
        downloadedCount++;
      } catch (error) {
        debugLog(`Failed to download subtitle ${language}: ${error.message}`);
      }
    }

    if (downloadedCount > 0 && preferences.get("show_notifications")) {
      core.osd(`Downloaded ${downloadedCount} subtitle(s)`);
    } else if (downloadedCount === 0) {
      debugLog("No subtitles downloaded");
      if (preferences.get("show_notifications")) {
        core.osd("No matching subtitles found");
      }
    }
  } catch (error) {
    debugLog(`Error downloading subtitles: ${error.message}`);
    if (preferences.get("show_notifications")) {
      core.osd("Failed to download subtitles");
    }
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
      debugLog(
        `Stored Jellyfin media for manual download: ${jellyfinInfo.itemId}`,
      );

      // Set video title from metadata if enabled
      if (preferences.get("set_video_title")) {
        debugLog(
          `Setting video title from metadata for: ${jellyfinInfo.itemId}`,
        );
        setVideoTitleFromMetadata(
          jellyfinInfo.serverBase,
          jellyfinInfo.itemId,
          jellyfinInfo.apiKey,
        );
      }

      // Only auto-download if enabled
      if (preferences.get("auto_download_enabled")) {
        debugLog(`Auto-downloading subtitles for: ${jellyfinInfo.itemId}`);
        downloadAllSubtitles(
          jellyfinInfo.serverBase,
          jellyfinInfo.itemId,
          jellyfinInfo.apiKey,
        );
      } else {
        debugLog(
          "Auto download disabled, but Jellyfin URL stored for manual download",
        );
      }
    } else {
      debugLog("Failed to parse Jellyfin URL");
    }
  } else {
    // Clear stored Jellyfin URL when loading non-Jellyfin content
    debugLog("Non-Jellyfin URL loaded, clearing stored Jellyfin data");
    lastJellyfinUrl = null;
    lastItemId = null;
    debugLog("Not a Jellyfin URL, skipping subtitle download");
  }
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
    debugLog(
      "No Jellyfin URL found - checking for Jellyfin URL in current file",
    );
    core.osd("No Jellyfin media detected. Please open a Jellyfin URL first.");
    return;
  }

  debugLog(`Attempting to download subtitles for: ${currentUrl}`);

  if (!isJellyfinUrl(currentUrl)) {
    debugLog(`URL is not a Jellyfin URL: ${currentUrl}`);
    core.osd("Current media is not from Jellyfin");
    return;
  }

  const jellyfinInfo = parseJellyfinUrl(currentUrl);
  if (!jellyfinInfo) {
    debugLog(`Failed to parse Jellyfin URL: ${currentUrl}`);
    core.osd("Failed to parse Jellyfin URL - check console for details");
    return;
  }

  // Store the URL for future use
  lastJellyfinUrl = currentUrl;
  lastItemId = jellyfinInfo.itemId;

  debugLog(`Downloading subtitles for item: ${jellyfinInfo.itemId}`);
  core.osd("Downloading subtitles...");
  downloadAllSubtitles(
    jellyfinInfo.serverBase,
    jellyfinInfo.itemId,
    jellyfinInfo.apiKey,
  );
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
    debugLog(
      "No Jellyfin URL found - checking for Jellyfin URL in current file",
    );
    core.osd("No Jellyfin media detected. Please open a Jellyfin URL first.");
    return;
  }

  debugLog(`Attempting to set title for: ${currentUrl}`);

  if (!isJellyfinUrl(currentUrl)) {
    debugLog(`URL is not a Jellyfin URL: ${currentUrl}`);
    core.osd("Current media is not from Jellyfin");
    return;
  }

  const jellyfinInfo = parseJellyfinUrl(currentUrl);
  if (!jellyfinInfo) {
    debugLog(`Failed to parse Jellyfin URL: ${currentUrl}`);
    core.osd("Failed to parse Jellyfin URL - check console for details");
    return;
  }

  // Store the URL for future use
  lastJellyfinUrl = currentUrl;
  lastItemId = jellyfinInfo.itemId;

  debugLog(`Setting title for item: ${jellyfinInfo.itemId}`);
  core.osd("Fetching title...");
  setVideoTitleFromMetadata(
    jellyfinInfo.serverBase,
    jellyfinInfo.itemId,
    jellyfinInfo.apiKey,
  );
}

// Menu items
menu.addItem(menu.item("Download Jellyfin Subtitles", manualDownloadSubtitles));
menu.addItem(menu.item("Set Jellyfin Title", manualSetTitle));
menu.addItem(
  menu.item(
    "Show Jellyfin Browser",
    () => {
      sidebar.show();
    },
    { keyBinding: "Cmd+Shift+J" },
  ),
);

/**
 * Open media in a new IINA instance
 */
function openInNewInstance(streamUrl, title) {
  if (typeof global !== "undefined" && global.postMessage) {
    debugLog("Requesting new player instance from global entry");

    // Listen for response from global entry
    const messageHandler = (name, data) => {
      if (name === "player-created") {
        debugLog("New player instance created: " + JSON.stringify(data));
        core.osd(`Opened in new window: ${data.title}`);
      } else if (name === "player-creation-failed") {
        debugLog("Failed to create new player instance: " + data.error);
        core.osd("Failed to open new window - opening in current window");
        // Fallback to current window
        core.open(streamUrl);
      }
    };

    // Set up temporary listener (IINA doesn't have off() so we use this pattern)
    const originalHandler = global.onMessage;
    global.onMessage = (name, callback) => {
      if (name === "player-created" || name === "player-creation-failed") {
        return messageHandler(name, callback);
      }
      return originalHandler?.call(global, name, callback);
    };

    // Request new instance creation
    global.postMessage("create-player", { url: streamUrl, title: title });

    // Clean up listener after 5 seconds
    setTimeout(() => {
      global.onMessage = originalHandler;
    }, 5000);
  } else {
    debugLog("Global entry not available, opening in current window");
    core.open(streamUrl);
  }
}

/**
 * Handle media playback requests from sidebar
 */
function handlePlayMedia(message) {
  debugLog("HANDLE PLAY MEDIA CALLED");
  debugLog("handlePlayMedia called with message: " + JSON.stringify(message));
  const { streamUrl, title } = message;
  debugLog(`Opening media: ${title} - ${streamUrl}`);

  try {
    const openInNewWindow = preferences.get("open_in_new_window");
    debugLog("open_in_new_window preference: " + openInNewWindow);

    if (openInNewWindow) {
      debugLog("Opening media in new instance: " + streamUrl);
      core.osd(`Opening in new window: ${title}`);
      openInNewInstance(streamUrl, title);
    } else {
      debugLog("Opening media in current window: " + streamUrl);
      core.osd(`Opening: ${title}`);
      core.open(streamUrl);
    }

    debugLog("Successfully initiated media opening: " + streamUrl);
  } catch (error) {
    debugLog("Error opening media: " + error);
    core.osd("Failed to open media");

    // Fallback: copy to clipboard as backup
    try {
      if (typeof core !== "undefined" && core.setClipboard) {
        core.setClipboard(streamUrl);
        core.osd("Error opening - URL copied to clipboard");
      } else if (typeof utils !== "undefined" && utils.setClipboard) {
        utils.setClipboard(streamUrl);
        core.osd("Error opening - URL copied to clipboard");
      } else {
        core.osd("Failed to open - check console for URL");
      }
    } catch (clipboardError) {
      debugLog("Both open and clipboard failed: " + clipboardError);
      core.osd("Failed to open media - check console");
    }
  }
}

// Event handlers
event.on("iina.file-loaded", onFileLoaded);

// Initialize sidebar when window is loaded
event.on("iina.window-loaded", () => {
  sidebar.loadFile("src/ui/sidebar/index.html");

  // Set up message handler for sidebar playback requests
  sidebar.onMessage("play-media", handlePlayMedia);

  // Also expose a global method for sidebar communication
  global.playMedia = (streamUrl, title) => {
    debugLog("Global playMedia called with:", streamUrl, title);
    handlePlayMedia({ streamUrl, title });
  };
});
