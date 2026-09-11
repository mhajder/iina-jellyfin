window.createSidebarOfflineMethods = function createSidebarOfflineMethods(debugLog) {
  const DOWNLOADABLE_TYPES = ['Movie', 'Episode', 'Audio'];
  const ACTIVE_STATUSES = ['queued', 'downloading'];
  const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
  const NOTICE_TIMEOUT_MS = 5000;
  const CONFIRM_TIMEOUT_MS = 4000;
  const TYPE_ICONS = { Movie: '🎬', Episode: '📺', Audio: '🎵' };

  function byId(id) {
    return document.getElementById(id);
  }

  function isShown(id) {
    return byId(id).style.display === 'block';
  }

  return {
    /**
     * Wire the offline downloads UI. The downloads panel sits outside the
     * connected-only content, so everything here works without a server.
     */
    setupOfflineUi() {
      this.offlineDownloads = [];
      this.offlineDirectory = null;
      this.downloadsPanelReturn = null;
      this.downloadsNoticeTimer = null;

      byId('downloadsBtn').addEventListener('click', () => this.toggleDownloadsPanel());
      byId('closeDownloadsBtn').addEventListener('click', () => this.hideDownloadsPanel());
      byId('openDownloadsFolderBtn').addEventListener('click', () => {
        this.postOfflineMessage('offline-open-folder');
      });
      byId('downloadEpisodeBtn').addEventListener('click', () => this.downloadSelectedEpisode());

      if (typeof iina !== 'undefined' && iina.onMessage) {
        iina.onMessage('offline-downloads', (data) => {
          debugLog('Received offline-downloads', {
            count: Array.isArray(data?.downloads) ? data.downloads.length : 0,
          });
          this.handleOfflineDownloads(data);
        });
      }

      this.renderDownloadsList();
      this.requestOfflineDownloads();
    },

    postOfflineMessage(name, data) {
      if (typeof iina !== 'undefined' && iina.postMessage) {
        iina.postMessage(name, data);
        return true;
      }
      debugLog(`iina.postMessage not available, cannot send ${name}`);
      return false;
    },

    requestOfflineDownloads() {
      this.postOfflineMessage('get-offline-downloads');
    },

    handleOfflineDownloads(data) {
      this.offlineDownloads = Array.isArray(data?.downloads) ? data.downloads : [];
      this.offlineDirectory = data?.directory || null;
      this.renderDownloadsList();
      this.updateDownloadsBadge();
      this.refreshDownloadButtons(document);
    },

    getOfflineEntry(itemId) {
      return (this.offlineDownloads || []).find((entry) => entry.itemId === itemId) || null;
    },

    isDownloadable(item) {
      return Boolean(item && item.Id && DOWNLOADABLE_TYPES.includes(item.Type));
    },

    isOfflineReady(entry) {
      return Boolean(entry && entry.status === 'completed' && !entry.fileMissing);
    },

    /**
     * Label and state of the per-item download button for a manifest entry.
     */
    describeDownloadButton(entry) {
      if (!entry || entry.status === 'cancelled') {
        return {
          label: '⬇ Offline',
          disabled: false,
          state: 'idle',
          title: 'Download for offline playback',
        };
      }
      if (entry.status === 'queued') {
        return { label: 'Queued…', disabled: true, state: 'queued', title: 'Waiting to download' };
      }
      if (entry.status === 'downloading') {
        return {
          label: `${entry.progress || 0}%`,
          disabled: true,
          state: 'downloading',
          title: 'Downloading',
        };
      }
      if (entry.status === 'completed') {
        if (entry.fileMissing) {
          return {
            label: 'Re-download',
            disabled: false,
            state: 'missing',
            title: 'The downloaded file is missing',
          };
        }
        return {
          label: '▶ Offline',
          disabled: false,
          state: 'completed',
          title: 'Play the offline copy',
        };
      }
      return {
        label: 'Retry ⬇',
        disabled: false,
        state: 'failed',
        title: entry.error || 'Download failed',
      };
    },

    applyDownloadButtonState(button) {
      const entry = this.getOfflineEntry(button.dataset.offlineItemId);
      const description = this.describeDownloadButton(entry);
      button.textContent = description.label;
      button.disabled = description.disabled;
      button.dataset.offlineState = description.state;
      button.title = description.title;
    },

    refreshDownloadButtons(root) {
      root.querySelectorAll('[data-offline-item-id]').forEach((button) => {
        this.applyDownloadButtonState(button);
      });
    },

    /**
     * HTML for the download button of a list row. The label is filled in by
     * applyDownloadButtonState once the element exists.
     */
    downloadButtonHtml(item, extraClass) {
      if (!this.isDownloadable(item)) {
        return '';
      }
      return `<button class="button secondary ${extraClass} offline-download-btn" data-action="download" data-offline-item-id="${this.escapeHtml(item.Id)}"></button>`;
    },

    /**
     * Click on a row's download button: play the offline copy when there is
     * one, otherwise (re)start the download.
     */
    handleDownloadButtonClick(item) {
      const entry = this.getOfflineEntry(item.Id);
      if (this.isOfflineReady(entry)) {
        return this.playOfflineDownload(entry.itemId);
      }
      return this.requestOfflineDownload(item);
    },

    pickDownloadFields(item) {
      return {
        Id: item.Id,
        Type: item.Type,
        Name: item.Name,
        SeriesName: item.SeriesName,
        ParentIndexNumber: item.ParentIndexNumber,
        IndexNumber: item.IndexNumber,
        ProductionYear: item.ProductionYear,
        RunTimeTicks: item.RunTimeTicks,
        AlbumArtist: item.AlbumArtist,
        Artists: item.Artists,
      };
    },

    requestOfflineDownload(item) {
      if (!this.isDownloadable(item)) {
        debugLog('Item cannot be downloaded', { id: item?.Id, type: item?.Type });
        this.showDownloadsNotice('This item cannot be downloaded for offline use');
        return false;
      }
      if (!this.currentServer) {
        this.showDownloadsNotice('Connect to a Jellyfin server to download media');
        return false;
      }

      const sent = this.postOfflineMessage('offline-download', {
        item: this.pickDownloadFields(item),
        serverUrl: this.currentServer.url,
        accessToken: this.currentServer.accessToken,
        serverId: this.currentServer.serverId || this.activeServerId || null,
      });
      if (sent) {
        debugLog(`Requested offline download of ${item.Name} (${item.Id})`);
        this.showDownloadsNotice(`Queued for download: ${item.Name || 'Unknown Title'}`);
      }
      return sent;
    },

    async requestOfflineDownloadForHint(hint) {
      if (!this.currentServer || !this.currentUser) {
        this.showDownloadsNotice('Connect to a Jellyfin server to download media');
        return false;
      }
      try {
        const params = new URLSearchParams({ userId: this.currentUser.Id });
        const response = await this.getHttpClient().get(
          `${this.currentServer.url}/Items/${hint.ItemId}?${params.toString()}`,
          { headers: { 'X-Emby-Token': this.currentServer.accessToken } }
        );
        if (!response.data || !response.data.Id) {
          throw new Error('Item details missing');
        }
        return this.requestOfflineDownload(response.data);
      } catch (error) {
        debugLog('Could not load item for download:', error);
        this.showDownloadsNotice('Failed to load item details for download');
        return false;
      }
    },

    downloadSelectedEpisode() {
      if (!this.selectedEpisode) {
        debugLog('No episode selected to download');
        return false;
      }
      return this.requestOfflineDownload(this.selectedEpisode);
    },

    playOfflineDownload(itemId) {
      debugLog(`Playing offline download ${itemId}`);
      const sent = this.postOfflineMessage('play-offline', { itemId });
      if (sent && isShown('episodeSection')) {
        this.hideEpisodeSelection();
      }
      return sent;
    },

    cancelOfflineDownload(itemId) {
      return this.postOfflineMessage('offline-cancel', { itemId });
    },

    removeOfflineDownload(itemId) {
      return this.postOfflineMessage('offline-remove', { itemId });
    },

    retryOfflineDownload(itemId) {
      return this.postOfflineMessage('offline-retry', {
        itemId,
        serverUrl: this.currentServer ? this.currentServer.url : null,
        accessToken: this.currentServer ? this.currentServer.accessToken : null,
      });
    },

    revealOfflineDownload(itemId) {
      return this.postOfflineMessage('offline-show-in-finder', { itemId });
    },

    toggleDownloadsPanel() {
      if (isShown('downloadsSection')) {
        this.hideDownloadsPanel();
      } else {
        this.showDownloadsPanel();
      }
    },

    showDownloadsPanel() {
      if (isShown('downloadsSection')) {
        return;
      }
      // Remember what was on screen so Back returns to it, connected or not.
      const sections = ['mainContent', 'episodeSection', 'albumTracksSection', 'loginSection'];
      this.downloadsPanelReturn = {};
      for (const id of sections) {
        this.downloadsPanelReturn[id] = isShown(id);
        byId(id).style.display = 'none';
      }
      byId('downloadsSection').style.display = 'block';
      byId('downloadsBtn').classList.add('active');
      this.renderDownloadsList();
      this.requestOfflineDownloads();
      this.scrollToTop();
    },

    hideDownloadsPanel() {
      byId('downloadsSection').style.display = 'none';
      byId('downloadsBtn').classList.remove('active');
      const restore = this.downloadsPanelReturn || {};
      for (const id of Object.keys(restore)) {
        if (restore[id]) {
          byId(id).style.display = 'block';
        }
      }
      this.downloadsPanelReturn = null;
    },

    updateDownloadsBadge() {
      const active = (this.offlineDownloads || []).filter((entry) =>
        ACTIVE_STATUSES.includes(entry.status)
      ).length;
      const badge = byId('downloadsBadge');
      badge.textContent = active > 0 ? String(active) : '';
      badge.style.display = active > 0 ? 'inline-block' : 'none';
    },

    formatBytes(bytes) {
      const value = Number(bytes);
      if (!Number.isFinite(value) || value <= 0) {
        return '';
      }
      let unitIndex = 0;
      let size = value;
      while (size >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
        size /= 1024;
        unitIndex++;
      }
      const digits = unitIndex === 0 ? 0 : 1;
      return `${size.toFixed(digits)} ${BYTE_UNITS[unitIndex]}`;
    },

    describeDownloadSubtitle(entry) {
      if (entry.type === 'Episode') {
        const parts = [];
        if (entry.seriesName) parts.push(entry.seriesName);
        if (entry.seasonNumber !== null && entry.episodeNumber !== null) {
          parts.push(`S${entry.seasonNumber}E${entry.episodeNumber}`);
        }
        return parts.join(' · ');
      }
      if (entry.type === 'Movie') {
        return entry.productionYear ? `Movie · ${entry.productionYear}` : 'Movie';
      }
      return 'Song';
    },

    describeDownloadStatus(entry) {
      const size = this.formatBytes(entry.expectedBytes);
      if (entry.status === 'queued') {
        return 'Queued';
      }
      if (entry.status === 'downloading') {
        return `Downloading ${entry.progress || 0}%${size ? ` of ${size}` : ''}`;
      }
      if (entry.status === 'cancelled') {
        return 'Cancelling…';
      }
      if (entry.status === 'failed') {
        return `Failed: ${entry.error || 'unknown error'}`;
      }
      if (entry.fileMissing) {
        return 'File missing — it was moved or deleted';
      }
      const subtitleCount = (entry.subtitles || []).length;
      const parts = ['Ready to play offline'];
      if (size) parts.push(size);
      parts.push(`${subtitleCount} subtitle${subtitleCount === 1 ? '' : 's'}`);
      return parts.join(' · ');
    },

    downloadActionsFor(entry) {
      if (ACTIVE_STATUSES.includes(entry.status)) {
        return [{ action: 'cancel', label: 'Cancel', secondary: true }];
      }
      if (entry.status === 'cancelled') {
        return [];
      }
      if (entry.status === 'failed') {
        return [
          { action: 'retry', label: 'Retry', secondary: false },
          { action: 'remove', label: 'Remove', secondary: true },
        ];
      }
      if (entry.fileMissing) {
        return [
          { action: 'retry', label: 'Re-download', secondary: false },
          { action: 'remove', label: 'Remove', secondary: true },
        ];
      }
      return [
        { action: 'play', label: '▶ Play', secondary: false },
        { action: 'reveal', label: 'Reveal', secondary: true },
        { action: 'remove', label: 'Remove', secondary: true },
      ];
    },

    handleDownloadEntryAction(action, entry, button) {
      if (action === 'play') {
        this.playOfflineDownload(entry.itemId);
      } else if (action === 'cancel') {
        this.cancelOfflineDownload(entry.itemId);
      } else if (action === 'retry') {
        this.retryOfflineDownload(entry.itemId);
      } else if (action === 'reveal') {
        this.revealOfflineDownload(entry.itemId);
      } else if (action === 'remove') {
        // Removing deletes files, so the first click only arms the button.
        if (button.dataset.confirm === 'true') {
          this.removeOfflineDownload(entry.itemId);
          return;
        }
        button.dataset.confirm = 'true';
        button.textContent = 'Confirm?';
        setTimeout(() => {
          if (button.isConnected) {
            button.dataset.confirm = 'false';
            button.textContent = 'Remove';
          }
        }, CONFIRM_TIMEOUT_MS);
      }
    },

    createDownloadEntryElement(entry) {
      const itemEl = document.createElement('div');
      itemEl.className = `download-item status-${entry.status}${entry.fileMissing ? ' missing' : ''}`;
      itemEl.dataset.downloadId = entry.itemId;

      const icon = TYPE_ICONS[entry.type] || '🎬';
      const subtitle = this.describeDownloadSubtitle(entry);
      const status = this.describeDownloadStatus(entry);
      const progress =
        entry.status === 'downloading' ? Math.max(0, Math.min(100, entry.progress || 0)) : null;
      const actions = this.downloadActionsFor(entry);

      itemEl.innerHTML = `
        <div class="download-icon">${icon}</div>
        <div class="download-body">
          <div class="media-title">${this.escapeHtml(entry.name || entry.title)}</div>
          ${subtitle ? `<div class="media-subtitle">${this.escapeHtml(subtitle)}</div>` : ''}
          <div class="download-status">${this.escapeHtml(status)}</div>
          ${
            progress !== null
              ? `<div class="download-progress"><div class="download-progress-bar" style="width: ${progress}%"></div></div>`
              : ''
          }
          <div class="media-actions">
            ${actions
              .map(
                (action) =>
                  `<button class="button ${action.secondary ? 'secondary ' : ''}media-action-btn download-action-btn" data-action="${action.action}">${action.label}</button>`
              )
              .join('')}
          </div>
        </div>
      `;

      itemEl.querySelectorAll('.download-action-btn').forEach((button) => {
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          this.handleDownloadEntryAction(button.dataset.action, entry, button);
        });
      });

      return itemEl;
    },

    renderDownloadsList() {
      const list = byId('downloadsList');
      const summary = byId('downloadsSummary');
      const directory = byId('downloadsDirectory');
      const downloads = this.offlineDownloads || [];

      directory.textContent = this.offlineDirectory ? `Folder: ${this.offlineDirectory}` : '';

      if (downloads.length === 0) {
        summary.textContent = '';
        list.innerHTML =
          '<div class="empty-state">No downloads yet. Use the ⬇ Offline button on a movie, episode or song.</div>';
        return;
      }

      const ready = downloads.filter((entry) => this.isOfflineReady(entry)).length;
      const active = downloads.filter((entry) => ACTIVE_STATUSES.includes(entry.status)).length;
      const summaryParts = [`${ready} ready`];
      if (active > 0) summaryParts.push(`${active} active`);
      summary.textContent = summaryParts.join(' · ');

      // Active downloads first, then newest first.
      const sorted = downloads.slice().sort((left, right) => {
        const leftActive = ACTIVE_STATUSES.includes(left.status) ? 0 : 1;
        const rightActive = ACTIVE_STATUSES.includes(right.status) ? 0 : 1;
        if (leftActive !== rightActive) return leftActive - rightActive;
        return (right.createdAt || 0) - (left.createdAt || 0);
      });

      list.innerHTML = '';
      for (const entry of sorted) {
        list.appendChild(this.createDownloadEntryElement(entry));
      }
    },

    showDownloadsNotice(text) {
      const notice = byId('downloadsNotice');
      if (this.downloadsNoticeTimer) {
        clearTimeout(this.downloadsNoticeTimer);
        this.downloadsNoticeTimer = null;
      }
      notice.textContent = text;
      notice.style.display = 'block';
      this.downloadsNoticeTimer = setTimeout(() => {
        notice.style.display = 'none';
        notice.textContent = '';
        this.downloadsNoticeTimer = null;
      }, NOTICE_TIMEOUT_MS);
    },
  };
};
