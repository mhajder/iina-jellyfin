/**
 * Jellyfin Sidebar Interface
 * Handles authentication and media browsing
 */

/**
 * Debug logging helper function
 * Only logs if debug logging is enabled in preferences
 */
function debugLog(message) {
  if (iina?.preferences?.get?.('debug_logging')) {
    console.log(`DEBUG: ${message}`);
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

  // ===== Multi-Server Handling =====

  handleServersList(data) {
    if (!data) return;
    this.servers = data.servers || [];
    this.activeServerId = data.activeServerId || null;
    this.renderServerList();

    // Auto-connect only on initial load, not after explicit disconnect/remove
    if (!this.initialAutoConnectDone && !this.currentServer) {
      const validServers = this.servers.filter((s) => s.userId);
      if (validServers.length > 0) {
        const activeServer =
          validServers.find((s) => s.id === this.activeServerId) || validServers[0];
        this.connectToServer(activeServer);
      }
      this.initialAutoConnectDone = true;
    }
  }

  renderServerList() {
    const listEl = document.getElementById('savedServerList');

    // Filter out legacy entries that have no userId (ghost entries)
    const validServers = this.servers.filter((s) => s.userId);

    if (validServers.length === 0) {
      listEl.style.display = 'none';
      return;
    }

    // Show server list
    listEl.style.display = 'flex';

    // Render saved server items with inline remove button
    listEl.innerHTML = validServers
      .map(
        (s) => `
      <div class="saved-server-item ${s.id === this.activeServerId ? 'active' : ''}" data-server-id="${s.id}">
        <div class="saved-server-dot"></div>
        <div class="saved-server-info">
          <div class="saved-server-name">${this.escapeHtml(s.serverName || s.serverUrl)}</div>
          <div class="saved-server-url">${this.escapeHtml(s.serverUrl)}</div>
          ${s.username ? `<div class="saved-server-user">${this.escapeHtml(s.username)}</div>` : ''}
        </div>
        <button class="server-remove-btn" data-server-id="${s.id}" title="Remove">✕</button>
      </div>
    `
      )
      .join('');

    // Click handler for server items (switch server)
    listEl.querySelectorAll('.saved-server-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        // Don't switch if clicking the remove button
        if (e.target.closest('.server-remove-btn')) return;
        const serverId = item.dataset.serverId;
        this.switchToServer(serverId);
      });
    });

    // Click handler for remove buttons
    listEl.querySelectorAll('.server-remove-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const serverId = btn.dataset.serverId;
        this.removeServerFromStorage(serverId);
      });
    });
  }

  switchToServer(serverId) {
    const server = this.servers.find((s) => s.id === serverId);
    if (!server) return;

    debugLog(`Switching to server: ${server.serverName}`);
    this.activeServerId = serverId;

    // Notify plugin to persist the switch
    if (typeof iina !== 'undefined' && iina.postMessage) {
      iina.postMessage('switch-server', { serverId });
    }

    // Connect to the server
    this.connectToServer(server);
    this.renderServerList();
  }

  async connectToServer(serverData) {
    try {
      debugLog('Connecting to server: ' + serverData.serverUrl);
      this.updateServerStatus('Connecting...', 'connecting');

      // Test the stored token
      const response = await this.getHttpClient().get(`${serverData.serverUrl}/System/Info`, {
        headers: {
          'X-Emby-Token': serverData.accessToken,
        },
      });

      if (response.status === 200 && response.data) {
        const userResponse = await this.getHttpClient().get(`${serverData.serverUrl}/Users/Me`, {
          headers: {
            'X-Emby-Token': serverData.accessToken,
          },
        });

        if (userResponse.status === 200 && userResponse.data) {
          this.currentServer = {
            name: response.data.ServerName || serverData.serverName || serverData.serverUrl,
            url: serverData.serverUrl,
            userId: userResponse.data.Id,
            accessToken: serverData.accessToken,
            serverId: serverData.id,
          };

          this.currentUser = userResponse.data;

          // Update server info in storage with user details
          if (typeof iina !== 'undefined' && iina.postMessage) {
            iina.postMessage('store-session', {
              serverUrl: serverData.serverUrl,
              accessToken: serverData.accessToken,
              serverName: response.data.ServerName || serverData.serverName || '',
              userId: userResponse.data.Id,
              username: userResponse.data.Name,
            });
          }

          debugLog('Connected as: ' + this.currentUser.Name);
          this.hideLoginForm();
          this.showMainContent();
          this.showLogoutButton();
          this.updateServerStatus(
            `Connected to ${this.currentServer.name} as ${this.currentUser.Name}`,
            'connected'
          );
          this.loadHomeTab();
          return;
        }
      }

      // Token invalid — prompt re-login
      debugLog('Token invalid for server, prompting re-login');
      this.updateServerStatus('Session expired - please login again', 'error');
      this.showLoginFormWithServer(serverData.serverUrl);
    } catch (error) {
      debugLog('Connection failed: ' + error.message);
      this.updateServerStatus('Connection failed - check server', 'error');
    }
  }

  showLoginFormWithServer(serverUrl) {
    this.showLoginForm();
    if (serverUrl) {
      document.getElementById('serverUrl').value = serverUrl;
      document.getElementById('qcServerUrl').value = serverUrl;
    }
  }

  removeServerFromStorage(serverId) {
    debugLog(`Removing server: ${serverId}`);

    // Notify plugin to remove
    if (typeof iina !== 'undefined' && iina.postMessage) {
      iina.postMessage('remove-server', { serverId });
    }

    // Update local state
    this.servers = this.servers.filter((s) => s.id !== serverId);
    if (this.activeServerId === serverId) {
      this.activeServerId = this.servers.length > 0 ? this.servers[0].id : null;
    }

    // If removed the currently connected server, disconnect
    if (this.currentServer && this.currentServer.serverId === serverId) {
      this.disconnectFromServer();
    }

    this.renderServerList();
  }

  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  // ===== Legacy Session Handlers (backward compatible) =====

  handleSessionAvailable(sessionData) {
    if (!sessionData || !sessionData.serverUrl || !sessionData.accessToken) {
      debugLog('Invalid session data received');
      return;
    }

    // If we already have servers loaded, don't duplicate auto-login
    if (this.servers.length > 0) {
      debugLog('Servers already loaded, skipping legacy session-available');
      return;
    }

    debugLog('Attempting auto-login with legacy session data');
    this.connectToServer(sessionData);
  }

  handleSessionData(sessionData) {
    if (!sessionData) {
      debugLog('No stored session data available');
      return;
    }

    // If we already have servers loaded, don't duplicate
    if (this.servers.length > 0) return;

    debugLog('Retrieved stored session data, attempting auto-login');
    this.connectToServer(sessionData);
  }

  handleSessionCleared() {
    debugLog('Session cleared');
    this.servers = [];
    this.activeServerId = null;
    this.renderServerList();
    if (this.currentServer) {
      this.disconnectFromServer();
    }
  }

  storeSessionData(serverUrl, accessToken, serverName, userId, username) {
    debugLog('Requesting session storage from main plugin');
    if (typeof iina !== 'undefined' && iina.postMessage) {
      iina.postMessage('store-session', {
        serverUrl: serverUrl,
        accessToken: accessToken,
        serverName: serverName || '',
        userId: userId || '',
        username: username || '',
      });
    }
  }

  // Disconnect from current server without removing it
  disconnectFromServer() {
    debugLog('Disconnecting from current server');
    this.currentUser = null;
    this.currentServer = null;
    this.activeServerId = null;
    this.updateServerStatus('Not connected', '');
    this.hideMainContent();
    this.showConnectButton();
    this.renderServerList();
    this.clearLoginForm();
  }

  // Simple logout functionality - clears everything
  logout() {
    debugLog('Logging out user');
    this.currentUser = null;
    this.currentServer = null;
    this.updateServerStatus('Not connected');
    this.hideMainContent();
    this.showConnectButton();
    this.clearLoginForm();
  }

  updateServerStatus(message, status = '') {
    const statusEl = document.getElementById('serverStatus');
    statusEl.textContent = message;
    statusEl.className = `server-status ${status}`;
  }

  showConnectButton() {
    document.getElementById('connectBtn').style.display = 'block';
    document.getElementById('addServerBtn').style.display = 'none';
    document.getElementById('logoutBtn').style.display = 'none';
  }

  showLogoutButton() {
    document.getElementById('connectBtn').style.display = 'none';
    document.getElementById('addServerBtn').style.display = 'block';
    document.getElementById('logoutBtn').style.display = 'block';
  }

  // Authentication
  showLoginForm() {
    document.getElementById('loginSection').style.display = 'block';
    // Reset to password tab
    this.switchLoginMethod('password');
    this.scrollToTop();
  }

  hideLoginForm() {
    document.getElementById('loginSection').style.display = 'none';
    this.cancelQuickConnect();
    this.clearLoginForm();
  }

  clearLoginForm() {
    document.getElementById('serverUrl').value = '';
    document.getElementById('username').value = '';
    document.getElementById('password').value = '';
    document.getElementById('loginError').textContent = '';
    document.getElementById('qcServerUrl').value = '';
    document.getElementById('qcError').textContent = '';
  }

  switchLoginMethod(method) {
    // Update tab active state
    document.querySelectorAll('.login-method-tab').forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.method === method);
    });

    // Show/hide forms
    const passwordForm = document.getElementById('passwordLoginForm');
    const qcForm = document.getElementById('quickConnectForm');

    if (method === 'quickconnect') {
      passwordForm.style.display = 'none';
      qcForm.style.display = 'flex';
      // Copy server URL from password form if available
      const serverUrl = document.getElementById('serverUrl').value.trim();
      if (serverUrl && !document.getElementById('qcServerUrl').value.trim()) {
        document.getElementById('qcServerUrl').value = serverUrl;
      }
    } else {
      passwordForm.style.display = 'flex';
      qcForm.style.display = 'none';
      // Copy server URL from QC form if available
      const qcUrl = document.getElementById('qcServerUrl').value.trim();
      if (qcUrl && !document.getElementById('serverUrl').value.trim()) {
        document.getElementById('serverUrl').value = qcUrl;
      }
      this.cancelQuickConnect();
    }
  }

  // ===== Quick Connect =====

  async startQuickConnect() {
    const serverUrl = document.getElementById('qcServerUrl').value.trim();
    const errorEl = document.getElementById('qcError');
    errorEl.textContent = '';

    if (!serverUrl) {
      errorEl.textContent = 'Please enter a server URL';
      return;
    }

    let normalizedUrl;
    try {
      normalizedUrl = this.normalizeServerUrl(serverUrl);
    } catch (e) {
      errorEl.textContent = e.message;
      return;
    }

    const startBtn = document.getElementById('qcStartBtn');
    startBtn.disabled = true;
    startBtn.textContent = 'Checking...';

    try {
      const httpClient = this.getHttpClient();

      // Check if Quick Connect is enabled on the server
      const enabledResponse = await httpClient.get(`${normalizedUrl}/QuickConnect/Enabled`);
      debugLog('Quick Connect enabled response: ' + JSON.stringify(enabledResponse.data));

      if (enabledResponse.data !== true && enabledResponse.data !== 'true') {
        errorEl.textContent =
          'Quick Connect is not enabled on this server. Ask your server administrator to enable it, or use password login.';
        startBtn.disabled = false;
        startBtn.textContent = 'Start Quick Connect';
        return;
      }

      // Initiate Quick Connect
      const initiateResponse = await httpClient.post(`${normalizedUrl}/QuickConnect/Initiate`, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `MediaBrowser Client="IINA Jellyfin Plugin", Device="IINA", DeviceId="IINA-Jellyfin-Plugin", Version="0.4.0"`,
        },
      });

      debugLog('Quick Connect initiate response: ' + JSON.stringify(initiateResponse.data));

      if (!initiateResponse.data || !initiateResponse.data.Secret || !initiateResponse.data.Code) {
        errorEl.textContent = 'Failed to initiate Quick Connect. Please try again.';
        startBtn.disabled = false;
        startBtn.textContent = 'Start Quick Connect';
        return;
      }

      // Store secret and show code
      this.qcSecret = initiateResponse.data.Secret;
      this.qcServerUrl = normalizedUrl;

      // Display the code
      document.getElementById('qcCode').textContent = initiateResponse.data.Code;
      document.getElementById('qcCodeSection').style.display = 'block';
      startBtn.style.display = 'none';

      // Start polling for approval
      this.pollQuickConnect();
    } catch (error) {
      debugLog('Quick Connect error: ' + error.message);
      errorEl.textContent = 'Failed to start Quick Connect. Check your server URL.';
      startBtn.disabled = false;
      startBtn.textContent = 'Start Quick Connect';
    }
  }

  pollQuickConnect() {
    if (this.qcPollingInterval) {
      clearInterval(this.qcPollingInterval);
    }

    let attempts = 0;
    const maxAttempts = 60; // 5 minutes at 5-second intervals

    this.qcPollingInterval = setInterval(async () => {
      attempts++;
      if (attempts > maxAttempts) {
        this.cancelQuickConnect();
        document.getElementById('qcError').textContent =
          'Quick Connect timed out. Please try again.';
        return;
      }

      try {
        const httpClient = this.getHttpClient();
        const response = await httpClient.get(
          `${this.qcServerUrl}/QuickConnect/Connect?secret=${this.qcSecret}`
        );

        debugLog('Quick Connect poll response: ' + JSON.stringify(response.data));

        if (response.data && response.data.Authenticated === true) {
          debugLog('Quick Connect approved! Authenticating...');
          clearInterval(this.qcPollingInterval);
          this.qcPollingInterval = null;

          // Update polling status
          const statusEl = document.getElementById('qcPollingStatus');
          statusEl.innerHTML = '<span style="color: #4ade80;">Approved! Logging in...</span>';

          // Exchange the secret for an access token
          await this.authenticateWithQuickConnect();
        }
      } catch (error) {
        debugLog('Quick Connect poll error: ' + error.message);
        // Don't cancel on transient errors, just keep polling
      }
    }, 5000);
  }

  async authenticateWithQuickConnect() {
    try {
      const httpClient = this.getHttpClient();
      const response = await httpClient.post(
        `${this.qcServerUrl}/Users/AuthenticateWithQuickConnect`,
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `MediaBrowser Client="IINA Jellyfin Plugin", Device="IINA", DeviceId="IINA-Jellyfin-Plugin", Version="0.4.0"`,
          },
          data: JSON.stringify({ Secret: this.qcSecret }),
        }
      );

      debugLog('Quick Connect auth response: ' + JSON.stringify(response.data).substring(0, 500));

      if (response.data && response.data.AccessToken) {
        const accessToken = response.data.AccessToken;
        const user = response.data.User;

        // Get server name
        let serverName = this.qcServerUrl;
        try {
          const infoResponse = await httpClient.get(`${this.qcServerUrl}/System/Info/Public`);
          if (infoResponse.data && infoResponse.data.ServerName) {
            serverName = infoResponse.data.ServerName;
          }
        } catch (infoError) {
          debugLog('Could not get server info: ' + infoError);
        }

        // Set up the connection
        this.currentServer = {
          name: serverName,
          url: this.qcServerUrl,
          userId: user.Id,
          accessToken: accessToken,
        };
        this.currentUser = user;

        // Store session
        this.storeSessionData(this.qcServerUrl, accessToken, serverName, user.Id, user.Name);

        // Clean up Quick Connect state
        const qcServerUrl = this.qcServerUrl;
        this.qcSecret = null;
        this.qcServerUrl = null;

        // Update UI
        this.hideLoginForm();
        this.showMainContent();
        this.showLogoutButton();
        this.updateServerStatus(`Connected as ${user.Name}`, 'connected');
        this.loadHomeTab();

        debugLog(`Quick Connect login successful as ${user.Name} on ${qcServerUrl}`);
      } else {
        document.getElementById('qcError').textContent =
          'Quick Connect authentication failed. Please try again.';
        this.resetQuickConnectUI();
      }
    } catch (error) {
      debugLog('Quick Connect auth error: ' + error.message);
      document.getElementById('qcError').textContent =
        'Authentication failed: ' + (error.message || 'Unknown error');
      this.resetQuickConnectUI();
    }
  }

  cancelQuickConnect() {
    if (this.qcPollingInterval) {
      clearInterval(this.qcPollingInterval);
      this.qcPollingInterval = null;
    }
    this.qcSecret = null;
    this.qcServerUrl = null;
    this.resetQuickConnectUI();
  }

  resetQuickConnectUI() {
    document.getElementById('qcCodeSection').style.display = 'none';
    document.getElementById('qcCode').textContent = '';
    const startBtn = document.getElementById('qcStartBtn');
    startBtn.style.display = 'block';
    startBtn.disabled = false;
    startBtn.textContent = 'Start Quick Connect';
    const statusEl = document.getElementById('qcPollingStatus');
    statusEl.innerHTML = '<span class="qc-spinner"></span><span>Waiting for approval...</span>';
  }

  async login() {
    debugLog('Login function called');
    const serverUrl = document.getElementById('serverUrl').value.trim();
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    const errorEl = document.getElementById('loginError');

    debugLog('Login inputs: ' + JSON.stringify({ serverUrl, username, password: '[HIDDEN]' }));

    if (!serverUrl || !username || !password) {
      errorEl.textContent = 'Please fill in all fields';
      return;
    }

    // Normalize server URL
    const normalizedUrl = this.normalizeServerUrl(serverUrl);
    debugLog('Normalized URL: ' + normalizedUrl);

    try {
      document.getElementById('loginBtn').disabled = true;
      document.getElementById('loginBtn').textContent = 'Logging in...';
      errorEl.textContent = '';

      debugLog('Starting authentication...');
      const authResult = await this.authenticateUser(normalizedUrl, username, password);
      debugLog('Authentication result: ' + JSON.stringify(authResult));

      if (authResult.success) {
        debugLog('Authentication successful');

        // Create server object
        this.currentServer = {
          name: authResult.serverName || normalizedUrl,
          url: normalizedUrl,
          userId: authResult.user.Id,
          accessToken: authResult.accessToken,
        };

        this.currentUser = authResult.user;

        // Store session data with full server info for multi-server management
        this.storeSessionData(
          normalizedUrl,
          authResult.accessToken,
          authResult.serverName || '',
          authResult.user.Id,
          authResult.user.Name
        );

        this.hideLoginForm();
        this.showMainContent();
        this.showLogoutButton();
        this.updateServerStatus(`Connected as ${authResult.user.Name}`, 'connected');
        this.loadHomeTab();
      } else {
        debugLog('Authentication failed: ' + authResult.error);
        errorEl.textContent = authResult.error || 'Login failed';
      }
    } catch (error) {
      debugLog('Login error: ' + error);
      errorEl.textContent = 'Connection failed. Please check your server URL.';
    } finally {
      document.getElementById('loginBtn').disabled = false;
      document.getElementById('loginBtn').textContent = 'Login';
    }
  }

  normalizeServerUrl(url) {
    if (!url || typeof url !== 'string') {
      throw new Error('Invalid server URL');
    }

    // Validate URL format
    url = url.trim();
    if (!url) {
      throw new Error('Server URL cannot be empty');
    }

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'http://' + url;
    }

    // Basic URL validation using regex pattern
    const urlPattern = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;
    if (!urlPattern.test(url)) {
      throw new Error('Invalid server URL format');
    }

    return url.replace(/\/$/, ''); // Remove trailing slash
  }

  async authenticateUser(serverUrl, username, password) {
    try {
      debugLog('Starting authentication for: ' + serverUrl);
      const authUrl = `${serverUrl}/Users/AuthenticateByName`;

      // Validate input parameters
      if (!username || !password) {
        throw new Error('Username and password are required');
      }

      const authData = {
        Username: username,
        Pw: password,
      };

      debugLog('Auth URL: ' + authUrl);
      debugLog(
        'Auth data: ' +
          JSON.stringify({
            Username: username,
            Pw: '[HIDDEN]',
          })
      );

      // First, let's try to check if the server is reachable
      const httpClient = this.getHttpClient();
      try {
        debugLog('Checking server reachability...');
        const publicInfoResponse = await httpClient.get(`${serverUrl}/System/Info/Public`);
        debugLog('Server public info: ' + JSON.stringify(publicInfoResponse));
        debugLog('Server is reachable');
      } catch (serverError) {
        debugLog('Server reachability check failed: ' + serverError);
        debugLog(
          'Error details: ' +
            JSON.stringify({
              message: serverError.message,
              status: serverError.status,
              statusText: serverError.statusText,
            })
        );
        // Don't fail immediately - the endpoint might work with curl but not IINA HTTP API
        // Just log the warning and continue with authentication
        debugLog('Warning: Server reachability check failed, but proceeding with authentication');
      }

      // Now try authentication with proper Jellyfin headers
      const response = await httpClient.post(authUrl, {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `MediaBrowser Client="IINA Jellyfin Plugin", Device="IINA", DeviceId="IINA-Jellyfin-Plugin", Version="0.4.0"`,
        },
        data: JSON.stringify(authData),
      });

      debugLog('Auth response status: ' + response.status);
      debugLog('Auth response data: ' + JSON.stringify(response.data));
      debugLog('Auth response headers: ' + JSON.stringify(response.headers));

      if (response.data && response.data.AccessToken) {
        debugLog('Authentication successful');
        // Get server info
        let serverName = serverUrl;
        try {
          const infoResponse = await httpClient.get(`${serverUrl}/System/Info/Public`);
          if (infoResponse.data && infoResponse.data.ServerName) {
            serverName = infoResponse.data.ServerName;
          }
        } catch (infoError) {
          debugLog('Could not get server info: ' + infoError);
        }

        return {
          success: true,
          user: response.data.User,
          accessToken: response.data.AccessToken,
          serverName: serverName,
        };
      } else {
        debugLog('Authentication failed - no access token in response');
        debugLog('Response data details: ' + JSON.stringify(response.data, null, 2));

        // Check for specific error messages in the response
        if (response.data && response.data.error) {
          return {
            success: false,
            error: `Authentication failed: ${response.data.error}`,
          };
        } else if (response.status === 401) {
          return {
            success: false,
            error: 'Invalid username or password',
          };
        } else if (response.status === 403) {
          return {
            success: false,
            error: 'Access forbidden - check user permissions',
          };
        } else {
          return {
            success: false,
            error: `Authentication failed with status ${response.status}`,
          };
        }
      }
    } catch (error) {
      debugLog('Auth error details:', error);
      debugLog('Auth error message:', error.message);
      debugLog('Auth error status:', error.status);
      debugLog('Auth error statusText:', error.statusText);

      // Provide more specific error messages based on the error
      if (error.status === 401) {
        return {
          success: false,
          error: 'Invalid username or password',
        };
      } else if (error.status === 403) {
        return {
          success: false,
          error: 'Access forbidden - check user permissions',
        };
      } else if (error.status === 404) {
        return {
          success: false,
          error: 'Authentication endpoint not found - check server URL',
        };
      } else if (error.message && error.message.includes('Network')) {
        return {
          success: false,
          error: 'Network error - check server URL and connectivity',
        };
      } else {
        return {
          success: false,
          error: `Authentication failed: ${error.message || 'Unknown error'}`,
        };
      }
    }
  }

  // UI Management
  showMainContent() {
    document.getElementById('mainContent').style.display = 'block';
    this.scrollToTop();
    this.loadGenres();
  }

  async loadGenres() {
    if (!this.currentServer || !this.currentUser) return;

    try {
      const params = new URLSearchParams({
        userId: this.currentUser.Id,
        Recursive: true,
        IncludeItemTypes: 'Movie,Series',
      });

      const fullUrl = `${this.currentServer.url}/Genres?${params.toString()}`;

      const response = await this.getHttpClient().get(fullUrl, {
        headers: {
          'X-Emby-Token': this.currentServer.accessToken,
        },
      });

      if (response.data && response.data.Items) {
        const moviesGenreSelect = document.getElementById('moviesGenreSelect');
        const seriesGenreSelect = document.getElementById('seriesGenreSelect');

        // Keep the "All Genres" option
        const allOption = '<option value="all" selected>All Genres</option>';
        let optionsHtml = allOption;

        response.data.Items.forEach((genre) => {
          optionsHtml += `<option value="${genre.Name}">${genre.Name}</option>`;
        });

        moviesGenreSelect.innerHTML = optionsHtml;
        seriesGenreSelect.innerHTML = optionsHtml;
      }
    } catch (error) {
      debugLog('Error loading genres:', error);
    }
  }

  hideMainContent() {
    document.getElementById('mainContent').style.display = 'none';
    this.hideEpisodeSelection();
  }

  scrollToTop() {
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  // Media Browsing
  async loadRecentItems() {
    debugLog('loadRecentItems called');
    if (!this.currentServer || !this.currentUser) {
      debugLog('Missing server or user, skipping loadRecentItems');
      return;
    }

    debugLog('Loading recent items for user:', this.currentUser.Name);
    const recentList = document.getElementById('recentList');
    recentList.innerHTML = '<div class="loading">Loading recent items...</div>';

    try {
      // Add query parameters to URL instead of using params property
      const params = new URLSearchParams({
        userId: this.currentUser.Id,
        limit: 20,
        fields:
          'BasicSyncInfo,CanDelete,PrimaryImageAspectRatio,ProductionYear,Status,EndDate,RunTimeTicks,ImageTags,BackdropImageTags,SeriesId',
        imageTypeLimit: 1,
        enableImageTypes: 'Primary,Backdrop,Thumb',
        includeItemTypes: 'Movie,Series,Episode',
      });

      const fullUrl = `${this.currentServer.url}/Items/Latest?${params.toString()}`;

      const response = await this.getHttpClient().get(fullUrl, {
        headers: {
          'X-Emby-Token': this.currentServer.accessToken,
        },
      });

      debugLog('=== HTTP RESPONSE RECEIVED ===');
      debugLog('Response data:', response.data);
      debugLog('Response data type:', typeof response.data);
      debugLog('Response data is array:', Array.isArray(response.data));

      if (response.data && Array.isArray(response.data)) {
        this.renderMediaList(response.data, recentList);
      } else {
        recentList.innerHTML = '<div class="empty-state">No recent items found</div>';
      }
    } catch (error) {
      debugLog('Error loading recent items:', error);
      recentList.innerHTML = '<div class="error">Failed to load recent items</div>';
    }
  }

  /**
   * Load the Home tab with Continue Watching, Up Next, and Recently Added
   */
  async loadHomeTab() {
    if (!this.currentServer || !this.currentUser) return;

    // Load all three sections in parallel
    await Promise.all([this.loadContinueWatching(), this.loadNextUp(), this.loadRecentItems()]);
    this.scrollToTop();
  }

  /**
   * Load Continue Watching (resume) items
   */
  async loadContinueWatching() {
    if (!this.currentServer || !this.currentUser) return;

    const container = document.getElementById('continueWatchingList');
    container.innerHTML = '<div class="loading">Loading...</div>';

    try {
      const params = new URLSearchParams({
        Limit: 10,
        MediaTypes: 'Video',
        Fields:
          'Overview,UserData,RunTimeTicks,SeriesName,ProductionYear,ParentIndexNumber,IndexNumber,SeriesId,ImageTags,BackdropImageTags',
      });

      const fullUrl = `${this.currentServer.url}/Users/${this.currentUser.Id}/Items/Resume?${params.toString()}`;

      const response = await this.getHttpClient().get(fullUrl, {
        headers: {
          'X-Emby-Token': this.currentServer.accessToken,
        },
      });

      if (response.data && response.data.Items && response.data.Items.length > 0) {
        this.renderMediaList(response.data.Items, container);
      } else {
        container.innerHTML = '<div class="empty-state">Nothing to resume</div>';
      }
    } catch (error) {
      debugLog('Error loading continue watching:', error);
      container.innerHTML = '<div class="error">Failed to load</div>';
    }
  }

  /**
   * Load Next Up episodes (next unwatched episodes in series the user is watching)
   */
  async loadNextUp() {
    if (!this.currentServer || !this.currentUser) return;

    const container = document.getElementById('nextUpList');
    container.innerHTML = '<div class="loading">Loading...</div>';

    try {
      const params = new URLSearchParams({
        UserId: this.currentUser.Id,
        Limit: 10,
        Fields:
          'Overview,UserData,RunTimeTicks,SeriesName,ProductionYear,ParentIndexNumber,IndexNumber,SeriesId,ImageTags,BackdropImageTags',
      });

      const fullUrl = `${this.currentServer.url}/Shows/NextUp?${params.toString()}`;

      const response = await this.getHttpClient().get(fullUrl, {
        headers: {
          'X-Emby-Token': this.currentServer.accessToken,
        },
      });

      if (response.data && response.data.Items && response.data.Items.length > 0) {
        this.renderMediaList(response.data.Items, container);
      } else {
        container.innerHTML = '<div class="empty-state">No upcoming episodes</div>';
      }
    } catch (error) {
      debugLog('Error loading next up:', error);
      container.innerHTML = '<div class="error">Failed to load</div>';
    }
  }

  /**
   * Load all movies from the user's libraries
   */
  async loadMovies() {
    if (!this.currentServer || !this.currentUser) return;

    const container = document.getElementById('moviesList');
    container.innerHTML = '<div class="loading">Loading movies...</div>';

    try {
      const sortValue = document.getElementById('moviesSortSelect').value.split(',');
      const filterValue = document.getElementById('moviesFilterSelect').value;
      const genreValue = document.getElementById('moviesGenreSelect').value;

      const params = new URLSearchParams({
        userId: this.currentUser.Id,
        IncludeItemTypes: 'Movie',
        Recursive: true,
        SortBy: sortValue[0],
        SortOrder: sortValue[1],
        Fields: 'Overview,UserData,RunTimeTicks,ProductionYear,ImageTags,BackdropImageTags',
        EnableImageTypes: 'Primary,Backdrop,Thumb',
        Limit: 50,
      });

      if (filterValue === 'unwatched') {
        params.append('IsPlayed', 'false');
      } else if (filterValue === 'favorites') {
        params.append('Filters', 'IsFavorite');
      }

      if (genreValue !== 'all') {
        params.append('Genres', genreValue);
      }

      const fullUrl = `${this.currentServer.url}/Users/${this.currentUser.Id}/Items?${params.toString()}`;

      const response = await this.getHttpClient().get(fullUrl, {
        headers: {
          'X-Emby-Token': this.currentServer.accessToken,
        },
      });

      if (response.data && response.data.Items && response.data.Items.length > 0) {
        this.renderMediaList(response.data.Items, container);
      } else {
        container.innerHTML = '<div class="empty-state">No movies found</div>';
      }
    } catch (error) {
      debugLog('Error loading movies:', error);
      container.innerHTML = '<div class="error">Failed to load movies</div>';
    }
  }

  /**
   * Load all series from the user's libraries
   */
  async loadSeries() {
    if (!this.currentServer || !this.currentUser) return;

    const container = document.getElementById('seriesList');
    container.innerHTML = '<div class="loading">Loading series...</div>';

    try {
      const sortValue = document.getElementById('seriesSortSelect').value.split(',');
      const filterValue = document.getElementById('seriesFilterSelect').value;
      const genreValue = document.getElementById('seriesGenreSelect').value;

      const params = new URLSearchParams({
        userId: this.currentUser.Id,
        IncludeItemTypes: 'Series',
        Recursive: true,
        SortBy: sortValue[0],
        SortOrder: sortValue[1],
        Fields: 'Overview,UserData,RunTimeTicks,ProductionYear,ImageTags,BackdropImageTags',
        EnableImageTypes: 'Primary,Backdrop,Thumb',
        Limit: 50,
      });

      if (filterValue === 'unwatched') {
        params.append('IsPlayed', 'false');
      } else if (filterValue === 'favorites') {
        params.append('Filters', 'IsFavorite');
      }

      if (genreValue !== 'all') {
        params.append('Genres', genreValue);
      }

      const fullUrl = `${this.currentServer.url}/Users/${this.currentUser.Id}/Items?${params.toString()}`;

      const response = await this.getHttpClient().get(fullUrl, {
        headers: {
          'X-Emby-Token': this.currentServer.accessToken,
        },
      });

      if (response.data && response.data.Items && response.data.Items.length > 0) {
        this.renderMediaList(response.data.Items, container);
      } else {
        container.innerHTML = '<div class="empty-state">No series found</div>';
      }
    } catch (error) {
      debugLog('Error loading series:', error);
      container.innerHTML = '<div class="error">Failed to load series</div>';
    }
  }

  debounceSearch(term) {
    if (this.searchTimeout) {
      clearTimeout(this.searchTimeout);
    }

    this.searchTimeout = setTimeout(() => {
      this.search(term);
    }, 500);
  }

  async search(term) {
    if (!this.currentServer || !this.currentUser || !term.trim()) {
      document.getElementById('searchResults').innerHTML =
        '<div class="empty-state">Enter a search term above</div>';
      return;
    }

    const searchResults = document.getElementById('searchResults');
    searchResults.innerHTML = '<div class="loading">Searching...</div>';

    try {
      const params = new URLSearchParams({
        userId: this.currentUser.Id,
        searchTerm: term,
        limit: 20,
        includeItemTypes: 'Movie,Series',
      });

      const fullUrl = `${this.currentServer.url}/Search/Hints?${params.toString()}`;

      const response = await this.getHttpClient().get(fullUrl, {
        headers: {
          'X-Emby-Token': this.currentServer.accessToken,
        },
      });

      if (response.data && response.data.SearchHints) {
        this.renderSearchResults(response.data.SearchHints, searchResults);
      } else {
        searchResults.innerHTML = '<div class="empty-state">No results found</div>';
      }
    } catch (error) {
      debugLog('Search error:', error);
      searchResults.innerHTML = '<div class="error">Search failed</div>';
    }
  }

  renderMediaList(items, container) {
    debugLog('renderMediaList called with ' + (items?.length || 0) + ' items');
    if (!items || items.length === 0) {
      container.innerHTML = '<div class="empty-state">No items found</div>';
      return;
    }

    container.innerHTML = '';
    items.forEach((item) => {
      debugLog('Creating media item element for: ' + item.Name + ' ' + item.Type);
      const itemEl = this.createMediaItemElement(item);
      container.appendChild(itemEl);
    });
    debugLog('Finished rendering ' + items.length + ' media items');
  }

  renderSearchResults(hints, container) {
    if (!hints || hints.length === 0) {
      container.innerHTML = '<div class="empty-state">No results found</div>';
      return;
    }

    container.innerHTML = '';
    hints.forEach((hint) => {
      const itemEl = this.createSearchItemElement(hint);
      container.appendChild(itemEl);
    });
  }

  /**
   * Get the thumbnail image URL for a media item
   * @param {Object} item - Jellyfin media item
   * @param {number} maxWidth - Max image width
   * @returns {string|null} Image URL or null
   */
  getThumbnailUrl(item, maxWidth = 160) {
    if (!this.currentServer) return null;
    const base = this.currentServer.url;
    const token = this.currentServer.accessToken;

    // For episodes, try the episode Primary image first
    if (item.Type === 'Episode') {
      if (item.ImageTags && item.ImageTags.Primary) {
        return `${base}/Items/${item.Id}/Images/Primary?maxWidth=${maxWidth}&quality=90&api_key=${token}`;
      }
      // Fallback to series thumb
      if (item.SeriesId) {
        return `${base}/Items/${item.SeriesId}/Images/Thumb?maxWidth=${maxWidth}&quality=90&api_key=${token}`;
      }
    }

    // For movies/series, try Thumb, then Primary, then Backdrop
    if (item.ImageTags && item.ImageTags.Thumb) {
      return `${base}/Items/${item.Id}/Images/Thumb?maxWidth=${maxWidth}&quality=90&api_key=${token}`;
    }
    if (item.ImageTags && item.ImageTags.Primary) {
      return `${base}/Items/${item.Id}/Images/Primary?maxWidth=${maxWidth}&quality=90&api_key=${token}`;
    }
    if (item.BackdropImageTags && item.BackdropImageTags.length > 0) {
      return `${base}/Items/${item.Id}/Images/Backdrop?maxWidth=${maxWidth * 2}&quality=90&api_key=${token}`;
    }
    return null;
  }

  /**
   * Format runtime ticks to human-readable duration
   * @param {number} ticks - Jellyfin RunTimeTicks
   * @returns {string} Formatted duration like "1h 23m" or "45m"
   */
  formatRuntime(ticks) {
    if (!ticks) return '';
    const totalMinutes = Math.floor(ticks / 600000000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  createMediaItemElement(item) {
    const itemEl = document.createElement('div');
    itemEl.className = 'media-item';
    itemEl.dataset.itemId = item.Id;
    itemEl.dataset.itemType = item.Type;

    const title = item.Name || 'Unknown Title';
    const year = item.ProductionYear ? ` (${item.ProductionYear})` : '';
    const type = item.Type;
    const duration = this.formatRuntime(item.RunTimeTicks);
    const thumbUrl = this.getThumbnailUrl(item);

    let subtitle = '';
    if (item.Type === 'Episode' && item.SeriesName) {
      const season = item.ParentIndexNumber || '?';
      const episode = item.IndexNumber || '?';
      subtitle = `${item.SeriesName} - S${season}E${episode}`;
    } else if (item.Type === 'Series') {
      subtitle = 'TV Series';
    } else if (item.Type === 'Movie') {
      subtitle = 'Movie';
    }

    const thumbHtml = thumbUrl
      ? `<div class="thumb-wrapper">
           <img class="list-thumb" src="${thumbUrl}" loading="lazy" alt="" onerror="this.parentElement.classList.add('thumb-fallback'); this.style.display='none';" />
           <div class="play-overlay">&#9654;</div>
         </div>`
      : `<div class="thumb-wrapper thumb-fallback"><div class="play-overlay">&#9654;</div></div>`;

    itemEl.innerHTML = `
            ${thumbHtml}
            <div class="list-body">
                <div class="media-title">${title}${year}</div>
                ${subtitle ? `<div class="media-subtitle">${subtitle}</div>` : ''}
                <div class="media-meta">${type}</div>
                <div class="media-actions">
                    <button class="button media-action-btn" data-action="select">
                        ${item.Type === 'Series' ? 'Browse Episodes' : 'Play'}
                    </button>
                    <button class="button secondary media-action-btn" data-action="open-jellyfin">
                        Jellyfin
                    </button>
                </div>
            </div>
            ${duration ? `<div class="list-duration">${duration}</div>` : ''}
        `;

    // Add event listeners for the action buttons
    const actionButtons = itemEl.querySelectorAll('.media-action-btn');
    debugLog(`Adding event listeners to ${actionButtons.length} action buttons`);
    actionButtons.forEach((button, index) => {
      debugLog(`Setting up button ${index}: ${button.dataset.action}`);
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = button.dataset.action;
        debugLog(`Action button clicked: ${action} for item ${item.Name}`);

        if (action === 'select') {
          this.selectMediaItem(item);
        } else if (action === 'open-jellyfin') {
          this.openInJellyfin(item);
        }
      });
    });

    itemEl.addEventListener('click', () => {
      debugLog('Media item clicked: ' + JSON.stringify(item));
      this.selectMediaItem(item);
    });

    return itemEl;
  }

  createSearchItemElement(hint) {
    const itemEl = document.createElement('div');
    itemEl.className = 'media-item';
    itemEl.dataset.itemId = hint.ItemId;
    itemEl.dataset.itemType = hint.Type;

    const title = hint.Name || 'Unknown Title';
    const year = hint.ProductionYear ? ` (${hint.ProductionYear})` : '';
    const type = hint.Type;
    const duration = this.formatRuntime(hint.RunTimeTicks);

    // Search hints may have a thumb via ThumbImageTag / ThumbImageItemId
    let thumbUrl = null;
    if (this.currentServer) {
      const base = this.currentServer.url;
      const token = this.currentServer.accessToken;
      if (hint.ThumbImageTag && hint.ThumbImageItemId) {
        thumbUrl = `${base}/Items/${hint.ThumbImageItemId}/Images/Thumb?maxWidth=160&quality=90&api_key=${token}`;
      } else if (hint.PrimaryImageTag) {
        thumbUrl = `${base}/Items/${hint.ItemId}/Images/Primary?maxWidth=160&quality=90&api_key=${token}`;
      } else if (hint.BackdropImageTag && hint.BackdropImageItemId) {
        thumbUrl = `${base}/Items/${hint.BackdropImageItemId}/Images/Backdrop?maxWidth=320&quality=90&api_key=${token}`;
      }
    }

    const thumbHtml = thumbUrl
      ? `<div class="thumb-wrapper">
           <img class="list-thumb" src="${thumbUrl}" loading="lazy" alt="" onerror="this.parentElement.classList.add('thumb-fallback'); this.style.display='none';" />
           <div class="play-overlay">&#9654;</div>
         </div>`
      : `<div class="thumb-wrapper thumb-fallback"><div class="play-overlay">&#9654;</div></div>`;

    itemEl.innerHTML = `
            ${thumbHtml}
            <div class="list-body">
                <div class="media-title">${title}${year}</div>
                <div class="media-meta">${type}</div>
                <div class="media-actions">
                    <button class="button search-action-btn" data-action="select">
                        ${hint.Type === 'Series' ? 'Browse Episodes' : 'Play'}
                    </button>
                    <button class="button secondary search-action-btn" data-action="open-jellyfin">
                        Open in Jellyfin
                    </button>
                </div>
            </div>
            ${duration ? `<div class="list-duration">${duration}</div>` : ''}
        `;

    // Add event listeners for the action buttons
    const actionButtons = itemEl.querySelectorAll('.search-action-btn');
    debugLog(`Adding event listeners to ${actionButtons.length} search action buttons`);
    actionButtons.forEach((button, index) => {
      debugLog(`Setting up search button ${index}: ${button.dataset.action}`);
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = button.dataset.action;
        debugLog(`Search action button clicked: ${action} for item ${hint.Name}`);

        if (action === 'select') {
          this.selectSearchItem(hint);
        } else if (action === 'open-jellyfin') {
          // For search hints, we need to create a basic item object
          const searchItem = {
            Id: hint.ItemId,
            Type: hint.Type,
            Name: hint.Name,
            ProductionYear: hint.ProductionYear,
          };
          this.openInJellyfin(searchItem);
        }
      });
    });

    itemEl.addEventListener('click', () => {
      this.selectSearchItem(hint);
    });

    return itemEl;
  }

  selectMediaItem(item) {
    debugLog('selectMediaItem called with: ' + JSON.stringify(item));
    this.selectedItem = item;

    // Update selection UI
    document.querySelectorAll('.media-item').forEach((el) => el.classList.remove('selected'));
    document.querySelector(`[data-item-id="${item.Id}"]`).classList.add('selected');

    if (item.Type === 'Series') {
      debugLog('Item is a Series, showing episode selection');
      this.showEpisodeSelection(item);
    } else {
      debugLog('Item is not a Series, playing media: ' + item.Type);
      this.playMedia(item);
    }
  }

  async selectSearchItem(hint) {
    // Need to get full item details from search hint
    try {
      const params = new URLSearchParams({
        userId: this.currentUser.Id,
      });

      const response = await this.getHttpClient().get(
        `${this.currentServer.url}/Items/${hint.ItemId}?${params.toString()}`,
        {
          headers: {
            'X-Emby-Token': this.currentServer.accessToken,
          },
        }
      );

      if (response.data) {
        this.selectMediaItem(response.data);
      }
    } catch (error) {
      debugLog('Error getting item details:', error);
      iina.core.osd('Failed to get item details');
    }
  }

  // Episode Selection
  async showEpisodeSelection(series) {
    document.getElementById('episodeSection').style.display = 'block';
    document.getElementById('mainContent').style.display = 'none';

    // Load seasons
    try {
      const params = new URLSearchParams({
        userId: this.currentUser.Id,
      });

      const response = await this.getHttpClient().get(
        `${this.currentServer.url}/Shows/${series.Id}/Seasons?${params.toString()}`,
        {
          headers: {
            'X-Emby-Token': this.currentServer.accessToken,
          },
        }
      );

      const seasonSelect = document.getElementById('seasonSelect');
      seasonSelect.innerHTML = '<option value="">Select a season...</option>';

      if (response.data && response.data.Items) {
        response.data.Items.forEach((season) => {
          if (season.IndexNumber !== undefined) {
            const option = document.createElement('option');
            option.value = season.Id;
            option.textContent = `Season ${season.IndexNumber}`;
            seasonSelect.appendChild(option);
          }
        });
      }
    } catch (error) {
      debugLog('Error loading seasons:', error);
      document.getElementById('episodeList').innerHTML =
        '<div class="error">Failed to load seasons</div>';
    }
  }

  async loadEpisodes(seasonId) {
    if (!seasonId) {
      document.getElementById('episodeList').innerHTML =
        '<div class="loading">Select a season</div>';
      return;
    }

    const episodeList = document.getElementById('episodeList');
    episodeList.innerHTML = '<div class="loading">Loading episodes...</div>';

    try {
      const params = new URLSearchParams({
        userId: this.currentUser.Id,
        seasonId: seasonId,
        fields:
          'MediaSources,Path,LocationType,IsFolder,CanDownload,UserData,BasicSyncInfo,RunTimeTicks,ImageTags',
      });

      const response = await this.getHttpClient().get(
        `${this.currentServer.url}/Shows/${this.selectedItem.Id}/Episodes?${params.toString()}`,
        {
          headers: {
            'X-Emby-Token': this.currentServer.accessToken,
          },
        }
      );

      if (response.data && response.data.Items) {
        episodeList.innerHTML = '';
        response.data.Items.forEach((episode) => {
          const episodeEl = document.createElement('div');
          const isAvailable = this.isEpisodeAvailable(episode);

          episodeEl.className = `episode-item ${!isAvailable ? 'unavailable' : ''}`;
          episodeEl.dataset.episodeId = episode.Id;
          episodeEl.dataset.available = isAvailable.toString();

          const episodeNum = episode.IndexNumber || '?';
          const title = episode.Name || `Episode ${episodeNum}`;
          const duration = this.formatRuntime(episode.RunTimeTicks);

          // Build episode thumbnail
          let episodeThumbUrl = null;
          if (this.currentServer) {
            const base = this.currentServer.url;
            const token = this.currentServer.accessToken;
            if (episode.ImageTags && episode.ImageTags.Primary) {
              episodeThumbUrl = `${base}/Items/${episode.Id}/Images/Primary?maxWidth=120&quality=90&api_key=${token}`;
            } else if (this.selectedItem && this.selectedItem.Id) {
              episodeThumbUrl = `${base}/Items/${this.selectedItem.Id}/Images/Thumb?maxWidth=120&quality=90&api_key=${token}`;
            }
          }

          const episodeThumbHtml = episodeThumbUrl
            ? `<div class="ep-thumb-wrapper">
                 <img class="ep-thumb" src="${episodeThumbUrl}" loading="lazy" alt="" onerror="this.parentElement.classList.add('thumb-fallback'); this.style.display='none';" />
               </div>`
            : `<div class="ep-thumb-wrapper thumb-fallback"></div>`;

          // Add availability indicator
          const availabilityIcon = isAvailable
            ? ''
            : ' <span class="unavailable-icon" title="Episode not available on server">⚠️</span>';

          episodeEl.innerHTML = `
            ${episodeThumbHtml}
            <div class="ep-body">
              <span class="ep-title">${episodeNum}. ${title}${availabilityIcon}</span>
            </div>
            ${duration ? `<span class="ep-duration">${duration}</span>` : ''}
          `;

          if (isAvailable) {
            episodeEl.addEventListener('click', () => {
              document
                .querySelectorAll('.episode-item')
                .forEach((el) => el.classList.remove('selected'));
              episodeEl.classList.add('selected');
              this.selectedEpisode = episode;
              document.getElementById('playEpisodeBtn').disabled = false;
              document.getElementById('openEpisodeInJellyfinBtn').disabled = false;
            });
          } else {
            // Add cursor indicator for unavailable episodes
            episodeEl.style.cursor = 'not-allowed';
            episodeEl.title = 'This episode is not available on the server';
          }

          episodeList.appendChild(episodeEl);
        });
      } else {
        episodeList.innerHTML = '<div class="empty-state">No episodes found</div>';
      }
    } catch (error) {
      debugLog('Error loading episodes:', error);
      episodeList.innerHTML = '<div class="error">Failed to load episodes</div>';
    }
  }

  playSelectedEpisode() {
    if (this.selectedEpisode) {
      this.playMedia(this.selectedEpisode);
    }
  }

  openSelectedEpisodeInJellyfin() {
    debugLog('openSelectedEpisodeInJellyfin called');

    if (this.selectedEpisode) {
      debugLog(`Opening selected episode in Jellyfin: ${this.selectedEpisode.Name}`);
      this.openInJellyfin(this.selectedEpisode);
    } else {
      debugLog('No episode selected');
    }
  }

  hideEpisodeSelection() {
    document.getElementById('episodeSection').style.display = 'none';
    document.getElementById('mainContent').style.display = 'block';
    this.selectedEpisode = null;
    this.selectedSeason = null;
    document.getElementById('playEpisodeBtn').disabled = true;
    document.getElementById('openEpisodeInJellyfinBtn').disabled = true;
  }

  /**
   * Open a media item in the Jellyfin web interface
   * @param {Object} item - The media item (episode, movie, series) to open
   */
  openInJellyfin(item) {
    if (!this.currentServer || !item) {
      debugLog('Cannot open in Jellyfin: missing server or item');
      debugLog('Debug info:', {
        hasServer: !!this.currentServer,
        hasItem: !!item,
        serverUrl: this.currentServer?.url,
        itemId: item?.Id,
        itemType: item?.Type,
      });
      return;
    }

    try {
      debugLog(`Opening item in Jellyfin: ${item.Name} (${item.Type})`);
      debugLog('Item details:', item);
      debugLog('Server details:', this.currentServer);

      // Construct the Jellyfin web interface URL
      const jellyfinUrl = `${this.currentServer.url}/web/index.html#!/details?id=${item.Id}`;

      debugLog(`Constructed Jellyfin URL: ${jellyfinUrl}`);

      // Use IINA's postMessage API to request opening the URL in default browser
      debugLog('Using IINA postMessage to open URL in default browser');

      // Send message to main IINA process to open URL
      const messageData = {
        url: jellyfinUrl,
        title: `${item.Name} - Jellyfin`,
      };

      debugLog(`Sending message: ${JSON.stringify(messageData)}`);
      iina.postMessage('open-external-url', messageData);

      debugLog('Successfully sent open-external-url message to IINA');
    } catch (error) {
      debugLog('Error in openInJellyfin:', error);

      // Show error feedback to user
      const errorMessage = `Failed to open Jellyfin page: ${error.message}`;
      if (typeof iina !== 'undefined' && iina.core && iina.core.osd) {
        iina.core.osd(errorMessage);
      }
    }
  }

  /**
   * Check if an episode is available on the server
   * @param {Object} episode - The episode object from Jellyfin API
   * @returns {boolean} - True if episode is available, false otherwise
   */
  isEpisodeAvailable(episode) {
    try {
      // Check multiple indicators of availability

      // 1. Check if LocationType exists and is not Virtual
      if (episode.LocationType && episode.LocationType === 'Virtual') {
        debugLog(`Episode ${episode.Name} marked as Virtual (unavailable)`);
        return false;
      }

      // 2. Check if MediaSources exist and have valid data
      if (!episode.MediaSources || episode.MediaSources.length === 0) {
        debugLog(`Episode ${episode.Name} has no MediaSources`);
        return false;
      }

      // 3. Check if any MediaSource has a valid Path
      const hasValidPath = episode.MediaSources.some((source) => {
        return source.Path && source.Path.trim() !== '';
      });

      if (!hasValidPath) {
        debugLog(`Episode ${episode.Name} has no valid media paths`);
        return false;
      }

      // 4. Check if episode has a direct Path property
      if (!episode.Path || episode.Path.trim() === '') {
        debugLog(`Episode ${episode.Name} has no direct path`);
        return false;
      }

      // 5. Additional check: if CanDownload is explicitly false
      if (episode.CanDownload === false) {
        debugLog(`Episode ${episode.Name} marked as not downloadable`);
        return false;
      }

      // 6. Check if it's marked as a folder (shouldn't be for episodes)
      if (episode.IsFolder === true) {
        debugLog(`Episode ${episode.Name} marked as folder`);
        return false;
      }

      debugLog(`Episode ${episode.Name} appears to be available`);
      return true;
    } catch (error) {
      debugLog(`Error checking episode availability for ${episode.Name}: ${error.message}`);
      // If we can't determine availability, assume it's unavailable for safety
      return false;
    }
  }

  // Media Playback
  async playMedia(item) {
    debugLog('playMedia called with item type:', item.Type, 'name:', item.Name, 'id:', item.Id);
    try {
      // Build playback URL - use Download endpoint that works manually
      const streamUrl = `${this.currentServer.url}/Items/${item.Id}/Download?api_key=${this.currentServer.accessToken}`;
      debugLog('Built download URL:', streamUrl);
      debugLog('Item details:', {
        Type: item.Type,
        Name: item.Name,
        Id: item.Id,
        Path: item.Path,
        MediaSources: item.MediaSources,
      });

      if (typeof iina !== 'undefined' && iina.postMessage) {
        debugLog('Sending play-media message to main plugin');
        iina.postMessage('play-media', {
          streamUrl: streamUrl,
          title: item.Name || 'Unknown Title',
        });

        // Hide episode selection if showing
        if (document.getElementById('episodeSection').style.display !== 'none') {
          this.hideEpisodeSelection();
        }
      } else {
        debugLog('iina.postMessage not available, trying global object');
        // Try using global object for communication
        if (typeof window !== 'undefined' && window.jellyfinPlugin) {
          debugLog('Using window.jellyfinPlugin for communication');
          // Try calling a method on the global plugin object
          if (window.jellyfinPlugin.playMedia) {
            window.jellyfinPlugin.playMedia(streamUrl, item.Name || 'Unknown Title');
          } else {
            debugLog('window.jellyfinPlugin.playMedia not available');
          }
        } else {
          debugLog('No communication method available, opening in new window');
          window.open(streamUrl, '_blank');
        }
      }
    } catch (error) {
      debugLog('Error playing media:', error);
    }
  }
}

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
