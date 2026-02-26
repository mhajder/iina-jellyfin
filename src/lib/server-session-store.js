'use strict';

function createServerSessionStore({ preferences, sidebar, log }) {
  function loadStoredServers() {
    try {
      const serversJson = preferences.get('jellyfin_servers');
      if (!serversJson) return [];
      const servers = typeof serversJson === 'string' ? JSON.parse(serversJson) : serversJson;
      if (!Array.isArray(servers)) return [];

      const validServers = servers.filter((server) => server.userId);
      if (validServers.length !== servers.length) {
        log(`Cleaned ${servers.length - validServers.length} ghost server entries without userId`);
        saveStoredServers(validServers);
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

      const existingIndex = servers.findIndex(
        (server) =>
          server.serverUrl.replace(/\/$/, '') === normalizedUrl &&
          ((serverData.userId && server.userId === serverData.userId) ||
            (!serverData.userId && !server.userId))
      );

      const serverEntry = {
        id: existingIndex >= 0 ? servers[existingIndex].id : `srv-${Date.now()}`,
        serverUrl: normalizedUrl,
        serverName: serverData.serverName || normalizedUrl,
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

      if (sidebar && sidebar.postMessage) {
        sidebar.postMessage('servers-updated', { servers, activeServerId: getActiveServerId() });
      }
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

      if (sidebar && sidebar.postMessage) {
        sidebar.postMessage('server-switched', {
          server,
          servers,
          activeServerId: serverId,
        });
      }
    }
  }

  function storeJellyfinSession(serverBase, apiKey) {
    try {
      log(`Storing Jellyfin session data for: ${serverBase}`);

      const server = addOrUpdateServer({
        serverUrl: serverBase,
        accessToken: apiKey,
      });

      if (server) {
        if (sidebar && sidebar.postMessage) {
          sidebar.postMessage('session-available', {
            serverUrl: server.serverUrl,
            accessToken: server.accessToken,
            serverId: server.id,
          });
        }
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

      if (sidebar && sidebar.postMessage) {
        sidebar.postMessage('session-cleared', {});
      }
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
