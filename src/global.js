/**
 * IINA Jellyfin Plugin - Global Entry
 * Handles creating new player instances for separate windows
 */

const { global, console, preferences } = iina;

/**
 * Debug logging helper function
 * Only logs if debug logging is enabled in preferences
 */
function debugLog(message) {
  if (preferences?.get?.('debug_logging')) {
    console.log(`DEBUG: ${message}`);
  }
}

debugLog('Jellyfin Plugin Global Entry loaded');

// Listen for messages from main entries to create new instances
global.onMessage('create-player', (data, player) => {
  debugLog('Global entry received create-player message: ' + JSON.stringify(data));

  try {
    const { url, title } = data;

    // Create a new player instance with the media URL
    const playerId = global.createPlayerInstance({
      url: url,
      label: `jellyfin-${Date.now()}`, // Unique label
      enablePlugins: false, // Disable other plugins for cleaner experience
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
        url: data.url,
      });
    }
  }
});

debugLog('Global entry message listeners registered');
