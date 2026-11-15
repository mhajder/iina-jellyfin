'use strict';

/** Jellyfin item ids compare without case or dashes (GUID vs. 32 hex). */
function normalizeItemId(id) {
  return String(id || '')
    .replace(/-/g, '')
    .toLowerCase();
}

function createAutoplayManager({
  http,
  mpv,
  core,
  preferences,
  buildJellyfinHeaders,
  fetchItemMetadata,
  mediaTitleOption,
  log,
}) {
  let lastProcessedEpisodeId = null;
  let lastProcessedSeriesId = null;
  let autoplayRequestCounter = 0;
  // The setup still resolving, if any; its file ending cancels it.
  let setupInFlight = null;
  let autoplayQueued = false;
  // The URL this plugin queued last. Only that entry can be a stale next
  // episode (one left behind when an episode is played again); anything else
  // after the current entry is the viewer's, even if it is a Jellyfin URL.
  let lastQueuedUrl = null;
  // The season list a queued episode was picked from. A special shown inside
  // a regular season belongs to the Specials season by its metadata, but its
  // next episode is the one after it in the season it was played from.
  const seasonContext = new Map();

  // Throws when the request fails. Callers must not read a failed request as
  // an empty season: that would skip ahead to the next season.
  async function fetchSeriesEpisodes(serverBase, seriesId, seasonId, apiKey) {
    log(`Fetching episodes for series: ${seriesId}, season: ${seasonId}`);

    const queryParams = [
      'seasonId=' + encodeURIComponent(seasonId),
      'fields=' + encodeURIComponent('MediaSources,Path,LocationType,IsFolder'),
    ].join('&');

    const response = await http.get(
      `${serverBase}/Shows/${seriesId}/Episodes?${queryParams}&ApiKey=${encodeURIComponent(apiKey)}`,
      {
        headers: buildJellyfinHeaders(apiKey, {
          Accept: 'application/json',
        }),
      }
    );

    // IINA's http resolves for every status, so check it before the body.
    if (response.statusCode >= 400) {
      throw new Error(`Jellyfin API returned status ${response.statusCode}`);
    }

    if (!response.data) {
      throw new Error('No data received from Jellyfin API');
    }

    const episodeData =
      typeof response.data === 'string' ? JSON.parse(response.data) : response.data;

    if (!episodeData.Items) {
      log('No episodes found in response');
      return [];
    }

    // Kept in the server's order: Jellyfin lists a season in airing order,
    // with any specials that air within it in their place. Sorting by
    // episode number would move those specials among the regular episodes.
    // Playback streams the item, so download permission is irrelevant here.
    const episodes = episodeData.Items.filter(
      (episode) => episode.MediaSources && episode.MediaSources.length > 0
    ).map((episode) => ({
      id: episode.Id,
      name: episode.Name,
      indexNumber: Number(episode.IndexNumber) || 0,
      // A special inside a season keeps its own season (0) for its label.
      seasonNumber:
        episode.ParentIndexNumber === undefined || episode.ParentIndexNumber === null
          ? null
          : Number(episode.ParentIndexNumber),
      duration: episode.RunTimeTicks,
      playUrl: `${serverBase}/Videos/${episode.Id}/stream?static=true&ApiKey=${encodeURIComponent(apiKey)}`,
    }));

    log(
      `Fetched ${episodes.length} episodes from series: ${episodes.map((episode) => `E${episode.indexNumber}`).join(', ')}`
    );
    return episodes;
  }

  async function getSeriesInfoFromEpisode(serverBase, episodeId, apiKey) {
    try {
      log(`Getting series info from episode: ${episodeId}`);

      const metadata = await fetchItemMetadata(serverBase, episodeId, apiKey);

      if (metadata.Type !== 'Episode') {
        log(`Item ${episodeId} is not an episode, it's a ${metadata.Type}`);
        return null;
      }

      const seriesId = metadata.SeriesId;
      const seasonId = metadata.SeasonId;
      const seriesName = metadata.SeriesName || '';
      // Specials are season 0, so a plain || 1 would relabel them as season 1
      const parsedSeasonNumber = Number(metadata.ParentIndexNumber ?? 1);
      const seasonNumber = Number.isFinite(parsedSeasonNumber) ? parsedSeasonNumber : 1;
      const episodeIndexNumber = Number(metadata.IndexNumber) || 0;

      if (!seriesId || !seasonId) {
        log(`Missing series info - SeriesId: ${seriesId}, SeasonId: ${seasonId}`);
        return null;
      }

      log(
        `Series info: SeriesName=${seriesName}, SeriesId=${seriesId}, SeasonId=${seasonId}, SeasonNumber=${seasonNumber}, EpisodeNumber=${episodeIndexNumber}`
      );

      return {
        seriesId,
        seasonId,
        seriesName,
        seasonNumber,
        currentEpisodeNumber: episodeIndexNumber,
      };
    } catch (error) {
      log(`Error getting series info from episode: ${error.message}`);
      return null;
    }
  }

  /**
   * The episode after the current one in its season's list. Matched by id,
   * as the list is in airing order: a number comparison would misplace
   * specials and stop at any gap. Only when the current episode is missing
   * from the list does its number decide, among that season's own episodes.
   */
  function nextInSeason(episodes, episodeId, currentEpisodeNumber, currentSeasonNumber) {
    const currentId = normalizeItemId(episodeId);
    const index = episodes.findIndex((episode) => normalizeItemId(episode.id) === currentId);
    if (index >= 0) return episodes[index + 1] || null;

    const currentEpNum = Number(currentEpisodeNumber);
    return (
      episodes
        .filter(
          (episode) =>
            (episode.seasonNumber === null || episode.seasonNumber === currentSeasonNumber) &&
            episode.indexNumber > currentEpNum
        )
        .sort((left, right) => left.indexNumber - right.indexNumber)[0] || null
    );
  }

  async function resolveNextEpisode(serverBase, seriesInfo, episodeId, apiKey) {
    const { seriesId, seasonId, currentEpisodeNumber, seasonNumber } = seriesInfo;
    try {
      const episodes = await fetchSeriesEpisodes(serverBase, seriesId, seasonId, apiKey);
      const nextEpisode = nextInSeason(episodes, episodeId, currentEpisodeNumber, seasonNumber);

      if (nextEpisode) {
        log(
          `Found next episode in current season: E${nextEpisode.indexNumber} - ${nextEpisode.name}`
        );
        return { ...nextEpisode, contextSeasonId: seasonId };
      }

      log('No next episode in current season, checking next season...');

      const seasonsResponse = await http.get(
        `${serverBase}/Shows/${seriesId}/Seasons?ApiKey=${encodeURIComponent(apiKey)}`,
        {
          headers: buildJellyfinHeaders(apiKey, { Accept: 'application/json' }),
        }
      );

      if (seasonsResponse.statusCode >= 400 || !seasonsResponse.data) return null;

      const seasonsData =
        typeof seasonsResponse.data === 'string'
          ? JSON.parse(seasonsResponse.data)
          : seasonsResponse.data;

      if (!seasonsData.Items || seasonsData.Items.length === 0) return null;

      const sortedSeasons = seasonsData.Items.filter(
        (season) => season.IndexNumber !== null && season.IndexNumber !== undefined
      ).sort((left, right) => (left.IndexNumber || 0) - (right.IndexNumber || 0));

      const currentSeasonIndex = sortedSeasons.findIndex((season) => season.Id === seasonId);
      if (currentSeasonIndex === -1) {
        log('Current season not in the season list — end of series');
        return null;
      }

      // The specials are not followed by the first regular season: they sort
      // first only because they are numbered 0.
      if (Number(sortedSeasons[currentSeasonIndex].IndexNumber) === 0) {
        log('End of the specials — not continuing into season 1');
        return null;
      }

      // A season with nothing playable (not yet aired, missing files) is
      // skipped rather than taken as the end of the series.
      for (const nextSeason of sortedSeasons.slice(currentSeasonIndex + 1)) {
        log(`Checking next season: ${nextSeason.Name} (S${nextSeason.IndexNumber})`);

        const nextSeasonEpisodes = await fetchSeriesEpisodes(
          serverBase,
          seriesId,
          nextSeason.Id,
          apiKey
        );

        if (nextSeasonEpisodes.length === 0) {
          log(`Season ${nextSeason.IndexNumber} has no playable episodes, trying the next one`);
          continue;
        }

        const firstEpisode = nextSeasonEpisodes[0];
        log(
          `Found first episode of next season: S${nextSeason.IndexNumber}E${firstEpisode.indexNumber} - ${firstEpisode.name}`
        );

        return {
          ...firstEpisode,
          seasonNumber: firstEpisode.seasonNumber ?? nextSeason.IndexNumber,
          contextSeasonId: nextSeason.Id,
        };
      }

      log('No later season has playable episodes — end of series');
      return null;
    } catch (error) {
      log(`Error resolving next episode: ${error.message}`);
      return null;
    }
  }

  function playlistFilename(index) {
    try {
      return mpv.getString(`playlist/${index}/filename`);
    } catch {
      return null;
    }
  }

  function itemIdInUrl(url) {
    const match = /\/(?:Items|Videos|Audio)\/([^/?]+)/i.exec(String(url || ''));
    return match ? normalizeItemId(match[1]) : null;
  }

  function queueNextEpisode(nextEpisode, seriesName, seasonNumber) {
    try {
      const seCode = `S${String(seasonNumber).padStart(2, '0')}E${String(nextEpisode.indexNumber).padStart(2, '0')}`;
      const episodeTitle = seriesName
        ? `${seriesName} ${seCode} - ${nextEpisode.name}`
        : `${seCode} - ${nextEpisode.name}`;

      log(`Queuing next episode: ${episodeTitle}`);

      try {
        const playlistCount = Number(mpv.getNumber('playlist-count') || 0);
        const currentPos = Number(mpv.getNumber('playlist-pos'));

        if (!Number.isFinite(currentPos) || currentPos < 0) {
          log(
            `Skipping playlist cleanup due to invalid playlist-pos=${currentPos}, playlist-count=${playlistCount}`
          );
        } else {
          // Only the entry this plugin queued last can be stale (a next
          // episode left behind when an episode is played again).
          let removedCount = 0;
          for (let i = playlistCount - 1; i > currentPos; i--) {
            const filename = playlistFilename(i);
            if (!filename || filename !== lastQueuedUrl) continue;
            try {
              mpv.command('playlist-remove', [String(i)]);
              removedCount++;
            } catch {
              // Ignore removal errors
            }
          }
          if (removedCount > 0) log(`Cleaned ${removedCount} stale playlist entries`);

          if (playlistCount - removedCount > currentPos + 1) {
            const following = playlistFilename(currentPos + 1);
            if (following && itemIdInUrl(following) === normalizeItemId(nextEpisode.id)) {
              // The viewer already queued this episode to play next.
              log(`Next episode ${nextEpisode.id} is already next in the playlist`);
              autoplayQueued = true;
              return;
            }
            // The viewer's own playlist continues after this episode: it plays
            // as they built it instead of being pushed behind the series.
            log("The playlist continues with the viewer's own entries, not queuing");
            return;
          }
        }
      } catch {
        log('Could not clean playlist (non-critical)');
      }

      const args = [nextEpisode.playUrl, 'insert-next'];
      if (preferences.get('set_video_title')) {
        args.push('-1', mediaTitleOption(episodeTitle));
      }
      mpv.command('loadfile', args);

      lastQueuedUrl = nextEpisode.playUrl;
      if (nextEpisode.contextSeasonId) {
        seasonContext.set(normalizeItemId(nextEpisode.id), nextEpisode.contextSeasonId);
      }
      autoplayQueued = true;

      log(`Queued next episode: ${episodeTitle}`);

      if (preferences.get('show_notifications')) {
        core.osd(`Up next: ${episodeTitle}`);
      }
    } catch (error) {
      log(`Error queuing next episode: ${error.message}`);
    }
  }

  function setupAutoplayForEpisode(serverBase, episodeId, apiKey) {
    if (lastProcessedEpisodeId === episodeId) {
      log(`Episode ${episodeId} already being processed, skipping duplicate setup`);
      return;
    }

    lastProcessedEpisodeId = episodeId;
    autoplayQueued = false;

    autoplayRequestCounter++;
    const thisRequestId = autoplayRequestCounter;
    setupInFlight = thisRequestId;

    (async () => {
      try {
        log(`Setting up autoplay for episode: ${episodeId} (request #${thisRequestId})`);

        const seriesInfo = await getSeriesInfoFromEpisode(serverBase, episodeId, apiKey);

        if (thisRequestId !== autoplayRequestCounter) {
          log(
            `Autoplay request #${thisRequestId} is stale (current: #${autoplayRequestCounter}), aborting`
          );
          return;
        }

        if (!seriesInfo) {
          log('Could not get series info, autoplay not available');
          return;
        }

        // Used once: played again later (e.g. from the Specials season
        // itself), the episode continues in its own season.
        const contextSeasonId = seasonContext.get(normalizeItemId(episodeId));
        seasonContext.delete(normalizeItemId(episodeId));
        if (contextSeasonId && contextSeasonId !== seriesInfo.seasonId) {
          log(`Episode ${episodeId} was queued from season ${contextSeasonId}, continuing there`);
          seriesInfo.seasonId = contextSeasonId;
        }

        log(
          `Got series info: series=${seriesInfo.seriesId}, season=${seriesInfo.seasonId}, seasonNum=${seriesInfo.seasonNumber}, currentEp=${seriesInfo.currentEpisodeNumber}`
        );

        if (lastProcessedSeriesId !== seriesInfo.seriesId) {
          log(`Series changed from ${lastProcessedSeriesId} to ${seriesInfo.seriesId}`);
          lastProcessedSeriesId = seriesInfo.seriesId;
        }

        const nextEpisode = await resolveNextEpisode(serverBase, seriesInfo, episodeId, apiKey);

        if (thisRequestId !== autoplayRequestCounter) {
          log(`Autoplay request #${thisRequestId} is stale after resolve, aborting`);
          return;
        }

        if (!nextEpisode) {
          log('No next episode found — end of series');
          return;
        }

        // ?? rather than ||: season 0 is a real season number
        const seasonNum = nextEpisode.seasonNumber ?? seriesInfo.seasonNumber;
        queueNextEpisode(nextEpisode, seriesInfo.seriesName, seasonNum);

        log(`Autoplay setup complete — queued next episode: ${nextEpisode.name}`);
      } catch (error) {
        log(`Error setting up autoplay: ${error.message}`);
      } finally {
        if (setupInFlight === thisRequestId) setupInFlight = null;
      }
    })();
  }

  /**
   * The file being set up has ended. A lookup still running for it would
   * otherwise queue its next episode into whatever plays now, even a local
   * file's playlist.
   */
  function cancelPendingSetup() {
    if (setupInFlight === null) return;
    log(`Cancelling autoplay request #${setupInFlight}, its file has ended`);
    autoplayRequestCounter++;
    setupInFlight = null;
    // Nothing was queued, so loading the episode again must set it up again.
    lastProcessedEpisodeId = null;
  }

  function hasEntryAfterCurrent() {
    try {
      const playlistCount = Number(mpv.getNumber('playlist-count') || 0);
      const currentPos = Number(mpv.getNumber('playlist-pos'));
      return Number.isFinite(currentPos) && currentPos >= 0 && playlistCount > currentPos + 1;
    } catch {
      return false;
    }
  }

  function resetForNewFile(episodeId) {
    // A repeated load of the same episode keeps the guard so the next episode
    // is not queued twice, unless nothing is queued behind it any more (e.g.
    // it was reopened, which clears the playlist) — then queue it again.
    if (!episodeId || lastProcessedEpisodeId !== episodeId || !hasEntryAfterCurrent()) {
      lastProcessedEpisodeId = null;
      // Setup runs again and sets this once it has queued the next episode.
      // While the guard holds, setup is skipped, so the episode queued behind
      // this one must stay marked as queued for end-file to defer its stop.
      autoplayQueued = false;
    }
  }

  function clearQueuedFlag() {
    autoplayQueued = false;
  }

  function isQueued() {
    return autoplayQueued;
  }

  return {
    setupAutoplayForEpisode,
    cancelPendingSetup,
    resetForNewFile,
    clearQueuedFlag,
    isQueued,
  };
}

module.exports = {
  createAutoplayManager,
};
