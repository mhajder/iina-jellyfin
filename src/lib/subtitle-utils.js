'use strict';

/**
 * File extension for a Jellyfin subtitle codec name. Jellyfin serves text
 * subtitles converted to whatever extension the stream URL asks for, so the
 * mapping only has to pick something mpv recognises.
 */
const EXTENSION_BY_CODEC = {
  subrip: 'srt',
  srt: 'srt',
  webvtt: 'vtt',
  vtt: 'vtt',
  ass: 'ass',
  ssa: 'ssa',
};

function subtitleExtensionForCodec(codec) {
  const normalized = String(codec).toLowerCase();
  if (EXTENSION_BY_CODEC[normalized]) {
    return EXTENSION_BY_CODEC[normalized];
  }
  if (normalized.includes('vtt')) {
    return 'vtt';
  }
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
