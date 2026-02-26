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
  playlist,
} = iina;

let isReplacingPlayback = false; // Guard to prevent spurious stop reports during file switch

const debugLog = createDebugLogger(preferences, console);

const {
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
  log: debugLog,
});

debugLog('Jellyfin Subtitles Plugin loaded');

const {
  startPlaybackTracking,
  stopPlaybackTracking,
  handlePlaybackPositionChange,
  handlePauseChange,
  markAsWatched,
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
 * Handle file loaded event
 */
function onFileLoaded(fileUrl) {
  debugLog(`File loaded: ${fileUrl}`);

  // Stop any existing playback tracking from previous file
  stopPlaybackTracking();

  const jellyfinInfo = updateFromFileUrl(fileUrl);
  if (jellyfinInfo) {
    // Store session data for auto-login if enabled
    storeJellyfinSession(jellyfinInfo.serverBase, jellyfinInfo.apiKey);

    // Start playback tracking for progress sync
    if (preferences.get('sync_playback_progress')) {
      debugLog(`Starting playback tracking for: ${jellyfinInfo.itemId}`);
      startPlaybackTracking(jellyfinInfo.serverBase, jellyfinInfo.itemId, jellyfinInfo.apiKey);
    }

    // Set video title from metadata if enabled
    if (preferences.get('set_video_title')) {
      debugLog(`Setting video title from metadata for: ${jellyfinInfo.itemId}`);
      setVideoTitleFromMetadata(jellyfinInfo.serverBase, jellyfinInfo.itemId, jellyfinInfo.apiKey);
    }

    // Setup autoplay for TV episodes if enabled
    if (preferences.get('autoplay_next_episode')) {
      debugLog(`Setting up autoplay for episode (itemId): ${jellyfinInfo.itemId}`);
      resetForNewFile();
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
        removeServer(data.serverId);
        // Also notify standalone window (removeServer only notifies sidebar)
        standaloneWindow.postMessage('servers-updated', {
          servers: loadStoredServers(),
          activeServerId: getActiveServerId(),
        });
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

      // Set replacement guard so end-file handler doesn't send spurious stop
      if (getCurrentPlaybackSession()) {
        isReplacingPlayback = true;
      }

      // Clear any previous playlist entries to prevent stale titles
      try {
        if (playlist && typeof playlist.clear === 'function') {
          playlist.clear();
        }
        // Reset autoplay state when starting new playback
        clearQueuedFlag();
      } catch (clearError) {
        debugLog(`Could not clear playlist before opening: ${clearError.message}`);
      }

      // Use mpv loadfile with force-media-title to set the title atomically
      // This prevents the stale title bug where the old title persists until
      // the async setVideoTitleFromMetadata call completes
      if (title) {
        try {
          mpv.command('loadfile', [streamUrl, 'replace', '-1', `force-media-title=${title}`]);
        } catch (error) {
          debugLog(`mpv loadfile with title failed: ${error.message}, falling back to core.open`);
          isReplacingPlayback = false;
          core.open(streamUrl);
        }
      } else {
        core.open(streamUrl);
      }
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

// Playback tracking events for Jellyfin progress sync
event.on('mpv.time-pos.changed', handlePlaybackPositionChange);

// Pause/unpause state sync
event.on('mpv.pause.changed', handlePauseChange);

// Handle file ending (includes both natural end and replacement)
event.on('mpv.end-file', () => {
  const queuedForAutoplay = isQueued();
  debugLog(
    'mpv.end-file triggered, isReplacingPlayback=' +
      isReplacingPlayback +
      ', autoplayQueued=' +
      queuedForAutoplay
  );
  if (isReplacingPlayback) {
    // File is being replaced (e.g. episode transition) — don't send stop report
    debugLog('File replacement in progress, skipping stop report');
    isReplacingPlayback = false;
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

// Handle EOF reached — mark as watched if near end
event.on('mpv.eof-reached', () => {
  debugLog('End of file reached (eof-reached)');
  const playbackSession = getCurrentPlaybackSession();
  if (playbackSession && playbackSession.itemId) {
    markAsWatched(playbackSession.serverBase, playbackSession.itemId, playbackSession.apiKey);
  }
});

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

  // Also expose a global method for sidebar communication
  global.playMedia = (streamUrl, title) => {
    debugLog('Global playMedia called with:', streamUrl, title);
    handlePlayMedia({ streamUrl, title });
  };

  // Send initial server data to sidebar after a brief delay
  setTimeout(() => {
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
