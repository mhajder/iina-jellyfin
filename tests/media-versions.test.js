import assert from 'node:assert/strict';
import test from 'node:test';

import { loadCommonJs } from './helpers/load-commonjs.js';

const { withMediaSourceId, versionLabel, listVersions, createVersionSwitchState } = loadCommonJs(
  'src/lib/media-versions.js'
);

const STREAM = 'https://jf/Videos/item/stream?static=true&ApiKey=K';

test('a version is picked with the MediaSourceId parameter', () => {
  assert.equal(withMediaSourceId(STREAM, 'abc'), `${STREAM}&MediaSourceId=abc`);
});

test('switching again replaces the version, however it was spelled', () => {
  const url = 'https://jf/Videos/item/stream?static=true&mediaSourceId=old&ApiKey=K';
  assert.equal(
    withMediaSourceId(url, 'new'),
    'https://jf/Videos/item/stream?static=true&ApiKey=K&MediaSourceId=new'
  );
});

test('a version label shows the name, video format and bitrate', () => {
  const source = {
    Name: "Director's Cut",
    Bitrate: 58_400_000,
    MediaStreams: [
      { Type: 'Audio', DisplayTitle: 'English - TrueHD' },
      { Type: 'Video', DisplayTitle: '4K HEVC HDR' },
    ],
  };
  assert.equal(versionLabel(source, 0), "Director's Cut (4K HEVC HDR · 58 Mbps)");
});

test('a version label does not repeat the format or invent details', () => {
  const formatOnly = { MediaStreams: [{ Type: 'Video', DisplayTitle: '1080p H264' }] };
  assert.equal(versionLabel(formatOnly, 0), '1080p H264');
  assert.equal(versionLabel({ Bitrate: 4_250_000 }, 1), 'Version 2 (4.3 Mbps)');
});

test('the requested version is the one marked playing', () => {
  const info = {
    MediaSources: [
      { Id: 'a', Name: '4K' },
      { Id: 'b', Name: '1080p' },
    ],
  };
  assert.deepEqual(
    listVersions(info, 'b').map(({ id, current }) => [id, current]),
    [
      ['a', false],
      ['b', true],
    ]
  );
});

test('without a known version the first one is playing', () => {
  const info = { MediaSources: [{ Id: 'a' }, { Id: 'b' }] };
  assert.equal(listVersions(info, null)[0].current, true);
  assert.equal(listVersions(info, 'gone')[0].current, true);
  assert.equal(listVersions({}, null).length, 0);
});

test('a version switch starts only the matching load where the old one was', () => {
  const state = createVersionSwitchState();
  state.begin('item', 'b', 1234.5);

  assert.equal(state.startPositionFor({ itemId: 'item', mediaSourceId: 'a' }), null);
  assert.equal(state.startPositionFor({ itemId: 'other', mediaSourceId: 'b' }), null);
  assert.equal(state.startPositionFor({ itemId: 'item', mediaSourceId: 'b' }), 1234.5);
  assert.equal(state.finish({ itemId: 'item', mediaSourceId: 'b' }), 1234.5);
  assert.equal(state.startPositionFor({ itemId: 'item', mediaSourceId: 'b' }), null);
});

test('a switch ends when any other file loads instead', () => {
  const state = createVersionSwitchState();
  state.begin('item', 'b', 60);

  assert.equal(state.finish(null), null);
  assert.equal(state.finish({ itemId: 'item', mediaSourceId: 'b' }), null);
});

test('a switch whose file never opened expires', () => {
  let now = 0;
  const state = createVersionSwitchState({ now: () => now, ttlMs: 30000 });
  state.begin('item', 'b', 60);
  now = 30001;

  assert.equal(state.startPositionFor({ itemId: 'item', mediaSourceId: 'b' }), null);
});
