'use strict';

function createPlaybackTrackingManager({
  core,
  http,
  preferences,
  buildJellyfinHeaders,
  fetchPlaybackInfo,
  fetchItemMetadata,
  secondsToTicks,
  ticksToSeconds,
  log,
}) {
  let currentPlaybackSession = null;
  let lastReportedPosition = 0;
  let lastKnownPosition = 0;
  let playbackTickCount = 0;
  let playbackTickTimer = null;

  const PLAYBACK_TICK_INTERVAL = 1000;
  const PROGRESS_REPORT_TICKS = 10;
  const WATCHED_THRESHOLD = 0.95;

  async function fetchResumePosition(serverBase, itemId, apiKey) {
    try {
      if (!preferences.get('sync_playback_progress')) {
        log('Playback progress sync disabled, skipping resume position fetch');
        return null;
      }

      const metadata = await fetchItemMetadata(serverBase, itemId, apiKey);

      if (!metadata || !metadata.UserData) {
        log('No UserData found in metadata');
        return null;
      }

      const playbackPositionTicks = metadata.UserData.PlaybackPositionTicks;
      const played = metadata.UserData.Played;

      if (played) {
        log('Item already marked as played, not resuming');
        return null;
      }

      if (!playbackPositionTicks || playbackPositionTicks === 0) {
        log('No resume position available');
        return null;
      }

      const positionSeconds = ticksToSeconds(playbackPositionTicks);
      log(`Found resume position: ${positionSeconds.toFixed(1)}s (${playbackPositionTicks} ticks)`);

      return positionSeconds;
    } catch (error) {
      log(`Error fetching resume position: ${error.message}`);
      return null;
    }
  }

  async function resumeFromJellyfin(serverBase, itemId, apiKey) {
    try {
      const resumePosition = await fetchResumePosition(serverBase, itemId, apiKey);

      if (resumePosition === null || resumePosition < 15) {
        log('No significant resume position, starting from beginning');
        return;
      }

      setTimeout(() => {
        try {
          log(`Resuming playback at ${resumePosition.toFixed(1)}s`);
          core.seekTo(resumePosition);

          if (preferences.get('show_notifications')) {
            const minutes = Math.floor(resumePosition / 60);
            const seconds = Math.floor(resumePosition % 60);
            core.osd(`Resuming at ${minutes}:${seconds.toString().padStart(2, '0')}`);
          }
        } catch (error) {
          log(`Error seeking to resume position: ${error.message}`);
        }
      }, 1000);
    } catch (error) {
      log(`Error resuming from Jellyfin: ${error.message}`);
    }
  }

  async function reportPlaybackStart(serverBase, itemId, apiKey, playSessionId, mediaSourceId) {
    try {
      if (!preferences.get('sync_playback_progress')) {
        log('Playback progress sync disabled, skipping playback start report');
        return false;
      }

      const url = `${serverBase}/Sessions/Playing?api_key=${apiKey}`;
      log(`Reporting playback start for item: ${itemId}`);

      const response = await http.post(url, {
        headers: buildJellyfinHeaders(apiKey, {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        }),
        data: {
          ItemId: itemId,
          MediaSourceId: mediaSourceId || itemId,
          PlaySessionId: playSessionId,
          CanSeek: true,
          PlayMethod: 'DirectPlay',
          PositionTicks: 0,
        },
      });

      if (response.statusCode >= 400) {
        log(`Playback start failed with status: ${response.statusCode}`);
        return false;
      }

      log(`Playback start reported, status: ${response.statusCode}`);
      return response.statusCode === 204 || response.statusCode === 200;
    } catch (error) {
      log(
        `Error reporting playback start: ${error && error.message ? error.message : JSON.stringify(error)}`
      );
      return false;
    }
  }

  async function reportPlaybackProgress(
    serverBase,
    itemId,
    apiKey,
    positionSeconds,
    playSessionId,
    mediaSourceId,
    isPaused = false
  ) {
    try {
      if (!preferences.get('sync_playback_progress')) {
        return false;
      }

      const positionTicks = secondsToTicks(positionSeconds);
      const url = `${serverBase}/Sessions/Playing/Progress?api_key=${apiKey}`;

      const response = await http.post(url, {
        headers: buildJellyfinHeaders(apiKey, {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        }),
        data: {
          ItemId: itemId,
          MediaSourceId: mediaSourceId || itemId,
          PlaySessionId: playSessionId,
          PositionTicks: positionTicks,
          IsPaused: isPaused,
          CanSeek: true,
          PlayMethod: 'DirectPlay',
        },
      });

      if (response.statusCode >= 400) {
        log(`Progress report failed with status: ${response.statusCode}`);
        return false;
      }

      return response.statusCode === 204 || response.statusCode === 200;
    } catch (error) {
      log(
        `Error reporting playback progress: ${error && error.message ? error.message : JSON.stringify(error)}`
      );
      return false;
    }
  }

  async function reportPlaybackStop(
    serverBase,
    itemId,
    apiKey,
    positionSeconds,
    playSessionId,
    mediaSourceId
  ) {
    try {
      if (!preferences.get('sync_playback_progress')) {
        log('Playback progress sync disabled, skipping playback stop report');
        return false;
      }

      const positionTicks = secondsToTicks(positionSeconds);
      const url = `${serverBase}/Sessions/Playing/Stopped?api_key=${apiKey}`;

      log(`Reporting playback stop: position=${positionSeconds}s (${positionTicks} ticks)`);

      const response = await http.post(url, {
        headers: buildJellyfinHeaders(apiKey, {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        }),
        data: {
          ItemId: itemId,
          MediaSourceId: mediaSourceId || itemId,
          PlaySessionId: playSessionId,
          PositionTicks: positionTicks,
        },
      });

      if (response.statusCode >= 400) {
        log(`Playback stop failed with status: ${response.statusCode}`);
        return false;
      }

      log(`Playback stop reported, status: ${response.statusCode}`);
      return response.statusCode === 204 || response.statusCode === 200;
    } catch (error) {
      log(
        `Error reporting playback stop: ${error && error.message ? error.message : JSON.stringify(error)}`
      );
      return false;
    }
  }

  async function markAsWatched(serverBase, itemId, apiKey) {
    try {
      if (!preferences.get('sync_playback_progress')) {
        log('Playback progress sync disabled, skipping mark as watched');
        return false;
      }

      const url = `${serverBase}/UserPlayedItems/${itemId}?api_key=${apiKey}`;
      log(`Marking item as watched: ${itemId}`);

      const response = await http.post(url, {
        headers: buildJellyfinHeaders(apiKey, {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        }),
      });

      if (response.statusCode >= 400) {
        log(`Mark as watched failed with status: ${response.statusCode}`);
        return false;
      }

      log(`Item marked as watched, status: ${response.statusCode}`);

      if (
        (response.statusCode === 200 || response.statusCode === 204) &&
        preferences.get('show_notifications')
      ) {
        core.osd('Marked as watched in Jellyfin');
      }

      return response.statusCode === 200 || response.statusCode === 204;
    } catch (error) {
      log(
        `Error marking item as watched: ${error && error.message ? error.message : JSON.stringify(error)}`
      );
      return false;
    }
  }

  async function startPlaybackTracking(serverBase, itemId, apiKey) {
    stopPlaybackTracking();

    if (!preferences.get('sync_playback_progress')) {
      log('Playback progress sync disabled');
      return;
    }

    log(`Starting playback tracking for item: ${itemId}`);

    let playSessionId = null;
    let mediaSourceId = null;
    try {
      const playbackInfo = await fetchPlaybackInfo(serverBase, itemId, apiKey);
      if (playbackInfo) {
        playSessionId = playbackInfo.PlaySessionId || null;
        if (playbackInfo.MediaSources && playbackInfo.MediaSources.length > 0) {
          mediaSourceId = playbackInfo.MediaSources[0].Id || null;
        }
        log(`PlaySessionId: ${playSessionId}, MediaSourceId: ${mediaSourceId}`);
      }
    } catch (error) {
      log(`Could not fetch playback info for session: ${error.message}`);
    }

    currentPlaybackSession = {
      serverBase,
      itemId,
      apiKey,
      playSessionId,
      mediaSourceId,
      startTime: Date.now(),
      duration: null,
      hasReportedWatched: false,
    };

    reportPlaybackStart(serverBase, itemId, apiKey, playSessionId, mediaSourceId);
    resumeFromJellyfin(serverBase, itemId, apiKey);

    try {
      const duration = core.status.duration;
      if (duration) {
        currentPlaybackSession.duration = duration;
        log(`Media duration: ${duration}s`);
      }
    } catch (error) {
      log(`Could not get duration: ${error.message}`);
    }

    startPlaybackTick();

    log('Playback tracking started');
  }

  function startPlaybackTick() {
    stopPlaybackTick();
    playbackTickCount = 0;

    playbackTickTimer = setInterval(() => {
      if (!currentPlaybackSession) {
        stopPlaybackTick();
        return;
      }

      try {
        const position = core.status.position;
        if (position !== null && position !== undefined && position > 0) {
          lastKnownPosition = position;
        }

        if (!currentPlaybackSession.duration) {
          const duration = core.status.duration;
          if (duration) {
            currentPlaybackSession.duration = duration;
          }
        }

        playbackTickCount++;

        if (playbackTickCount >= PROGRESS_REPORT_TICKS) {
          playbackTickCount = 0;
          const isPaused = core.status.paused || false;
          const { serverBase, itemId, apiKey, playSessionId, mediaSourceId } =
            currentPlaybackSession;

          reportPlaybackProgress(
            serverBase,
            itemId,
            apiKey,
            lastKnownPosition,
            playSessionId,
            mediaSourceId,
            isPaused
          );

          lastReportedPosition = lastKnownPosition;

          const duration = currentPlaybackSession.duration;
          if (duration && !currentPlaybackSession.hasReportedWatched) {
            const percentComplete = lastKnownPosition / duration;
            log(`Playback progress: ${(percentComplete * 100).toFixed(1)}%`);

            if (percentComplete >= WATCHED_THRESHOLD) {
              log(`Reached ${WATCHED_THRESHOLD * 100}% threshold, marking as watched`);
              markAsWatched(serverBase, itemId, apiKey);
              currentPlaybackSession.hasReportedWatched = true;
            }
          }
        }

        const duration = currentPlaybackSession.duration;
        if (duration && lastKnownPosition > 0) {
          const remaining = duration - lastKnownPosition;
          if (remaining <= 0.5) {
            log('EOF detected via tick, stopping playback tracking');
            stopPlaybackTracking();
          }
        }
      } catch (error) {
        log(`Error in playback tick: ${error.message}`);
      }
    }, PLAYBACK_TICK_INTERVAL);
  }

  function stopPlaybackTick() {
    if (playbackTickTimer) {
      clearInterval(playbackTickTimer);
      playbackTickTimer = null;
    }
    playbackTickCount = 0;
  }

  function handlePlaybackPositionChange() {
    if (!currentPlaybackSession) return;

    try {
      const position = core.status.position;
      if (position !== null && position !== undefined && position > 0) {
        lastKnownPosition = position;
      }
    } catch (error) {
      log(`Error in position change handler: ${error.message}`);
    }
  }

  function handlePauseChange() {
    if (!currentPlaybackSession) return;

    try {
      const position = core.status.position;
      if (position !== null && position !== undefined && position > 0) {
        lastKnownPosition = position;
      }

      const isPaused = core.status.paused || false;
      log(`Pause state changed: isPaused=${isPaused}, position=${lastKnownPosition}`);

      const { serverBase, itemId, apiKey, playSessionId, mediaSourceId } = currentPlaybackSession;

      reportPlaybackProgress(
        serverBase,
        itemId,
        apiKey,
        lastKnownPosition,
        playSessionId,
        mediaSourceId,
        isPaused
      );

      playbackTickCount = 0;
    } catch (error) {
      log(`Error in pause change handler: ${error.message}`);
    }
  }

  function stopPlaybackTracking() {
    if (currentPlaybackSession) {
      stopPlaybackTick();

      const { serverBase, itemId, apiKey, playSessionId, mediaSourceId } = currentPlaybackSession;

      let finalPosition = lastKnownPosition;
      try {
        const position = core.status.position;
        if (position !== null && position !== undefined && position > 0) {
          finalPosition = position;
        }
      } catch {
        log(`Could not get final position from core, using lastKnownPosition: ${finalPosition}`);
      }

      if (finalPosition <= 0) {
        finalPosition = lastReportedPosition;
      }

      reportPlaybackStop(serverBase, itemId, apiKey, finalPosition, playSessionId, mediaSourceId);

      currentPlaybackSession = null;
      lastReportedPosition = 0;
      lastKnownPosition = 0;
      log('Playback session ended');
    }
  }

  function getCurrentPlaybackSession() {
    return currentPlaybackSession;
  }

  return {
    startPlaybackTracking,
    stopPlaybackTracking,
    handlePlaybackPositionChange,
    handlePauseChange,
    markAsWatched,
    getCurrentPlaybackSession,
  };
}

module.exports = {
  createPlaybackTrackingManager,
};
