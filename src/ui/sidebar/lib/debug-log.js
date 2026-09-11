/**
 * Debug logging for the sidebar webview. Only logs when debug logging is
 * enabled in the plugin preferences. Mirrors src/lib/debug-log.js, which the
 * webview cannot require.
 */
window.createSidebarDebugLogger = function createSidebarDebugLogger() {
  const MAX_DEBUG_LOG_LENGTH = 600;
  const MAX_KEYS = 8;

  // Credentials travel in URLs (api_key=...) and in the MediaBrowser
  // Authorization header (Token="..."). Strip them from anything we log.
  const SECRET_QUERY_PARAM = /([?&](?:api_key|apikey|api-key|x-emby-token)=)[^&\s"']+/gi;
  const SECRET_TOKEN_FIELD = /((?:token|accesstoken|api_key)"?\s*[:=]\s*"?)[A-Za-z0-9._-]{8,}/gi;

  function redactSecrets(value) {
    return String(value)
      .replace(SECRET_QUERY_PARAM, '$1[redacted]')
      .replace(SECRET_TOKEN_FIELD, '$1[redacted]');
  }

  function truncateDebugText(value, maxLength = MAX_DEBUG_LOG_LENGTH) {
    if (value.length <= maxLength) {
      return value;
    }

    return `${value.slice(0, maxLength)}…[truncated ${value.length - maxLength} chars]`;
  }

  function serializeDebugArg(arg) {
    if (arg instanceof Error) {
      return `${arg.name}: ${arg.message}`;
    }

    if (Array.isArray(arg)) {
      return `[Array(${arg.length})]`;
    }

    if (arg && typeof arg === 'object') {
      const keys = Object.keys(arg);
      const preview = keys.slice(0, MAX_KEYS).reduce((acc, key) => {
        const value = arg[key];
        if (
          value === null ||
          value === undefined ||
          typeof value === 'number' ||
          typeof value === 'boolean'
        ) {
          acc[key] = value;
        } else if (typeof value === 'string') {
          acc[key] = truncateDebugText(value, 120);
        } else if (Array.isArray(value)) {
          acc[key] = `[Array(${value.length})]`;
        } else if (typeof value === 'object') {
          acc[key] = '[Object]';
        } else {
          acc[key] = String(value);
        }
        return acc;
      }, {});

      if (keys.length > MAX_KEYS) {
        preview.__extraKeys = keys.length - MAX_KEYS;
      }

      return truncateDebugText(JSON.stringify(preview));
    }

    // Primitives (and anything else) stringify directly
    return truncateDebugText(String(arg));
  }

  function debugLog(...parts) {
    if (typeof iina !== 'undefined' && iina?.preferences?.get?.('debug_logging')) {
      console.log(`DEBUG: ${redactSecrets(parts.map(serializeDebugArg).join(' | '))}`);
    }
  }

  debugLog.redactSecrets = redactSecrets;
  debugLog.serializeDebugArg = serializeDebugArg;
  return debugLog;
};
