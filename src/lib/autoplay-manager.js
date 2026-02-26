'use strict';

function createAutoplayManager({
  http,
  mpv,
  core,
  preferences,
  buildJellyfinHeaders,
  fetchItemMetadata,
  log,
}) {
  let lastProcessedEpisodeId = null;
  let lastProcessedSeriesId = null;
  let autoplayRequestCounter = 0;
  let autoplayQueued = false;

  async function fetchSeriesEpisodes(serverBase, seriesId, seasonId, apiKey) {
    try {
      log(`Fetching episodes for series: ${seriesId}, season: ${seasonId}`);

      const queryParams = [
        'seasonId=' + encodeURIComponent(seasonId),
        'fields=' + encodeURIComponent('MediaSources,Path,LocationType,IsFolder,CanDownload'),
      ].join('&');

      const response = await http.get(
        `${serverBase}/Shows/${seriesId}/Episodes?${queryParams}&api_key=${apiKey}`,
        {
          headers: buildJellyfinHeaders(apiKey, {
            Accept: 'application/json',
          }),
        }
      );

      if (!response.data) {
        throw new Error('No data received from Jellyfin API');
      }

      const episodeData =
        typeof response.data === 'string' ? JSON.parse(response.data) : response.data;

      if (!episodeData.Items) {
        log('No episodes found in response');
        return [];
      }

      const episodes = episodeData.Items.filter((episode) => {
        const hasMediaSources = episode.MediaSources && episode.MediaSources.length > 0;
        const canDownload = episode.CanDownload !== false;
        return hasMediaSources && canDownload;
      }).map((episode) => ({
        id: episode.Id,
        name: episode.Name,
        indexNumber: Number(episode.IndexNumber) || 0,
        duration: episode.RunTimeTicks,
        playUrl: `${serverBase}/Items/${episode.Id}/Download?api_key=${apiKey}`,
      }));

      episodes.sort((left, right) => left.indexNumber - right.indexNumber);

      log(
        `Fetched ${episodes.length} episodes from series: ${episodes.map((episode) => `E${episode.indexNumber}`).join(', ')}`
      );
      return episodes;
    } catch (error) {
      log(`Error fetching series episodes: ${error.message}`);
      return [];
    }
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
      const seasonNumber = Number(metadata.ParentIndexNumber) || 1;
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

  async function resolveNextEpisode(serverBase, seriesId, seasonId, currentEpisodeNumber, apiKey) {
    try {
      const episodes = await fetchSeriesEpisodes(serverBase, seriesId, seasonId, apiKey);
      const currentEpNum = Number(currentEpisodeNumber);
      const nextEpisode = episodes.find((episode) => episode.indexNumber === currentEpNum + 1);

      if (nextEpisode) {
        log(
          `Found next episode in current season: E${nextEpisode.indexNumber} - ${nextEpisode.name}`
        );
        return nextEpisode;
      }

      log('No next episode in current season, checking next season...');

      const seasonsResponse = await http.get(
        `${serverBase}/Shows/${seriesId}/Seasons?api_key=${apiKey}`,
        {
          headers: buildJellyfinHeaders(apiKey, { Accept: 'application/json' }),
        }
      );

      if (!seasonsResponse.data) return null;

      const seasonsData =
        typeof seasonsResponse.data === 'string'
          ? JSON.parse(seasonsResponse.data)
          : seasonsResponse.data;

      if (!seasonsData.Items || seasonsData.Items.length === 0) return null;

      const sortedSeasons = seasonsData.Items.filter(
        (season) => season.IndexNumber !== null && season.IndexNumber !== undefined
      ).sort((left, right) => (left.IndexNumber || 0) - (right.IndexNumber || 0));

      const currentSeasonIndex = sortedSeasons.findIndex((season) => season.Id === seasonId);
      if (currentSeasonIndex === -1 || currentSeasonIndex >= sortedSeasons.length - 1) {
        log('No next season available — end of series');
        return null;
      }

      const nextSeason = sortedSeasons[currentSeasonIndex + 1];
      log(`Found next season: ${nextSeason.Name} (S${nextSeason.IndexNumber})`);

      const nextSeasonEpisodes = await fetchSeriesEpisodes(
        serverBase,
        seriesId,
        nextSeason.Id,
        apiKey
      );

      if (nextSeasonEpisodes.length === 0) {
        log('Next season has no episodes');
        return null;
      }

      const firstEpisode = nextSeasonEpisodes[0];
      log(
        `Found first episode of next season: S${nextSeason.IndexNumber}E${firstEpisode.indexNumber} - ${firstEpisode.name}`
      );

      firstEpisode.seasonNumber = nextSeason.IndexNumber;

      return firstEpisode;
    } catch (error) {
      log(`Error resolving next episode: ${error.message}`);
      return null;
    }
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
        const currentPos = Number(mpv.getNumber('playlist-pos') || 0);

        if (playlistCount > currentPos + 1) {
          for (let i = playlistCount - 1; i > currentPos; i--) {
            try {
              mpv.command('playlist-remove', [String(i)]);
            } catch {
              // Ignore removal errors
            }
          }
          log(`Cleaned ${playlistCount - currentPos - 1} stale playlist entries`);
        }
      } catch {
        log('Could not clean playlist (non-critical)');
      }

      mpv.command('loadfile', [
        nextEpisode.playUrl,
        'insert-next',
        '-1',
        `force-media-title=${episodeTitle}`,
      ]);

      autoplayQueued = true;

      log(`Queued next episode: ${episodeTitle}`);

      if (preferences.get('show_notifications')) {
        core.osd(`Up next: ${episodeTitle}`);
      }
    } catch (error) {
      log(`Error queuing next episode: ${error.message}`);
    }
  }

  function storeCurrentEpisodeInfo(episodeId, seriesInfo) {
    try {
      if (!seriesInfo) {
        log('Series info is null, clearing stored episode info');
        preferences.set('last_episode_id', '');
        preferences.set('last_series_id', '');
        preferences.set('last_season_id', '');
        preferences.set('last_episode_number', 0);
        return;
      }

      log(
        `Storing episode info for autoplay - Episode: ${episodeId}, Series: ${seriesInfo.seriesId}`
      );
      preferences.set('last_episode_id', episodeId);
      preferences.set('last_series_id', seriesInfo.seriesId);
      preferences.set('last_season_id', seriesInfo.seasonId);
      preferences.set('last_episode_number', seriesInfo.currentEpisodeNumber);
      preferences.sync();
    } catch (error) {
      log(`Error storing episode info: ${error.message}`);
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

        log(
          `Got series info: series=${seriesInfo.seriesId}, season=${seriesInfo.seasonId}, seasonNum=${seriesInfo.seasonNumber}, currentEp=${seriesInfo.currentEpisodeNumber}`
        );

        if (lastProcessedSeriesId !== seriesInfo.seriesId) {
          log(`Series changed from ${lastProcessedSeriesId} to ${seriesInfo.seriesId}`);
          lastProcessedSeriesId = seriesInfo.seriesId;
        }

        storeCurrentEpisodeInfo(episodeId, seriesInfo);

        const nextEpisode = await resolveNextEpisode(
          serverBase,
          seriesInfo.seriesId,
          seriesInfo.seasonId,
          seriesInfo.currentEpisodeNumber,
          apiKey
        );

        if (thisRequestId !== autoplayRequestCounter) {
          log(`Autoplay request #${thisRequestId} is stale after resolve, aborting`);
          return;
        }

        if (!nextEpisode) {
          log('No next episode found — end of series');
          return;
        }

        const seasonNum = nextEpisode.seasonNumber || seriesInfo.seasonNumber;
        queueNextEpisode(nextEpisode, seriesInfo.seriesName, seasonNum);

        log(`Autoplay setup complete — queued next episode: ${nextEpisode.name}`);
      } catch (error) {
        log(`Error setting up autoplay: ${error.message}`);
      }
    })();
  }

  function resetForNewFile() {
    lastProcessedEpisodeId = null;
    autoplayQueued = false;
  }

  function clearQueuedFlag() {
    autoplayQueued = false;
  }

  function isQueued() {
    return autoplayQueued;
  }

  return {
    setupAutoplayForEpisode,
    resetForNewFile,
    clearQueuedFlag,
    isQueued,
  };
}

module.exports = {
  createAutoplayManager,
};
