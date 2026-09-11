import { describe, expect, it } from 'vitest';
import { subtitleExtensionForCodec, isExternalTextSubtitle } from '../../src/lib/subtitle-utils.js';

describe('subtitleExtensionForCodec', () => {
  it.each([
    ['subrip', 'srt'],
    ['SubRip', 'srt'],
    ['webvtt', 'vtt'],
    ['vtt', 'vtt'],
    ['ass', 'ass'],
    ['ssa', 'ssa'],
    ['x-srt-custom', 'srt'],
    ['some-vtt-variant', 'vtt'],
    ['pgssub', 'srt'],
    ['', 'srt'],
    [null, 'srt'],
    [undefined, 'srt'],
  ])('maps %j to %s', (codec, expected) => {
    expect(subtitleExtensionForCodec(codec)).toBe(expected);
  });
});

describe('isExternalTextSubtitle', () => {
  const external = { Type: 'Subtitle', IsTextSubtitleStream: true, IsExternal: true };

  it('accepts an external text subtitle stream', () => {
    expect(isExternalTextSubtitle(external)).toBe(true);
  });

  it('rejects embedded streams', () => {
    expect(isExternalTextSubtitle({ ...external, IsExternal: false })).toBe(false);
  });

  it('rejects image based subtitles', () => {
    expect(isExternalTextSubtitle({ ...external, IsTextSubtitleStream: false })).toBe(false);
  });

  it('rejects other stream types', () => {
    expect(isExternalTextSubtitle({ ...external, Type: 'Audio' })).toBe(false);
  });

  it('rejects truthy but non-boolean flags', () => {
    expect(isExternalTextSubtitle({ ...external, IsExternal: 'yes' })).toBe(false);
  });

  it('rejects missing streams', () => {
    expect(isExternalTextSubtitle(null)).toBe(false);
    expect(isExternalTextSubtitle(undefined)).toBe(false);
  });
});
