/**
 * IINA Jellyfin Plugin
 */

const { createDebugLogger } = require('./lib/debug-log.js');
const { createJellyfinApi } = require('./lib/jellyfin-api.js');
const { createServerSessionStore } = require('./lib/server-session-store.js');
const { createPlaybackTrackingManager } = require('./lib/playback-tracking.js');
const { createAutoplayManager } = require('./lib/autoplay-manager.js');
const { createMediaActionsManager } = require('./lib/media-actions.js');

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
} = iina;

// Guard to prevent spurious stop reports during a file switch. Stored as a
// timestamp and expired after REPLACEMENT_GUARD_MS: if the expected end-file
// never arrives (e.g. core.open failed), a stale guard must not swallow the
// stop report of the next file that really does finish.
let replacingPlaybackAt = 0;
const REPLACEMENT_GUARD_MS = 10000;

function markReplacingPlayback() {
  replacingPlaybackAt = Date.now();
}

function consumeReplacementGuard() {
  if (!replacingPlaybackAt) {
    return false;
  }

  const age = Date.now() - replacingPlaybackAt;
  replacingPlaybackAt = 0;

  if (age > REPLACEMENT_GUARD_MS) {
    debugLog(`Ignoring replacement guard set ${age}ms ago (expired)`);
    return false;
  }

  return true;
}

const debugLog = createDebugLogger(preferences, console);

const {
  getClientIdentity,
  buildJellyfinHeaders,
  parseJellyfinUrl,
  isJellyfinUrl,
  fetchPlaybackInfo,
  fetchItemMetadata,
  secondsToTicks,
  ticksToSeconds,
} = createJellyfinApi({
  http,
  preferences,
  log: debugLog,
});

const {
  loadStoredServers,
  getActiveServerId,
  setActiveServerId,
  addOrUpdateServer,
  removeServer,
  switchActiveServer,
  storeJellyfinSession,
  clearJellyfinSession,
  getStoredJellyfinSession,
} = createServerSessionStore({
  preferences,
  sidebar,
  standaloneWindow,
  log: debugLog,
});

debugLog('Jellyfin Subtitles Plugin loaded');

const {
  startPlaybackTracking,
  stopPlaybackTracking,
  handlePauseChange,
  getCurrentPlaybackSession,
} = createPlaybackTrackingManager({
  core,
  http,
  preferences,
  buildJellyfinHeaders,
  fetchPlaybackInfo,
  fetchItemMetadata,
  secondsToTicks,
  ticksToSeconds,
  log: debugLog,
});

const { setupAutoplayForEpisode, resetForNewFile, clearQueuedFlag, isQueued } =
  createAutoplayManager({
    http,
    mpv,
    core,
    preferences,
    buildJellyfinHeaders,
    fetchItemMetadata,
    log: debugLog,
  });

const {
  setVideoTitleFromMetadata,
  downloadAllSubtitles,
  manualDownloadSubtitles,
  manualSetTitle,
  updateFromFileUrl,
} = createMediaActionsManager({
  core,
  http,
  utils,
  preferences,
  mpv,
  parseJellyfinUrl,
  isJellyfinUrl,
  fetchPlaybackInfo,
  fetchItemMetadata,
  log: debugLog,
});

/**
 * Compare two Jellyfin base URLs by host and port, ignoring the scheme and any
 * trailing slash, so http/https of the same server still count as one server.
 */
function isSameJellyfinHost(left, right) {
  const hostOf = (url) =>
    String(url || '')
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '')
      .toLowerCase();

  const leftHost = hostOf(left);
  return leftHost.length > 0 && leftHost === hostOf(right);
}

/**
 * Handle file loaded event
 */
function onFileLoaded(fileUrl) {
  debugLog(`File loaded: ${fileUrl}`);

  // The first item of a queued list is playing now, so the rest can be added
  flushPendingPlaylistQueue(fileUrl);

  // Stop any existing playback tracking from previous file
  stopPlaybackTracking();

  const jellyfinInfo = updateFromFileUrl(fileUrl);
  if (jellyfinInfo) {
    // Decide which credentials playback reporting (progress/resume/watched)
    // should use. By default it's the api_key embedded in the playing URL, so
    // it records into whoever owns that key. When "use_connected_account" is on
    // and a server is logged in via the Jellyfin browser sidebar, report to
    // that account instead — the item id still comes from the URL, only the
    // server + token change. This lets several people open the SAME shared link
    // (e.g. over Syncplay) while each records progress into their own account.
    let reportServerBase = jellyfinInfo.serverBase;
    let reportApiKey = jellyfinInfo.apiKey;
    if (preferences.get('use_connected_account')) {
      const session = getStoredJellyfinSession();
      if (session && session.accessToken) {
        // Only the credentials may change, never the item id — reporting a
        // URL's item to a different server would 404 on every request.
        if (isSameJellyfinHost(session.serverUrl, jellyfinInfo.serverBase)) {
          reportServerBase = session.serverUrl;
          reportApiKey = session.accessToken;
          debugLog(
            `Connected-account mode: reporting as ${session.username || session.serverName} @ ${reportServerBase} (ignoring URL api_key)`
          );
        } else {
          debugLog(
            `Connected-account mode ON but the logged-in server (${session.serverUrl}) is not the one in the URL (${jellyfinInfo.serverBase}); using URL api_key`
          );
        }
      } else {
        debugLog('Connected-account mode ON but no logged-in server; falling back to URL api_key');
      }
    } else if (preferences.get('auto_login_enabled')) {
      // Default behaviour: remember this URL's session for auto-login.
      storeJellyfinSession(jellyfinInfo.serverBase, jellyfinInfo.apiKey);
    } else {
      debugLog('Auto-login from Jellyfin URLs disabled, not storing the URL credentials');
    }

    // Start playback tracking for progress sync
    if (preferences.get('sync_playback_progress')) {
      debugLog(`Starting playback tracking for: ${jellyfinInfo.itemId}`);
      startPlaybackTracking(reportServerBase, jellyfinInfo.itemId, reportApiKey);
    }

    // Set video title from metadata if enabled
    if (preferences.get('set_video_title')) {
      debugLog(`Setting video title from metadata for: ${jellyfinInfo.itemId}`);
      setVideoTitleFromMetadata(jellyfinInfo.serverBase, jellyfinInfo.itemId, jellyfinInfo.apiKey);
    }

    // Setup autoplay for TV episodes if enabled
    if (preferences.get('autoplay_next_episode')) {
      debugLog(`Setting up autoplay for episode (itemId): ${jellyfinInfo.itemId}`);
      resetForNewFile(jellyfinInfo.itemId);
      setupAutoplayForEpisode(jellyfinInfo.serverBase, jellyfinInfo.itemId, jellyfinInfo.apiKey);
    }

    // Only auto-download if enabled
    if (preferences.get('auto_download_enabled')) {
      debugLog(`Auto-downloading subtitles for: ${jellyfinInfo.itemId}`);
      downloadAllSubtitles(jellyfinInfo.serverBase, jellyfinInfo.itemId, jellyfinInfo.apiKey);
    } else {
      debugLog('Auto download disabled, but Jellyfin URL stored for manual download');
    }
  }
}

/**
 * Show Jellyfin Browser - handles the case when no window is available
 */
function showJellyfinBrowser() {
  debugLog('Attempting to show Jellyfin browser');

  // The sidebar lives inside the player window, so it is only useful while that
  // window is on screen. sidebar.show() cannot be used to detect that: it only
  // throws while the window has never been loaded, and IINA keeps window.loaded
  // true after the window is closed. Showing it then succeeds silently on an
  // invisible window and the browser appears to do nothing until IINA restarts.
  let windowAvailable = false;
  try {
    windowAvailable = Boolean(core.window && core.window.loaded && core.window.visible);
  } catch (error) {
    debugLog(`Could not read window state: ${error.message}`);
  }

  if (windowAvailable && sidebar && typeof sidebar.show === 'function') {
    try {
      sidebar.show();
      debugLog('Sidebar shown successfully');
      return;
    } catch (error) {
      debugLog(`Direct sidebar.show() failed: ${error.message}`);
    }
  } else {
    debugLog(`No visible player window (windowAvailable=${windowAvailable}), using standalone`);
  }

  // Sidebar missing or threw — fall back to a standalone window.
  // Check if we have stored session data that could be useful.
  const sessionData = getStoredJellyfinSession();

  debugLog('Opening Jellyfin browser in standalone window');
  openJellyfinStandaloneWindow(sessionData);
}

/**
 * Open Jellyfin browser in a standalone window
 */
function openJellyfinStandaloneWindow(sessionData) {
  try {
    debugLog('Creating standalone Jellyfin browser window');

    // Load the same sidebar HTML in standalone window
    standaloneWindow.loadFile('src/ui/sidebar/index.html');

    // Set window properties. setFrame takes four numbers (width, height, x, y)
    // and setProperty a single object; anything else is silently ignored.
    standaloneWindow.setFrame(400, 600, 100, 100);
    standaloneWindow.setProperty({ title: 'Jellyfin Browser', resizable: true });

    // Set up message handlers for standalone window.
    // These must be registered after every loadFile() call and cannot be
    // hoisted out of this function: standaloneWindow.loadFile() clears the
    // window's message listeners (JavascriptAPIStandaloneWindow.loadFile ->
    // messageHub.clearListeners), which would leave the webview unable to
    // reach the plugin at all. Re-registering is safe because the message hub
    // keys listeners by name and replaces the previous callback.
    standaloneWindow.onMessage('get-client-identity', () => {
      standaloneWindow.postMessage('client-identity', getClientIdentity());
    });

    standaloneWindow.onMessage('get-session', () => {
      standaloneWindow.postMessage('session-data', getStoredJellyfinSession());
    });

    standaloneWindow.onMessage('play-media', (data) => {
      handlePlayMedia(data);
      // Close standalone window after starting playback
      standaloneWindow.close();
    });

    standaloneWindow.onMessage('play-media-list', (data) => {
      handlePlayMediaList(data);
      standaloneWindow.close();
    });

    standaloneWindow.onMessage('clear-session', () => {
      clearJellyfinSession();
    });

    standaloneWindow.onMessage('store-session', (data) => {
      if (data && data.serverUrl && data.accessToken) {
        const server = addOrUpdateServer({
          serverUrl: data.serverUrl,
          accessToken: data.accessToken,
          serverName: data.serverName || '',
          userId: data.userId || '',
          username: data.username || '',
        });
        if (server) {
          setActiveServerId(server.id);
          standaloneWindow.postMessage('servers-updated', {
            servers: loadStoredServers(),
            activeServerId: server.id,
          });
        }
      }
    });

    // Multi-server management messages
    standaloneWindow.onMessage('get-servers', () => {
      const servers = loadStoredServers();
      const activeServerId = getActiveServerId();
      standaloneWindow.postMessage('servers-list', { servers, activeServerId });
    });

    standaloneWindow.onMessage('remove-server', (data) => {
      if (data && data.serverId) {
        // The store notifies both webviews itself
        removeServer(data.serverId);
      }
    });

    standaloneWindow.onMessage('switch-server', (data) => {
      if (data && data.serverId) {
        switchActiveServer(data.serverId);
      }
    });

    standaloneWindow.onMessage('open-external-url', (data) => {
      if (data && data.url) {
        debugLog(`Opening external URL from standalone: ${data.url}`);
        try {
          utils.open(data.url);
        } catch (error) {
          debugLog(`Failed to open external URL: ${error.message}`);
        }
      }
    });

    // Open the window
    standaloneWindow.open();

    // Send session data after a brief delay
    setTimeout(() => {
      standaloneWindow.postMessage('client-identity', getClientIdentity());
      // Send multi-server list (sidebar will auto-connect to active server)
      const servers = loadStoredServers();
      const activeServerId = getActiveServerId();
      standaloneWindow.postMessage('servers-list', { servers, activeServerId });
      // Also send legacy session for backward compatibility
      if (sessionData) {
        standaloneWindow.postMessage('session-available', sessionData);
      }
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
    // mpv key binding format: Command is "Meta". Unknown modifier names are
    // dropped silently, so "Cmd+Shift+J" would bind plain Shift+J and steal
    // IINA's own "cycle subtitles backward" shortcut.
    { keyBinding: 'Meta+Shift+j' }
  )
);

// Replies from the global entry are registered once at load. IINA has no off(),
// and the reply can arrive at any time, so a per-request listener isn't possible.
if (typeof global !== 'undefined' && global.onMessage) {
  global.onMessage('player-created', (data) => {
    debugLog('New player instance created', {
      playerId: data?.playerId,
      title: data?.title,
      url: data?.url,
    });
    if (data?.title) {
      core.osd(`Opened in new window: ${data.title}`);
    }
  });

  global.onMessage('player-creation-failed', (data) => {
    debugLog('Failed to create new player instance: ' + data?.error);
    core.osd('Failed to open new window - opening in current window');
    // Fallback to current window
    if (data?.url) {
      core.open(data.url);
    }
  });
}

/**
 * Open media in a new IINA instance
 */
function openInNewInstance(streamUrl, title) {
  if (typeof global !== 'undefined' && global.postMessage) {
    debugLog('Requesting new player instance from global entry');
    global.postMessage('create-player', { url: streamUrl, title: title });
  } else {
    debugLog('Global entry not available, opening in current window');
    core.open(streamUrl);
  }
}

/**
 * Open media in the current window, replacing what is playing
 */
function openInCurrentWindow(streamUrl, title) {
  debugLog('Opening media in current window: ' + streamUrl);

  // Set replacement guard so end-file handler doesn't send spurious stop
  if (getCurrentPlaybackSession()) {
    markReplacingPlayback();
  }

  // Clear any previous playlist entries to prevent stale titles. IINA's
  // playlist API has no clear(), so use mpv's own command — it drops every
  // entry except the one currently playing, which core.open replaces below.
  try {
    mpv.command('playlist-clear', []);
    // Reset autoplay state when starting new playback
    clearQueuedFlag();
  } catch (clearError) {
    debugLog(`Could not clear playlist before opening: ${clearError.message}`);
  }

  // We use core.open instead of mpv.command('loadfile') because core.open
  // properly triggers IINA's native lifecycle and sleep prevention checks.
  // Set force-media-title BEFORE core.open so mpv uses it when loadfile runs.
  if (title) {
    mpv.set('force-media-title', title);
  }
  core.open(streamUrl);
}

// Items waiting to join the playlist behind the one currently being opened.
let pendingPlaylistQueue = null;
const PENDING_QUEUE_TTL_MS = 60000;

/**
 * Append the items held back by handlePlayMediaList. Called once the first item
 * of the list has actually loaded, so mpv's replacing load cannot discard them.
 */
function flushPendingPlaylistQueue(fileUrl) {
  if (!pendingPlaylistQueue) {
    return;
  }

  const { items, at, itemId } = pendingPlaylistQueue;
  pendingPlaylistQueue = null;

  if (Date.now() - at > PENDING_QUEUE_TTL_MS) {
    debugLog('Queued playlist items are stale, not appending them');
    return;
  }

  // Make sure this is the file the list started with. IINA percent-encodes the
  // URL, so compare on the item id rather than the whole string.
  if (itemId && fileUrl && !String(fileUrl).includes(itemId)) {
    debugLog(`Loaded file is not the queued list's first item (${itemId}), dropping the queue`);
    return;
  }

  try {
    // loadfile carries per-file options, so each queued entry keeps its own
    // title instead of showing a raw URL in the playlist.
    for (const item of items) {
      const args = [item.streamUrl, 'append'];
      if (item.title) {
        args.push('-1', `force-media-title=${item.title}`);
      }
      mpv.command('loadfile', args);
    }
    debugLog(`Appended ${items.length} queued item(s) to the playlist`);
  } catch (error) {
    debugLog('Could not append queued items: ' + error);
  }
}

/**
 * Handle a request to play several items in order (e.g. a whole album).
 * A playlist only exists within one window, so this always plays in the
 * current window regardless of the open_in_new_window preference.
 */
function handlePlayMediaList(message) {
  const items = (message?.items || []).filter((item) => item && item.streamUrl);
  debugLog(`handlePlayMediaList called with ${items.length} playable item(s)`);

  if (items.length === 0) {
    debugLog('No playable items in list');
    core.osd('Nothing to play');
    return;
  }

  const [firstItem, ...queuedItems] = items;

  try {
    if (queuedItems.length > 0) {
      core.osd(`Playing ${items.length} tracks, starting with: ${firstItem.title}`);
    } else {
      core.osd(`Opening: ${firstItem.title}`);
    }

    // The rest can only be appended once the first item has loaded. core.open()
    // defers its mpv loadfile for network URLs while something is still
    // playing (PlayerCore.open: it stores pendingUrl and closes the window
    // first), and that load replaces the playlist — appending now would be
    // wiped out a moment later.
    // Playback URLs are /Videos/{id}/stream or /Audio/{id}/stream; /Items/ is
    // still matched for links produced by earlier versions.
    const firstItemId =
      (String(firstItem.streamUrl).match(/\/(?:Items|Videos|Audio)\/([^/?]+)/) || [])[1] || null;
    pendingPlaylistQueue =
      queuedItems.length > 0 ? { items: queuedItems, at: Date.now(), itemId: firstItemId } : null;

    openInCurrentWindow(firstItem.streamUrl, firstItem.title);

    debugLog(`Holding ${queuedItems.length} item(s) until the first one loads`);
  } catch (error) {
    debugLog('Error playing media list: ' + error);
    core.osd('Failed to play tracks');
  }
}

/**
 * Handle media playback requests from sidebar
 */
function handlePlayMedia(message) {
  debugLog('HANDLE PLAY MEDIA CALLED');
  debugLog('handlePlayMedia called with message', {
    title: message?.title,
    streamUrl: message?.streamUrl,
  });
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
      core.osd(`Opening: ${title}`);
      openInCurrentWindow(streamUrl, title);
    }

    debugLog('Successfully initiated media opening: ' + streamUrl);
  } catch (error) {
    debugLog('Error opening media: ' + error);
    core.osd('Failed to open media');

    // No clipboard API is exposed to plugins, so the URL only goes to the log
    debugLog(`URL that failed to open: ${streamUrl}`);
  }
}

// Event handlers
event.on('iina.file-loaded', onFileLoaded);

// Position is sampled by the playback tracking tick. IINA does not observe
// mpv's time-pos property, so there is no mpv.time-pos.changed event to
// subscribe to — it drives its own time display from a periodic timer.

// Pause/unpause state sync
event.on('mpv.pause.changed', handlePauseChange);

// Handle file ending (includes both natural end and replacement)
event.on('mpv.end-file', () => {
  const queuedForAutoplay = isQueued();
  const isReplacingPlayback = consumeReplacementGuard();
  debugLog(
    'mpv.end-file triggered, isReplacingPlayback=' +
      isReplacingPlayback +
      ', autoplayQueued=' +
      queuedForAutoplay
  );
  if (isReplacingPlayback) {
    // File is being replaced (e.g. episode transition) — don't send stop report
    debugLog('File replacement in progress, skipping stop report');
    return;
  }
  if (queuedForAutoplay) {
    // Next episode is queued via insert-next — mpv will auto-advance
    debugLog('Autoplay queued, mpv will play next episode — skipping stop cleanup');
    // Reset for the next cycle (setupAutoplayForEpisode will re-set these)
    clearQueuedFlag();
    return;
  }
  stopPlaybackTracking();
});

// Reaching the end marks the item watched from the playback tracking tick.
// eof-reached is an mpv property, not an event, so there is no
// mpv.eof-reached event to listen for.

// Stop tracking when window closes
event.on('iina.window-will-close', () => {
  debugLog('Window closing, stopping playback tracking');
  stopPlaybackTracking();
});

// Ensure we report stop on app termination
event.on('iina.application-will-terminate', () => {
  debugLog('Application terminating, stopping playback tracking');
  stopPlaybackTracking();
});

// Initialize sidebar when window is loaded
event.on('iina.window-loaded', () => {
  sidebar.loadFile('src/ui/sidebar/index.html');

  // Set up message handler for sidebar playback requests
  sidebar.onMessage('play-media', handlePlayMedia);
  sidebar.onMessage('play-media-list', handlePlayMediaList);

  // The webview cannot read preferences, so it asks for the shared Jellyfin
  // client identity (device id + version) it must authenticate with.
  sidebar.onMessage('get-client-identity', () => {
    sidebar.postMessage('client-identity', getClientIdentity());
  });

  // Handle session requests from sidebar (backward compatible)
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
      const server = addOrUpdateServer({
        serverUrl: data.serverUrl,
        accessToken: data.accessToken,
        serverName: data.serverName || '',
        userId: data.userId || '',
        username: data.username || '',
      });
      if (server) {
        setActiveServerId(server.id);
        // Send back updated server list
        sidebar.postMessage('servers-updated', {
          servers: loadStoredServers(),
          activeServerId: server.id,
        });
      }
    }
  });

  // Multi-server management messages
  sidebar.onMessage('get-servers', () => {
    const servers = loadStoredServers();
    const activeServerId = getActiveServerId();
    sidebar.postMessage('servers-list', { servers, activeServerId });
  });

  sidebar.onMessage('remove-server', (data) => {
    if (data && data.serverId) {
      removeServer(data.serverId);
    }
  });

  sidebar.onMessage('switch-server', (data) => {
    if (data && data.serverId) {
      switchActiveServer(data.serverId);
    }
  });

  // Handle external URL opening requests from sidebar
  sidebar.onMessage('open-external-url', (data) => {
    if (data && data.url) {
      debugLog(`Opening external URL: ${data.url}`);
      try {
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
        core.osd('Failed to open Jellyfin page in browser');
        debugLog(`URL that failed to open: ${data.url}`);
      }
    } else {
      debugLog('Invalid open-external-url message - missing URL');
    }
  });

  // Send initial server data to sidebar after a brief delay
  setTimeout(() => {
    sidebar.postMessage('client-identity', getClientIdentity());
    const servers = loadStoredServers();
    const activeServerId = getActiveServerId();
    if (servers.length > 0) {
      sidebar.postMessage('servers-list', { servers, activeServerId });
    }
    // Also send backward compatible session-available for auto-login
    const sessionData = getStoredJellyfinSession();
    if (sessionData) {
      sidebar.postMessage('session-available', sessionData);
    }
  }, 500);
});
