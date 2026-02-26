window.createSidebarAuthServerMethods = function createSidebarAuthServerMethods(debugLog) {
  return {
    handleServersList(data) {
      if (!data) return;
      this.servers = data.servers || [];
      this.activeServerId = data.activeServerId || null;
      this.renderServerList();

      if (!this.initialAutoConnectDone && !this.currentServer) {
        const validServers = this.servers.filter((server) => server.userId);
        if (validServers.length > 0) {
          const activeServer =
            validServers.find((server) => server.id === this.activeServerId) || validServers[0];
          this.connectToServer(activeServer);
        }
        this.initialAutoConnectDone = true;
      }
    },

    renderServerList() {
      const listEl = document.getElementById('savedServerList');

      const validServers = this.servers.filter((server) => server.userId);

      if (validServers.length === 0) {
        listEl.style.display = 'none';
        return;
      }

      listEl.style.display = 'flex';

      listEl.innerHTML = validServers
        .map(
          (server) => `
      <div class="saved-server-item ${server.id === this.activeServerId ? 'active' : ''}" data-server-id="${server.id}">
        <div class="saved-server-dot"></div>
        <div class="saved-server-info">
          <div class="saved-server-name">${this.escapeHtml(server.serverName || server.serverUrl)}</div>
          <div class="saved-server-url">${this.escapeHtml(server.serverUrl)}</div>
          ${server.username ? `<div class="saved-server-user">${this.escapeHtml(server.username)}</div>` : ''}
        </div>
        <button class="server-remove-btn" data-server-id="${server.id}" title="Remove">✕</button>
      </div>
    `
        )
        .join('');

      listEl.querySelectorAll('.saved-server-item').forEach((item) => {
        item.addEventListener('click', (event) => {
          if (event.target.closest('.server-remove-btn')) return;
          const serverId = item.dataset.serverId;
          this.switchToServer(serverId);
        });
      });

      listEl.querySelectorAll('.server-remove-btn').forEach((btn) => {
        btn.addEventListener('click', (event) => {
          event.stopPropagation();
          const serverId = btn.dataset.serverId;
          this.removeServerFromStorage(serverId);
        });
      });
    },

    switchToServer(serverId) {
      const server = this.servers.find((item) => item.id === serverId);
      if (!server) return;

      debugLog(`Switching to server: ${server.serverName}`);
      this.activeServerId = serverId;

      if (typeof iina !== 'undefined' && iina.postMessage) {
        iina.postMessage('switch-server', { serverId });
      }

      this.connectToServer(server);
      this.renderServerList();
    },

    async connectToServer(serverData) {
      try {
        debugLog('Connecting to server: ' + serverData.serverUrl);
        this.updateServerStatus('Connecting...', 'connecting');

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

        debugLog('Token invalid for server, prompting re-login');
        this.updateServerStatus('Session expired - please login again', 'error');
        this.showLoginFormWithServer(serverData.serverUrl);
      } catch (error) {
        debugLog('Connection failed: ' + error.message);
        this.updateServerStatus('Connection failed - check server', 'error');
      }
    },

    showLoginFormWithServer(serverUrl) {
      this.showLoginForm();
      if (serverUrl) {
        document.getElementById('serverUrl').value = serverUrl;
        document.getElementById('qcServerUrl').value = serverUrl;
      }
    },

    removeServerFromStorage(serverId) {
      debugLog(`Removing server: ${serverId}`);

      if (typeof iina !== 'undefined' && iina.postMessage) {
        iina.postMessage('remove-server', { serverId });
      }

      this.servers = this.servers.filter((server) => server.id !== serverId);
      if (this.activeServerId === serverId) {
        this.activeServerId = this.servers.length > 0 ? this.servers[0].id : null;
      }

      if (this.currentServer && this.currentServer.serverId === serverId) {
        this.disconnectFromServer();
      }

      this.renderServerList();
    },

    escapeHtml(str) {
      const div = document.createElement('div');
      div.textContent = str || '';
      return div.innerHTML;
    },

    handleSessionAvailable(sessionData) {
      if (!sessionData || !sessionData.serverUrl || !sessionData.accessToken) {
        debugLog('Invalid session data received');
        return;
      }

      if (this.servers.length > 0) {
        debugLog('Servers already loaded, skipping legacy session-available');
        return;
      }

      debugLog('Attempting auto-login with legacy session data');
      this.connectToServer(sessionData);
    },

    handleSessionData(sessionData) {
      if (!sessionData) {
        debugLog('No stored session data available');
        return;
      }

      if (this.servers.length > 0) return;

      debugLog('Retrieved stored session data, attempting auto-login');
      this.connectToServer(sessionData);
    },

    handleSessionCleared() {
      debugLog('Session cleared');
      this.servers = [];
      this.activeServerId = null;
      this.renderServerList();
      if (this.currentServer) {
        this.disconnectFromServer();
      }
    },

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
    },

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
    },

    logout() {
      debugLog('Logging out user');
      this.currentUser = null;
      this.currentServer = null;
      this.updateServerStatus('Not connected');
      this.hideMainContent();
      this.showConnectButton();
      this.clearLoginForm();
    },

    updateServerStatus(message, status = '') {
      const statusEl = document.getElementById('serverStatus');
      statusEl.textContent = message;
      statusEl.className = `server-status ${status}`;
    },

    showConnectButton() {
      document.getElementById('connectBtn').style.display = 'block';
      document.getElementById('addServerBtn').style.display = 'none';
      document.getElementById('logoutBtn').style.display = 'none';
    },

    showLogoutButton() {
      document.getElementById('connectBtn').style.display = 'none';
      document.getElementById('addServerBtn').style.display = 'block';
      document.getElementById('logoutBtn').style.display = 'block';
    },

    showLoginForm() {
      document.getElementById('loginSection').style.display = 'block';
      this.switchLoginMethod('password');
      this.scrollToTop();
    },

    hideLoginForm() {
      document.getElementById('loginSection').style.display = 'none';
      this.cancelQuickConnect();
      this.clearLoginForm();
    },

    clearLoginForm() {
      document.getElementById('serverUrl').value = '';
      document.getElementById('username').value = '';
      document.getElementById('password').value = '';
      document.getElementById('loginError').textContent = '';
      document.getElementById('qcServerUrl').value = '';
      document.getElementById('qcError').textContent = '';
    },

    switchLoginMethod(method) {
      document.querySelectorAll('.login-method-tab').forEach((tab) => {
        tab.classList.toggle('active', tab.dataset.method === method);
      });

      const passwordForm = document.getElementById('passwordLoginForm');
      const qcForm = document.getElementById('quickConnectForm');

      if (method === 'quickconnect') {
        passwordForm.style.display = 'none';
        qcForm.style.display = 'flex';
        const serverUrl = document.getElementById('serverUrl').value.trim();
        if (serverUrl && !document.getElementById('qcServerUrl').value.trim()) {
          document.getElementById('qcServerUrl').value = serverUrl;
        }
      } else {
        passwordForm.style.display = 'flex';
        qcForm.style.display = 'none';
        const qcUrl = document.getElementById('qcServerUrl').value.trim();
        if (qcUrl && !document.getElementById('serverUrl').value.trim()) {
          document.getElementById('serverUrl').value = qcUrl;
        }
        this.cancelQuickConnect();
      }
    },

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
      } catch (error) {
        errorEl.textContent = error.message;
        return;
      }

      const startBtn = document.getElementById('qcStartBtn');
      startBtn.disabled = true;
      startBtn.textContent = 'Checking...';

      try {
        const httpClient = this.getHttpClient();

        const enabledResponse = await httpClient.get(`${normalizedUrl}/QuickConnect/Enabled`);
        debugLog('Quick Connect enabled response: ' + JSON.stringify(enabledResponse.data));

        if (enabledResponse.data !== true && enabledResponse.data !== 'true') {
          errorEl.textContent =
            'Quick Connect is not enabled on this server. Ask your server administrator to enable it, or use password login.';
          startBtn.disabled = false;
          startBtn.textContent = 'Start Quick Connect';
          return;
        }

        const initiateResponse = await httpClient.post(`${normalizedUrl}/QuickConnect/Initiate`, {
          headers: {
            'Content-Type': 'application/json',
            Authorization:
              'MediaBrowser Client="IINA Jellyfin Plugin", Device="IINA", DeviceId="IINA-Jellyfin-Plugin", Version="0.4.0"',
          },
        });

        debugLog('Quick Connect initiate response: ' + JSON.stringify(initiateResponse.data));

        if (
          !initiateResponse.data ||
          !initiateResponse.data.Secret ||
          !initiateResponse.data.Code
        ) {
          errorEl.textContent = 'Failed to initiate Quick Connect. Please try again.';
          startBtn.disabled = false;
          startBtn.textContent = 'Start Quick Connect';
          return;
        }

        this.qcSecret = initiateResponse.data.Secret;
        this.qcServerUrl = normalizedUrl;

        document.getElementById('qcCode').textContent = initiateResponse.data.Code;
        document.getElementById('qcCodeSection').style.display = 'block';
        startBtn.style.display = 'none';

        this.pollQuickConnect();
      } catch (error) {
        debugLog('Quick Connect error: ' + error.message);
        errorEl.textContent = 'Failed to start Quick Connect. Check your server URL.';
        startBtn.disabled = false;
        startBtn.textContent = 'Start Quick Connect';
      }
    },

    pollQuickConnect() {
      if (this.qcPollingInterval) {
        clearInterval(this.qcPollingInterval);
      }

      let attempts = 0;
      const maxAttempts = 60;

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

            const statusEl = document.getElementById('qcPollingStatus');
            statusEl.innerHTML = '<span style="color: #4ade80;">Approved! Logging in...</span>';

            await this.authenticateWithQuickConnect();
          }
        } catch (error) {
          debugLog('Quick Connect poll error: ' + error.message);
        }
      }, 5000);
    },

    async authenticateWithQuickConnect() {
      try {
        const httpClient = this.getHttpClient();
        const response = await httpClient.post(
          `${this.qcServerUrl}/Users/AuthenticateWithQuickConnect`,
          {
            headers: {
              'Content-Type': 'application/json',
              Authorization:
                'MediaBrowser Client="IINA Jellyfin Plugin", Device="IINA", DeviceId="IINA-Jellyfin-Plugin", Version="0.4.0"',
            },
            data: JSON.stringify({ Secret: this.qcSecret }),
          }
        );

        debugLog('Quick Connect auth response: ' + JSON.stringify(response.data).substring(0, 500));

        if (response.data && response.data.AccessToken) {
          const accessToken = response.data.AccessToken;
          const user = response.data.User;

          let serverName = this.qcServerUrl;
          try {
            const infoResponse = await httpClient.get(`${this.qcServerUrl}/System/Info/Public`);
            if (infoResponse.data && infoResponse.data.ServerName) {
              serverName = infoResponse.data.ServerName;
            }
          } catch (infoError) {
            debugLog('Could not get server info: ' + infoError);
          }

          this.currentServer = {
            name: serverName,
            url: this.qcServerUrl,
            userId: user.Id,
            accessToken: accessToken,
          };
          this.currentUser = user;

          this.storeSessionData(this.qcServerUrl, accessToken, serverName, user.Id, user.Name);

          const qcServerUrl = this.qcServerUrl;
          this.qcSecret = null;
          this.qcServerUrl = null;

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
    },

    cancelQuickConnect() {
      if (this.qcPollingInterval) {
        clearInterval(this.qcPollingInterval);
        this.qcPollingInterval = null;
      }
      this.qcSecret = null;
      this.qcServerUrl = null;
      this.resetQuickConnectUI();
    },

    resetQuickConnectUI() {
      document.getElementById('qcCodeSection').style.display = 'none';
      document.getElementById('qcCode').textContent = '';
      const startBtn = document.getElementById('qcStartBtn');
      startBtn.style.display = 'block';
      startBtn.disabled = false;
      startBtn.textContent = 'Start Quick Connect';
      const statusEl = document.getElementById('qcPollingStatus');
      statusEl.innerHTML = '<span class="qc-spinner"></span><span>Waiting for approval...</span>';
    },

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

          this.currentServer = {
            name: authResult.serverName || normalizedUrl,
            url: normalizedUrl,
            userId: authResult.user.Id,
            accessToken: authResult.accessToken,
          };

          this.currentUser = authResult.user;

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
    },

    normalizeServerUrl(url) {
      if (!url || typeof url !== 'string') {
        throw new Error('Invalid server URL');
      }

      let normalized = url.trim();
      if (!normalized) {
        throw new Error('Server URL cannot be empty');
      }

      if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
        normalized = 'http://' + normalized;
      }

      const urlPattern = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;
      if (!urlPattern.test(normalized)) {
        throw new Error('Invalid server URL format');
      }

      return normalized.replace(/\/$/, '');
    },

    async authenticateUser(serverUrl, username, password) {
      try {
        debugLog('Starting authentication for: ' + serverUrl);
        const authUrl = `${serverUrl}/Users/AuthenticateByName`;

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
          debugLog('Warning: Server reachability check failed, but proceeding with authentication');
        }

        const response = await httpClient.post(authUrl, {
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization:
              'MediaBrowser Client="IINA Jellyfin Plugin", Device="IINA", DeviceId="IINA-Jellyfin-Plugin", Version="0.4.0"',
          },
          data: JSON.stringify(authData),
        });

        debugLog('Auth response status: ' + response.status);
        debugLog('Auth response data: ' + JSON.stringify(response.data));
        debugLog('Auth response headers: ' + JSON.stringify(response.headers));

        if (response.data && response.data.AccessToken) {
          debugLog('Authentication successful');
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
        }

        debugLog('Authentication failed - no access token in response');
        debugLog('Response data details: ' + JSON.stringify(response.data, null, 2));

        if (response.data && response.data.error) {
          return {
            success: false,
            error: `Authentication failed: ${response.data.error}`,
          };
        }
        if (response.status === 401) {
          return {
            success: false,
            error: 'Invalid username or password',
          };
        }
        if (response.status === 403) {
          return {
            success: false,
            error: 'Access forbidden - check user permissions',
          };
        }
        return {
          success: false,
          error: `Authentication failed with status ${response.status}`,
        };
      } catch (error) {
        debugLog('Auth error details:', error);
        debugLog('Auth error message:', error.message);
        debugLog('Auth error status:', error.status);
        debugLog('Auth error statusText:', error.statusText);

        if (error.status === 401) {
          return {
            success: false,
            error: 'Invalid username or password',
          };
        }
        if (error.status === 403) {
          return {
            success: false,
            error: 'Access forbidden - check user permissions',
          };
        }
        if (error.status === 404) {
          return {
            success: false,
            error: 'Authentication endpoint not found - check server URL',
          };
        }
        if (error.message && error.message.includes('Network')) {
          return {
            success: false,
            error: 'Network error - check server URL and connectivity',
          };
        }
        return {
          success: false,
          error: `Authentication failed: ${error.message || 'Unknown error'}`,
        };
      }
    },
  };
};
