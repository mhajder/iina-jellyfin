import { describe, expect, it } from 'vitest';
import {
  QUALITY_PRESETS,
  DEFAULT_QUALITY_ID,
  TEXT_SUBTITLE_FORMATS,
  IMAGE_SUBTITLE_FORMATS,
  resolveQualityPreset,
  listQualityPresets,
  buildDownloadDeviceProfile,
  containerFromTranscodingUrl,
} from '../../src/lib/download-profile.js';

describe('quality presets', () => {
  it('starts with the original quality and descends by bitrate', () => {
    expect(DEFAULT_QUALITY_ID).toBe('original');
    expect(QUALITY_PRESETS[0]).toEqual({
      id: 'original',
      label: 'Original quality',
      bitrate: null,
    });
    const bitrates = QUALITY_PRESETS.slice(1).map((preset) => preset.bitrate);
    expect(bitrates).toEqual([8000000, 4000000, 2000000, 1000000, 500000, 250000]);
    expect(QUALITY_PRESETS.slice(1).map((preset) => preset.label)).toEqual([
      '8 Mb/s',
      '4 Mb/s',
      '2 Mb/s',
      '1 Mb/s',
      '500 Kb/s',
      '250 Kb/s',
    ]);
    expect(QUALITY_PRESETS.map((preset) => preset.id)).toEqual([
      'original',
      '8000',
      '4000',
      '2000',
      '1000',
      '500',
      '250',
    ]);
  });

  it('resolves ids, numbers and garbage', () => {
    expect(resolveQualityPreset('2000')).toEqual({ id: '2000', label: '2 Mb/s', bitrate: 2000000 });
    expect(resolveQualityPreset(500).id).toBe('500');
    expect(resolveQualityPreset('nope').id).toBe('original');
    expect(resolveQualityPreset(undefined).id).toBe('original');
    expect(resolveQualityPreset(null).id).toBe('original');
    expect(resolveQualityPreset('').id).toBe('original');
  });

  it('lists presets without internal fields', () => {
    const listed = listQualityPresets();
    expect(listed).toHaveLength(QUALITY_PRESETS.length);
    expect(listed[1]).toEqual({ id: '8000', label: '8 Mb/s' });
    expect(Object.keys(listed[0])).toEqual(['id', 'label']);
  });
});

describe('buildDownloadDeviceProfile', () => {
  const profile = buildDownloadDeviceProfile(2000000);

  it('caps the bitrate and asks for a progressive mp4', () => {
    expect(profile.Name).toBe('IINA Jellyfin Offline Download');
    expect(profile.MaxStreamingBitrate).toBe(2000000);
    expect(profile.MaxStaticBitrate).toBe(2000000);
    expect(profile.TranscodingProfiles).toEqual([
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
    ]);
    expect(profile.CodecProfiles).toEqual([]);
  });

  it('allows direct play of what IINA can play', () => {
    expect(profile.DirectPlayProfiles).toHaveLength(2);
    expect(profile.DirectPlayProfiles[0]).toEqual({
      Type: 'Video',
      Container: 'mp4,mkv,avi,mov,flv,ts,m2ts,webm,ogv,3gp',
      VideoCodec: 'h264,hevc,h265,mpeg4,mpeg2video,vp8,vp9,av1',
      AudioCodec: 'aac,mp3,ac3,eac3,dts,truehd,flac,opus,vorbis,alac,pcm',
    });
    expect(profile.DirectPlayProfiles[1]).toEqual({
      Type: 'Audio',
      Container: 'mp3,m4a,aac,flac,alac,wav,ogg,opus',
      AudioCodec: 'mp3,aac,alac,flac,opus,vorbis,pcm',
    });
  });

  it('keeps text subtitles external and burns image subtitles in', () => {
    const external = profile.SubtitleProfiles.filter((entry) => entry.Method === 'External');
    const encoded = profile.SubtitleProfiles.filter((entry) => entry.Method === 'Encode');
    expect(external.map((entry) => entry.Format)).toEqual(TEXT_SUBTITLE_FORMATS);
    expect(encoded.map((entry) => entry.Format)).toEqual(IMAGE_SUBTITLE_FORMATS);
    expect(profile.SubtitleProfiles).toHaveLength(
      TEXT_SUBTITLE_FORMATS.length + IMAGE_SUBTITLE_FORMATS.length
    );
    expect(TEXT_SUBTITLE_FORMATS).toEqual(expect.arrayContaining(['srt', 'subrip', 'vtt', 'ass']));
    expect(IMAGE_SUBTITLE_FORMATS).toEqual(expect.arrayContaining(['pgssub', 'vobsub', 'dvdsub']));
  });

  it('builds a fresh object per call', () => {
    expect(buildDownloadDeviceProfile(500000)).not.toBe(profile);
    expect(buildDownloadDeviceProfile(500000).MaxStreamingBitrate).toBe(500000);
  });
});

describe('containerFromTranscodingUrl', () => {
  it('reads the extension of stream and master urls', () => {
    expect(containerFromTranscodingUrl('/Videos/a/stream.mp4?x=1')).toBe('mp4');
    expect(containerFromTranscodingUrl('/Videos/a/stream.MKV')).toBe('mkv');
    expect(containerFromTranscodingUrl('/Videos/a/master.m3u8?x=1')).toBe('m3u8');
    expect(containerFromTranscodingUrl('/Audio/a/stream.mp3?api_key=k')).toBe('mp3');
  });

  it('falls back to mp4', () => {
    expect(containerFromTranscodingUrl('/Videos/a/stream?x=1')).toBe('mp4');
    expect(containerFromTranscodingUrl('/Videos/a/other.mp4')).toBe('mp4');
    expect(containerFromTranscodingUrl('')).toBe('mp4');
    expect(containerFromTranscodingUrl(undefined)).toBe('mp4');
  });
});
