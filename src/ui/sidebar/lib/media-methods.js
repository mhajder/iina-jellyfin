window.createSidebarMediaMethods = function createSidebarMediaMethods(debugLog) {
  // Items per request in the paged lists (movies, series, music)
  const PAGE_SIZE = 50;

  return {
    /**
     * Take a ticket for a container before starting a request. Responses are
     * rendered only while they hold the newest ticket, so a slow reply cannot
     * overwrite fresher results (fast typing in search, flipping filters, ...).
     */
    nextRequestId(key) {
      if (!this.requestIds) this.requestIds = {};
      this.requestIds[key] = (this.requestIds[key] || 0) + 1;
      return this.requestIds[key];
    },

    isLatestRequest(key, requestId) {
      const current = this.requestIds ? this.requestIds[key] : undefined;
      if (current !== requestId) {
        debugLog(`Dropping stale ${key} response (#${requestId}, current #${current})`);
        return false;
      }
      return true;
    },

    /**
     * Move every ticket on so no reply to a request already in flight is
     * rendered. Requests started afterwards take fresh tickets.
     */
    invalidatePendingRequests() {
      if (!this.requestIds) return;
      for (const key of Object.keys(this.requestIds)) {
        this.requestIds[key]++;
      }
    },

    showMainContent() {
      // Called once a login or server switch succeeds: anything still in
      // flight was asked of the previous server or session.
      this.invalidatePendingRequests();
      document.getElementById('mainContent').style.display = 'block';
      this.scrollToTop();
      this.loadGenres();
      this.loadMusicGenres();
    },

    async loadGenres() {
      if (!this.currentServer || !this.currentUser) return;
      const requestId = this.nextRequestId('genres');

      try {
        const params = new URLSearchParams({
          userId: this.currentUser.Id,
          Recursive: true,
          IncludeItemTypes: 'Movie,Series',
        });

        const fullUrl = `${this.currentServer.url}/Genres?${params.toString()}`;

        const response = await this.getHttpClient().get(fullUrl, {
          headers: {
            Authorization: this.buildAuthorizationHeader(this.currentServer.accessToken),
          },
        });

        if (!this.isLatestRequest('genres', requestId)) return;

        if (response.data && response.data.Items) {
          const moviesGenreSelect = document.getElementById('moviesGenreSelect');
          const seriesGenreSelect = document.getElementById('seriesGenreSelect');

          const allOption = '<option value="all" selected>All Genres</option>';
          let optionsHtml = allOption;

          response.data.Items.forEach((genre) => {
            const genreName = this.escapeHtml(genre.Name);
            optionsHtml += `<option value="${genreName}">${genreName}</option>`;
          });

          moviesGenreSelect.innerHTML = optionsHtml;
          seriesGenreSelect.innerHTML = optionsHtml;
        }
      } catch (error) {
        debugLog('Error loading genres:', error);
      }
    },

    hideMainContent() {
      // Both helpers return to the media list by default; here the whole
      // content area is going away, so they must not show it again.
      this.hideEpisodeSelection(false);
      this.hideAlbumTracks(false);
      document.getElementById('mainContent').style.display = 'none';
    },

    /**
     * Clears all media content from the DOM and resets selection state.
     * Called when disconnecting from a server or logging out to prevent
     * stale content from a previous server being visible on reconnect.
     */
    clearAllMediaContent() {
      // Requests still in flight belong to the previous server or session:
      // none of their replies may be rendered.
      this.invalidatePendingRequests();

      // Reset selection state
      this.selectedItem = null;
      this.selectedSeason = null;
      this.selectedEpisode = null;
      this.selectedAlbum = null;
      this.selectedTrack = null;
      this.albumTracks = [];

      // Clear media list containers
      const listIds = [
        'recentList',
        'continueWatchingList',
        'nextUpList',
        'moviesList',
        'seriesList',
        'musicList',
        'searchResults',
      ];
      for (const id of listIds) {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '';
      }

      // Clear search input
      const searchInput = document.getElementById('searchInput');
      if (searchInput) searchInput.value = '';

      // Reset genre / filter selects to defaults
      const selectIds = [
        'moviesGenreSelect',
        'seriesGenreSelect',
        'musicGenreSelect',
        'moviesSortSelect',
        'seriesSortSelect',
        'musicSortSelect',
        'moviesFilterSelect',
        'seriesFilterSelect',
        'musicViewSelect',
      ];
      for (const id of selectIds) {
        const el = document.getElementById(id);
        if (el) el.selectedIndex = 0;
      }

      // Hide filter panels
      const filterPanelIds = ['moviesFilterPanel', 'seriesFilterPanel', 'musicFilterPanel'];
      for (const id of filterPanelIds) {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
      }

      // Reset active tab to Home
      const tabButtons = document.querySelectorAll('.tab-button');
      const tabContents = document.querySelectorAll('.tab-content');
      tabButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === 'home'));
      tabContents.forEach((content) => content.classList.remove('active'));
      const homeTab = document.getElementById('homeTab');
      if (homeTab) homeTab.classList.add('active');
    },

    scrollToTop() {
      window.scrollTo({ top: 0, behavior: 'instant' });
    },

    async loadRecentItems() {
      debugLog('loadRecentItems called');
      if (!this.currentServer || !this.currentUser) {
        debugLog('Missing server or user, skipping loadRecentItems');
        return;
      }

      debugLog('Loading recent items for user:', this.currentUser.Name);
      const recentList = document.getElementById('recentList');
      recentList.innerHTML = '<div class="loading">Loading recent items...</div>';
      const requestId = this.nextRequestId('recent');

      try {
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
            Authorization: this.buildAuthorizationHeader(this.currentServer.accessToken),
          },
        });

        debugLog('=== HTTP RESPONSE RECEIVED ===');
        debugLog('Response data:', response.data);
        debugLog('Response data type:', typeof response.data);
        debugLog('Response data is array:', Array.isArray(response.data));

        if (!this.isLatestRequest('recent', requestId)) return;

        if (response.data && Array.isArray(response.data)) {
          this.renderMediaList(response.data, recentList);
        } else {
          recentList.innerHTML = '<div class="empty-state">No recent items found</div>';
        }
      } catch (error) {
        debugLog('Error loading recent items:', error);
        if (!this.isLatestRequest('recent', requestId)) return;
        recentList.innerHTML = '<div class="error">Failed to load recent items</div>';
      }
    },

    async loadHomeTab() {
      if (!this.currentServer || !this.currentUser) return;

      await Promise.all([this.loadContinueWatching(), this.loadNextUp(), this.loadRecentItems()]);
      this.scrollToTop();
    },

    async loadContinueWatching() {
      if (!this.currentServer || !this.currentUser) return;

      const container = document.getElementById('continueWatchingList');
      container.innerHTML = '<div class="loading">Loading...</div>';
      const requestId = this.nextRequestId('continueWatching');

      try {
        const params = new URLSearchParams({
          userId: this.currentUser.Id,
          Limit: 10,
          MediaTypes: 'Video',
          Fields:
            'Overview,UserData,RunTimeTicks,SeriesName,ProductionYear,ParentIndexNumber,IndexNumber,SeriesId,ImageTags,BackdropImageTags',
        });

        const fullUrl = `${this.currentServer.url}/UserItems/Resume?${params.toString()}`;

        const response = await this.getHttpClient().get(fullUrl, {
          headers: {
            Authorization: this.buildAuthorizationHeader(this.currentServer.accessToken),
          },
        });

        if (!this.isLatestRequest('continueWatching', requestId)) return;

        if (response.data && response.data.Items && response.data.Items.length > 0) {
          this.renderMediaList(response.data.Items, container);
        } else {
          container.innerHTML = '<div class="empty-state">Nothing to resume</div>';
        }
      } catch (error) {
        debugLog('Error loading continue watching:', error);
        if (!this.isLatestRequest('continueWatching', requestId)) return;
        container.innerHTML = '<div class="error">Failed to load</div>';
      }
    },

    async loadNextUp() {
      if (!this.currentServer || !this.currentUser) return;

      const container = document.getElementById('nextUpList');
      container.innerHTML = '<div class="loading">Loading...</div>';
      const requestId = this.nextRequestId('nextUp');

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
            Authorization: this.buildAuthorizationHeader(this.currentServer.accessToken),
          },
        });

        if (!this.isLatestRequest('nextUp', requestId)) return;

        if (response.data && response.data.Items && response.data.Items.length > 0) {
          this.renderMediaList(response.data.Items, container);
        } else {
          container.innerHTML = '<div class="empty-state">No upcoming episodes</div>';
        }
      } catch (error) {
        debugLog('Error loading next up:', error);
        if (!this.isLatestRequest('nextUp', requestId)) return;
        container.innerHTML = '<div class="error">Failed to load</div>';
      }
    },

    loadMovies(startIndex = 0, button = null) {
      return this.loadLibraryPage('movies', 'Movie', startIndex, button);
    },

    loadSeries(startIndex = 0, button = null) {
      return this.loadLibraryPage('series', 'Series', startIndex, button);
    },

    /**
     * One page of the Movies or Series tab, by its filters. Page 1 replaces
     * the list; later pages come from its "Load more" button.
     */
    async loadLibraryPage(section, itemType, startIndex, button) {
      if (!this.currentServer || !this.currentUser) return;

      const container = document.getElementById(`${section}List`);
      if (!button) container.innerHTML = `<div class="loading">Loading ${section}...</div>`;
      const requestId = this.pageRequestId(section, button);

      try {
        const sortValue = document.getElementById(`${section}SortSelect`).value.split(',');
        const filterValue = document.getElementById(`${section}FilterSelect`).value;
        const genreValue = document.getElementById(`${section}GenreSelect`).value;

        const params = new URLSearchParams({
          userId: this.currentUser.Id,
          IncludeItemTypes: itemType,
          Recursive: true,
          SortBy: sortValue[0],
          SortOrder: sortValue[1],
          // The episode count, for series only: it tells which have nothing
          // to play.
          Fields: `Overview,UserData,RunTimeTicks,ProductionYear,ImageTags,BackdropImageTags${itemType === 'Series' ? ',RecursiveItemCount' : ''}`,
          EnableImageTypes: 'Primary,Backdrop,Thumb',
          StartIndex: startIndex,
          Limit: PAGE_SIZE,
        });

        if (filterValue === 'unwatched') {
          params.append('IsPlayed', 'false');
        } else if (filterValue === 'favorites') {
          params.append('Filters', 'IsFavorite');
        }

        if (genreValue !== 'all') {
          params.append('Genres', genreValue);
        }

        const fullUrl = `${this.currentServer.url}/Items?${params.toString()}`;

        const response = await this.getHttpClient().get(fullUrl, {
          headers: {
            Authorization: this.buildAuthorizationHeader(this.currentServer.accessToken),
          },
        });

        if (!this.isLatestRequest(section, requestId)) return;

        this.renderPage(container, response, {
          startIndex,
          button,
          emptyHtml: `<div class="empty-state">No ${section} found</div>`,
          // A series without a single episode (an empty folder, or only
          // metadata) has nothing to browse. Only a count the server gives
          // as 0 hides it; without one the series stays.
          filter: itemType === 'Series' ? (item) => item.RecursiveItemCount !== 0 : null,
          render: (items, append) => this.renderMediaList(items, container, { append }),
          loadMore: (next, nextButton) => this.loadLibraryPage(section, itemType, next, nextButton),
        });
      } catch (error) {
        debugLog(`Error loading ${section}:`, error);
        if (!this.isLatestRequest(section, requestId)) return;
        this.pageFailed(container, button, `<div class="error">Failed to load ${section}</div>`);
      }
    },

    /**
     * The ticket for a page. A further page keeps the list's ticket, so
     * changing a filter while it loads still drops its reply.
     */
    pageRequestId(key, button) {
      if (button && this.requestIds && this.requestIds[key] !== undefined) {
        return this.requestIds[key];
      }
      return this.nextRequestId(key);
    },

    /**
     * Show one page of a list. Jellyfin pages large libraries, so when it has
     * more than are shown a "Load more" button fetches the next page.
     *
     * filter drops items from the display only: the paging still counts every
     * item the server sent, or the next page would start in the wrong place.
     * A page with nothing left to show loads the next one by itself.
     */
    renderPage(container, response, { startIndex, button, emptyHtml, filter, render, loadMore }) {
      const data = response.data || {};
      const items = Array.isArray(data.Items) ? data.Items : [];
      if (button) button.remove();

      if (items.length === 0) {
        if (startIndex === 0) container.innerHTML = emptyHtml;
        return;
      }

      const visible = filter ? items.filter(filter) : items;
      this.visibleCounts = this.visibleCounts || {};
      const visibleSoFar =
        (startIndex === 0 ? 0 : this.visibleCounts[container.id] || 0) + visible.length;
      this.visibleCounts[container.id] = visibleSoFar;

      if (visible.length > 0) {
        render(visible, startIndex > 0);
      } else if (startIndex === 0) {
        container.innerHTML = '';
      }

      const shown = startIndex + items.length;
      const total = Number(data.TotalRecordCount);
      const hasMore = Number.isFinite(total) ? total > shown : items.length >= PAGE_SIZE;
      if (!hasMore) {
        if (visibleSoFar === 0) container.innerHTML = emptyHtml;
        return;
      }

      const more = document.createElement('button');
      more.className = 'button secondary load-more-btn';
      more.textContent = Number.isFinite(total) ? `Load more (${shown} of ${total})` : 'Load more';
      const loadNext = () => {
        if (more.disabled) return;
        more.disabled = true;
        more.textContent = 'Loading...';
        loadMore(shown, more);
      };
      more.addEventListener('click', (event) => {
        event.stopPropagation();
        loadNext();
      });
      container.appendChild(more);
      if (visible.length === 0) loadNext();
    },

    pageFailed(container, button, errorHtml) {
      if (button) {
        button.disabled = false;
        button.textContent = 'Failed to load more - try again';
      } else {
        container.innerHTML = errorHtml;
      }
    },

    debounceSearch(term) {
      if (this.searchTimeout) {
        clearTimeout(this.searchTimeout);
      }

      this.searchTimeout = setTimeout(() => {
        this.search(term);
      }, 500);
    },

    getSelectedSearchTypes() {
      const activeChips = document.querySelectorAll('.search-type-chip.active');
      return Array.from(activeChips).map((chip) => chip.dataset.type);
    },

    async search(term) {
      // Take the ticket before any early return: clearing the box or the type
      // chips must also invalidate a search still in flight, or its slow reply
      // would replace the prompt shown below.
      const requestId = this.nextRequestId('search');

      if (!this.currentServer || !this.currentUser || !term.trim()) {
        document.getElementById('searchResults').innerHTML =
          '<div class="empty-state">Enter a search term above</div>';
        return;
      }

      const selectedTypes = this.getSelectedSearchTypes();
      const searchResults = document.getElementById('searchResults');

      if (selectedTypes.length === 0) {
        searchResults.innerHTML =
          '<div class="empty-state">Select at least one media type to search</div>';
        return;
      }

      searchResults.innerHTML = '<div class="loading">Searching...</div>';

      try {
        const params = new URLSearchParams({
          userId: this.currentUser.Id,
          searchTerm: term,
          limit: 20,
          includeItemTypes: selectedTypes.join(','),
        });

        const fullUrl = `${this.currentServer.url}/Search/Hints?${params.toString()}`;

        const response = await this.getHttpClient().get(fullUrl, {
          headers: {
            Authorization: this.buildAuthorizationHeader(this.currentServer.accessToken),
          },
        });

        if (!this.isLatestRequest('search', requestId)) return;

        if (response.data && response.data.SearchHints) {
          this.renderSearchResults(response.data.SearchHints, searchResults);
        } else {
          searchResults.innerHTML = '<div class="empty-state">No results found</div>';
        }
      } catch (error) {
        debugLog('Search error:', error);
        if (!this.isLatestRequest('search', requestId)) return;
        searchResults.innerHTML = '<div class="error">Search failed</div>';
      }
    },

    renderMediaList(items, container, { append = false } = {}) {
      debugLog('renderMediaList called with ' + (items?.length || 0) + ' items');
      if (!items || items.length === 0) {
        if (!append) container.innerHTML = '<div class="empty-state">No items found</div>';
        return;
      }

      if (!append) container.innerHTML = '';
      items.forEach((item) => {
        debugLog('Creating media item element for: ' + item.Name + ' ' + item.Type);
        const itemEl = this.createMediaItemElement(item);
        container.appendChild(itemEl);
      });
      debugLog('Finished rendering ' + items.length + ' media items');
    },

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
    },

    getThumbnailUrl(item, maxWidth = 160) {
      if (!this.currentServer) return null;
      const base = this.currentServer.url;

      if (item.Type === 'Episode') {
        if (item.ImageTags && item.ImageTags.Primary) {
          return `${base}/Items/${item.Id}/Images/Primary?maxWidth=${maxWidth}&quality=90`;
        }
        if (item.SeriesId) {
          return `${base}/Items/${item.SeriesId}/Images/Thumb?maxWidth=${maxWidth}&quality=90`;
        }
      }

      if (item.ImageTags && item.ImageTags.Thumb) {
        return `${base}/Items/${item.Id}/Images/Thumb?maxWidth=${maxWidth}&quality=90`;
      }
      if (item.ImageTags && item.ImageTags.Primary) {
        return `${base}/Items/${item.Id}/Images/Primary?maxWidth=${maxWidth}&quality=90`;
      }
      if (item.BackdropImageTags && item.BackdropImageTags.length > 0) {
        return `${base}/Items/${item.Id}/Images/Backdrop?maxWidth=${maxWidth * 2}&quality=90`;
      }
      return null;
    },

    formatRuntime(ticks) {
      if (!ticks) return '';
      const totalMinutes = Math.floor(ticks / 600000000);
      // Anything under a minute (a short track, an intro) would read "0m".
      if (totalMinutes === 0) return `${Math.max(1, Math.floor(ticks / 10000000))}s`;
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;
      if (hours > 0) return `${hours}h ${minutes}m`;
      return `${minutes}m`;
    },

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
        // ?? not ||: specials are season 0, and episode 0 exists too
        const season = item.ParentIndexNumber ?? '?';
        const episode = item.IndexNumber ?? '?';
        subtitle = `${item.SeriesName} - S${season}E${episode}`;
      } else if (item.Type === 'Series') {
        subtitle = 'TV Series';
      } else if (item.Type === 'Movie') {
        subtitle = 'Movie';
      } else if (item.Type === 'MusicAlbum') {
        subtitle = item.AlbumArtist || 'Album';
      } else if (item.Type === 'Audio') {
        const artist = item.AlbumArtist || item.Artists?.join(', ') || '';
        const album = item.Album || '';
        subtitle = [artist, album].filter(Boolean).join(' — ');
      }

      const thumbHtml = thumbUrl
        ? `<div class="thumb-wrapper">
           <img class="list-thumb" src="${this.escapeHtml(thumbUrl)}" loading="lazy" alt="" onerror="this.parentElement.classList.add('thumb-fallback'); this.style.display='none';" />
           <div class="play-overlay">&#9654;</div>
         </div>`
        : `<div class="thumb-wrapper thumb-fallback"><div class="play-overlay">&#9654;</div></div>`;

      itemEl.innerHTML = `
            ${thumbHtml}
            <div class="list-body">
                <div class="media-title">${this.escapeHtml(title)}${this.escapeHtml(year)}</div>
                ${subtitle ? `<div class="media-subtitle">${this.escapeHtml(subtitle)}</div>` : ''}
                <div class="media-meta">${this.escapeHtml(type)}</div>
                <div class="media-actions">
                    <button class="button media-action-btn" data-action="select">
                        ${item.Type === 'Series' ? 'Browse Episodes' : item.Type === 'MusicAlbum' ? 'View Tracks' : 'Play'}
                    </button>
                    <button class="button secondary media-action-btn" data-action="open-jellyfin">
                        Jellyfin
                    </button>
                </div>
            </div>
            ${duration ? `<div class="list-duration">${duration}</div>` : ''}
        `;

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
    },

    createSearchItemElement(hint) {
      const itemEl = document.createElement('div');
      itemEl.className = 'media-item';
      itemEl.dataset.itemId = hint.ItemId;
      itemEl.dataset.itemType = hint.Type;

      const title = hint.Name || 'Unknown Title';
      const year = hint.ProductionYear ? ` (${hint.ProductionYear})` : '';
      const type = hint.Type;
      const duration = this.formatRuntime(hint.RunTimeTicks);

      let thumbUrl = null;
      if (this.currentServer) {
        const base = this.currentServer.url;
        if (hint.ThumbImageTag && hint.ThumbImageItemId) {
          thumbUrl = `${base}/Items/${hint.ThumbImageItemId}/Images/Thumb?maxWidth=160&quality=90`;
        } else if (hint.PrimaryImageTag) {
          thumbUrl = `${base}/Items/${hint.ItemId}/Images/Primary?maxWidth=160&quality=90`;
        } else if (hint.BackdropImageTag && hint.BackdropImageItemId) {
          thumbUrl = `${base}/Items/${hint.BackdropImageItemId}/Images/Backdrop?maxWidth=320&quality=90`;
        }
      }

      const thumbHtml = thumbUrl
        ? `<div class="thumb-wrapper">
           <img class="list-thumb" src="${this.escapeHtml(thumbUrl)}" loading="lazy" alt="" onerror="this.parentElement.classList.add('thumb-fallback'); this.style.display='none';" />
           <div class="play-overlay">&#9654;</div>
         </div>`
        : `<div class="thumb-wrapper thumb-fallback"><div class="play-overlay">&#9654;</div></div>`;

      itemEl.innerHTML = `
            ${thumbHtml}
            <div class="list-body">
                <div class="media-title">${this.escapeHtml(title)}${this.escapeHtml(year)}</div>
                <div class="media-meta">${this.escapeHtml(type)}</div>
                <div class="media-actions">
                    <button class="button search-action-btn" data-action="select">
                        ${hint.Type === 'Series' ? 'Browse Episodes' : hint.Type === 'MusicAlbum' ? 'View Tracks' : 'Play'}
                    </button>
                    <button class="button secondary search-action-btn" data-action="open-jellyfin">
                        Open in Jellyfin
                    </button>
                </div>
            </div>
            ${duration ? `<div class="list-duration">${duration}</div>` : ''}
        `;

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
    },

    selectMediaItem(item) {
      debugLog('selectMediaItem called', {
        id: item?.Id,
        type: item?.Type,
        name: item?.Name,
      });
      this.selectedItem = item;
      // A search result still being looked up must not replace this choice.
      this.nextRequestId('searchItem');

      document.querySelectorAll('.media-item').forEach((el) => el.classList.remove('selected'));
      // The item is not always on screen (e.g. selected from search results)
      // Escaped so an id with a quote or backslash cannot break the selector.
      const quotedId = String(item.Id).replace(/["\\]/g, '\\$&');
      const selectedEl = document.querySelector(`[data-item-id="${quotedId}"]`);
      if (selectedEl) {
        selectedEl.classList.add('selected');
      }

      if (item.Type === 'Series') {
        debugLog('Item is a Series, showing episode selection');
        this.showEpisodeSelection(item);
      } else if (item.Type === 'MusicAlbum') {
        debugLog('Item is a MusicAlbum, showing album tracks');
        this.showAlbumTracks(item);
      } else {
        debugLog('Item is not a Series or Album, playing media: ' + item.Type);
        this.playMedia(item);
      }
    },

    async selectSearchItem(hint) {
      // A result chosen before signing out or switching server must not
      // start playing once its slow reply arrives.
      const requestId = this.nextRequestId('searchItem');

      try {
        const params = new URLSearchParams({
          userId: this.currentUser.Id,
        });

        const response = await this.getHttpClient().get(
          `${this.currentServer.url}/Items/${hint.ItemId}?${params.toString()}`,
          {
            headers: {
              Authorization: this.buildAuthorizationHeader(this.currentServer.accessToken),
            },
          }
        );

        if (!this.isLatestRequest('searchItem', requestId)) return;

        if (response.data) {
          this.selectMediaItem(response.data);
        }
      } catch (error) {
        if (!this.isLatestRequest('searchItem', requestId)) return;
        // The webview has no core API — iina here only exposes postMessage and
        // onMessage — so report failures in the UI, not through an OSD.
        debugLog('Error getting item details:', error);
        const searchResults = document.getElementById('searchResults');
        if (searchResults) {
          searchResults.innerHTML = '<div class="error">Failed to open item</div>';
        }
      }
    },

    async showEpisodeSelection(series) {
      document.getElementById('episodeSection').style.display = 'block';
      document.getElementById('mainContent').style.display = 'none';

      // Clear stale episodes and reset state from any previously viewed series
      document.getElementById('episodeList').innerHTML =
        '<div class="loading">Select a season</div>';
      this.selectedEpisode = null;
      this.selectedSeason = null;
      document.getElementById('playEpisodeBtn').disabled = true;
      document.getElementById('openEpisodeInJellyfinBtn').disabled = true;
      // A slower response for a series viewed before this one must not fill
      // the season list, and its episodes must not land under this series.
      const requestId = this.nextRequestId('seasons');
      this.nextRequestId('episodes');
      // The previous series' seasons must not be pickable while these load.
      document.getElementById('seasonSelect').innerHTML =
        '<option value="">Loading seasons...</option>';

      try {
        const params = new URLSearchParams({
          userId: this.currentUser.Id,
        });

        const response = await this.getHttpClient().get(
          `${this.currentServer.url}/Shows/${series.Id}/Seasons?${params.toString()}`,
          {
            headers: {
              Authorization: this.buildAuthorizationHeader(this.currentServer.accessToken),
            },
          }
        );

        if (!this.isLatestRequest('seasons', requestId)) return;

        const seasonSelect = document.getElementById('seasonSelect');
        seasonSelect.innerHTML = '<option value="">Select a season...</option>';

        if (response.data && response.data.Items) {
          response.data.Items.forEach((season) => {
            // Jellyfin can send null for an unnumbered season. It is listed by
            // name rather than as "Season null", and not hidden, or its
            // episodes could not be reached at all.
            const isNumbered = season.IndexNumber !== undefined && season.IndexNumber !== null;
            const label = isNumbered ? `Season ${season.IndexNumber}` : season.Name;
            if (!label) return;
            const option = document.createElement('option');
            option.value = season.Id;
            option.textContent = label;
            seasonSelect.appendChild(option);
          });
        }
      } catch (error) {
        if (!this.isLatestRequest('seasons', requestId)) return;
        debugLog('Error loading seasons:', error);
        document.getElementById('seasonSelect').innerHTML =
          '<option value="">No seasons loaded</option>';
        document.getElementById('episodeList').innerHTML =
          '<div class="error">Failed to load seasons</div>';
      }
    },

    async loadEpisodes(seasonId) {
      if (!seasonId) {
        document.getElementById('episodeList').innerHTML =
          '<div class="loading">Select a season</div>';
        return;
      }

      const episodeList = document.getElementById('episodeList');
      episodeList.innerHTML = '<div class="loading">Loading episodes...</div>';
      const requestId = this.nextRequestId('episodes');

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
              Authorization: this.buildAuthorizationHeader(this.currentServer.accessToken),
            },
          }
        );

        if (!this.isLatestRequest('episodes', requestId)) return;

        if (response.data && response.data.Items) {
          episodeList.innerHTML = '';
          response.data.Items.forEach((episode) => {
            const episodeEl = document.createElement('div');
            const isAvailable = this.isEpisodeAvailable(episode);

            episodeEl.className = `episode-item ${!isAvailable ? 'unavailable' : ''}`;
            episodeEl.dataset.episodeId = episode.Id;
            episodeEl.dataset.available = isAvailable.toString();

            const episodeNum = episode.IndexNumber ?? '?';
            const title = episode.Name || `Episode ${episodeNum}`;
            const duration = this.formatRuntime(episode.RunTimeTicks);

            let episodeThumbUrl = null;
            if (this.currentServer) {
              const base = this.currentServer.url;
              if (episode.ImageTags && episode.ImageTags.Primary) {
                episodeThumbUrl = `${base}/Items/${episode.Id}/Images/Primary?maxWidth=120&quality=90`;
              } else if (this.selectedItem && this.selectedItem.Id) {
                episodeThumbUrl = `${base}/Items/${this.selectedItem.Id}/Images/Thumb?maxWidth=120&quality=90`;
              }
            }

            const episodeThumbHtml = episodeThumbUrl
              ? `<div class="ep-thumb-wrapper">
                 <img class="ep-thumb" src="${this.escapeHtml(episodeThumbUrl)}" loading="lazy" alt="" onerror="this.parentElement.classList.add('thumb-fallback'); this.style.display='none';" />
               </div>`
              : `<div class="ep-thumb-wrapper thumb-fallback"></div>`;

            const availabilityIcon = isAvailable
              ? ''
              : ' <span class="unavailable-icon" title="Episode not available on server">⚠️</span>';

            episodeEl.innerHTML = `
            ${episodeThumbHtml}
            <div class="ep-body">
              <span class="ep-title">${this.escapeHtml(episodeNum)}. ${this.escapeHtml(title)}${availabilityIcon}</span>
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
        if (!this.isLatestRequest('episodes', requestId)) return;
        episodeList.innerHTML = '<div class="error">Failed to load episodes</div>';
      }
    },

    playSelectedEpisode() {
      if (this.selectedEpisode) {
        this.playMedia(this.selectedEpisode);
      }
    },

    openSelectedEpisodeInJellyfin() {
      debugLog('openSelectedEpisodeInJellyfin called');

      if (this.selectedEpisode) {
        debugLog(`Opening selected episode in Jellyfin: ${this.selectedEpisode.Name}`);
        this.openInJellyfin(this.selectedEpisode);
      } else {
        debugLog('No episode selected');
      }
    },

    hideEpisodeSelection(returnToMain = true) {
      document.getElementById('episodeSection').style.display = 'none';
      if (returnToMain) {
        document.getElementById('mainContent').style.display = 'block';
      }
      this.selectedEpisode = null;
      this.selectedSeason = null;
      document.getElementById('playEpisodeBtn').disabled = true;
      document.getElementById('openEpisodeInJellyfinBtn').disabled = true;
      // Clear episode list and season dropdown so stale data isn't shown next time
      document.getElementById('episodeList').innerHTML = '';
      document.getElementById('seasonSelect').innerHTML = '';
    },

    /**
     * The item's details page in Jellyfin's web client. 10.9 moved its routes
     * from "#!/" to "#/" and only redirects the old form as deprecated, while
     * 10.8 and older only know "#!/". The serverId tells the web client which
     * of its servers the item is on.
     */
    buildJellyfinWebUrl(item) {
      const server = this.currentServer;
      const [major, minor] = String(server.version || '')
        .split('.')
        .map(Number);
      const modern = major > 10 || (major === 10 && minor >= 9);
      const params = [`id=${encodeURIComponent(item.Id)}`];
      if (server.jellyfinServerId) {
        params.push(`serverId=${encodeURIComponent(server.jellyfinServerId)}`);
      }
      return `${server.url}/web/index.html#${modern ? '' : '!'}/details?${params.join('&')}`;
    },

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

        const jellyfinUrl = this.buildJellyfinWebUrl(item);

        debugLog(`Constructed Jellyfin URL: ${jellyfinUrl}`);
        debugLog('Using IINA postMessage API to open URL in default browser');

        const messageData = {
          url: jellyfinUrl,
          title: `${item.Name} - Jellyfin`,
        };

        debugLog('Sending message', {
          url: messageData.url,
          title: messageData.title,
        });
        iina.postMessage('open-external-url', messageData);

        debugLog('Successfully sent open-external-url message to IINA');
      } catch (error) {
        // No core API in the webview; the plugin shows the OSD for this action
        debugLog(`Failed to open Jellyfin page: ${error.message}`);
      }
    },

    isEpisodeAvailable(episode) {
      try {
        if (episode.LocationType && episode.LocationType === 'Virtual') {
          debugLog(`Episode ${episode.Name} marked as Virtual (unavailable)`);
          return false;
        }

        if (!episode.MediaSources || episode.MediaSources.length === 0) {
          debugLog(`Episode ${episode.Name} has no MediaSources`);
          return false;
        }

        // Filesystem paths are deliberately not checked: Jellyfin withholds
        // Path from non-admin accounts, and an episode that is playable by
        // streaming does not need one. LocationType and MediaSources already
        // say whether the file exists on the server, which is the same test
        // the autoplay manager uses.

        if (episode.IsFolder === true) {
          debugLog(`Episode ${episode.Name} marked as folder`);
          return false;
        }

        debugLog(`Episode ${episode.Name} appears to be available`);
        return true;
      } catch (error) {
        debugLog(`Error checking episode availability for ${episode.Name}: ${error.message}`);
        return false;
      }
    },

    /**
     * One page of the Music tab in its current view (albums, artists or
     * songs). Page 1 replaces the list; later pages come from "Load more".
     */
    async loadMusic(startIndex = 0, button = null) {
      if (!this.currentServer || !this.currentUser) return;

      const container = document.getElementById('musicList');
      if (!button) container.innerHTML = '<div class="loading">Loading music...</div>';
      const requestId = this.pageRequestId('music', button);

      try {
        const viewMode = document.getElementById('musicViewSelect').value;
        const sortValue = document.getElementById('musicSortSelect').value.split(',');
        const genreValue = document.getElementById('musicGenreSelect').value;

        const views = {
          artists: {
            path: 'Artists',
            viewType: 'artist',
            empty: 'No artists found',
            params: { Fields: 'Overview,UserData,ImageTags,BackdropImageTags' },
          },
          songs: {
            path: 'Items',
            viewType: 'song',
            empty: 'No songs found',
            params: {
              IncludeItemTypes: 'Audio',
              Recursive: true,
              Fields:
                'Overview,UserData,RunTimeTicks,ProductionYear,ImageTags,AlbumArtist,Album,AlbumId',
            },
          },
          albums: {
            path: 'Items',
            viewType: 'album',
            empty: 'No albums found',
            params: {
              IncludeItemTypes: 'MusicAlbum',
              Recursive: true,
              Fields:
                'Overview,UserData,RunTimeTicks,ProductionYear,ImageTags,BackdropImageTags,AlbumArtist,ChildCount',
            },
          },
        };
        const view = views[viewMode] || views.albums;

        const params = new URLSearchParams({
          userId: this.currentUser.Id,
          ...view.params,
          SortBy: sortValue[0],
          SortOrder: sortValue[1],
          EnableImageTypes: 'Primary',
          StartIndex: startIndex,
          Limit: PAGE_SIZE,
        });

        if (genreValue !== 'all') {
          params.append('Genres', genreValue);
        }

        const fullUrl = `${this.currentServer.url}/${view.path}?${params.toString()}`;

        const response = await this.getHttpClient().get(fullUrl, {
          headers: {
            Authorization: this.buildAuthorizationHeader(this.currentServer.accessToken),
          },
        });

        if (!this.isLatestRequest('music', requestId)) return;

        this.renderPage(container, response, {
          startIndex,
          button,
          emptyHtml: `<div class="empty-state">${view.empty}</div>`,
          render: (items, append) =>
            this.renderMusicList(items, container, view.viewType, { append }),
          loadMore: (next, nextButton) => this.loadMusic(next, nextButton),
        });
      } catch (error) {
        debugLog('Error loading music:', error);
        if (!this.isLatestRequest('music', requestId)) return;
        this.pageFailed(container, button, '<div class="error">Failed to load music</div>');
      }
    },

    async loadMusicGenres() {
      if (!this.currentServer || !this.currentUser) return;
      const requestId = this.nextRequestId('musicGenres');

      try {
        const params = new URLSearchParams({
          userId: this.currentUser.Id,
          IncludeItemTypes: 'MusicAlbum,Audio',
        });

        const fullUrl = `${this.currentServer.url}/MusicGenres?${params.toString()}`;

        const response = await this.getHttpClient().get(fullUrl, {
          headers: {
            Authorization: this.buildAuthorizationHeader(this.currentServer.accessToken),
          },
        });

        if (!this.isLatestRequest('musicGenres', requestId)) return;

        if (response.data && response.data.Items) {
          const musicGenreSelect = document.getElementById('musicGenreSelect');
          let optionsHtml = '<option value="all" selected>All Genres</option>';

          response.data.Items.forEach((genre) => {
            const genreName = this.escapeHtml(genre.Name);
            optionsHtml += `<option value="${genreName}">${genreName}</option>`;
          });

          musicGenreSelect.innerHTML = optionsHtml;
        }
      } catch (error) {
        debugLog('Error loading music genres:', error);
      }
    },

    getMusicThumbnailUrl(item, maxWidth = 96) {
      if (!this.currentServer) return null;
      const base = this.currentServer.url;

      if (item.ImageTags && item.ImageTags.Primary) {
        return `${base}/Items/${item.Id}/Images/Primary?maxWidth=${maxWidth}&quality=90`;
      }
      if (item.AlbumId) {
        return `${base}/Items/${item.AlbumId}/Images/Primary?maxWidth=${maxWidth}&quality=90`;
      }
      if (item.BackdropImageTags && item.BackdropImageTags.length > 0) {
        return `${base}/Items/${item.Id}/Images/Backdrop?maxWidth=${maxWidth * 2}&quality=90`;
      }
      return null;
    },

    renderMusicList(items, container, viewType, { append = false } = {}) {
      debugLog('renderMusicList called with ' + (items?.length || 0) + ' items, view: ' + viewType);
      if (!items || items.length === 0) {
        if (!append) container.innerHTML = '<div class="empty-state">No items found</div>';
        return;
      }

      if (!append) container.innerHTML = '';
      items.forEach((item) => {
        const itemEl = this.createMusicItemElement(item, viewType);
        container.appendChild(itemEl);
      });
    },

    createMusicItemElement(item, viewType) {
      const itemEl = document.createElement('div');
      itemEl.className = 'music-item';
      itemEl.dataset.itemId = item.Id;
      itemEl.dataset.itemType = item.Type;

      const title = item.Name || 'Unknown Title';
      const thumbUrl = this.getMusicThumbnailUrl(item);
      const duration = this.formatRuntime(item.RunTimeTicks);

      let subtitle = '';
      let fallbackIcon = '\ud83c\udfb5';

      if (viewType === 'album') {
        subtitle = item.AlbumArtist || item.AlbumArtists?.map((a) => a.Name).join(', ') || '';
        const trackCount = item.ChildCount ? `${item.ChildCount} tracks` : '';
        const year = item.ProductionYear ? `${item.ProductionYear}` : '';
        const metaParts = [year, trackCount].filter(Boolean);
        subtitle = [subtitle, metaParts.join(' \u00b7 ')].filter(Boolean).join(' \u2014 ');
        fallbackIcon = '\ud83d\udcbf';
      } else if (viewType === 'artist') {
        subtitle = 'Artist';
        fallbackIcon = '\ud83c\udfa4';
      } else if (viewType === 'song') {
        const artist = item.AlbumArtist || item.AlbumArtists?.map((a) => a.Name).join(', ') || '';
        const album = item.Album || '';
        subtitle = [artist, album].filter(Boolean).join(' \u2014 ');
        fallbackIcon = '\ud83c\udfb5';
      }

      const thumbHtml = thumbUrl
        ? `<div class="album-thumb-wrapper">
           <img class="album-thumb" src="${this.escapeHtml(thumbUrl)}" loading="lazy" alt="" onerror="this.parentElement.classList.add('thumb-fallback'); this.style.display='none'; this.parentElement.textContent='${fallbackIcon}';" />
         </div>`
        : `<div class="album-thumb-wrapper thumb-fallback">${fallbackIcon}</div>`;

      let actionLabel = 'Play';
      if (viewType === 'album') {
        actionLabel = 'View Tracks';
      } else if (viewType === 'artist') {
        actionLabel = 'View Albums';
      }

      itemEl.innerHTML = `
        ${thumbHtml}
        <div class="list-body">
          <div class="media-title">${this.escapeHtml(title)}</div>
          ${subtitle ? `<div class="media-subtitle">${this.escapeHtml(subtitle)}</div>` : ''}
          <div class="media-actions">
            <button class="button media-action-btn" data-action="select">${actionLabel}</button>
            <button class="button secondary media-action-btn" data-action="open-jellyfin">Jellyfin</button>
          </div>
        </div>
        ${duration ? `<div class="list-duration">${duration}</div>` : ''}
      `;

      const actionButtons = itemEl.querySelectorAll('.media-action-btn');
      actionButtons.forEach((button) => {
        button.addEventListener('click', (e) => {
          e.stopPropagation();
          const action = button.dataset.action;
          if (action === 'select') {
            this.selectMusicItem(item, viewType);
          } else if (action === 'open-jellyfin') {
            this.openInJellyfin(item);
          }
        });
      });

      itemEl.addEventListener('click', () => {
        this.selectMusicItem(item, viewType);
      });

      return itemEl;
    },

    selectMusicItem(item, viewType) {
      debugLog('selectMusicItem called', {
        id: item?.Id,
        type: item?.Type,
        name: item?.Name,
        viewType,
      });

      if (viewType === 'album' || item.Type === 'MusicAlbum') {
        this.showAlbumTracks(item);
      } else if (viewType === 'artist' || item.Type === 'MusicArtist') {
        this.showArtistAlbums(item);
      } else {
        // Song - play directly
        this.playMedia(item);
      }
    },

    async showArtistAlbums(artist, startIndex = 0, button = null) {
      if (!this.currentServer || !this.currentUser) return;

      const container = document.getElementById('musicList');
      if (!button) container.innerHTML = '<div class="loading">Loading albums...</div>';
      const requestId = this.pageRequestId('music', button);

      try {
        const params = new URLSearchParams({
          userId: this.currentUser.Id,
          IncludeItemTypes: 'MusicAlbum',
          Recursive: true,
          SortBy: 'ProductionYear,SortName',
          SortOrder: 'Descending',
          AlbumArtistIds: artist.Id,
          Fields: 'Overview,UserData,RunTimeTicks,ProductionYear,ImageTags,AlbumArtist,ChildCount',
          EnableImageTypes: 'Primary',
          StartIndex: startIndex,
          Limit: PAGE_SIZE,
        });

        const fullUrl = `${this.currentServer.url}/Items?${params.toString()}`;

        const response = await this.getHttpClient().get(fullUrl, {
          headers: {
            Authorization: this.buildAuthorizationHeader(this.currentServer.accessToken),
          },
        });

        if (!this.isLatestRequest('music', requestId)) return;

        this.renderPage(container, response, {
          startIndex,
          button,
          emptyHtml: `<div class="empty-state">No albums found for ${this.escapeHtml(artist.Name)}</div>`,
          render: (items, append) => this.renderMusicList(items, container, 'album', { append }),
          loadMore: (next, nextButton) => this.showArtistAlbums(artist, next, nextButton),
        });
      } catch (error) {
        debugLog('Error loading artist albums:', error);
        if (!this.isLatestRequest('music', requestId)) return;
        this.pageFailed(container, button, '<div class="error">Failed to load albums</div>');
      }
    },

    async showAlbumTracks(album) {
      debugLog('showAlbumTracks called for album:', album.Name);

      document.getElementById('albumTracksSection').style.display = 'block';
      document.getElementById('mainContent').style.display = 'none';
      document.getElementById('albumTracksTitle').textContent =
        album.Name + (album.AlbumArtist ? ` — ${album.AlbumArtist}` : '');

      this.selectedAlbum = album;
      this.selectedTrack = null;
      document.getElementById('playAllTracksBtn').disabled = false;
      document.getElementById('openAlbumInJellyfinBtn').disabled = false;

      const tracksList = document.getElementById('albumTracksList');
      tracksList.innerHTML = '<div class="loading">Loading tracks...</div>';
      const requestId = this.nextRequestId('albumTracks');

      try {
        const params = new URLSearchParams({
          userId: this.currentUser.Id,
          ParentId: album.Id,
          SortBy: 'ParentIndexNumber,IndexNumber,SortName',
          SortOrder: 'Ascending',
          Fields: 'RunTimeTicks,MediaSources,Path,UserData,ImageTags,AlbumArtist,Artists',
          IncludeItemTypes: 'Audio',
        });

        const fullUrl = `${this.currentServer.url}/Items?${params.toString()}`;

        const response = await this.getHttpClient().get(fullUrl, {
          headers: {
            Authorization: this.buildAuthorizationHeader(this.currentServer.accessToken),
          },
        });

        if (!this.isLatestRequest('albumTracks', requestId)) return;

        if (response.data && response.data.Items && response.data.Items.length > 0) {
          this.albumTracks = response.data.Items;
          this.renderAlbumTracks(response.data.Items, tracksList);
        } else {
          this.albumTracks = [];
          tracksList.innerHTML = '<div class="empty-state">No tracks found</div>';
        }
      } catch (error) {
        debugLog('Error loading album tracks:', error);
        if (!this.isLatestRequest('albumTracks', requestId)) return;
        tracksList.innerHTML = '<div class="error">Failed to load tracks</div>';
      }
    },

    renderAlbumTracks(tracks, container) {
      container.innerHTML = '';

      tracks.forEach((track, index) => {
        const trackEl = document.createElement('div');
        trackEl.className = 'track-item';
        trackEl.dataset.trackId = track.Id;

        const trackNum = track.IndexNumber || index + 1;
        const title = track.Name || `Track ${trackNum}`;
        const duration = this.formatRuntime(track.RunTimeTicks);
        const artists = track.Artists?.join(', ') || track.AlbumArtist || '';

        trackEl.innerHTML = `
          <span class="track-number">${this.escapeHtml(trackNum)}</span>
          <div class="track-body">
            <span class="track-title">${this.escapeHtml(title)}</span>
            ${artists ? `<span class="track-artist">${this.escapeHtml(artists)}</span>` : ''}
          </div>
          ${duration ? `<span class="track-duration">${duration}</span>` : ''}
        `;

        trackEl.addEventListener('click', () => {
          document.querySelectorAll('.track-item').forEach((el) => el.classList.remove('selected'));
          trackEl.classList.add('selected');
          this.selectedTrack = track;
          this.playMedia(track);
        });

        container.appendChild(trackEl);
      });
    },

    playAllAlbumTracks() {
      if (!this.albumTracks || this.albumTracks.length === 0) {
        debugLog('No album tracks to play');
        return;
      }

      const items = this.albumTracks
        .map((track) => ({
          streamUrl: this.buildStreamUrl(track),
          title: track.Name || 'Unknown Title',
        }))
        .filter((item) => item.streamUrl);

      if (items.length === 0) {
        debugLog('No playable album tracks');
        return;
      }

      debugLog('Playing all album tracks, count:', items.length);

      if (typeof iina !== 'undefined' && iina.postMessage) {
        // The plugin plays the first track and appends the rest to the playlist
        iina.postMessage('play-media-list', { items });
      } else {
        debugLog('iina.postMessage not available, playing the first track only');
        this.playMedia(this.albumTracks[0]);
      }
    },

    openAlbumInJellyfin() {
      if (this.selectedAlbum) {
        this.openInJellyfin(this.selectedAlbum);
      }
    },

    hideAlbumTracks(returnToMain = true) {
      document.getElementById('albumTracksSection').style.display = 'none';
      if (returnToMain) {
        document.getElementById('mainContent').style.display = 'block';
      }
      this.selectedAlbum = null;
      this.selectedTrack = null;
      this.albumTracks = [];
      document.getElementById('albumTracksList').innerHTML = '';
      document.getElementById('playAllTracksBtn').disabled = true;
      document.getElementById('openAlbumInJellyfinBtn').disabled = true;
    },

    /**
     * Build a direct-play URL. The streaming routes are what Jellyfin's own
     * clients use; /Items/{id}/Download additionally requires the account to
     * have media download permission, which browsing does not.
     * static=true asks for the original file without transcoding.
     */
    buildStreamUrl(item) {
      if (!this.currentServer || !item || !item.Id) return null;
      const route = item.Type === 'Audio' ? 'Audio' : 'Videos';
      return `${this.currentServer.url}/${route}/${item.Id}/stream?static=true&ApiKey=${encodeURIComponent(this.currentServer.accessToken)}`;
    },

    /**
     * The title the player shows, in the plugin's own format (see
     * titleFromMetadata in media-actions.js). mpv names the playlist entry
     * after the first title it sees, so an episode sent by name alone would
     * stay just "Pilot" in the playlist.
     */
    mediaTitle(item) {
      const name = item.Name || 'Unknown Title';
      const isNumber = (value) => value !== undefined && value !== null;
      if (item.Type === 'Episode' && item.SeriesName) {
        let title = item.SeriesName;
        if (isNumber(item.ParentIndexNumber) && isNumber(item.IndexNumber)) {
          const pad = (value) => String(value).padStart(2, '0');
          title += ` S${pad(item.ParentIndexNumber)}E${pad(item.IndexNumber)}`;
        }
        return `${title} - ${name}`;
      }
      if (item.Type === 'Movie' && item.ProductionYear) {
        return `${name} (${item.ProductionYear})`;
      }
      return name;
    },

    async playMedia(item) {
      debugLog('playMedia called with item type:', item.Type, 'name:', item.Name, 'id:', item.Id);
      try {
        const streamUrl = this.buildStreamUrl(item);
        if (!streamUrl) {
          debugLog('Cannot build a stream URL: missing server or item id');
          return;
        }
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
            title: this.mediaTitle(item),
          });

          // The section is hidden by CSS, so its inline style starts empty;
          // only showEpisodeSelection() sets it to 'block'. Checking for
          // !== 'none' would treat a never-opened picker as open and bring
          // the main list back over the album tracks.
          if (document.getElementById('episodeSection').style.display === 'block') {
            this.hideEpisodeSelection();
          }
        } else {
          debugLog('iina.postMessage not available, opening in a new window');
          window.open(streamUrl, '_blank');
        }
      } catch (error) {
        debugLog('Error playing media:', error);
      }
    },
  };
};
