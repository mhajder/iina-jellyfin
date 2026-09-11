import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

/**
 * A tiny Jellyfin look-alike for end-to-end tests. It serves the sidebar's own
 * files under /ui/ (standing in for the plugin folder IINA loads them from) and
 * enough of the Jellyfin REST API for the sidebar to connect, browse and
 * download. Flip `state.online` to false to simulate losing the connection:
 * API requests are then dropped at the socket level while /ui/ keeps working,
 * exactly like a laptop whose home server is out of reach.
 */
export const TOKEN = 'e2e-access-token';
export const USER = { Id: 'user-1', Name: 'tester' };

export const ITEMS = {
  movie: {
    Id: 'movie-1',
    Type: 'Movie',
    Name: 'Big Film',
    ProductionYear: 2020,
    RunTimeTicks: 66 * 600000000,
  },
  broken: { Id: 'broken-1', Type: 'Movie', Name: 'Broken Film', ProductionYear: 2021 },
  slow: { Id: 'slow-1', Type: 'Movie', Name: 'Slow Film', ProductionYear: 2022 },
  series: { Id: 'series-1', Type: 'Series', Name: 'Show' },
  season: {
    Id: 'season-1',
    Type: 'Season',
    Name: 'Season 1',
    IndexNumber: 1,
    SeriesId: 'series-1',
  },
  episode: {
    Id: 'ep-1',
    Type: 'Episode',
    Name: 'Pilot',
    SeriesName: 'Show',
    SeriesId: 'series-1',
    SeasonId: 'season-1',
    ParentIndexNumber: 1,
    IndexNumber: 1,
    RunTimeTicks: 25 * 600000000,
    MediaSources: [{ Id: 'src-ep-1' }],
  },
};

const MEDIA_SIZES = { 'movie-1': 256 * 1024, 'ep-1': 64 * 1024, 'slow-1': 2 * 1024 * 1024 };

const SUBTITLES = {
  'movie-1': [
    { Index: 2, Language: 'eng', Codec: 'subrip', DisplayTitle: 'English' },
    { Index: 3, Language: 'pol', Codec: 'subrip', DisplayTitle: 'Polish' },
    { Index: 4, Language: 'ger', Codec: 'pgssub', IsTextSubtitleStream: false },
  ],
  'ep-1': [{ Index: 2, Language: 'eng', Codec: 'subrip', DisplayTitle: 'English' }],
};

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

/**
 * Deterministic file content: a repeating pattern derived from the item id, so
 * the test can verify the downloaded bytes without storing fixtures.
 */
export function mediaBytes(itemId) {
  const size = MEDIA_SIZES[itemId] || 32 * 1024;
  return Buffer.alloc(size, `${itemId}:`);
}

export function subtitleText(itemId, index) {
  const stream = (SUBTITLES[itemId] || []).find((entry) => entry.Index === index);
  const language = stream ? stream.Language : 'unknown';
  return `1\n00:00:01,000 --> 00:00:02,000\nHello from ${itemId} in ${language}\n`;
}

function subtitleStreams(itemId) {
  return (SUBTITLES[itemId] || []).map((stream) => ({
    Type: 'Subtitle',
    IsExternal: true,
    IsTextSubtitleStream: true,
    ...stream,
  }));
}

function isAuthorized(req) {
  const token = req.headers['x-emby-token'];
  const authorization = req.headers.authorization || '';
  return token === TOKEN || authorization.includes(`Token="${TOKEN}"`);
}

export function createMockJellyfin({ uiDir }) {
  const state = { online: true, requests: [], brokenItems: new Set(['broken-1']) };
  let server = null;

  function json(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  }

  function serveStatic(req, res, pathname) {
    const relative = pathname.replace(/^\/ui\//, '');
    const filePath = path.normalize(path.join(uiDir, relative));
    if (!filePath.startsWith(uiDir) || !fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': STATIC_TYPES[path.extname(filePath)] || 'text/plain' });
    fs.createReadStream(filePath).pipe(res);
  }

  function streamSlowly(res, bytes) {
    // 2 MB in 64 KB chunks every 100 ms: long enough to cancel mid-way
    const chunkSize = 64 * 1024;
    let offset = 0;
    res.writeHead(200, { 'Content-Type': 'video/x-matroska', 'Content-Length': bytes.length });
    const timer = setInterval(() => {
      if (res.destroyed) {
        clearInterval(timer);
        return;
      }
      res.write(bytes.subarray(offset, offset + chunkSize));
      offset += chunkSize;
      if (offset >= bytes.length) {
        clearInterval(timer);
        res.end();
      }
    }, 100);
  }

  function handleApi(req, res, url) {
    const { pathname, searchParams } = url;
    let match;

    if (pathname === '/System/Info/Public') {
      return json(res, 200, { ServerName: 'Mock Jellyfin', Version: '10.9.0' });
    }
    if (!isAuthorized(req)) {
      return json(res, 401, { error: 'unauthorized' });
    }
    if (pathname === '/System/Info') {
      return json(res, 200, { ServerName: 'Mock Jellyfin', Id: 'server-1' });
    }
    if (pathname === '/Users/Me') {
      return json(res, 200, USER);
    }
    if (pathname === '/Items/Latest') {
      return json(res, 200, [ITEMS.movie, ITEMS.series]);
    }
    if (pathname === '/UserItems/Resume') {
      return json(res, 200, { Items: [] });
    }
    if (pathname === '/Shows/NextUp') {
      return json(res, 200, { Items: [ITEMS.episode] });
    }
    if (pathname === '/Genres' || pathname === '/MusicGenres' || pathname === '/Artists') {
      return json(res, 200, { Items: [] });
    }
    if (pathname === '/Search/Hints') {
      return json(res, 200, {
        SearchHints: [{ ItemId: 'movie-1', Type: 'Movie', Name: 'Big Film', ProductionYear: 2020 }],
      });
    }
    if (pathname === '/Items') {
      const types = searchParams.get('IncludeItemTypes') || '';
      if (types.includes('Movie')) {
        return json(res, 200, { Items: [ITEMS.movie, ITEMS.broken, ITEMS.slow] });
      }
      if (types.includes('Series')) {
        return json(res, 200, { Items: [ITEMS.series] });
      }
      return json(res, 200, { Items: [] });
    }
    if (pathname === '/Shows/series-1/Seasons') {
      return json(res, 200, { Items: [ITEMS.season] });
    }
    if (pathname === '/Shows/series-1/Episodes') {
      return json(res, 200, { Items: [ITEMS.episode] });
    }
    if ((match = pathname.match(/^\/Items\/([^/]+)\/PlaybackInfo$/))) {
      const itemId = match[1];
      return json(res, 200, {
        PlaySessionId: 'ps-1',
        MediaSources: [
          {
            Id: `src-${itemId}`,
            Container: 'mkv,webm',
            Size: mediaBytes(itemId).length,
            MediaStreams: [{ Type: 'Video' }, ...subtitleStreams(itemId)],
          },
        ],
      });
    }
    if ((match = pathname.match(/^\/Items\/([^/]+)\/Images\//))) {
      res.writeHead(404);
      return res.end();
    }
    if ((match = pathname.match(/^\/Items\/([^/]+)$/))) {
      const item = Object.values(ITEMS).find((entry) => entry.Id === match[1]);
      return item ? json(res, 200, item) : json(res, 404, { error: 'unknown item' });
    }
    if ((match = pathname.match(/^\/Videos\/([^/]+)\/stream$/))) {
      const itemId = match[1];
      if (state.brokenItems.has(itemId)) {
        return json(res, 500, { error: 'transcoder exploded' });
      }
      const bytes = mediaBytes(itemId);
      if (itemId === 'slow-1') {
        return streamSlowly(res, bytes);
      }
      res.writeHead(200, { 'Content-Type': 'video/x-matroska', 'Content-Length': bytes.length });
      return res.end(bytes);
    }
    if ((match = pathname.match(/^\/Videos\/([^/]+)\/[^/]+\/Subtitles\/(\d+)\/stream\.\w+$/))) {
      const text = subtitleText(match[1], Number(match[2]));
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Content-Length': Buffer.byteLength(text),
      });
      return res.end(text);
    }
    return json(res, 404, { error: `no route for ${pathname}` });
  }

  function requestListener(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/ui/')) {
      return serveStatic(req, res, url.pathname);
    }
    state.requests.push({ method: req.method, path: url.pathname, query: url.search });
    if (!state.online) {
      // Nothing answers: the same failure a client sees without network.
      req.socket.destroy();
      return undefined;
    }
    return handleApi(req, res, url);
  }

  return {
    state,
    mediaBytes,
    subtitleText,
    async start() {
      server = http.createServer(requestListener);
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();
      this.baseUrl = `http://127.0.0.1:${port}`;
      return this.baseUrl;
    },
    async stop() {
      if (!server) return;
      await new Promise((resolve) => server.close(resolve));
      server = null;
    },
    requestsTo(pathname) {
      return state.requests.filter((request) => request.path === pathname);
    },
  };
}
