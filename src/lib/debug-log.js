'use strict';

const MAX_LOG_LENGTH = 600;
const MAX_KEYS = 8;

function truncateText(value, maxLength = MAX_LOG_LENGTH) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}…[truncated ${value.length - maxLength} chars]`;
}

function serializeObject(value) {
  if (!value || typeof value !== 'object') {
    return String(value);
  }

  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }

  if (Array.isArray(value)) {
    return `[Array(${value.length})]`;
  }

  const keys = Object.keys(value);
  const picked = keys.slice(0, MAX_KEYS).reduce((acc, key) => {
    const item = value[key];
    if (
      item === null ||
      item === undefined ||
      typeof item === 'number' ||
      typeof item === 'boolean'
    ) {
      acc[key] = item;
    } else if (typeof item === 'string') {
      acc[key] = truncateText(item, 120);
    } else if (Array.isArray(item)) {
      acc[key] = `[Array(${item.length})]`;
    } else if (typeof item === 'object') {
      acc[key] = '[Object]';
    } else {
      acc[key] = String(item);
    }
    return acc;
  }, {});

  if (keys.length > MAX_KEYS) {
    picked.__extraKeys = keys.length - MAX_KEYS;
  }

  return JSON.stringify(picked);
}

function serializeArg(arg) {
  if (arg === null || arg === undefined) {
    return String(arg);
  }

  if (typeof arg === 'string') {
    return truncateText(arg);
  }

  if (typeof arg === 'number' || typeof arg === 'boolean' || typeof arg === 'bigint') {
    return String(arg);
  }

  return truncateText(serializeObject(arg));
}

function createDebugLogger(preferences, loggerConsole) {
  return function debugLog(...parts) {
    if (preferences?.get?.('debug_logging')) {
      const text = parts.map(serializeArg).join(' | ');
      loggerConsole.log(`DEBUG: ${text}`);
    }
  };
}

module.exports = {
  createDebugLogger,
};
