window.createSidebarMediaMethods = function createSidebarMediaMethods(debugLog) {
  return {
    showMainContent() {
      document.getElementById('mainContent').style.display = 'block';
      this.scrollToTop();
      this.loadGenres();
    },

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
    },

    hideMainContent() {
      document.getElementById('mainContent').style.display = 'none';
      this.hideEpisodeSelection();
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
    },

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
    },

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
    },

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
    },

    debounceSearch(term) {
      if (this.searchTimeout) {
        clearTimeout(this.searchTimeout);
      }

      this.searchTimeout = setTimeout(() => {
        this.search(term);
      }, 500);
    },

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
    },

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
      const token = this.currentServer.accessToken;

      if (item.Type === 'Episode') {
        if (item.ImageTags && item.ImageTags.Primary) {
          return `${base}/Items/${item.Id}/Images/Primary?maxWidth=${maxWidth}&quality=90&api_key=${token}`;
        }
        if (item.SeriesId) {
          return `${base}/Items/${item.SeriesId}/Images/Thumb?maxWidth=${maxWidth}&quality=90&api_key=${token}`;
        }
      }

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
    },

    formatRuntime(ticks) {
      if (!ticks) return '';
      const totalMinutes = Math.floor(ticks / 600000000);
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
      debugLog('selectMediaItem called with: ' + JSON.stringify(item));
      this.selectedItem = item;

      document.querySelectorAll('.media-item').forEach((el) => el.classList.remove('selected'));
      document.querySelector(`[data-item-id="${item.Id}"]`).classList.add('selected');

      if (item.Type === 'Series') {
        debugLog('Item is a Series, showing episode selection');
        this.showEpisodeSelection(item);
      } else {
        debugLog('Item is not a Series, playing media: ' + item.Type);
        this.playMedia(item);
      }
    },

    async selectSearchItem(hint) {
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
    },

    async showEpisodeSelection(series) {
      document.getElementById('episodeSection').style.display = 'block';
      document.getElementById('mainContent').style.display = 'none';

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
    },

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

    hideEpisodeSelection() {
      document.getElementById('episodeSection').style.display = 'none';
      document.getElementById('mainContent').style.display = 'block';
      this.selectedEpisode = null;
      this.selectedSeason = null;
      document.getElementById('playEpisodeBtn').disabled = true;
      document.getElementById('openEpisodeInJellyfinBtn').disabled = true;
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

        const jellyfinUrl = `${this.currentServer.url}/web/index.html#!/details?id=${item.Id}`;

        debugLog(`Constructed Jellyfin URL: ${jellyfinUrl}`);
        debugLog('Using IINA postMessage API to open URL in default browser');

        const messageData = {
          url: jellyfinUrl,
          title: `${item.Name} - Jellyfin`,
        };

        debugLog(`Sending message: ${JSON.stringify(messageData)}`);
        iina.postMessage('open-external-url', messageData);

        debugLog('Successfully sent open-external-url message to IINA');
      } catch (error) {
        debugLog('Error in openInJellyfin:', error);

        const errorMessage = `Failed to open Jellyfin page: ${error.message}`;
        if (typeof iina !== 'undefined' && iina.core && iina.core.osd) {
          iina.core.osd(errorMessage);
        }
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

        const hasValidPath = episode.MediaSources.some((source) => {
          return source.Path && source.Path.trim() !== '';
        });

        if (!hasValidPath) {
          debugLog(`Episode ${episode.Name} has no valid media paths`);
          return false;
        }

        if (!episode.Path || episode.Path.trim() === '') {
          debugLog(`Episode ${episode.Name} has no direct path`);
          return false;
        }

        if (episode.CanDownload === false) {
          debugLog(`Episode ${episode.Name} marked as not downloadable`);
          return false;
        }

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

    async playMedia(item) {
      debugLog('playMedia called with item type:', item.Type, 'name:', item.Name, 'id:', item.Id);
      try {
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

          if (document.getElementById('episodeSection').style.display !== 'none') {
            this.hideEpisodeSelection();
          }
        } else {
          debugLog('iina.postMessage not available, trying global object');
          if (typeof window !== 'undefined' && window.jellyfinPlugin) {
            debugLog('Using window.jellyfinPlugin for communication');
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
    },
  };
};
