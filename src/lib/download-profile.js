'use strict';

/**
 * Quality choices for offline downloads. "original" fetches the file as it
 * is stored on the server; every other preset asks Jellyfin to transcode to a
 * progressive MP4 capped at that bitrate (the server picks the resolution
 * that fits the bitrate), which is what a phone or a slow disk wants.
 *
 * Mirrors the presets of Streamyfin's download quality picker.
 */
const QUALITY_PRESETS = [
  { id: 'original', label: 'Original quality', bitrate: null },
  { id: '8000', label: '8 Mb/s', bitrate: 8000000 },
  { id: '4000', label: '4 Mb/s', bitrate: 4000000 },
  { id: '2000', label: '2 Mb/s', bitrate: 2000000 },
  { id: '1000', label: '1 Mb/s', bitrate: 1000000 },
  { id: '500', label: '500 Kb/s', bitrate: 500000 },
  { id: '250', label: '250 Kb/s', bitrate: 250000 },
];

const DEFAULT_QUALITY_ID = QUALITY_PRESETS[0].id;

// Text formats can be saved as sidecar files next to the video; image
// formats have no sidecar representation mpv could load, so the server burns
// them into the transcoded picture.
const TEXT_SUBTITLE_FORMATS = [
  'srt',
  'subrip',
  'vtt',
  'webvtt',
  'ass',
  'ssa',
  'ttml',
  'mov_text',
  'microdvd',
  'mpl2',
  'pjs',
  'realtext',
  'scc',
  'smi',
  'stl',
  'sub',
  'subviewer',
  'text',
  'vplayer',
];
const IMAGE_SUBTITLE_FORMATS = ['dvdsub', 'idx', 'pgs', 'pgssub', 'teletext', 'vobsub', 'xsub'];

/**
 * The preset for an id; unknown or missing ids fall back to the original
 * quality so a stale preference can never break downloads.
 */
function resolveQualityPreset(id) {
  return QUALITY_PRESETS.find((preset) => preset.id === String(id)) || QUALITY_PRESETS[0];
}

/**
 * Presets as sent to the sidebar (no internal fields).
 */
function listQualityPresets() {
  return QUALITY_PRESETS.map(({ id, label }) => ({ id, label }));
}

/**
 * Device profile sent with the PlaybackInfo request of a capped download.
 * Direct play is allowed for anything IINA plays; when the source exceeds
 * the bitrate cap the server answers with a TranscodingUrl to a progressive
 * MP4 (H.264/HEVC + AAC/AC3), which streams to disk while it is encoded.
 */
function buildDownloadDeviceProfile(bitrate) {
  return {
    Name: 'IINA Jellyfin Offline Download',
    MaxStreamingBitrate: bitrate,
    MaxStaticBitrate: bitrate,
    DirectPlayProfiles: [
      {
        Type: 'Video',
        Container: 'mp4,mkv,avi,mov,flv,ts,m2ts,webm,ogv,3gp',
        VideoCodec: 'h264,hevc,h265,mpeg4,mpeg2video,vp8,vp9,av1',
        AudioCodec: 'aac,mp3,ac3,eac3,dts,truehd,flac,opus,vorbis,alac,pcm',
      },
      {
        Type: 'Audio',
        Container: 'mp3,m4a,aac,flac,alac,wav,ogg,opus',
        AudioCodec: 'mp3,aac,alac,flac,opus,vorbis,pcm',
      },
    ],
    TranscodingProfiles: [
      {
        Type: 'Video',
        Context: 'Streaming',
        Protocol: 'http',
        Container: 'mp4',
        VideoCodec: 'h264,hevc',
        AudioCodec: 'aac,mp3,ac3,eac3',
        MaxAudioChannels: '6',
        CopyTimestamps: false,
      },
      {
        Type: 'Audio',
        Context: 'Streaming',
        Protocol: 'http',
        Container: 'mp3',
        AudioCodec: 'mp3',
        MaxAudioChannels: '2',
      },
    ],
    CodecProfiles: [],
    SubtitleProfiles: [
      ...TEXT_SUBTITLE_FORMATS.map((Format) => ({ Format, Method: 'External' })),
      ...IMAGE_SUBTITLE_FORMATS.map((Format) => ({ Format, Method: 'Encode' })),
    ],
  };
}

/**
 * Container extension of a Jellyfin transcoding URL such as
 * /Videos/{id}/stream.mp4?...; falls back to mp4.
 */
function containerFromTranscodingUrl(transcodingUrl) {
  const match = String(transcodingUrl || '').match(/\/(?:stream|master)\.([a-z0-9]+)(?:\?|$)/i);
  return match ? match[1].toLowerCase() : 'mp4';
}

module.exports = {
  QUALITY_PRESETS,
  DEFAULT_QUALITY_ID,
  TEXT_SUBTITLE_FORMATS,
  IMAGE_SUBTITLE_FORMATS,
  resolveQualityPreset,
  listQualityPresets,
  buildDownloadDeviceProfile,
  containerFromTranscodingUrl,
};
