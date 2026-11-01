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
  // Bumped by every start and stop so an in-flight startPlaybackTracking can
  // tell that its session is no longer the one being played.
  let sessionRequestCounter = 0;
  let lastKnownPosition = 0;
  // A position of 0 means two different things: the file has not started yet
  // (including the moment before the resume seek runs), or the user rewound to
  // the beginning. Only after a position above 0 has been seen is 0 a real
  // playback position worth reporting.
  let hasStartedPlayback = false;
  // Set when mpv ended the tracked file but the stop is deferred until the next
  // file loads. core.status then describes the next file, so its position must
  // not be read for this one.
  let trackedFileEnded = false;
  let playbackTickCount = 0;
  let playbackTickTimer = null;
  // The last stop report sent. Reopening the same item reads its resume point
  // only after this has landed, or the server still has the older position.
  // The wait is capped: a slow report must not hold the resume seek back
  // until the first progress report has already overwritten the position.
  let pendingStopReport = null;
  const STOP_REPORT_WAIT_MS = 3000;

  function waitForStopReportOf(serverBase, itemId) {
    const pending = pendingStopReport;
    if (!pending || pending.serverBase !== serverBase || pending.itemId !== itemId) {
      return Promise.resolve();
    }

    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(resolve, STOP_REPORT_WAIT_MS);
    });
    return Promise.race([pending.report, timeout]).finally(() => clearTimeout(timer));
  }

  /**
   * Current playback position, or null when it carries no information yet.
   */
  function samplePosition() {
    const position = core.status.position;

    if (position === null || position === undefined || position < 0) {
      return null;
    }

    if (position > 0) {
      hasStartedPlayback = true;
      return position;
    }

    return hasStartedPlayback ? 0 : null;
  }

  /**
   * The position a progress report should carry. Until playback has started
   * the sampled 0 says nothing, and Jellyfin saves every reported position as
   * the resume point, so the position the server already has is sent back
   * instead, or nothing while that is not known yet.
   */
  function reportablePosition() {
    if (hasStartedPlayback) return lastKnownPosition;
    return currentPlaybackSession.resumePosition ?? null;
  }

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

      // 0 is a known position; null below means the server's is unknown.
      if (played) {
        log('Item already marked as played, not resuming');
        return 0;
      }

      if (!playbackPositionTicks || playbackPositionTicks === 0) {
        log('No resume position available');
        return 0;
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
    // The session this resume belongs to. The user can load another file while
    // the metadata request or the 1s delay is still pending — seeking then
    // would jump the *new* file to this item's resume position.
    const session = currentPlaybackSession;

    try {
      await waitForStopReportOf(serverBase, itemId);
      const resumePosition = await fetchResumePosition(serverBase, itemId, apiKey);

      // Keep what the server had, so stopping without playing anything can
      // report it back unchanged instead of resetting the item. A failed
      // lookup stays null: the position is unknown, not 0.
      if (session) {
        session.resumePosition = resumePosition;
      }

      if (resumePosition === null || resumePosition < 15) {
        log('No significant resume position, starting from beginning');
        return;
      }

      if (currentPlaybackSession !== session) {
        log(`Playback session changed while fetching resume position for ${itemId}, not seeking`);
        return;
      }

      setTimeout(() => {
        try {
          if (currentPlaybackSession !== session) {
            log(`Playback session changed before resume seek for ${itemId}, not seeking`);
            return;
          }

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

      const url = `${serverBase}/Sessions/Playing?ApiKey=${apiKey}`;
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
      const url = `${serverBase}/Sessions/Playing/Progress?ApiKey=${apiKey}`;

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
    mediaSourceId,
    failed = false
  ) {
    try {
      if (!preferences.get('sync_playback_progress')) {
        log('Playback progress sync disabled, skipping playback stop report');
        return false;
      }

      const positionTicks = secondsToTicks(positionSeconds);
      const url = `${serverBase}/Sessions/Playing/Stopped?ApiKey=${apiKey}`;

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
          Failed: failed,
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

      const url = `${serverBase}/UserPlayedItems/${itemId}?ApiKey=${apiKey}`;
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

  /**
   * Options:
   * - mediaSourceId: the version playing, from the URL. Without it Jellyfin
   *   plays (and so reports) its first media source.
   * - startPosition: where a version switch reopened the item. It stands in
   *   for the resume point, and there is no resume seek, as the file already
   *   started there.
   */
  async function startPlaybackTracking(
    serverBase,
    itemId,
    apiKey,
    { mediaSourceId: requestedMediaSourceId = null, startPosition = null } = {}
  ) {
    stopPlaybackTracking();

    if (!preferences.get('sync_playback_progress')) {
      log('Playback progress sync disabled');
      return;
    }

    log(`Starting playback tracking for item: ${itemId}`);

    const requestId = ++sessionRequestCounter;

    let playSessionId = null;
    let mediaSourceId = requestedMediaSourceId;
    try {
      const playbackInfo = await fetchPlaybackInfo(serverBase, itemId, apiKey);
      if (playbackInfo) {
        playSessionId = playbackInfo.PlaySessionId || null;
        if (!mediaSourceId && playbackInfo.MediaSources && playbackInfo.MediaSources.length > 0) {
          mediaSourceId = playbackInfo.MediaSources[0].Id || null;
        }
        log(`PlaySessionId: ${playSessionId}, MediaSourceId: ${mediaSourceId}`);
      }
    } catch (error) {
      log(`Could not fetch playback info for session: ${error.message}`);
    }

    if (requestId !== sessionRequestCounter) {
      // Another file was loaded (or playback stopped) while the playback info
      // request was in flight — installing this session now would report
      // progress for the wrong item.
      log(`Playback tracking for ${itemId} is stale, not starting`);
      return;
    }

    currentPlaybackSession = {
      serverBase,
      itemId,
      apiKey,
      playSessionId,
      mediaSourceId,
      startTime: Date.now(),
      resumePosition: startPosition,
      duration: null,
      hasReportedWatched: false,
    };

    reportPlaybackStart(serverBase, itemId, apiKey, playSessionId, mediaSourceId);
    if (startPosition === null) {
      resumeFromJellyfin(serverBase, itemId, apiKey);
    } else {
      log(`Version switch started at ${startPosition}s, not seeking to the resume point`);
    }

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
        const position = samplePosition();
        if (position !== null) {
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

          const reportPosition = reportablePosition();
          if (reportPosition !== null) {
            reportPlaybackProgress(
              serverBase,
              itemId,
              apiKey,
              reportPosition,
              playSessionId,
              mediaSourceId,
              isPaused
            );
          }

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

            // This runs before mpv reports eof-reached and clears the session,
            // so the watched state has to be sent from here. The progress
            // threshold above only runs every PROGRESS_REPORT_TICKS ticks and
            // can be missed entirely on short files or after a seek to the end.
            if (!currentPlaybackSession.hasReportedWatched) {
              const finished = currentPlaybackSession;
              finished.hasReportedWatched = true;
              markAsWatched(finished.serverBase, finished.itemId, finished.apiKey);
            }

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

  function handlePauseChange() {
    // After the tracked file ended, core.status describes the next file.
    if (!currentPlaybackSession || trackedFileEnded) return;

    try {
      const position = samplePosition();
      if (position !== null) {
        lastKnownPosition = position;
      }

      const isPaused = core.status.paused || false;
      log(`Pause state changed: isPaused=${isPaused}, position=${lastKnownPosition}`);

      const { serverBase, itemId, apiKey, playSessionId, mediaSourceId } = currentPlaybackSession;

      const reportPosition = reportablePosition();
      if (reportPosition === null) {
        log('Playback has not started yet, not reporting the pause');
        return;
      }

      reportPlaybackProgress(
        serverBase,
        itemId,
        apiKey,
        reportPosition,
        playSessionId,
        mediaSourceId,
        isPaused
      );

      playbackTickCount = 0;
    } catch (error) {
      log(`Error in pause change handler: ${error.message}`);
    }
  }

  /**
   * The tracked file ended but its stop report waits for the next file. Freeze
   * the last sampled position so the tick cannot overwrite it with the next
   * file's.
   */
  function markTrackedFileEnded() {
    if (!currentPlaybackSession) return;

    trackedFileEnded = true;
    stopPlaybackTick();
  }

  function stopPlaybackTracking() {
    // Invalidate any start that is still waiting on its playback info request,
    // even when there is no session to stop yet.
    sessionRequestCounter++;

    if (currentPlaybackSession) {
      stopPlaybackTick();

      const { serverBase, itemId, apiKey, playSessionId, mediaSourceId } = currentPlaybackSession;

      let finalPosition = lastKnownPosition;
      if (!trackedFileEnded) {
        try {
          const position = samplePosition();
          if (position !== null) {
            finalPosition = position;
          }
        } catch {
          log(`Could not get final position from core, using lastKnownPosition: ${finalPosition}`);
        }
      }

      // Nothing ever played, so report what the item already had. Sending 0
      // here would drop it out of Continue Watching just for being opened.
      // When that is unknown too, the stop is sent as failed: Jellyfin then
      // ends the session without touching the saved position, where leaving
      // the position out would mark the item played.
      let failed = false;
      if (!hasStartedPlayback) {
        const preserved = currentPlaybackSession.resumePosition;
        if (preserved === null || preserved === undefined) {
          log('No playback observed and the stored position is unknown, stopping as failed');
          failed = true;
          finalPosition = 0;
        } else {
          log(`No playback observed, reporting the stored position (${preserved}s)`);
          finalPosition = preserved;
        }
      }

      pendingStopReport = {
        serverBase,
        itemId,
        report: reportPlaybackStop(
          serverBase,
          itemId,
          apiKey,
          finalPosition,
          playSessionId,
          mediaSourceId,
          failed
        ),
      };

      currentPlaybackSession = null;
      lastKnownPosition = 0;
      hasStartedPlayback = false;
      trackedFileEnded = false;
      log('Playback session ended');
    }
  }

  function getCurrentPlaybackSession() {
    return currentPlaybackSession;
  }

  return {
    startPlaybackTracking,
    stopPlaybackTracking,
    markTrackedFileEnded,
    handlePauseChange,
    markAsWatched,
    getCurrentPlaybackSession,
  };
}

module.exports = {
  createPlaybackTrackingManager,
};
