'use strict';

function createDebugLogger(preferences, loggerConsole) {
  return function debugLog(message) {
    if (preferences?.get?.('debug_logging')) {
      loggerConsole.log(`DEBUG: ${message}`);
    }
  };
}

module.exports = {
  createDebugLogger,
};
