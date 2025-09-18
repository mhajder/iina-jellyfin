/**
 * Jellyfin Sidebar Interface
 * Handles authentication and media browsing
 */

debugLog("JELLYFIN SIDEBAR JS LOADED");

/**
 * Debug logging helper function
 * Only logs if debug logging is enabled in preferences
 */
function debugLog(message) {
  if (iina?.preferences?.get?.("debug_logging")) {
    console.log(`DEBUG: ${message}`);
  }
}

class JellyfinSidebar {
  constructor() {
    debugLog("JellyfinSidebar constructor called");
    debugLog("iina object available: " + typeof iina);

    this.currentUser = null;
    this.currentServer = null;
    this.selectedItem = null;
    this.selectedSeason = null;
    this.selectedEpisode = null;
    this.searchTimeout = null;

    this.init();
  }

  getHttpClient() {
    // Use browser fetch API since sidebar runs in webview context
    return {
      get: (url, options = {}) => this.fetchHttpRequest("GET", url, options),
      post: (url, options = {}) => this.fetchHttpRequest("POST", url, options),
    };
  }

  async fetchHttpRequest(method, url, options = {}) {
    try {
      const fetchOptions = {
        method,
        headers: options.headers || {},
      };

      if (method === "POST" && options.data) {
        fetchOptions.body = options.data;
      }

      debugLog(`${method} request to: ${url}`);
      const response = await fetch(url, fetchOptions);

      const responseData = await response.text();
      let parsedData;
      try {
        parsedData = JSON.parse(responseData);
      } catch (parseError) {
        console.warn("Failed to parse JSON response:", parseError);
        parsedData = responseData;
      }

      return {
        data: parsedData,
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
      };
    } catch (error) {
      console.error("HTTP request failed:", error);
      throw {
        message: error.message,
        status: 0,
        statusText: "Network Error",
      };
    }
  }

  init() {
    this.setupEventListeners();
    this.setupTabNavigation();
    this.showLoginForm();
  }

  setupEventListeners() {
    // Connection management
    document.getElementById("connectBtn").addEventListener("click", () => {
      this.showLoginForm();
    });

    document.getElementById("logoutBtn").addEventListener("click", () => {
      this.logout();
    });

    // Login form
    document.getElementById("loginBtn").addEventListener("click", () => {
      this.login();
    });

    document.getElementById("cancelLoginBtn").addEventListener("click", () => {
      this.hideLoginForm();
    });

    // Search
    document.getElementById("searchInput").addEventListener("input", (e) => {
      this.debounceSearch(e.target.value);
    });

    // Episode selection
    document.getElementById("seasonSelect").addEventListener("change", (e) => {
      this.loadEpisodes(e.target.value);
    });

    document.getElementById("playEpisodeBtn").addEventListener("click", () => {
      this.playSelectedEpisode();
    });

    document
      .getElementById("cancelEpisodeBtn")
      .addEventListener("click", () => {
        this.hideEpisodeSelection();
      });

    // Enter key handling
    document.getElementById("password").addEventListener("keypress", (e) => {
      if (e.key === "Enter") {
        this.login();
      }
    });
  }

  setupTabNavigation() {
    const tabButtons = document.querySelectorAll(".tab-button");
    const tabContents = document.querySelectorAll(".tab-content");

    tabButtons.forEach((button) => {
      button.addEventListener("click", () => {
        const tabName = button.dataset.tab;

        // Update active button
        tabButtons.forEach((btn) => btn.classList.remove("active"));
        button.classList.add("active");

        // Update active content
        tabContents.forEach((content) => content.classList.remove("active"));
        document.getElementById(tabName + "Tab").classList.add("active");

        // Load content if needed
        if (tabName === "recent" && this.currentUser) {
          this.loadRecentItems();
        }
      });
    });
  }

  // Simple logout functionality
  logout() {
    debugLog("Logging out user");
    this.currentUser = null;
    this.currentServer = null;
    this.updateServerStatus("Not connected");
    this.hideMainContent();
    this.showConnectButton();
    this.clearLoginForm();
  }

  updateServerStatus(message, status = "") {
    const statusEl = document.getElementById("serverStatus");
    statusEl.textContent = message;
    statusEl.className = `server-status ${status}`;
  }

  showConnectButton() {
    document.getElementById("connectBtn").style.display = "block";
    document.getElementById("logoutBtn").style.display = "none";
  }

  showLogoutButton() {
    document.getElementById("connectBtn").style.display = "none";
    document.getElementById("logoutBtn").style.display = "block";
  }

  // Authentication
  showLoginForm() {
    document.getElementById("loginSection").style.display = "block";
    document.getElementById("serverUrl").focus();
  }

  hideLoginForm() {
    document.getElementById("loginSection").style.display = "none";
    this.clearLoginForm();
  }

  clearLoginForm() {
    document.getElementById("serverUrl").value = "";
    document.getElementById("username").value = "";
    document.getElementById("password").value = "";
    document.getElementById("loginError").textContent = "";
  }

  async login() {
    debugLog("Login function called");
    const serverUrl = document.getElementById("serverUrl").value.trim();
    const username = document.getElementById("username").value.trim();
    const password = document.getElementById("password").value;
    const errorEl = document.getElementById("loginError");

    debugLog(
      "Login inputs: " +
        JSON.stringify({ serverUrl, username, password: "[HIDDEN]" }),
    );

    if (!serverUrl || !username || !password) {
      errorEl.textContent = "Please fill in all fields";
      return;
    }

    // Normalize server URL
    const normalizedUrl = this.normalizeServerUrl(serverUrl);
    debugLog("Normalized URL: " + normalizedUrl);

    try {
      document.getElementById("loginBtn").disabled = true;
      document.getElementById("loginBtn").textContent = "Logging in...";
      errorEl.textContent = "";

      debugLog("Starting authentication...");
      const authResult = await this.authenticateUser(
        normalizedUrl,
        username,
        password,
      );
      debugLog("Authentication result: " + JSON.stringify(authResult));

      if (authResult.success) {
        debugLog("Authentication successful");

        // Create simple server object
        this.currentServer = {
          name: authResult.serverName || normalizedUrl,
          url: normalizedUrl,
          userId: authResult.user.Id,
          accessToken: authResult.accessToken,
        };

        this.currentUser = authResult.user;

        this.hideLoginForm();
        this.showMainContent();
        this.showLogoutButton();
        this.updateServerStatus(
          `Connected as ${authResult.user.Name}`,
          "connected",
        );
        this.loadRecentItems();
      } else {
        debugLog("Authentication failed: " + authResult.error);
        errorEl.textContent = authResult.error || "Login failed";
      }
    } catch (error) {
      debugLog("Login error: " + error);
      errorEl.textContent = "Connection failed. Please check your server URL.";
    } finally {
      document.getElementById("loginBtn").disabled = false;
      document.getElementById("loginBtn").textContent = "Login";
    }
  }

  normalizeServerUrl(url) {
    if (!url || typeof url !== "string") {
      throw new Error("Invalid server URL");
    }

    // Validate URL format
    url = url.trim();
    if (!url) {
      throw new Error("Server URL cannot be empty");
    }

    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      url = "http://" + url;
    }

    // Basic URL validation using regex pattern
    const urlPattern = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;
    if (!urlPattern.test(url)) {
      throw new Error("Invalid server URL format");
    }

    return url.replace(/\/$/, ""); // Remove trailing slash
  }

  async authenticateUser(serverUrl, username, password) {
    try {
      debugLog("Starting authentication for: " + serverUrl);
      const authUrl = `${serverUrl}/Users/AuthenticateByName`;

      // Validate input parameters
      if (!username || !password) {
        throw new Error("Username and password are required");
      }

      const authData = {
        Username: username,
        Pw: password,
      };

      debugLog("Auth URL: " + authUrl);
      debugLog(
        "Auth data: " +
          JSON.stringify({
            Username: username,
            Pw: "[HIDDEN]",
          }),
      );

      // First, let's try to check if the server is reachable
      const httpClient = this.getHttpClient();
      try {
        debugLog("Checking server reachability...");
        const publicInfoResponse = await httpClient.get(
          `${serverUrl}/System/Info/Public`,
        );
        debugLog("Server public info: " + JSON.stringify(publicInfoResponse));
        debugLog("Server is reachable");
      } catch (serverError) {
        debugLog("Server reachability check failed: " + serverError);
        debugLog(
          "Error details: " +
            JSON.stringify({
              message: serverError.message,
              status: serverError.status,
              statusText: serverError.statusText,
            }),
        );
        // Don't fail immediately - the endpoint might work with curl but not IINA HTTP API
        // Just log the warning and continue with authentication
        debugLog(
          "Warning: Server reachability check failed, but proceeding with authentication",
        );
      }

      // Now try authentication with proper Jellyfin headers
      const response = await httpClient.post(authUrl, {
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Emby-Authorization": `Emby UserId="${username}", Client="IINA Jellyfin Plugin", Device="IINA", DeviceId="IINA-${Date.now()}", Version="0.0.1", Token=""`,
        },
        data: JSON.stringify(authData),
      });

      debugLog("Auth response status: " + response.status);
      debugLog("Auth response data: " + JSON.stringify(response.data));
      debugLog("Auth response headers: " + JSON.stringify(response.headers));

      if (response.data && response.data.AccessToken) {
        debugLog("Authentication successful");
        // Get server info
        let serverName = serverUrl;
        try {
          const infoResponse = await httpClient.get(
            `${serverUrl}/System/Info/Public`,
          );
          if (infoResponse.data && infoResponse.data.ServerName) {
            serverName = infoResponse.data.ServerName;
          }
        } catch (infoError) {
          debugLog("Could not get server info: " + infoError);
        }

        return {
          success: true,
          user: response.data.User,
          accessToken: response.data.AccessToken,
          serverName: serverName,
        };
      } else {
        debugLog("Authentication failed - no access token in response");
        debugLog(
          "Response data details: " + JSON.stringify(response.data, null, 2),
        );

        // Check for specific error messages in the response
        if (response.data && response.data.error) {
          return {
            success: false,
            error: `Authentication failed: ${response.data.error}`,
          };
        } else if (response.status === 401) {
          return {
            success: false,
            error: "Invalid username or password",
          };
        } else if (response.status === 403) {
          return {
            success: false,
            error: "Access forbidden - check user permissions",
          };
        } else {
          return {
            success: false,
            error: `Authentication failed with status ${response.status}`,
          };
        }
      }
    } catch (error) {
      debugLog("Auth error details:", error);
      debugLog("Auth error message:", error.message);
      debugLog("Auth error status:", error.status);
      debugLog("Auth error statusText:", error.statusText);

      // Provide more specific error messages based on the error
      if (error.status === 401) {
        return {
          success: false,
          error: "Invalid username or password",
        };
      } else if (error.status === 403) {
        return {
          success: false,
          error: "Access forbidden - check user permissions",
        };
      } else if (error.status === 404) {
        return {
          success: false,
          error: "Authentication endpoint not found - check server URL",
        };
      } else if (error.message && error.message.includes("Network")) {
        return {
          success: false,
          error: "Network error - check server URL and connectivity",
        };
      } else {
        return {
          success: false,
          error: `Authentication failed: ${error.message || "Unknown error"}`,
        };
      }
    }
  }

  // UI Management
  showMainContent() {
    document.getElementById("mainContent").style.display = "block";
  }

  hideMainContent() {
    document.getElementById("mainContent").style.display = "none";
    this.hideEpisodeSelection();
  }

  // Media Browsing
  async loadRecentItems() {
    debugLog("loadRecentItems called");
    if (!this.currentServer || !this.currentUser) {
      debugLog("Missing server or user, skipping loadRecentItems");
      return;
    }

    debugLog("Loading recent items for user:", this.currentUser.Name);
    const recentList = document.getElementById("recentList");
    recentList.innerHTML = '<div class="loading">Loading recent items...</div>';

    try {
      // Add query parameters to URL instead of using params property
      const params = new URLSearchParams({
        userId: this.currentUser.Id,
        limit: 20,
        fields:
          "BasicSyncInfo,CanDelete,PrimaryImageAspectRatio,ProductionYear,Status,EndDate",
        includeItemTypes: "Movie,Series,Episode",
      });

      const fullUrl = `${this.currentServer.url}/Items/Latest?${params.toString()}`;

      const response = await this.getHttpClient().get(fullUrl, {
        headers: {
          "X-Emby-Token": this.currentServer.accessToken,
        },
      });

      debugLog("=== HTTP RESPONSE RECEIVED ===");
      debugLog("Response data:", response.data);
      debugLog("Response data type:", typeof response.data);
      debugLog("Response data is array:", Array.isArray(response.data));

      if (response.data && Array.isArray(response.data)) {
        this.renderMediaList(response.data, recentList);
      } else {
        recentList.innerHTML =
          '<div class="empty-state">No recent items found</div>';
      }
    } catch (error) {
      debugLog("Error loading recent items:", error);
      recentList.innerHTML =
        '<div class="error">Failed to load recent items</div>';
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
      document.getElementById("searchResults").innerHTML =
        '<div class="empty-state">Enter a search term above</div>';
      return;
    }

    const searchResults = document.getElementById("searchResults");
    searchResults.innerHTML = '<div class="loading">Searching...</div>';

    try {
      const params = new URLSearchParams({
        userId: this.currentUser.Id,
        searchTerm: term,
        limit: 20,
        includeItemTypes: "Movie,Series",
      });

      const fullUrl = `${this.currentServer.url}/Search/Hints?${params.toString()}`;

      const response = await this.getHttpClient().get(fullUrl, {
        headers: {
          "X-Emby-Token": this.currentServer.accessToken,
        },
      });

      if (response.data && response.data.SearchHints) {
        this.renderSearchResults(response.data.SearchHints, searchResults);
      } else {
        searchResults.innerHTML =
          '<div class="empty-state">No results found</div>';
      }
    } catch (error) {
      debugLog("Search error:", error);
      searchResults.innerHTML = '<div class="error">Search failed</div>';
    }
  }

  renderMediaList(items, container) {
    debugLog("renderMediaList called with " + (items?.length || 0) + " items");
    if (!items || items.length === 0) {
      container.innerHTML = '<div class="empty-state">No items found</div>';
      return;
    }

    container.innerHTML = "";
    items.forEach((item) => {
      debugLog(
        "Creating media item element for: " + item.Name + " " + item.Type,
      );
      const itemEl = this.createMediaItemElement(item);
      container.appendChild(itemEl);
    });
    debugLog("Finished rendering " + items.length + " media items");
  }

  renderSearchResults(hints, container) {
    if (!hints || hints.length === 0) {
      container.innerHTML = '<div class="empty-state">No results found</div>';
      return;
    }

    container.innerHTML = "";
    hints.forEach((hint) => {
      const itemEl = this.createSearchItemElement(hint);
      container.appendChild(itemEl);
    });
  }

  createMediaItemElement(item) {
    const itemEl = document.createElement("div");
    itemEl.className = "media-item";
    itemEl.dataset.itemId = item.Id;
    itemEl.dataset.itemType = item.Type;

    const title = item.Name || "Unknown Title";
    const year = item.ProductionYear ? ` (${item.ProductionYear})` : "";
    const type = item.Type;

    let subtitle = "";
    if (item.Type === "Episode" && item.SeriesName) {
      const season = item.ParentIndexNumber || "?";
      const episode = item.IndexNumber || "?";
      subtitle = `${item.SeriesName} - S${season}E${episode}`;
    } else if (item.Type === "Series") {
      subtitle = "TV Series";
    } else if (item.Type === "Movie") {
      subtitle = "Movie";
    }

    itemEl.innerHTML = `
            <div class="media-title">${title}${year}</div>
            ${subtitle ? `<div class="media-subtitle">${subtitle}</div>` : ""}
            <div class="media-meta">${type}</div>
        `;

    itemEl.addEventListener("click", () => {
      debugLog("Media item clicked: " + JSON.stringify(item));
      this.selectMediaItem(item);
    });

    return itemEl;
  }

  createSearchItemElement(hint) {
    const itemEl = document.createElement("div");
    itemEl.className = "media-item";
    itemEl.dataset.itemId = hint.ItemId;
    itemEl.dataset.itemType = hint.Type;

    const title = hint.Name || "Unknown Title";
    const year = hint.ProductionYear ? ` (${hint.ProductionYear})` : "";
    const type = hint.Type;

    itemEl.innerHTML = `
            <div class="media-title">${title}${year}</div>
            <div class="media-meta">${type}</div>
        `;

    itemEl.addEventListener("click", () => {
      this.selectSearchItem(hint);
    });

    return itemEl;
  }

  selectMediaItem(item) {
    debugLog("selectMediaItem called with: " + JSON.stringify(item));
    this.selectedItem = item;

    // Update selection UI
    document
      .querySelectorAll(".media-item")
      .forEach((el) => el.classList.remove("selected"));
    document
      .querySelector(`[data-item-id="${item.Id}"]`)
      .classList.add("selected");

    if (item.Type === "Series") {
      debugLog("Item is a Series, showing episode selection");
      this.showEpisodeSelection(item);
    } else {
      debugLog("Item is not a Series, playing media: " + item.Type);
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
            "X-Emby-Token": this.currentServer.accessToken,
          },
        },
      );

      if (response.data) {
        this.selectMediaItem(response.data);
      }
    } catch (error) {
      debugLog("Error getting item details:", error);
      iina.core.osd("Failed to get item details");
    }
  }

  // Episode Selection
  async showEpisodeSelection(series) {
    document.getElementById("episodeSection").style.display = "block";
    document.getElementById("mainContent").style.display = "none";

    // Load seasons
    try {
      const params = new URLSearchParams({
        userId: this.currentUser.Id,
      });

      const response = await this.getHttpClient().get(
        `${this.currentServer.url}/Shows/${series.Id}/Seasons?${params.toString()}`,
        {
          headers: {
            "X-Emby-Token": this.currentServer.accessToken,
          },
        },
      );

      const seasonSelect = document.getElementById("seasonSelect");
      seasonSelect.innerHTML = '<option value="">Select a season...</option>';

      if (response.data && response.data.Items) {
        response.data.Items.forEach((season) => {
          if (season.IndexNumber !== undefined) {
            const option = document.createElement("option");
            option.value = season.Id;
            option.textContent = `Season ${season.IndexNumber}`;
            seasonSelect.appendChild(option);
          }
        });
      }
    } catch (error) {
      debugLog("Error loading seasons:", error);
      document.getElementById("episodeList").innerHTML =
        '<div class="error">Failed to load seasons</div>';
    }
  }

  async loadEpisodes(seasonId) {
    if (!seasonId) {
      document.getElementById("episodeList").innerHTML =
        '<div class="loading">Select a season</div>';
      return;
    }

    const episodeList = document.getElementById("episodeList");
    episodeList.innerHTML = '<div class="loading">Loading episodes...</div>';

    try {
      const params = new URLSearchParams({
        userId: this.currentUser.Id,
        seasonId: seasonId,
      });

      const response = await this.getHttpClient().get(
        `${this.currentServer.url}/Shows/${this.selectedItem.Id}/Episodes?${params.toString()}`,
        {
          headers: {
            "X-Emby-Token": this.currentServer.accessToken,
          },
        },
      );

      if (response.data && response.data.Items) {
        episodeList.innerHTML = "";
        response.data.Items.forEach((episode) => {
          const episodeEl = document.createElement("div");
          episodeEl.className = "episode-item";
          episodeEl.dataset.episodeId = episode.Id;

          const episodeNum = episode.IndexNumber || "?";
          const title = episode.Name || `Episode ${episodeNum}`;

          episodeEl.innerHTML = `${episodeNum}. ${title}`;

          episodeEl.addEventListener("click", () => {
            document
              .querySelectorAll(".episode-item")
              .forEach((el) => el.classList.remove("selected"));
            episodeEl.classList.add("selected");
            this.selectedEpisode = episode;
            document.getElementById("playEpisodeBtn").disabled = false;
          });

          episodeList.appendChild(episodeEl);
        });
      } else {
        episodeList.innerHTML =
          '<div class="empty-state">No episodes found</div>';
      }
    } catch (error) {
      debugLog("Error loading episodes:", error);
      episodeList.innerHTML =
        '<div class="error">Failed to load episodes</div>';
    }
  }

  playSelectedEpisode() {
    if (this.selectedEpisode) {
      this.playMedia(this.selectedEpisode);
    }
  }

  hideEpisodeSelection() {
    document.getElementById("episodeSection").style.display = "none";
    document.getElementById("mainContent").style.display = "block";
    this.selectedEpisode = null;
    this.selectedSeason = null;
    document.getElementById("playEpisodeBtn").disabled = true;
  }

  // Media Playback
  async playMedia(item) {
    debugLog(
      "playMedia called with item type:",
      item.Type,
      "name:",
      item.Name,
      "id:",
      item.Id,
    );
    try {
      // Build playback URL - use Download endpoint that works manually
      const streamUrl = `${this.currentServer.url}/Items/${item.Id}/Download?api_key=${this.currentServer.accessToken}`;
      debugLog("Built download URL:", streamUrl);
      debugLog("Item details:", {
        Type: item.Type,
        Name: item.Name,
        Id: item.Id,
        Path: item.Path,
        MediaSources: item.MediaSources,
      });

      // Send message to main plugin using IINA's sidebar messaging
      debugLog("Checking iina availability:", typeof iina);
      if (typeof iina !== "undefined") {
        debugLog("iina.postMessage available:", typeof iina.postMessage);
      } else {
        debugLog("iina is undefined, trying alternative methods");
      }

      if (typeof iina !== "undefined" && iina.postMessage) {
        debugLog("Sending play-media message to main plugin");
        iina.postMessage("play-media", {
          streamUrl: streamUrl,
          title: item.Name || "Unknown Title",
        });

        // Hide episode selection if showing
        if (
          document.getElementById("episodeSection").style.display !== "none"
        ) {
          this.hideEpisodeSelection();
        }
      } else {
        debugLog("iina.postMessage not available, trying global object");
        // Try using global object for communication
        if (typeof window !== "undefined" && window.jellyfinPlugin) {
          debugLog("Using window.jellyfinPlugin for communication");
          // Try calling a method on the global plugin object
          if (window.jellyfinPlugin.playMedia) {
            window.jellyfinPlugin.playMedia(
              streamUrl,
              item.Name || "Unknown Title",
            );
          } else {
            debugLog("window.jellyfinPlugin.playMedia not available");
          }
        } else {
          debugLog("No communication method available, opening in new window");
          window.open(streamUrl, "_blank");
        }
      }
    } catch (error) {
      debugLog("Error playing media:", error);
    }
  }
}

// Initialize sidebar when DOM is loaded
document.addEventListener("DOMContentLoaded", () => {
  debugLog("DOM loaded, initializing Jellyfin sidebar");
  debugLog("Document ready state:", document.readyState);
  debugLog("window.jellyfinPlugin available:", typeof window.jellyfinPlugin);
  if (window.jellyfinPlugin) {
    debugLog(
      "jellyfinPlugin.http available:",
      typeof window.jellyfinPlugin.http,
    );
  }
  window.jellyfinSidebar = new JellyfinSidebar();
  debugLog("Jellyfin sidebar initialized");
});

// Expose for main plugin communication
window.JellyfinSidebar = JellyfinSidebar;

// Also try to initialize immediately if DOM is already loaded
if (document.readyState === "loading") {
  debugLog("DOM still loading, waiting for DOMContentLoaded");
} else {
  debugLog("DOM already loaded, initializing immediately");
  debugLog("window.jellyfinPlugin available:", typeof window.jellyfinPlugin);
  if (window.jellyfinPlugin) {
    debugLog(
      "jellyfinPlugin.http available:",
      typeof window.jellyfinPlugin.http,
    );
  }
  window.jellyfinSidebar = new JellyfinSidebar();
}
