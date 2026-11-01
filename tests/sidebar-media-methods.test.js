import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { runScript } from './helpers/load-commonjs.js';

const SERVER = 'https://jf.example.com';
const TOKEN = 'tok-123';

const camel = (name) => name.replace(/-(\w)/g, (_, c) => c.toUpperCase());

// Just enough of a DOM element for the mixin: class handling, listeners,
// children and a querySelectorAll that finds tagged elements in innerHTML.
class FakeElement {
  constructor(tagName = 'div', id = null) {
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.listeners = {};
    this.textContent = '';
    this.value = '';
    this.title = '';
    this.disabled = false;
    this.selectedIndex = -1;
    this.classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      contains: (name) => this.classes.has(name),
      toggle: (name, force) => {
        const on = force ?? !this.classes.has(name);
        if (on) this.classes.add(name);
        else this.classes.delete(name);
        return on;
      },
    };
    this.html = '';
    this.queried = new Map();
  }

  get className() {
    return [...this.classes].join(' ');
  }

  set className(value) {
    this.classes = new Set(value.split(/\s+/).filter(Boolean));
  }

  get innerHTML() {
    return this.html;
  }

  set innerHTML(html) {
    this.html = html;
    this.children = [];
    this.queried = new Map();
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  addEventListener(type, listener) {
    (this.listeners[type] ||= []).push(listener);
  }

  click() {
    const event = {
      stopped: false,
      stopPropagation() {
        this.stopped = true;
      },
    };
    for (const listener of this.listeners.click || []) listener(event);
    return event;
  }

  querySelectorAll(selector) {
    if (!this.queried.has(selector)) {
      const cls = selector.replace(/^\./, '');
      const found = [];
      for (const [, tag, attrs] of this.html.matchAll(/<(\w+)([^>]*)>/g)) {
        const classAttr = /class="([^"]*)"/.exec(attrs);
        if (!classAttr || !classAttr[1].split(/\s+/).includes(cls)) continue;
        const el = new FakeElement(tag);
        for (const [, key, value] of attrs.matchAll(/data-([\w-]+)="([^"]*)"/g)) {
          el.dataset[camel(key)] = value;
        }
        found.push(el);
      }
      this.queried.set(selector, found);
    }
    return this.queried.get(selector);
  }
}

function matches(el, selector) {
  const attr = /^\[data-([\w-]+)="([^"]*)"\]$/.exec(selector);
  if (attr) return el.dataset[camel(attr[1])] === attr[2];
  return selector
    .split('.')
    .filter(Boolean)
    .every((cls) => el.classList.contains(cls));
}

function createDocument() {
  const byId = new Map();
  function* walk(elements) {
    for (const el of elements) {
      yield el;
      yield* walk(el.children);
    }
  }
  return {
    createElement: (tag) => new FakeElement(tag),
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, new FakeElement('div', id));
      return byId.get(id);
    },
    querySelectorAll: (selector) => [...walk(byId.values())].filter((el) => matches(el, selector)),
    querySelector: (selector) =>
      [...walk(byId.values())].find((el) => matches(el, selector)) || null,
  };
}

// Requests stay pending until resolved, unless `http.reply(url)` answers them.
function createHttp() {
  const http = {
    requests: [],
    reply: null,
    get(url, options) {
      return new Promise((resolve, reject) => {
        const request = {
          url,
          options,
          path: new URL(url).pathname,
          params: new URL(url).searchParams,
          resolve: (data) => resolve({ status: 200, data }),
          reject,
        };
        http.requests.push(request);
        if (http.reply) {
          try {
            request.resolve(http.reply(request));
          } catch (error) {
            reject(error);
          }
        }
      });
    },
  };
  return http;
}

function createClient({ bridge = true } = {}) {
  const document = createDocument();
  const posted = [];
  const opened = [];
  const scrolls = [];
  const timers = [];
  const window = {
    scrollTo: (options) => scrolls.push(options),
    open: (url, target) => opened.push({ url, target }),
  };
  const globals = {
    window,
    document,
    URLSearchParams,
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      if (timer) timer.cleared = true;
    },
  };
  if (bridge) {
    globals.iina = { postMessage: (name, data) => posted.push({ name, data: plain(data) }) };
  }
  const context = vm.createContext(globals);
  runScript('src/ui/sidebar/lib/auth-server-methods.js', context);
  runScript('src/ui/sidebar/lib/media-methods.js', context);
  const authMethods = context.window.createSidebarAuthServerMethods(() => {});
  const mediaMethods = context.window.createSidebarMediaMethods(() => {});

  const http = createHttp();
  const client = {
    ...mediaMethods,
    escapeHtml: authMethods.escapeHtml,
    currentServer: { url: SERVER, accessToken: TOKEN },
    currentUser: { Id: 'user-1', Name: 'Ann' },
    buildAuthorizationHeader: (token) => `MediaBrowser Token="${token}"`,
    getHttpClient: () => http,
  };

  for (const section of ['movies', 'series', 'music']) {
    document.getElementById(`${section}SortSelect`).value = 'SortName,Ascending';
    document.getElementById(`${section}GenreSelect`).value = 'all';
  }
  document.getElementById('moviesFilterSelect').value = 'all';
  document.getElementById('seriesFilterSelect').value = 'all';
  document.getElementById('musicViewSelect').value = 'albums';

  return { client, document, http, posted, opened, scrolls, timers };
}

// Values built inside the vm context have that context's prototypes.
const plain = (value) => JSON.parse(JSON.stringify(value));
const flush = () => new Promise((resolve) => setImmediate(resolve));
const byPath = (routes) => (request) => {
  const reply = routes[request.path];
  if (reply === undefined) throw new Error(`unexpected request ${request.url}`);
  if (reply instanceof Error) throw reply;
  return typeof reply === 'function' ? reply(request) : reply;
};
const button = (el, selector, action) =>
  el.querySelectorAll(selector).find((b) => b.dataset.action === action);
const streamUrl = (route, id) => `${SERVER}/${route}/${id}/stream?static=true&ApiKey=${TOKEN}`;

test('movies are requested with the chosen sort, filter and genre and rendered', async () => {
  const { client, document, http } = createClient();
  document.getElementById('moviesSortSelect').value = 'PremiereDate,Descending';
  document.getElementById('moviesFilterSelect').value = 'favorites';
  document.getElementById('moviesGenreSelect').value = 'Comedy';
  http.reply = () => ({
    Items: [
      {
        Id: 'm1',
        Name: 'Heat',
        Type: 'Movie',
        ProductionYear: 1995,
        RunTimeTicks: 170 * 600000000,
        ImageTags: { Primary: 'p' },
      },
    ],
  });

  await client.loadMovies();

  const [request] = http.requests;
  assert.equal(request.path, '/Items');
  assert.equal(request.params.get('userId'), 'user-1');
  assert.equal(request.params.get('IncludeItemTypes'), 'Movie');
  assert.equal(request.params.get('SortBy'), 'PremiereDate');
  assert.equal(request.params.get('SortOrder'), 'Descending');
  assert.equal(request.params.get('Filters'), 'IsFavorite');
  assert.equal(request.params.get('Genres'), 'Comedy');
  assert.equal(request.params.has('IsPlayed'), false);
  assert.equal(request.options.headers.Authorization, `MediaBrowser Token="${TOKEN}"`);

  const list = document.getElementById('moviesList');
  assert.equal(list.children.length, 1);
  const [item] = list.children;
  assert.equal(item.dataset.itemId, 'm1');
  assert.match(item.innerHTML, /Heat \(1995\)/);
  assert.match(item.innerHTML, /2h 50m/);
  assert.ok(
    item.innerHTML.includes(
      `src="${SERVER}/Items/m1/Images/Primary?maxWidth=160&amp;quality=90&amp;ApiKey=${TOKEN}"`
    )
  );
});

test('series filtered to unwatched ask for unplayed items and report an empty result', async () => {
  const { client, document, http } = createClient();
  document.getElementById('seriesFilterSelect').value = 'unwatched';
  http.reply = () => ({ Items: [] });

  await client.loadSeries();

  const [request] = http.requests;
  assert.equal(request.params.get('IncludeItemTypes'), 'Series');
  assert.equal(request.params.get('IsPlayed'), 'false');
  assert.equal(request.params.has('Genres'), false);
  assert.equal(request.params.has('Filters'), false);
  assert.match(document.getElementById('seriesList').innerHTML, /No series found/);
});

test('failed movie and series requests show an error in their lists', async () => {
  const { client, document, http } = createClient();
  http.reply = () => {
    throw new Error('offline');
  };

  await client.loadMovies();
  await client.loadSeries();

  assert.match(document.getElementById('moviesList').innerHTML, /Failed to load movies/);
  assert.match(document.getElementById('seriesList').innerHTML, /Failed to load series/);
});

test('a newer movies request wins over a slower earlier one', async () => {
  const { client, document, http } = createClient();

  const first = client.loadMovies();
  const second = client.loadMovies();
  http.requests[1].resolve({ Items: [{ Id: 'new', Name: 'New', Type: 'Movie' }] });
  await second;
  http.requests[0].resolve({ Items: [{ Id: 'old', Name: 'Old', Type: 'Movie' }] });
  await first;

  const ids = document.getElementById('moviesList').children.map((el) => el.dataset.itemId);
  assert.deepEqual(ids, ['new']);

  // A late failure of an outdated request does not replace fresh results either.
  const stale = client.loadSeries();
  const fresh = client.loadSeries();
  http.requests[3].resolve({ Items: [{ Id: 's', Name: 'Show', Type: 'Series' }] });
  await fresh;
  http.requests[2].reject(new Error('timeout'));
  await stale;
  assert.equal(document.getElementById('seriesList').children.length, 1);
});

test('nothing is requested while signed out', async () => {
  const { client, document, http } = createClient();
  client.currentUser = null;

  await client.loadMovies();
  await client.loadSeries();
  await client.loadRecentItems();
  await client.loadHomeTab();
  await client.loadMusic();
  await client.loadGenres();
  await client.loadMusicGenres();
  await client.showArtistAlbums({ Id: 'ar1' });
  await client.search('alien');

  assert.equal(http.requests.length, 0);
  assert.match(document.getElementById('searchResults').innerHTML, /Enter a search term above/);
});

test('server-provided names are escaped when media items are rendered', () => {
  const { client, document } = createClient();
  const list = document.getElementById('recentList');

  client.renderMediaList(
    [
      {
        Id: 'e1',
        Type: 'Episode',
        Name: '<img src=x onerror=alert(1)>',
        SeriesName: '"><script>alert(2)</script>',
        ParentIndexNumber: 1,
        IndexNumber: 2,
      },
    ],
    list
  );

  const html = list.children[0].innerHTML;
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('&quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt; - S1E2'));
});

test('media items describe each type and label the primary action', () => {
  const { client, document } = createClient();
  const list = document.getElementById('nextUpList');

  client.renderMediaList(
    [
      { Id: 'sp', Type: 'Episode', SeriesName: 'Show', ParentIndexNumber: 0, IndexNumber: 0 },
      { Id: 'unk', Type: 'Episode', SeriesName: 'Show' },
      { Id: 's1', Type: 'Series', Name: 'Show' },
      { Id: 'al', Type: 'MusicAlbum', Name: 'Blue', AlbumArtist: 'Joni' },
      { Id: 'au', Type: 'Audio', Name: 'River', Artists: ['Joni', 'Guest'], Album: 'Blue' },
    ],
    list
  );

  const [special, unknown, series, album, audio] = list.children.map((el) => el.innerHTML);
  assert.match(special, /Show - S0E0/, 'season and episode zero are real numbers');
  assert.match(special, /Unknown Title/);
  assert.match(unknown, /Show - S\?E\?/);
  assert.match(series, /TV Series/);
  assert.match(series, /Browse Episodes/);
  assert.match(album, /media-subtitle">Joni</);
  assert.match(album, /View Tracks/);
  assert.match(audio, /Joni, Guest — Blue/);
  assert.match(audio, /Play/);

  client.renderMediaList([], list);
  assert.match(list.innerHTML, /No items found/);
});

test('clicking a media item plays its direct stream and marks it selected', () => {
  const { client, document, posted } = createClient();
  const list = document.getElementById('moviesList');
  client.renderMediaList(
    [
      { Id: 'm1', Type: 'Movie', Name: 'Heat' },
      { Id: 'm2', Type: 'Movie', Name: 'Ronin' },
    ],
    list
  );
  const [first, second] = list.children;

  first.click();
  second.click();

  assert.equal(first.classList.contains('selected'), false);
  assert.equal(second.classList.contains('selected'), true);
  assert.equal(client.selectedItem.Id, 'm2');
  assert.deepEqual(posted, [
    { name: 'play-media', data: { streamUrl: streamUrl('Videos', 'm1'), title: 'Heat' } },
    { name: 'play-media', data: { streamUrl: streamUrl('Videos', 'm2'), title: 'Ronin' } },
  ]);
});

test('media item buttons play or open the Jellyfin page without bubbling to the row', () => {
  const { client, posted } = createClient();
  const item = client.createMediaItemElement({ Id: 'm1', Type: 'Movie', Name: 'Heat' });

  const playEvent = button(item, '.media-action-btn', 'select').click();
  const openEvent = button(item, '.media-action-btn', 'open-jellyfin').click();

  assert.equal(playEvent.stopped, true);
  assert.equal(openEvent.stopped, true);
  assert.deepEqual(posted, [
    { name: 'play-media', data: { streamUrl: streamUrl('Videos', 'm1'), title: 'Heat' } },
    {
      name: 'open-external-url',
      data: { url: `${SERVER}/web/index.html#!/details?id=m1`, title: 'Heat - Jellyfin' },
    },
  ]);
});

test('thumbnails fall back from episode to series, thumb to primary to backdrop', () => {
  const { client } = createClient();
  const img = (id, kind, width = 160) =>
    `${SERVER}/Items/${id}/Images/${kind}?maxWidth=${width}&quality=90&ApiKey=${TOKEN}`;

  assert.equal(
    client.getThumbnailUrl({ Id: 'e', Type: 'Episode', ImageTags: { Primary: 'p' } }),
    img('e', 'Primary')
  );
  assert.equal(
    client.getThumbnailUrl({ Id: 'e', Type: 'Episode', SeriesId: 's' }),
    img('s', 'Thumb')
  );
  assert.equal(
    client.getThumbnailUrl({ Id: 'm', ImageTags: { Thumb: 't', Primary: 'p' } }),
    img('m', 'Thumb')
  );
  assert.equal(
    client.getThumbnailUrl({ Id: 'm', ImageTags: { Primary: 'p' } }, 80),
    img('m', 'Primary', 80)
  );
  assert.equal(
    client.getThumbnailUrl({ Id: 'm', BackdropImageTags: ['b'] }),
    img('m', 'Backdrop', 320)
  );
  assert.equal(client.getThumbnailUrl({ Id: 'm', BackdropImageTags: [] }), null);

  assert.equal(client.getMusicThumbnailUrl({ Id: 't', AlbumId: 'a' }), img('a', 'Primary', 96));
  assert.equal(
    client.getMusicThumbnailUrl({ Id: 'ar', BackdropImageTags: ['b'] }),
    img('ar', 'Backdrop', 192)
  );
  assert.equal(client.getMusicThumbnailUrl({ Id: 'x' }), null);

  client.currentServer = null;
  assert.equal(client.getThumbnailUrl({ Id: 'm', ImageTags: { Primary: 'p' } }), null);
  assert.equal(client.getMusicThumbnailUrl({ Id: 'm', ImageTags: { Primary: 'p' } }), null);
});

test('runtimes are shown in hours and minutes', () => {
  const { client } = createClient();
  const minutes = (n) => n * 600000000;

  assert.equal(client.formatRuntime(0), '');
  assert.equal(client.formatRuntime(undefined), '');
  assert.equal(client.formatRuntime(minutes(45)), '45m');
  assert.equal(client.formatRuntime(minutes(60)), '1h 0m');
  assert.equal(client.formatRuntime(minutes(61)), '1h 1m');
});

test('the home tab loads continue watching, next up and recent items', async () => {
  const { client, document, http, scrolls } = createClient();
  http.reply = byPath({
    '/UserItems/Resume': { Items: [{ Id: 'r1', Type: 'Movie', Name: 'Resume me' }] },
    '/Shows/NextUp': { Items: [] },
    '/Items/Latest': [{ Id: 'l1', Type: 'Series', Name: 'Latest' }],
  });

  await client.loadHomeTab();

  assert.equal(
    http.requests.find((r) => r.path === '/Shows/NextUp').params.get('UserId'),
    'user-1'
  );
  assert.equal(
    http.requests.find((r) => r.path === '/UserItems/Resume').params.get('MediaTypes'),
    'Video'
  );
  assert.equal(document.getElementById('continueWatchingList').children[0].dataset.itemId, 'r1');
  assert.match(document.getElementById('nextUpList').innerHTML, /No upcoming episodes/);
  assert.equal(document.getElementById('recentList').children[0].dataset.itemId, 'l1');
  assert.deepEqual(plain(scrolls), [{ top: 0, behavior: 'instant' }]);
});

test('home rows show an empty state or an error when there is nothing to list', async () => {
  const { client, document, http } = createClient();
  http.reply = byPath({
    '/UserItems/Resume': { Items: [] },
    '/Shows/NextUp': new Error('boom'),
    '/Items/Latest': { Items: [] },
  });

  await client.loadHomeTab();

  assert.match(document.getElementById('continueWatchingList').innerHTML, /Nothing to resume/);
  assert.match(document.getElementById('nextUpList').innerHTML, /Failed to load/);
  assert.match(document.getElementById('recentList').innerHTML, /No recent items found/);

  http.reply = byPath({ '/Items/Latest': new Error('boom'), '/UserItems/Resume': new Error('x') });
  await client.loadRecentItems();
  await client.loadContinueWatching();
  assert.match(document.getElementById('recentList').innerHTML, /Failed to load recent items/);
  assert.match(document.getElementById('continueWatchingList').innerHTML, /Failed to load/);
});

test('genre options are escaped and shared by the movie and series filters', async () => {
  const { client, document, http } = createClient();
  http.reply = () => ({ Items: [{ Name: 'Action' }, { Name: 'Rock & "Roll" <x>' }] });

  await client.loadGenres();

  assert.equal(http.requests[0].path, '/Genres');
  assert.equal(http.requests[0].params.get('IncludeItemTypes'), 'Movie,Series');
  const movies = document.getElementById('moviesGenreSelect').innerHTML;
  assert.equal(document.getElementById('seriesGenreSelect').innerHTML, movies);
  assert.ok(movies.startsWith('<option value="all" selected>All Genres</option>'));
  assert.ok(movies.includes('<option value="Action">Action</option>'));
  assert.ok(
    movies.includes(
      '<option value="Rock &amp; &quot;Roll&quot; &lt;x&gt;">Rock &amp; &quot;Roll&quot; &lt;x&gt;</option>'
    )
  );
});

test('music genres fill the music filter, and a failure leaves it unchanged', async () => {
  const { client, document, http } = createClient();
  http.reply = () => ({ Items: [{ Name: 'Jazz' }] });

  await client.loadMusicGenres();

  assert.equal(http.requests[0].path, '/MusicGenres');
  const select = document.getElementById('musicGenreSelect');
  assert.ok(select.innerHTML.includes('<option value="Jazz">Jazz</option>'));

  const before = select.innerHTML;
  http.reply = () => {
    throw new Error('offline');
  };
  await client.loadMusicGenres();
  await client.loadGenres();
  assert.equal(select.innerHTML, before);
});

function addSearchChip(document, type, active) {
  const chip = document.createElement('button');
  chip.className = active ? 'search-type-chip active' : 'search-type-chip';
  chip.dataset.type = type;
  document.getElementById('searchTypeFilters').appendChild(chip);
}

test('search asks for the selected media types and renders the hints', async () => {
  const { client, document, http } = createClient();
  addSearchChip(document, 'Movie', true);
  addSearchChip(document, 'Series', false);
  addSearchChip(document, 'Audio', true);
  http.reply = () => ({
    SearchHints: [
      {
        ItemId: 'h1',
        Type: 'Movie',
        Name: 'Alien <3',
        ProductionYear: 1979,
        ThumbImageTag: 't',
        ThumbImageItemId: 'h1-thumb',
      },
      { ItemId: 'h2', Type: 'Series', Name: 'Aliens', PrimaryImageTag: 'p' },
      { ItemId: 'h3', Type: 'MusicAlbum', BackdropImageTag: 'b', BackdropImageItemId: 'h3-bd' },
    ],
  });

  await client.search('alien');

  const [request] = http.requests;
  assert.equal(request.path, '/Search/Hints');
  assert.equal(request.params.get('searchTerm'), 'alien');
  assert.equal(request.params.get('includeItemTypes'), 'Movie,Audio');

  const [movie, series, album] = document.getElementById('searchResults').children;
  assert.equal(movie.dataset.itemId, 'h1');
  assert.ok(movie.innerHTML.includes('Alien &lt;3 (1979)'));
  assert.ok(movie.innerHTML.includes(`${SERVER}/Items/h1-thumb/Images/Thumb?maxWidth=160`));
  assert.ok(series.innerHTML.includes(`${SERVER}/Items/h2/Images/Primary?maxWidth=160`));
  assert.match(series.innerHTML, /Browse Episodes/);
  assert.ok(album.innerHTML.includes(`${SERVER}/Items/h3-bd/Images/Backdrop?maxWidth=320`));
  assert.match(album.innerHTML, /Unknown Title/);
  assert.match(album.innerHTML, /View Tracks/);
});

test('search without a term or a media type does not hit the server', async () => {
  const { client, document, http } = createClient();
  addSearchChip(document, 'Movie', false);

  await client.search('   ');
  assert.match(document.getElementById('searchResults').innerHTML, /Enter a search term above/);

  await client.search('alien');
  assert.match(
    document.getElementById('searchResults').innerHTML,
    /Select at least one media type to search/
  );
  assert.equal(http.requests.length, 0);
});

test('a search with no hints or a failed request says so', async () => {
  const { client, document, http } = createClient();
  addSearchChip(document, 'Movie', true);
  const results = document.getElementById('searchResults');

  http.reply = () => ({});
  await client.search('x');
  assert.match(results.innerHTML, /No results found/);

  http.reply = () => ({ SearchHints: [] });
  await client.search('x');
  assert.match(results.innerHTML, /No results found/);

  http.reply = () => {
    throw new Error('offline');
  };
  await client.search('x');
  assert.match(results.innerHTML, /Search failed/);
});

test('typing quickly searches only for the last term', async () => {
  const { client, document, http, timers } = createClient();
  addSearchChip(document, 'Movie', true);
  http.reply = () => ({ SearchHints: [] });

  client.debounceSearch('a');
  client.debounceSearch('al');
  client.debounceSearch('ali');

  assert.deepEqual(
    timers.map((timer) => timer.cleared),
    [true, true, false]
  );
  assert.equal(timers[2].ms, 500);
  timers.filter((timer) => !timer.cleared).forEach((timer) => timer.fn());
  await flush();

  assert.deepEqual(
    http.requests.map((request) => request.params.get('searchTerm')),
    ['ali']
  );
});

test('clearing the search box drops the reply of a search still in flight', async () => {
  const { client, document, http } = createClient();
  addSearchChip(document, 'Movie', true);
  const results = document.getElementById('searchResults');

  const pending = client.search('alien');
  await client.search('');
  http.requests[0].resolve({ SearchHints: [{ ItemId: 'h1', Type: 'Movie', Name: 'Alien' }] });
  await pending;

  assert.match(results.innerHTML, /Enter a search term above/);
  assert.equal(results.children.length, 0);
});

test('deselecting every media type drops the reply of a search still in flight', async () => {
  const { client, document, http } = createClient();
  addSearchChip(document, 'Movie', true);
  const results = document.getElementById('searchResults');

  const pending = client.search('alien');
  document.querySelector('.search-type-chip').classList.remove('active');
  await client.search('alien');
  http.requests[0].resolve({ SearchHints: [{ ItemId: 'h1', Type: 'Movie', Name: 'Alien' }] });
  await pending;

  assert.match(results.innerHTML, /Select at least one media type to search/);
  assert.equal(results.children.length, 0);
});

test('choosing a search result loads the full item before playing it', async () => {
  const { client, http, posted } = createClient();
  http.reply = byPath({ '/Items/h1': { Id: 'h1', Type: 'Movie', Name: 'Alien' } });
  const hint = { ItemId: 'h1', Type: 'Movie', Name: 'Alien' };
  const item = client.createSearchItemElement(hint);

  const event = button(item, '.search-action-btn', 'select').click();
  await flush();

  assert.equal(event.stopped, true);
  assert.equal(http.requests[0].params.get('userId'), 'user-1');
  assert.deepEqual(posted, [
    { name: 'play-media', data: { streamUrl: streamUrl('Videos', 'h1'), title: 'Alien' } },
  ]);

  item.click();
  await flush();
  assert.equal(posted.length, 2, 'clicking the row selects the result too');
});

test('opening a search result in Jellyfin posts its details page', () => {
  const { client, http, posted } = createClient();
  const item = client.createSearchItemElement({ ItemId: 'h1', Type: 'Movie', Name: 'Alien' });

  button(item, '.search-action-btn', 'open-jellyfin').click();

  assert.equal(http.requests.length, 0);
  assert.deepEqual(posted, [
    {
      name: 'open-external-url',
      data: { url: `${SERVER}/web/index.html#!/details?id=h1`, title: 'Alien - Jellyfin' },
    },
  ]);
});

test('a search result that fails to load reports the failure in the results', async () => {
  const { client, document, http, posted } = createClient();
  http.reply = () => {
    throw new Error('404');
  };

  await client.selectSearchItem({ ItemId: 'gone' });

  assert.match(document.getElementById('searchResults').innerHTML, /Failed to open item/);
  assert.equal(posted.length, 0);
});

test('audio is streamed from the audio route and untitled media gets a placeholder title', async () => {
  const { client, posted } = createClient();

  await client.playMedia({ Id: 'a1', Type: 'Audio' });

  assert.deepEqual(posted, [
    { name: 'play-media', data: { streamUrl: streamUrl('Audio', 'a1'), title: 'Unknown Title' } },
  ]);
});

test('without the plugin bridge media opens in a new window', async () => {
  const { client, opened } = createClient({ bridge: false });

  await client.playMedia({ Id: 'm1', Type: 'Movie', Name: 'Heat' });

  assert.deepEqual(opened, [{ url: streamUrl('Videos', 'm1'), target: '_blank' }]);
});

test('media without an id or a server is not played', async () => {
  const { client, posted, opened } = createClient();

  await client.playMedia({ Type: 'Movie', Name: 'No id' });
  client.currentServer = null;
  await client.playMedia({ Id: 'm1', Type: 'Movie' });

  assert.equal(posted.length, 0);
  assert.equal(opened.length, 0);
  assert.equal(client.buildStreamUrl(null), null);
});

test('opening in Jellyfin needs a server and an item', () => {
  const { client, posted } = createClient();

  client.openInJellyfin(null);
  client.currentServer = null;
  client.openInJellyfin({ Id: 'm1', Name: 'Heat' });

  assert.equal(posted.length, 0);
});

test('selecting a series opens the episode picker with its seasons', async () => {
  const { client, document, http } = createClient();
  http.reply = () => ({
    Items: [
      { Id: 'x1', IndexNumber: 1, Name: 'Season One' },
      { Id: 'x0', IndexNumber: 0, Name: 'Specials' },
      { Id: 'extras', IndexNumber: null, Name: 'Extras' },
      { Id: 'nameless', IndexNumber: null },
    ],
  });

  client.selectMediaItem({ Id: 's1', Type: 'Series', Name: 'Show' });
  await flush();

  assert.equal(http.requests[0].path, '/Shows/s1/Seasons');
  assert.equal(document.getElementById('episodeSection').style.display, 'block');
  assert.equal(document.getElementById('mainContent').style.display, 'none');
  assert.equal(document.getElementById('playEpisodeBtn').disabled, true);
  assert.match(document.getElementById('episodeList').innerHTML, /Select a season/);

  const select = document.getElementById('seasonSelect');
  assert.match(select.innerHTML, /Select a season\.\.\./);
  assert.deepEqual(
    select.children.map((option) => [option.value, option.textContent]),
    [
      ['x1', 'Season 1'],
      ['x0', 'Season 0'],
      ['extras', 'Extras'],
    ]
  );
});

test('seasons of a previously opened series are discarded', async () => {
  const { client, document, http } = createClient();

  const first = client.showEpisodeSelection({ Id: 'a' });
  const second = client.showEpisodeSelection({ Id: 'b' });
  http.requests[1].resolve({ Items: [{ Id: 'b1', IndexNumber: 1 }] });
  await second;
  http.requests[0].resolve({ Items: [{ Id: 'a1', IndexNumber: 1 }] });
  await first;

  assert.deepEqual(
    document.getElementById('seasonSelect').children.map((option) => option.value),
    ['b1']
  );
});

test('a failed season request is reported in the episode list', async () => {
  const { client, document, http } = createClient();
  http.reply = () => {
    throw new Error('offline');
  };

  await client.showEpisodeSelection({ Id: 's1' });

  assert.match(document.getElementById('seasonSelect').innerHTML, /No seasons loaded/);
  assert.match(document.getElementById('episodeList').innerHTML, /Failed to load seasons/);
});

test('episodes are listed with unavailable ones marked and not selectable', async () => {
  const { client, document, http, posted } = createClient();
  client.selectedItem = { Id: 's1', Type: 'Series' };
  http.reply = () => ({
    Items: [
      {
        Id: 'e1',
        IndexNumber: 1,
        Name: '<b>Pilot</b>',
        MediaSources: [{}],
        ImageTags: { Primary: 'p' },
        RunTimeTicks: 42 * 600000000,
      },
      { Id: 'e2', IndexNumber: 2, LocationType: 'Virtual' },
      { Id: 'e3', IndexNumber: 3, MediaSources: [] },
      { Id: 'e4', MediaSources: [{}], IsFolder: true },
    ],
  });

  await client.loadEpisodes('season-1');

  const [request] = http.requests;
  assert.equal(request.path, '/Shows/s1/Episodes');
  assert.equal(request.params.get('seasonId'), 'season-1');

  const [pilot, ...unavailable] = document.getElementById('episodeList').children;
  assert.equal(pilot.dataset.available, 'true');
  assert.ok(pilot.innerHTML.includes('1. &lt;b&gt;Pilot&lt;/b&gt;'));
  assert.ok(pilot.innerHTML.includes(`${SERVER}/Items/e1/Images/Primary?maxWidth=120`));
  assert.match(pilot.innerHTML, /42m/);
  assert.deepEqual(
    unavailable.map((el) => [el.dataset.available, el.classList.contains('unavailable')]),
    [
      ['false', true],
      ['false', true],
      ['false', true],
    ]
  );
  assert.ok(unavailable[0].innerHTML.includes('2. Episode 2'));
  assert.ok(unavailable[0].innerHTML.includes(`${SERVER}/Items/s1/Images/Thumb?maxWidth=120`));
  assert.ok(unavailable[2].innerHTML.includes('?. Episode ?'));

  unavailable[0].click();
  assert.equal(client.selectedEpisode, undefined);

  pilot.click();
  assert.equal(pilot.classList.contains('selected'), true);
  assert.equal(client.selectedEpisode.Id, 'e1');
  assert.equal(document.getElementById('playEpisodeBtn').disabled, false);
  assert.equal(document.getElementById('openEpisodeInJellyfinBtn').disabled, false);

  client.openSelectedEpisodeInJellyfin();
  client.playSelectedEpisode();
  assert.deepEqual(
    posted.map((message) => message.name),
    ['open-external-url', 'play-media']
  );
  assert.equal(posted[0].data.url, `${SERVER}/web/index.html#!/details?id=e1`);
  assert.equal(posted[1].data.streamUrl, streamUrl('Videos', 'e1'));
});

test('playing an episode closes the episode picker', async () => {
  const { client, document, posted } = createClient();
  document.getElementById('episodeSection').style.display = 'block';
  document.getElementById('mainContent').style.display = 'none';
  document.getElementById('episodeList').innerHTML = '<div>episodes</div>';
  client.selectedEpisode = { Id: 'e1', Type: 'Episode', Name: 'Pilot' };

  client.playSelectedEpisode();
  await flush();

  assert.equal(posted.length, 1);
  assert.equal(document.getElementById('episodeSection').style.display, 'none');
  assert.equal(document.getElementById('mainContent').style.display, 'block');
  assert.equal(document.getElementById('episodeList').innerHTML, '');
  assert.equal(document.getElementById('playEpisodeBtn').disabled, true);
  assert.equal(client.selectedEpisode, null);
});

test('without a selected episode the episode buttons do nothing', () => {
  const { client, posted } = createClient();

  client.playSelectedEpisode();
  client.openSelectedEpisodeInJellyfin();

  assert.equal(posted.length, 0);
});

test('episodes are not requested until a season is chosen, and failures are shown', async () => {
  const { client, document, http } = createClient();
  client.selectedItem = { Id: 's1' };

  await client.loadEpisodes('');
  assert.match(document.getElementById('episodeList').innerHTML, /Select a season/);
  assert.equal(http.requests.length, 0);

  http.reply = () => ({});
  await client.loadEpisodes('season-1');
  assert.match(document.getElementById('episodeList').innerHTML, /No episodes found/);

  http.reply = () => {
    throw new Error('offline');
  };
  await client.loadEpisodes('season-1');
  assert.match(document.getElementById('episodeList').innerHTML, /Failed to load episodes/);
});

test('the music view picks the albums, artists or songs endpoint', async () => {
  const { client, document, http } = createClient();
  document.getElementById('musicGenreSelect').value = 'Jazz';
  const list = document.getElementById('musicList');
  const view = document.getElementById('musicViewSelect');

  http.reply = () => ({
    Items: [
      {
        Id: 'al1',
        Type: 'MusicAlbum',
        Name: 'Kind of Blue',
        AlbumArtists: [{ Name: 'Miles Davis' }],
        ProductionYear: 1959,
        ChildCount: 5,
        ImageTags: { Primary: 'p' },
      },
    ],
  });
  await client.loadMusic();
  assert.equal(http.requests[0].path, '/Items');
  assert.equal(http.requests[0].params.get('IncludeItemTypes'), 'MusicAlbum');
  assert.equal(http.requests[0].params.get('Genres'), 'Jazz');
  assert.match(list.children[0].innerHTML, /Miles Davis — 1959 · 5 tracks/);
  assert.match(list.children[0].innerHTML, /View Tracks/);

  view.value = 'artists';
  http.reply = () => ({ Items: [{ Id: 'ar1', Type: 'MusicArtist', Name: 'Miles Davis' }] });
  await client.loadMusic();
  assert.equal(http.requests[1].path, '/Artists');
  assert.equal(http.requests[1].params.get('Genres'), 'Jazz');
  assert.match(list.children[0].innerHTML, /media-subtitle">Artist</);
  assert.match(list.children[0].innerHTML, /View Albums/);

  view.value = 'songs';
  http.reply = () => ({
    Items: [{ Id: 't1', Type: 'Audio', Name: 'So What', AlbumArtist: 'Miles', Album: 'KoB' }],
  });
  await client.loadMusic();
  assert.equal(http.requests[2].params.get('IncludeItemTypes'), 'Audio');
  assert.match(list.children[0].innerHTML, /Miles — KoB/);
  assert.match(list.children[0].innerHTML, />Play</);
});

test('empty and failed music requests are reported', async () => {
  const { client, document, http } = createClient();
  const list = document.getElementById('musicList');
  const view = document.getElementById('musicViewSelect');
  http.reply = () => ({ Items: [] });

  for (const [mode, message] of [
    ['albums', /No albums found/],
    ['artists', /No artists found/],
    ['songs', /No songs found/],
  ]) {
    view.value = mode;
    await client.loadMusic();
    assert.match(list.innerHTML, message);
  }

  http.reply = () => {
    throw new Error('offline');
  };
  await client.loadMusic();
  assert.match(list.innerHTML, /Failed to load music/);

  client.renderMusicList([], list, 'album');
  assert.match(list.innerHTML, /No items found/);
});

test('choosing an artist lists their albums', async () => {
  const { client, document, http } = createClient();
  const artist = { Id: 'ar1', Type: 'MusicArtist', Name: 'AC/DC & <Friends>' };
  const item = client.createMusicItemElement(artist, 'artist');
  http.reply = () => ({ Items: [] });

  button(item, '.media-action-btn', 'select').click();
  await flush();

  const [request] = http.requests;
  assert.equal(request.params.get('AlbumArtistIds'), 'ar1');
  assert.equal(request.params.get('IncludeItemTypes'), 'MusicAlbum');
  assert.ok(
    document
      .getElementById('musicList')
      .innerHTML.includes('No albums found for AC/DC &amp; &lt;Friends&gt;')
  );

  http.reply = () => ({ Items: [{ Id: 'al1', Type: 'MusicAlbum', Name: 'Back in Black' }] });
  await client.showArtistAlbums(artist);
  assert.equal(document.getElementById('musicList').children[0].dataset.itemId, 'al1');

  http.reply = () => {
    throw new Error('offline');
  };
  await client.showArtistAlbums(artist);
  assert.match(document.getElementById('musicList').innerHTML, /Failed to load albums/);
});

test('choosing an album shows its tracks and clicking a track plays it', async () => {
  const { client, document, http, posted } = createClient();
  const album = { Id: 'al1', Type: 'MusicAlbum', Name: 'Kind of Blue', AlbumArtist: 'Miles Davis' };
  http.reply = () => ({
    Items: [
      { Id: 't1', Type: 'Audio', Name: 'So <What>', IndexNumber: 1, Artists: ['Miles', 'Trane'] },
      { Id: 't2', Type: 'Audio', AlbumArtist: 'Miles Davis', RunTimeTicks: 9 * 600000000 },
    ],
  });

  client.createMusicItemElement(album, 'album').click();
  await flush();

  assert.equal(http.requests[0].params.get('ParentId'), 'al1');
  assert.equal(document.getElementById('albumTracksSection').style.display, 'block');
  assert.equal(document.getElementById('mainContent').style.display, 'none');
  assert.equal(
    document.getElementById('albumTracksTitle').textContent,
    'Kind of Blue — Miles Davis'
  );
  assert.equal(document.getElementById('playAllTracksBtn').disabled, false);
  assert.equal(client.selectedAlbum, album);
  assert.equal(client.albumTracks.length, 2);

  const [first, second] = document.getElementById('albumTracksList').children;
  assert.ok(first.innerHTML.includes('So &lt;What&gt;'));
  assert.match(first.innerHTML, /Miles, Trane/);
  assert.match(second.innerHTML, /track-number">2</);
  assert.match(second.innerHTML, /Track 2/);
  assert.match(second.innerHTML, /track-artist">Miles Davis</);
  assert.match(second.innerHTML, /9m/);

  second.click();
  assert.equal(second.classList.contains('selected'), true);
  assert.equal(client.selectedTrack.Id, 't2');
  assert.deepEqual(posted, [
    { name: 'play-media', data: { streamUrl: streamUrl('Audio', 't2'), title: 'Unknown Title' } },
  ]);

  client.openAlbumInJellyfin();
  assert.equal(posted[1].data.url, `${SERVER}/web/index.html#!/details?id=al1`);
});

test('playing a track keeps the album view open when the episode picker was never opened', async () => {
  const { client, document, http } = createClient();
  http.reply = () => ({ Items: [{ Id: 't1', Type: 'Audio', Name: 'So What', IndexNumber: 1 }] });

  client
    .createMusicItemElement({ Id: 'al1', Type: 'MusicAlbum', Name: 'Kind of Blue' }, 'album')
    .click();
  await flush();
  document.getElementById('albumTracksList').children[0].click();

  assert.equal(document.getElementById('albumTracksSection').style.display, 'block');
  assert.equal(document.getElementById('mainContent').style.display, 'none');
});

test('an album without tracks or with a failed request says so', async () => {
  const { client, document, http } = createClient();
  const list = document.getElementById('albumTracksList');

  http.reply = () => ({ Items: [] });
  await client.showAlbumTracks({ Id: 'al1', Name: 'Empty' });
  assert.match(list.innerHTML, /No tracks found/);
  assert.equal(document.getElementById('albumTracksTitle').textContent, 'Empty');
  assert.equal(client.albumTracks.length, 0);

  http.reply = () => {
    throw new Error('offline');
  };
  await client.showAlbumTracks({ Id: 'al1', Name: 'Empty' });
  assert.match(list.innerHTML, /Failed to load tracks/);
});

test('songs play directly from the music list', () => {
  const { client, posted } = createClient();
  const song = { Id: 't1', Type: 'Audio', Name: 'So What' };

  client.createMusicItemElement(song, 'song').click();
  button(client.createMusicItemElement(song, 'song'), '.media-action-btn', 'open-jellyfin').click();

  assert.deepEqual(
    posted.map((message) => message.name),
    ['play-media', 'open-external-url']
  );
  assert.equal(posted[0].data.streamUrl, streamUrl('Audio', 't1'));
});

test('play all sends every album track to the plugin as one playlist', () => {
  const { client, posted } = createClient();

  client.playAllAlbumTracks();
  assert.equal(posted.length, 0, 'nothing to play before tracks are loaded');

  client.albumTracks = [
    { Id: 't1', Type: 'Audio', Name: 'So What' },
    { Type: 'Audio', Name: 'No id' },
    { Id: 't3', Type: 'Audio' },
  ];
  client.playAllAlbumTracks();

  assert.deepEqual(posted, [
    {
      name: 'play-media-list',
      data: {
        items: [
          { streamUrl: streamUrl('Audio', 't1'), title: 'So What' },
          { streamUrl: streamUrl('Audio', 't3'), title: 'Unknown Title' },
        ],
      },
    },
  ]);

  client.albumTracks = [{ Type: 'Audio', Name: 'No id' }];
  client.playAllAlbumTracks();
  assert.equal(posted.length, 1, 'tracks that cannot be streamed are not sent');
});

test('without the plugin bridge play all opens only the first track', () => {
  const { client, opened } = createClient({ bridge: false });
  client.albumTracks = [
    { Id: 't1', Type: 'Audio' },
    { Id: 't2', Type: 'Audio' },
  ];

  client.playAllAlbumTracks();

  assert.deepEqual(opened, [{ url: streamUrl('Audio', 't1'), target: '_blank' }]);
});

test('closing the album view resets album state', () => {
  const { client, document } = createClient();
  document.getElementById('albumTracksSection').style.display = 'block';
  document.getElementById('albumTracksList').innerHTML = '<div>tracks</div>';
  client.selectedAlbum = { Id: 'al1' };
  client.albumTracks = [{ Id: 't1' }];

  client.hideAlbumTracks();

  assert.equal(document.getElementById('albumTracksSection').style.display, 'none');
  assert.equal(document.getElementById('mainContent').style.display, 'block');
  assert.equal(document.getElementById('albumTracksList').innerHTML, '');
  assert.equal(document.getElementById('playAllTracksBtn').disabled, true);
  assert.equal(document.getElementById('openAlbumInJellyfinBtn').disabled, true);
  assert.equal(client.selectedAlbum, null);
  assert.equal(client.albumTracks.length, 0);

  client.openAlbumInJellyfin();
});

test('hiding the main content closes the episode and album views without reopening the list', () => {
  const { client, document } = createClient();
  for (const id of ['mainContent', 'episodeSection', 'albumTracksSection']) {
    document.getElementById(id).style.display = 'block';
  }

  client.hideMainContent();

  for (const id of ['mainContent', 'episodeSection', 'albumTracksSection']) {
    assert.equal(document.getElementById(id).style.display, 'none', id);
  }
});

test('showing the main content loads both genre lists and scrolls to top', async () => {
  const { client, document, http, scrolls } = createClient();
  http.reply = () => ({ Items: [] });

  client.showMainContent();
  await flush();

  assert.equal(document.getElementById('mainContent').style.display, 'block');
  assert.deepEqual(http.requests.map((request) => request.path).sort(), [
    '/Genres',
    '/MusicGenres',
  ]);
  assert.equal(scrolls.length, 1);
});

test('signing out clears media lists, filters, selection and the active tab', () => {
  const { client, document } = createClient();
  const lists = ['recentList', 'moviesList', 'musicList', 'searchResults'];
  for (const id of lists) document.getElementById(id).innerHTML = '<div>old</div>';
  document.getElementById('searchInput').value = 'alien';
  document.getElementById('moviesSortSelect').selectedIndex = 3;
  document.getElementById('musicViewSelect').selectedIndex = 2;
  document.getElementById('seriesFilterPanel').style.display = 'block';

  const tabs = document.getElementById('tabBar');
  for (const name of ['home', 'movies']) {
    const tab = document.createElement('button');
    tab.className = name === 'movies' ? 'tab-button active' : 'tab-button';
    tab.dataset.tab = name;
    tabs.appendChild(tab);
  }
  const moviesTab = document.getElementById('moviesTab');
  moviesTab.className = 'tab-content active';
  const homeTab = document.getElementById('homeTab');
  homeTab.className = 'tab-content';

  client.selectedItem = { Id: 'm1' };
  client.selectedEpisode = { Id: 'e1' };
  client.albumTracks = [{ Id: 't1' }];

  client.clearAllMediaContent();

  for (const id of lists) assert.equal(document.getElementById(id).innerHTML, '', id);
  assert.equal(document.getElementById('searchInput').value, '');
  assert.equal(document.getElementById('moviesSortSelect').selectedIndex, 0);
  assert.equal(document.getElementById('musicViewSelect').selectedIndex, 0);
  assert.equal(document.getElementById('seriesFilterPanel').style.display, 'none');
  assert.deepEqual(
    tabs.children.map((tab) => [tab.dataset.tab, tab.classList.contains('active')]),
    [
      ['home', true],
      ['movies', false],
    ]
  );
  assert.equal(moviesTab.classList.contains('active'), false);
  assert.equal(homeTab.classList.contains('active'), true);
  assert.equal(client.selectedItem, null);
  assert.equal(client.selectedEpisode, null);
  assert.equal(client.albumTracks.length, 0);
});
