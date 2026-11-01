'use strict';

/**
 * Jellyfin groups several files of one item (a 4K and a 1080p release, say)
 * as its media sources, shown as "versions". Playback direct-plays one of
 * them, chosen with the MediaSourceId query parameter; without it Jellyfin
 * plays the first media source.
 */

/** The URL with its MediaSourceId parameter set to this version. */
function withMediaSourceId(url, mediaSourceId) {
  const [base, query = ''] = String(url).split('?');
  const params = query.split('&').filter((param) => param && !/^mediasourceid=/i.test(param));
  params.push(`MediaSourceId=${encodeURIComponent(mediaSourceId)}`);
  return `${base}?${params.join('&')}`;
}

function formatBitrate(bitsPerSecond) {
  if (!bitsPerSecond) return null;
  const mbps = bitsPerSecond / 1e6;
  return `${mbps >= 10 ? Math.round(mbps) : mbps.toFixed(1)} Mbps`;
}

/**
 * A menu label for a media source: its name, then the video format and
 * bitrate, e.g. "Director's Cut (4K HEVC HDR · 58 Mbps)".
 */
function versionLabel(source, index) {
  const video = (source.MediaStreams || []).find((stream) => stream.Type === 'Video');
  const format = (video && video.DisplayTitle) || null;
  const name = source.Name || format || `Version ${index + 1}`;
  const details = [format !== name ? format : null, formatBitrate(source.Bitrate)].filter(Boolean);
  return details.length > 0 ? `${name} (${details.join(' · ')})` : name;
}

/**
 * The versions of an item, for the menu. The one playing is the requested
 * media source or, without one (or an unknown one), the first.
 */
function listVersions(playbackInfo, requestedMediaSourceId) {
  const sources = ((playbackInfo && playbackInfo.MediaSources) || []).filter((source) => source.Id);
  const playing = sources.find((source) => source.Id === requestedMediaSourceId) || sources[0];
  return sources.map((source, index) => ({
    id: source.Id,
    label: versionLabel(source, index),
    current: source === playing,
  }));
}

/**
 * A version switch reopens the item. The new load has to start where the old
 * one was, and must not then seek to the Jellyfin resume point. The switch is
 * matched by item and media source id rather than the whole URL, which IINA
 * may re-encode, and expires so a failed open cannot leak into a later play
 * of the same version.
 */
function createVersionSwitchState({ now = () => Date.now(), ttlMs = 30000 } = {}) {
  let pending = null;

  function matches(info) {
    return (
      pending !== null &&
      Boolean(info) &&
      now() - pending.at <= ttlMs &&
      pending.itemId === info.itemId &&
      pending.mediaSourceId === info.mediaSourceId
    );
  }

  return {
    begin(itemId, mediaSourceId, position) {
      pending = { itemId, mediaSourceId, position, at: now() };
    },
    /** Where a load of this item and version starts, or null if not switching. */
    startPositionFor(info) {
      return matches(info) ? pending.position : null;
    },
    /** Ends the switch once a file has loaded; returns its start position or null. */
    finish(info) {
      const position = matches(info) ? pending.position : null;
      pending = null;
      return position;
    },
  };
}

module.exports = {
  withMediaSourceId,
  versionLabel,
  listVersions,
  createVersionSwitchState,
};
