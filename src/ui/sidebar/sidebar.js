/**
 * Jellyfin Sidebar Interface
 * Handles authentication and media browsing
 */

/**
 * Debug logging helper function
 * Only logs if debug logging is enabled in preferences
 */
const MAX_DEBUG_LOG_LENGTH = 600;

function truncateDebugText(value, maxLength = MAX_DEBUG_LOG_LENGTH) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}…[truncated ${value.length - maxLength} chars]`;
}

function serializeDebugArg(arg) {
  if (arg === null || arg === undefined) {
    return String(arg);
  }

  if (typeof arg === 'string') {
    return truncateDebugText(arg);
  }

  if (typeof arg === 'number' || typeof arg === 'boolean' || typeof arg === 'bigint') {
    return String(arg);
  }

  if (arg instanceof Error) {
    return `${arg.name}: ${arg.message}`;
  }

  if (Array.isArray(arg)) {
    return `[Array(${arg.length})]`;
  }

  if (typeof arg === 'object') {
    const keys = Object.keys(arg);
    const preview = keys.slice(0, 8).reduce((acc, key) => {
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

    if (keys.length > 8) {
      preview.__extraKeys = keys.length - 8;
    }

    return truncateDebugText(JSON.stringify(preview));
  }

  return truncateDebugText(String(arg));
}

function debugLog(...parts) {
  if (iina?.preferences?.get?.('debug_logging')) {
    console.log(`DEBUG: ${parts.map(serializeDebugArg).join(' | ')}`);
  }
}

debugLog('Jellyfin Sidebar loaded');

class JellyfinSidebar {
  constructor() {
    debugLog('JellyfinSidebar constructor called');

    this.currentUser = null;
    this.currentServer = null;
    this.selectedItem = null;
    this.selectedSeason = null;
    this.selectedEpisode = null;
    this.searchTimeout = null;
    this.pendingSessionData = null;

    // Multi-server state
    this.servers = []; // Array of stored server objects
    this.activeServerId = null;
    this.initialAutoConnectDone = false;

    // Quick Connect state
    this.qcSecret = null;
    this.qcPollingInterval = null;
    this.qcServerUrl = null;

    this.init();
  }

  getHttpClient() {
    // Use browser fetch API since sidebar runs in webview context
    return {
      get: (url, options = {}) => this.fetchHttpRequest('GET', url, options),
      post: (url, options = {}) => this.fetchHttpRequest('POST', url, options),
    };
  }

  async fetchHttpRequest(method, url, options = {}) {
    try {
      const fetchOptions = {
        method,
        headers: options.headers || {},
      };

      if (method === 'POST' && options.data) {
        fetchOptions.body = options.data;
      }

      debugLog(`${method} request to: ${url}`);
      const response = await fetch(url, fetchOptions);

      const responseData = await response.text();
      let parsedData;
      try {
        parsedData = JSON.parse(responseData);
      } catch (parseError) {
        debugLog('Failed to parse JSON response:', parseError);
        parsedData = responseData;
      }

      return {
        data: parsedData,
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
      };
    } catch (error) {
      debugLog('HTTP request failed:', error);
      throw {
        message: error.message,
        status: 0,
        statusText: 'Network Error',
      };
    }
  }

  init() {
    this.setupEventListeners();
    this.setupTabNavigation();
    this.setupMessageHandlers();

    // Request session data from main plugin
    this.requestSessionData();

    // Show login form initially (will be hidden if auto-login succeeds)
    this.showLoginForm();
  }

  setupEventListeners() {
    // Connection management
    document.getElementById('connectBtn').addEventListener('click', () => {
      this.showLoginForm();
    });

    document.getElementById('addServerBtn').addEventListener('click', () => {
      this.showLoginForm();
    });

    document.getElementById('logoutBtn').addEventListener('click', () => {
      this.disconnectFromServer();
    });

    // Login form
    document.getElementById('loginBtn').addEventListener('click', () => {
      this.login();
    });

    document.getElementById('cancelLoginBtn').addEventListener('click', () => {
      this.hideLoginForm();
    });

    // Quick Connect
    document.getElementById('qcStartBtn').addEventListener('click', () => {
      this.startQuickConnect();
    });

    document.getElementById('qcCancelBtn').addEventListener('click', () => {
      this.cancelQuickConnect();
      this.hideLoginForm();
    });

    // Login method tabs
    document.querySelectorAll('.login-method-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        this.switchLoginMethod(tab.dataset.method);
      });
    });

    // Search
    document.getElementById('searchInput').addEventListener('input', (e) => {
      this.debounceSearch(e.target.value);
    });

    // Search type filter chips
    document.querySelectorAll('.search-type-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        chip.classList.toggle('active');
        // Re-run search with current input value if there's a term
        const term = document.getElementById('searchInput').value;
        if (term.trim()) {
          this.debounceSearch(term);
        }
      });
    });

    // Filters
    document.getElementById('moviesFilterBtn').addEventListener('click', () => {
      const panel = document.getElementById('moviesFilterPanel');
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    });

    document.getElementById('seriesFilterBtn').addEventListener('click', () => {
      const panel = document.getElementById('seriesFilterPanel');
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    });

    ['moviesSortSelect', 'moviesFilterSelect', 'moviesGenreSelect'].forEach((id) => {
      document.getElementById(id).addEventListener('change', () => this.loadMovies());
    });

    ['seriesSortSelect', 'seriesFilterSelect', 'seriesGenreSelect'].forEach((id) => {
      document.getElementById(id).addEventListener('change', () => this.loadSeries());
    });

    // Episode selection
    document.getElementById('seasonSelect').addEventListener('change', (e) => {
      this.loadEpisodes(e.target.value);
    });

    document.getElementById('playEpisodeBtn').addEventListener('click', () => {
      this.playSelectedEpisode();
    });

    document.getElementById('openEpisodeInJellyfinBtn').addEventListener('click', () => {
      this.openSelectedEpisodeInJellyfin();
    });

    document.getElementById('cancelEpisodeBtn').addEventListener('click', () => {
      this.hideEpisodeSelection();
    });

    // Enter key handling
    document.getElementById('password').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        this.login();
      }
    });
  }

  setupTabNavigation() {
    const tabButtons = document.querySelectorAll('.tab-button');
    const tabContents = document.querySelectorAll('.tab-content');

    tabButtons.forEach((button) => {
      button.addEventListener('click', () => {
        const tabName = button.dataset.tab;

        // Update active button
        tabButtons.forEach((btn) => btn.classList.remove('active'));
        button.classList.add('active');

        // Update active content
        tabContents.forEach((content) => content.classList.remove('active'));
        document.getElementById(tabName + 'Tab').classList.add('active');

        // Load content if needed
        if (tabName === 'home' && this.currentUser) {
          this.loadHomeTab();
        } else if (tabName === 'movies' && this.currentUser) {
          this.loadMovies();
        } else if (tabName === 'series' && this.currentUser) {
          this.loadSeries();
        }
      });
    });
  }

  setupMessageHandlers() {
    if (typeof iina !== 'undefined' && iina.onMessage) {
      // Legacy session messages (backward compatible)
      iina.onMessage('session-available', (data) => {
        debugLog('Received session-available message: ' + JSON.stringify(data));
        this.handleSessionAvailable(data);
      });

      iina.onMessage('session-data', (data) => {
        debugLog('Received session-data message: ' + JSON.stringify(data));
        this.handleSessionData(data);
      });

      iina.onMessage('session-cleared', () => {
        debugLog('Received session-cleared message');
        this.handleSessionCleared();
      });

      // Multi-server messages
      iina.onMessage('servers-list', (data) => {
        debugLog('Received servers-list: ' + JSON.stringify(data));
        this.handleServersList(data);
      });

      iina.onMessage('servers-updated', (data) => {
        debugLog('Received servers-updated: ' + JSON.stringify(data));
        this.handleServersList(data);
      });

      iina.onMessage('server-switched', (data) => {
        debugLog('Received server-switched: ' + JSON.stringify(data));
        if (data && data.server) {
          this.handleServersList(data);
          this.connectToServer(data.server);
        }
      });
    } else {
      debugLog('iina.onMessage not available, session auto-login disabled');
    }
  }

  requestSessionData() {
    debugLog('Requesting server data from main plugin');
    if (typeof iina !== 'undefined' && iina.postMessage) {
      // Request multi-server list first
      iina.postMessage('get-servers');
      // Also request legacy session for backward compatibility
      iina.postMessage('get-session');
    } else {
      debugLog('iina.postMessage not available, cannot request session data');
    }
  }
}

Object.assign(JellyfinSidebar.prototype, window.createSidebarAuthServerMethods(debugLog));
Object.assign(JellyfinSidebar.prototype, window.createSidebarMediaMethods(debugLog));

// Initialize sidebar when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  debugLog('DOM loaded, initializing Jellyfin sidebar');
  window.jellyfinSidebar = new JellyfinSidebar();
  debugLog('Jellyfin sidebar initialized');
});

// Expose for main plugin communication
window.JellyfinSidebar = JellyfinSidebar;

// Also try to initialize immediately if DOM is already loaded
if (document.readyState === 'loading') {
  debugLog('DOM still loading, waiting for DOMContentLoaded');
} else {
  debugLog('DOM already loaded, initializing immediately');
  window.jellyfinSidebar = new JellyfinSidebar();
}
