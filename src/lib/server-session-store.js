'use strict';

function createServerSessionStore({
  preferences,
  sidebar,
  standaloneWindow,
  isSameJellyfinServer,
  log,
}) {
  /**
   * Both browser surfaces show the same server list, and either can be the one
   * the user is acting in, so state changes go to both. Posting to a webview
   * that was never created is a no-op inside IINA.
   */
  function notifyViews(name, data) {
    for (const view of [sidebar, standaloneWindow]) {
      if (view && typeof view.postMessage === 'function') {
        view.postMessage(name, data);
      }
    }
  }

  function loadStoredServers() {
    try {
      const serversJson = preferences.get('jellyfin_servers');
      if (!serversJson) return [];
      const servers = typeof serversJson === 'string' ? JSON.parse(serversJson) : serversJson;
      if (!Array.isArray(servers)) return [];

      // A server is usable as long as it has somewhere to connect and a token.
      // Sessions taken from a played URL have no userId until the sidebar
      // connects and reads /Users/Me, so requiring one here deleted them on the
      // very next read and auto-login from URLs never survived.
      const usableServers = servers.filter(
        (server) => server && server.serverUrl && server.accessToken
      );

      // Drop an unverified URL session for a server that is also signed in:
      // the account entry supersedes it, and keeping both shows the server
      // twice in the list.
      const signedIn = usableServers.filter((server) => server.userId);
      const validServers = usableServers.filter(
        (server) =>
          server.userId ||
          !signedIn.some((account) => isSameJellyfinServer(account.serverUrl, server.serverUrl))
      );

      if (validServers.length !== servers.length) {
        log(`Cleaned ${servers.length - validServers.length} redundant server entries`);
        saveStoredServers(validServers);

        // A dropped URL session may have been the active server. Its account
        // entry takes over, or the active id would point at nothing and the
        // first server in the list, possibly an unrelated one, would be used.
        const activeId = getActiveServerId();
        const droppedActive = usableServers.find(
          (server) => server.id === activeId && !validServers.includes(server)
        );
        if (droppedActive) {
          const account = signedIn.find((server) =>
            isSameJellyfinServer(server.serverUrl, droppedActive.serverUrl)
          );
          setActiveServerId(account.id);
          log(`Active server moved to the signed-in entry ${account.id}`);
        }
      }
      return validServers;
    } catch {
      log('Error loading stored servers, returning empty array');
      return [];
    }
  }

  function saveStoredServers(servers) {
    try {
      preferences.set('jellyfin_servers', JSON.stringify(servers));
      preferences.sync();
      log(`Saved ${servers.length} server(s) to preferences`);
    } catch (error) {
      log(`Error saving servers: ${error.message}`);
    }
  }

  function getActiveServerId() {
    return preferences.get('jellyfin_active_server_id') || null;
  }

  function setActiveServerId(serverId) {
    preferences.set('jellyfin_active_server_id', serverId || '');
    preferences.sync();
  }

  function addOrUpdateServer(serverData) {
    try {
      const servers = loadStoredServers();
      const normalizedUrl = serverData.serverUrl.replace(/\/$/, '');

      const isSameUrl = (server) => isSameJellyfinServer(server.serverUrl, normalizedUrl);

      // Match the same user on the same server. Failing that, a known user
      // takes over the entry left by a URL session on that server (it is the
      // same credential being identified), rather than adding a duplicate.
      // A URL session never claims an entry that already belongs to a user.
      let existingIndex = -1;
      if (serverData.userId) {
        existingIndex = servers.findIndex(
          (server) => isSameUrl(server) && server.userId === serverData.userId
        );
      }
      if (existingIndex < 0) {
        existingIndex = servers.findIndex((server) => isSameUrl(server) && !server.userId);
      }

      // The match can be another spelling of the server (scheme, case). A
      // played link must not rewrite a stored https:// URL to http://, which
      // would send the token unencrypted from then on, so a URL session keeps
      // the stored URL and only moves it up to https. A sign-in uses the URL
      // the user signed in with.
      const existingUrl = existingIndex >= 0 ? servers[existingIndex].serverUrl : null;
      const serverUrl =
        existingUrl &&
        !serverData.userId &&
        !(/^http:/i.test(existingUrl) && /^https:/i.test(normalizedUrl))
          ? existingUrl
          : normalizedUrl;

      const serverEntry = {
        id: existingIndex >= 0 ? servers[existingIndex].id : `srv-${Date.now()}`,
        serverUrl,
        serverName: serverData.serverName || serverUrl,
        accessToken: serverData.accessToken,
        userId: serverData.userId || '',
        username: serverData.username || '',
        addedAt: existingIndex >= 0 ? servers[existingIndex].addedAt : Date.now(),
        updatedAt: Date.now(),
      };

      if (existingIndex >= 0) {
        servers[existingIndex] = serverEntry;
        log(`Updated existing server: ${serverEntry.serverName}`);
      } else {
        servers.push(serverEntry);
        log(`Added new server: ${serverEntry.serverName}`);
      }

      saveStoredServers(servers);

      if (servers.length === 1 || !getActiveServerId()) {
        setActiveServerId(serverEntry.id);
      }

      return serverEntry;
    } catch (error) {
      log(`Error adding/updating server: ${error.message}`);
      return null;
    }
  }

  function removeServer(serverId) {
    try {
      let servers = loadStoredServers();
      servers = servers.filter((server) => server.id !== serverId);
      saveStoredServers(servers);

      if (getActiveServerId() === serverId) {
        setActiveServerId(servers.length > 0 ? servers[0].id : null);
      }

      log(`Removed server: ${serverId}`);

      notifyViews('servers-updated', { servers, activeServerId: getActiveServerId() });
    } catch (error) {
      log(`Error removing server: ${error.message}`);
    }
  }

  function getActiveServer() {
    try {
      const servers = loadStoredServers();
      const activeId = getActiveServerId();
      if (activeId) {
        const activeServer = servers.find((server) => server.id === activeId);
        if (activeServer) return activeServer;
      }
      return servers.length > 0 ? servers[0] : null;
    } catch {
      return null;
    }
  }

  function switchActiveServer(serverId) {
    const servers = loadStoredServers();
    const server = servers.find((item) => item.id === serverId);
    if (server) {
      setActiveServerId(serverId);
      log(`Switched active server to: ${server.serverName}`);

      notifyViews('server-switched', { server, servers, activeServerId: serverId });
    }
  }

  function storeJellyfinSession(serverBase, apiKey) {
    try {
      const normalizedUrl = String(serverBase || '').replace(/\/$/, '');

      // If this server is already signed in, its account credentials are the
      // better ones and storing the URL's api_key next to them would leave two
      // entries for the same server in the list.
      const signedIn = loadStoredServers().find(
        (server) => server.userId && isSameJellyfinServer(server.serverUrl, normalizedUrl)
      );
      if (signedIn) {
        log(
          `Server ${normalizedUrl} is already signed in as ${signedIn.username || signedIn.userId}`
        );
        notifyViews('session-available', {
          serverUrl: signedIn.serverUrl,
          accessToken: signedIn.accessToken,
          serverId: signedIn.id,
        });
        return;
      }

      log(`Storing Jellyfin session data for: ${serverBase}`);

      const server = addOrUpdateServer({
        serverUrl: serverBase,
        accessToken: apiKey,
      });

      if (server) {
        notifyViews('session-available', {
          serverUrl: server.serverUrl,
          accessToken: server.accessToken,
          serverId: server.id,
        });
      }
    } catch (error) {
      log(`Error storing Jellyfin session: ${error.message}`);
    }
  }

  function clearJellyfinSession() {
    try {
      log('Clearing all Jellyfin session data');
      saveStoredServers([]);
      setActiveServerId(null);

      notifyViews('session-cleared', {});
    } catch (error) {
      log(`Error clearing Jellyfin session: ${error.message}`);
    }
  }

  function getStoredJellyfinSession() {
    try {
      const server = getActiveServer();
      if (!server) {
        log('No stored server found');
        return null;
      }

      log(`Retrieved active server: ${server.serverName} (${server.serverUrl})`);
      return {
        serverUrl: server.serverUrl,
        accessToken: server.accessToken,
        serverId: server.id,
        serverName: server.serverName,
        userId: server.userId,
        username: server.username,
      };
    } catch (error) {
      log(`Error retrieving Jellyfin session: ${error.message}`);
      return null;
    }
  }

  return {
    loadStoredServers,
    saveStoredServers,
    getActiveServerId,
    setActiveServerId,
    addOrUpdateServer,
    removeServer,
    getActiveServer,
    switchActiveServer,
    storeJellyfinSession,
    clearJellyfinSession,
    getStoredJellyfinSession,
  };
}

module.exports = {
  createServerSessionStore,
};
