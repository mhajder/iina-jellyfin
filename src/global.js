/**
 * IINA Jellyfin Plugin - Global Entry
 * Handles creating new player instances for separate windows
 */

const { createDebugLogger } = require('./lib/debug-log.js');

const { global, console, preferences } = iina;

const debugLog = createDebugLogger(preferences, console);

debugLog('Jellyfin Plugin Global Entry loaded');

// Listen for messages from main entries to create new instances
global.onMessage('create-player', (data, player) => {
  debugLog('Global entry received create-player message', {
    hasData: !!data,
    url: data?.url,
    title: data?.title,
  });

  try {
    const { url, title } = data;

    // Create a new player instance with the media URL
    const playerId = global.createPlayerInstance({
      url: url,
      label: `jellyfin-${Date.now()}`, // Unique label
      // With false, IINA loads only this plugin in the new window, so the
      // viewer's other plugins (subtitle search, user scripts...) would be
      // missing from every Jellyfin video opened in a new window.
      enablePlugins: true,
      disableWindowAnimation: false, // Keep animations for better UX
    });

    debugLog(`Created new player instance ${playerId} for: ${title}`);

    // Send confirmation back to the requesting player
    if (player) {
      global.postMessage(player, 'player-created', {
        playerId: playerId,
        title: title,
        url: url,
      });
    }
  } catch (error) {
    debugLog('Error creating player instance: ' + error);

    // Send error back to requesting player
    if (player) {
      global.postMessage(player, 'player-creation-failed', {
        error: error.toString(),
        url: data?.url,
        // The requester falls back to its own window and needs the title.
        title: data?.title,
      });
    }
  }
});

debugLog('Global entry message listeners registered');
