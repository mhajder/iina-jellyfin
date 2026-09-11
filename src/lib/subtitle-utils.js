'use strict';

/**
 * File extension for a Jellyfin subtitle codec name. Jellyfin serves text
 * subtitles converted to whatever extension the stream URL asks for, so the
 * mapping only has to pick something mpv recognises.
 */
function subtitleExtensionForCodec(codec) {
  const normalized = String(codec || '').toLowerCase();
  if (normalized === 'subrip') return 'srt';
  if (normalized === 'webvtt' || normalized === 'vtt') return 'vtt';
  if (normalized === 'ass') return 'ass';
  if (normalized === 'ssa') return 'ssa';
  if (normalized.includes('srt')) return 'srt';
  if (normalized.includes('vtt')) return 'vtt';
  return 'srt';
}

/**
 * Whether a MediaStream is an external text subtitle file. Embedded tracks
 * travel inside the media file itself and never need a separate download.
 */
function isExternalTextSubtitle(stream) {
  return Boolean(
    stream &&
    stream.Type === 'Subtitle' &&
    stream.IsTextSubtitleStream === true &&
    stream.IsExternal === true
  );
}

module.exports = {
  subtitleExtensionForCodec,
  isExternalTextSubtitle,
};
