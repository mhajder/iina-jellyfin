// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bootSidebar,
  click,
  connect,
  createWebviewBridge,
  flushPromises,
  mockFetch,
} from './helpers/sidebar-dom.js';

const byId = (id) => document.getElementById(id);
const BASE = 'http://jf.local:8096';

/** Text that ended up directly inside row containers instead of in a child element. */
function strayText(root) {
  const containers = [
    root,
    ...root.querySelectorAll(
      '.media-item, .music-item, .episode-item, .track-item, .list-body, .media-actions, .ep-body, .track-body'
    ),
  ];
  return containers
    .flatMap((el) => Array.from(el.childNodes))
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent.trim())
    .join('');
}

/** Every request carries the token header and the user id. */
function expectAuthed(fetchMock, index = 0) {
  const [url, options] = fetchMock.mock.calls[index];
  expect(options.headers).toEqual({ 'X-Emby-Token': 'tok' });
  const parsed = new URL(url);
  expect(parsed.searchParams.get('userId') || parsed.searchParams.get('UserId')).toBe('user-1');
  return parsed;
}

function neverResolvingFetch() {
  globalThis.fetch = vi.fn(() => new Promise(() => {}));
}

const MOVIE = {
  Id: 'movie-1',
  Type: 'Movie',
  Name: 'Big Film',
  ProductionYear: 2020,
  RunTimeTicks: 66 * 600000000,
  ImageTags: { Primary: 'p' },
};
const SERIES = { Id: 'series-1', Type: 'Series', Name: 'Show', ImageTags: { Thumb: 't' } };
const EPISODE = {
  Id: 'ep-1',
  Type: 'Episode',
  Name: 'Pilot',
  SeriesName: 'Show',
  SeriesId: 'series-1',
  ParentIndexNumber: 0,
  IndexNumber: 0,
  RunTimeTicks: 25 * 600000000,
};
const ALBUM = { Id: 'album-1', Type: 'MusicAlbum', Name: 'Record', AlbumArtist: 'Band' };
const SONG = { Id: 'song-1', Type: 'Audio', Name: 'Tune', AlbumArtist: 'Band', Album: 'Record' };

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('sidebar media methods', () => {
  let bridge;
  let sidebar;

  beforeEach(async () => {
    bridge = createWebviewBridge();
    sidebar = await bootSidebar({ bridge });
    connect(sidebar);
    bridge.postMessage.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete globalThis.iina;
    delete globalThis.fetch;
  });

  describe('request tickets', () => {
    it('drops stale responses', async () => {
      const first = deferred();
      const second = deferred();
      let call = 0;
      globalThis.fetch = vi.fn(async () => {
        call++;
        const body = await (call === 1 ? first.promise : second.promise);
        return { status: 200, statusText: 'OK', headers: new Headers(), text: async () => body };
      });

      const loadA = sidebar.loadMovies();
      const loadB = sidebar.loadMovies();
      second.resolve(JSON.stringify({ Items: [{ ...MOVIE, Name: 'Second' }] }));
      await loadB;
      first.resolve(JSON.stringify({ Items: [{ ...MOVIE, Name: 'First' }] }));
      await loadA;

      expect(byId('moviesList').textContent).toContain('Second');
      expect(byId('moviesList').textContent).not.toContain('First');
    });
  });

  describe('main content and genres', () => {
    it('shows the main content and loads both genre lists', async () => {
      const fetchMock = mockFetch([
        ['/Genres?', { Items: [{ Name: 'Drama' }, { Name: 'A<b>' }] }],
        ['/MusicGenres?', { Items: [{ Name: 'Jazz' }] }],
      ]);
      byId('mainContent').style.display = 'none';

      sidebar.showMainContent();
      await flushPromises();

      expect(byId('mainContent').style.display).toBe('block');
      expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'instant' });
      expect(fetchMock.mock.calls[0][0]).toBe(
        `${BASE}/Genres?userId=user-1&Recursive=true&IncludeItemTypes=Movie%2CSeries`
      );
      expectAuthed(fetchMock, 0);
      expect(fetchMock.mock.calls[1][0]).toBe(
        `${BASE}/MusicGenres?userId=user-1&IncludeItemTypes=MusicAlbum%2CAudio`
      );
      expectAuthed(fetchMock, 1);
      expect(byId('moviesGenreSelect').options).toHaveLength(3);
      expect(byId('seriesGenreSelect').options[2].textContent).toBe('A<b>');
      expect(byId('musicGenreSelect').options).toHaveLength(2);
    });

    it('leaves the genre lists alone on empty or failed responses', async () => {
      mockFetch([
        ['/Genres?', {}],
        ['/MusicGenres?', new Error('down')],
      ]);
      await sidebar.loadGenres();
      await sidebar.loadMusicGenres();
      expect(byId('moviesGenreSelect').options).toHaveLength(1);
      expect(byId('musicGenreSelect').options).toHaveLength(1);

      mockFetch([
        ['/Genres?', new Error('down')],
        ['/MusicGenres?', {}],
      ]);
      await sidebar.loadGenres();
      await sidebar.loadMusicGenres();

      sidebar.currentUser = null;
      const fetchMock = mockFetch([]);
      await sidebar.loadGenres();
      await sidebar.loadMusicGenres();
      connect(sidebar);
      sidebar.currentServer = null;
      await sidebar.loadGenres();
      await sidebar.loadMusicGenres();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('hides the main content together with the pickers', () => {
      byId('episodeSection').style.display = 'block';
      byId('albumTracksSection').style.display = 'block';
      sidebar.hideMainContent();
      expect(byId('mainContent').style.display).toBe('none');
      expect(byId('episodeSection').style.display).toBe('none');
      expect(byId('albumTracksSection').style.display).toBe('none');
    });

    it('clears all media content and resets the view', () => {
      byId('recentList').innerHTML = '<div>x</div>';
      byId('searchInput').value = 'term';
      byId('moviesSortSelect').selectedIndex = 2;
      byId('moviesFilterPanel').style.display = 'block';
      document.querySelector('.tab-button[data-tab="movies"]').classList.add('active');
      byId('moviesTab').classList.add('active');
      sidebar.selectedItem = MOVIE;

      sidebar.clearAllMediaContent();

      expect(byId('recentList').innerHTML).toBe('');
      expect(byId('searchInput').value).toBe('');
      expect(byId('moviesSortSelect').selectedIndex).toBe(0);
      expect(byId('moviesFilterPanel').style.display).toBe('none');
      expect(byId('homeTab').classList.contains('active')).toBe(true);
      expect(byId('moviesTab').classList.contains('active')).toBe(false);
      const activeButtons = document.querySelectorAll('.tab-button.active');
      expect(activeButtons).toHaveLength(1);
      expect(activeButtons[0].dataset.tab).toBe('home');
      expect(document.querySelectorAll('.tab-content.active')).toHaveLength(1);
      expect(sidebar.selectedItem).toBeNull();
      expect(sidebar.albumTracks).toEqual([]);
    });

    it('tolerates missing elements when clearing', () => {
      for (const id of [
        'recentList',
        'searchInput',
        'moviesGenreSelect',
        'moviesFilterPanel',
        'homeTab',
      ]) {
        byId(id).remove();
      }
      expect(() => sidebar.clearAllMediaContent()).not.toThrow();
    });
  });

  describe('home tab', () => {
    it('loads the three home lists', async () => {
      const fetchMock = mockFetch([
        ['/UserItems/Resume', { Items: [MOVIE] }],
        ['/Shows/NextUp', { Items: [EPISODE] }],
        ['/Items/Latest', [SERIES]],
      ]);

      await sidebar.loadHomeTab();

      expect(byId('continueWatchingList').querySelectorAll('.media-item')).toHaveLength(1);
      expect(byId('nextUpList').querySelectorAll('.media-item')).toHaveLength(1);
      expect(byId('recentList').querySelectorAll('.media-item')).toHaveLength(1);
      expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'instant' });
      const urls = {};
      fetchMock.mock.calls.forEach((call, index) => {
        urls[new URL(call[0]).pathname] = expectAuthed(fetchMock, index);
      });
      const resume = urls['/UserItems/Resume'];
      expect(resume.searchParams.get('MediaTypes')).toBe('Video');
      expect(resume.searchParams.get('Limit')).toBe('10');
      expect(resume.searchParams.get('Fields')).toContain('SeriesName');
      const nextUp = urls['/Shows/NextUp'];
      expect(nextUp.searchParams.get('UserId')).toBe('user-1');
      expect(nextUp.searchParams.get('Fields')).toContain('IndexNumber');
      const latest = urls['/Items/Latest'];
      expect(latest.searchParams.get('includeItemTypes')).toBe('Movie,Series,Episode');
      expect(latest.searchParams.get('enableImageTypes')).toBe('Primary,Backdrop,Thumb');
      expect(latest.searchParams.get('fields')).toContain('RunTimeTicks');
      expect(latest.searchParams.get('limit')).toBe('20');
    });

    it('treats missing payloads as empty lists', async () => {
      mockFetch([
        ['/UserItems/Resume', null],
        ['/Shows/NextUp', null],
        ['/Items/Latest', null],
      ]);
      await sidebar.loadHomeTab();
      expect(byId('continueWatchingList').textContent).toContain('Nothing to resume');
      expect(byId('nextUpList').textContent).toContain('No upcoming episodes');
      expect(byId('recentList').textContent).toContain('No recent items found');

      mockFetch([
        ['/UserItems/Resume', {}],
        ['/Shows/NextUp', { Items: [] }],
        ['/Items/Latest', []],
      ]);
      await sidebar.loadHomeTab();
      expect(byId('continueWatchingList').textContent).toContain('Nothing to resume');
      expect(byId('nextUpList').textContent).toContain('No upcoming episodes');
      expect(byId('recentList').textContent).toContain('No items found');
    });

    it('shows loading placeholders while requests are pending', () => {
      neverResolvingFetch();
      sidebar.loadRecentItems();
      sidebar.loadContinueWatching();
      sidebar.loadNextUp();
      sidebar.loadMovies();
      sidebar.loadSeries();
      sidebar.search('term');
      sidebar.loadMusic();
      sidebar.showAlbumTracks(ALBUM);
      sidebar.selectedItem = SERIES;
      sidebar.loadEpisodes('s1');
      expect(byId('recentList').textContent).toBe('Loading recent items...');
      expect(byId('continueWatchingList').textContent).toBe('Loading...');
      expect(byId('nextUpList').textContent).toBe('Loading...');
      expect(byId('moviesList').textContent).toBe('Loading movies...');
      expect(byId('seriesList').textContent).toBe('Loading series...');
      expect(byId('searchResults').textContent).toBe('Searching...');
      expect(byId('musicList').textContent).toBe('Loading music...');
      expect(byId('albumTracksList').textContent).toBe('Loading tracks...');
      expect(byId('episodeList').textContent).toBe('Loading episodes...');
      sidebar.showArtistAlbums({ Id: 'ar' });
      expect(byId('musicList').textContent).toBe('Loading albums...');
    });

    it('shows empty states and errors', async () => {
      mockFetch([
        ['/UserItems/Resume', { Items: [] }],
        ['/Shows/NextUp', {}],
        ['/Items/Latest', { not: 'an array' }],
      ]);
      await sidebar.loadHomeTab();
      expect(byId('continueWatchingList').textContent).toContain('Nothing to resume');
      expect(byId('nextUpList').textContent).toContain('No upcoming episodes');
      expect(byId('recentList').textContent).toContain('No recent items found');

      mockFetch([
        ['/UserItems/Resume', new Error('x')],
        ['/Shows/NextUp', new Error('x')],
        ['/Items/Latest', new Error('x')],
      ]);
      await sidebar.loadHomeTab();
      expect(byId('continueWatchingList').textContent).toContain('Failed to load');
      expect(byId('nextUpList').textContent).toContain('Failed to load');
      expect(byId('recentList').textContent).toContain('Failed to load recent items');
    });

    it('does nothing while disconnected', async () => {
      window.scrollTo.mockClear();
      const lists = [
        'recentList',
        'continueWatchingList',
        'nextUpList',
        'moviesList',
        'seriesList',
        'musicList',
      ];
      for (const id of lists) byId(id).innerHTML = '<div>untouched</div>';
      const fetchMock = mockFetch([]);
      const loadEverything = async () => {
        await sidebar.loadHomeTab();
        await sidebar.loadRecentItems();
        await sidebar.loadContinueWatching();
        await sidebar.loadNextUp();
        await sidebar.loadMovies();
        await sidebar.loadSeries();
        await sidebar.loadMusic();
        await sidebar.showArtistAlbums({ Id: 'ar' });
        await sidebar.search('term');
      };

      // A user without a server, and a server without a user, both count as disconnected
      sidebar.currentServer = null;
      await loadEverything();
      connect(sidebar);
      sidebar.currentUser = null;
      await loadEverything();

      expect(fetchMock).not.toHaveBeenCalled();
      for (const id of lists) expect(byId(id).textContent).toBe('untouched');
      expect(byId('searchResults').textContent).toContain('Enter a search term above');
      expect(window.scrollTo).not.toHaveBeenCalledWith({ top: 0, behavior: 'instant' });
    });

    it('drops stale responses for each list', async () => {
      const gate = deferred();
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls++;
        if (calls <= 3) await gate.promise;
        return {
          status: 200,
          statusText: 'OK',
          headers: new Headers(),
          text: async () => JSON.stringify({ Items: [] }),
        };
      });

      const stale = Promise.all([
        sidebar.loadRecentItems(),
        sidebar.loadContinueWatching(),
        sidebar.loadNextUp(),
      ]);
      globalThis.fetch.mockImplementation(async () => {
        throw new Error('later failure');
      });
      await Promise.all([
        sidebar.loadRecentItems(),
        sidebar.loadContinueWatching(),
        sidebar.loadNextUp(),
      ]);
      gate.resolve();
      await stale;

      expect(byId('recentList').textContent).toContain('Failed to load recent items');
      expect(byId('continueWatchingList').textContent).toContain('Failed to load');
      expect(byId('nextUpList').textContent).toContain('Failed to load');
    });

    it('drops stale failures too', async () => {
      const gate = deferred();
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls++;
        if (calls <= 3) {
          await gate.promise;
          throw new Error('old failure');
        }
        return {
          status: 200,
          statusText: 'OK',
          headers: new Headers(),
          text: async () => JSON.stringify({ Items: [MOVIE] }),
        };
      });

      const stale = Promise.all([
        sidebar.loadRecentItems(),
        sidebar.loadContinueWatching(),
        sidebar.loadNextUp(),
      ]);
      await Promise.all([
        sidebar.loadRecentItems(),
        sidebar.loadContinueWatching(),
        sidebar.loadNextUp(),
      ]);
      gate.resolve();
      await stale;

      expect(byId('continueWatchingList').querySelectorAll('.media-item')).toHaveLength(1);
      expect(byId('nextUpList').querySelectorAll('.media-item')).toHaveLength(1);
      expect(byId('recentList').textContent).toContain('No recent items found');
    });
  });

  describe('movies and series', () => {
    it('applies sort, filter and genre parameters', async () => {
      const fetchMock = mockFetch([['/Items?', { Items: [MOVIE] }]]);
      byId('moviesSortSelect').value = 'DateCreated,Descending';
      byId('moviesFilterSelect').value = 'unwatched';
      byId('moviesGenreSelect').innerHTML = '<option value="Drama" selected>Drama</option>';

      await sidebar.loadMovies();
      const url = expectAuthed(fetchMock, 0);
      expect(url.pathname).toBe('/Items');
      expect(url.searchParams.get('SortBy')).toBe('DateCreated');
      expect(url.searchParams.get('SortOrder')).toBe('Descending');
      expect(url.searchParams.get('IsPlayed')).toBe('false');
      expect(url.searchParams.get('Filters')).toBeNull();
      expect(url.searchParams.get('Genres')).toBe('Drama');
      expect(url.searchParams.get('IncludeItemTypes')).toBe('Movie');
      expect(url.searchParams.get('Recursive')).toBe('true');
      expect(url.searchParams.get('Limit')).toBe('50');
      expect(url.searchParams.get('EnableImageTypes')).toBe('Primary,Backdrop,Thumb');
      expect(url.searchParams.get('Fields')).toContain('UserData');
      expect(byId('moviesList').querySelectorAll('.media-item')).toHaveLength(1);

      byId('seriesFilterSelect').value = 'favorites';
      await sidebar.loadSeries();
      const seriesUrl = expectAuthed(fetchMock, 1);
      expect(seriesUrl.searchParams.get('Filters')).toBe('IsFavorite');
      expect(seriesUrl.searchParams.get('IsPlayed')).toBeNull();
      expect(seriesUrl.searchParams.get('Genres')).toBeNull();
      expect(seriesUrl.searchParams.get('IncludeItemTypes')).toBe('Series');
      expect(seriesUrl.searchParams.get('Recursive')).toBe('true');
      expect(seriesUrl.searchParams.get('SortBy')).toBe('SortName');
      expect(seriesUrl.searchParams.get('SortOrder')).toBe('Ascending');
      expect(seriesUrl.searchParams.get('EnableImageTypes')).toBe('Primary,Backdrop,Thumb');
      expect(seriesUrl.searchParams.get('Fields')).toContain('BackdropImageTags');
      expect(seriesUrl.searchParams.get('Limit')).toBe('50');

      byId('moviesFilterSelect').value = 'favorites';
      await sidebar.loadMovies();
      expect(new URL(fetchMock.mock.calls[2][0]).searchParams.get('Filters')).toBe('IsFavorite');

      byId('seriesFilterSelect').value = 'unwatched';
      byId('seriesGenreSelect').innerHTML = '<option value="Comedy" selected>Comedy</option>';
      await sidebar.loadSeries();
      const seriesUrl2 = new URL(fetchMock.mock.calls[3][0]);
      expect(seriesUrl2.searchParams.get('IsPlayed')).toBe('false');
      expect(seriesUrl2.searchParams.get('Filters')).toBeNull();
      expect(seriesUrl2.searchParams.get('Genres')).toBe('Comedy');

      byId('moviesFilterSelect').value = 'all';
      byId('moviesGenreSelect').innerHTML = '<option value="all" selected>All Genres</option>';
      await sidebar.loadMovies();
      const plain = new URL(fetchMock.mock.calls[4][0]);
      expect(plain.searchParams.get('IsPlayed')).toBeNull();
      expect(plain.searchParams.get('Filters')).toBeNull();
      expect(plain.searchParams.get('Genres')).toBeNull();
    });

    it('shows empty, error and stale states', async () => {
      mockFetch([['/Items?', { Items: [] }]]);
      await sidebar.loadMovies();
      await sidebar.loadSeries();
      expect(byId('moviesList').textContent).toContain('No movies found');
      expect(byId('seriesList').textContent).toContain('No series found');
      mockFetch([['/Items?', {}]]);
      await sidebar.loadMovies();
      await sidebar.loadSeries();
      expect(byId('moviesList').textContent).toContain('No movies found');
      expect(byId('seriesList').textContent).toContain('No series found');
      mockFetch([['/Items?', null]]);
      await sidebar.loadMovies();
      await sidebar.loadSeries();
      expect(byId('moviesList').textContent).toContain('No movies found');
      expect(byId('seriesList').textContent).toContain('No series found');

      mockFetch([['/Items?', new Error('x')]]);
      await sidebar.loadMovies();
      await sidebar.loadSeries();
      expect(byId('moviesList').textContent).toContain('Failed to load movies');
      expect(byId('seriesList').textContent).toContain('Failed to load series');

      sidebar.currentUser = null;
      const fetchMock = mockFetch([]);
      await sidebar.loadMovies();
      await sidebar.loadSeries();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('ignores stale series responses and failures', async () => {
      const gate = deferred();
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls++;
        if (calls === 1) {
          await gate.promise;
          throw new Error('old');
        }
        if (calls === 2) {
          await gate.promise;
          return {
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
            text: async () => JSON.stringify({ Items: [SERIES] }),
          };
        }
        return {
          status: 200,
          statusText: 'OK',
          headers: new Headers(),
          text: async () => JSON.stringify({ Items: [] }),
        };
      });

      const staleFailure = sidebar.loadSeries();
      const staleSuccess = sidebar.loadSeries();
      await sidebar.loadSeries();
      gate.resolve();
      await Promise.all([staleFailure, staleSuccess]);

      expect(byId('seriesList').textContent).toContain('No series found');
    });

    it('ignores a stale movies failure', async () => {
      const gate = deferred();
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls++;
        if (calls === 1) {
          await gate.promise;
          throw new Error('old');
        }
        return {
          status: 200,
          statusText: 'OK',
          headers: new Headers(),
          text: async () => JSON.stringify({ Items: [MOVIE] }),
        };
      });
      const stale = sidebar.loadMovies();
      await sidebar.loadMovies();
      gate.resolve();
      await stale;
      expect(byId('moviesList').querySelectorAll('.media-item')).toHaveLength(1);
    });
  });

  describe('search', () => {
    it('prompts for a term or media type', async () => {
      const fetchMock = mockFetch([]);
      await sidebar.search('   ');
      expect(byId('searchResults').textContent).toContain('Enter a search term above');

      document
        .querySelectorAll('.search-type-chip')
        .forEach((chip) => chip.classList.remove('active'));
      await sidebar.search('bat');
      expect(byId('searchResults').textContent).toContain('Select at least one media type');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('renders hints from the selected types', async () => {
      const fetchMock = mockFetch([
        [
          '/Search/Hints',
          {
            SearchHints: [
              { ItemId: 'h1', Type: 'Movie', Name: 'Hint', ProductionYear: 1999, RunTimeTicks: 1 },
            ],
          },
        ],
      ]);
      document.querySelector('.search-type-chip[data-type="Audio"]').classList.remove('active');

      await sidebar.search('hint');

      const url = expectAuthed(fetchMock, 0);
      expect(url.pathname).toBe('/Search/Hints');
      expect(url.searchParams.get('includeItemTypes')).toBe('Movie,Series,MusicAlbum');
      expect(url.searchParams.get('searchTerm')).toBe('hint');
      expect(url.searchParams.get('limit')).toBe('20');
      expect(byId('searchResults').querySelectorAll('.media-item')).toHaveLength(1);
      expect(byId('searchResults').textContent).toContain('Hint (1999)');
    });

    it('shows no results, errors and drops stale searches', async () => {
      mockFetch([['/Search/Hints', {}]]);
      await sidebar.search('x');
      expect(byId('searchResults').textContent).toContain('No results found');
      mockFetch([['/Search/Hints', null]]);
      await sidebar.search('x');
      expect(byId('searchResults').textContent).toContain('No results found');

      mockFetch([['/Search/Hints', { SearchHints: [] }]]);
      await sidebar.search('x');
      expect(byId('searchResults').textContent).toContain('No results found');

      mockFetch([['/Search/Hints', new Error('x')]]);
      await sidebar.search('x');
      expect(byId('searchResults').textContent).toContain('Search failed');

      const gate = deferred();
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls++;
        if (calls === 1) {
          await gate.promise;
          throw new Error('old');
        }
        if (calls === 2) {
          await gate.promise;
          return {
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
            text: async () => JSON.stringify({ SearchHints: [{ ItemId: 'old', Type: 'Movie' }] }),
          };
        }
        return {
          status: 200,
          statusText: 'OK',
          headers: new Headers(),
          text: async () =>
            JSON.stringify({ SearchHints: [{ ItemId: 'new', Type: 'Movie', Name: 'New' }] }),
        };
      });
      const staleFailure = sidebar.search('a');
      const staleSuccess = sidebar.search('ab');
      await sidebar.search('abc');
      gate.resolve();
      await Promise.all([staleFailure, staleSuccess]);
      expect(byId('searchResults').textContent).toContain('New');
      expect(byId('searchResults').querySelectorAll('.media-item')).toHaveLength(1);
    });

    it('debounces searches', () => {
      vi.useFakeTimers();
      const search = vi.spyOn(sidebar, 'search').mockImplementation(() => {});
      sidebar.debounceSearch('a');
      sidebar.debounceSearch('ab');
      vi.advanceTimersByTime(499);
      expect(search).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(search).toHaveBeenCalledWith('ab');
    });

    it('opens a hint by loading the full item', async () => {
      const fetchMock = mockFetch([['/Items/h1', SERIES]]);
      const select = vi.spyOn(sidebar, 'selectMediaItem').mockImplementation(() => {});
      await sidebar.selectSearchItem({ ItemId: 'h1' });
      expect(select).toHaveBeenCalledWith(SERIES);
      expect(expectAuthed(fetchMock, 0).pathname).toBe('/Items/h1');

      mockFetch([['/Items/h1', null]]);
      await sidebar.selectSearchItem({ ItemId: 'h1' });
      expect(select).toHaveBeenCalledTimes(1);

      mockFetch([['/Items/h1', new Error('x')]]);
      await sidebar.selectSearchItem({ ItemId: 'h1' });
      expect(byId('searchResults').textContent).toContain('Failed to open item');

      byId('searchResults').remove();
      await expect(sidebar.selectSearchItem({ ItemId: 'h1' })).resolves.toBeUndefined();
    });
  });

  describe('rendering media items', () => {
    it('renders the empty state', () => {
      const container = byId('recentList');
      sidebar.renderMediaList([], container);
      expect(container.textContent).toContain('No items found');
      sidebar.renderMediaList(null, container);
      expect(container.textContent).toContain('No items found');
      sidebar.renderSearchResults(null, container);
      expect(container.textContent).toContain('No results found');
      sidebar.renderSearchResults([], container);
      expect(container.textContent).toContain('No results found');

      sidebar.renderMediaList([MOVIE, SERIES], container);
      expect(container.childNodes).toHaveLength(2);
      expect(strayText(container)).toBe('');
      sidebar.renderSearchResults([{ ItemId: 'h1', Type: 'Movie' }], container);
      expect(container.childNodes).toHaveLength(1);
      expect(strayText(container)).toBe('');
    });

    it('formats runtimes', () => {
      expect(sidebar.formatRuntime(0)).toBe('');
      expect(sidebar.formatRuntime(undefined)).toBe('');
      expect(sidebar.formatRuntime(25 * 600000000)).toBe('25m');
      expect(sidebar.formatRuntime(66 * 600000000)).toBe('1h 6m');
    });

    it('picks thumbnails by item type and available images', () => {
      const thumb = (item) => sidebar.getThumbnailUrl(item);
      expect(thumb({ ...EPISODE, ImageTags: { Primary: 'p' } })).toBe(
        `${BASE}/Items/ep-1/Images/Primary?maxWidth=160&quality=90&api_key=tok`
      );
      expect(thumb(EPISODE)).toBe(
        `${BASE}/Items/series-1/Images/Thumb?maxWidth=160&quality=90&api_key=tok`
      );
      expect(thumb({ ...EPISODE, SeriesId: undefined, ImageTags: { Thumb: 't' } })).toBe(
        `${BASE}/Items/ep-1/Images/Thumb?maxWidth=160&quality=90&api_key=tok`
      );
      expect(thumb(SERIES)).toContain('/Images/Thumb?maxWidth=160');
      expect(thumb(MOVIE)).toContain('/Images/Primary?maxWidth=160');
      expect(thumb({ Id: 'b', Type: 'Movie', BackdropImageTags: ['x'] })).toContain(
        '/Images/Backdrop?maxWidth=320'
      );
      expect(thumb({ Id: 'b', Type: 'Movie', BackdropImageTags: [] })).toBeNull();
      expect(thumb({ Id: 'b', Type: 'Movie', ImageTags: {} })).toBeNull();
      // Only episodes fall back to their series artwork
      expect(thumb({ Id: 'b', Type: 'Movie', SeriesId: 'series-1' })).toBeNull();
      expect(
        thumb({ Id: 'b', Type: 'Movie', SeriesId: 'series-1', BackdropImageTags: ['x'] })
      ).toContain('/Items/b/Images/Backdrop');
      sidebar.currentServer = null;
      expect(thumb(MOVIE)).toBeNull();
    });

    it('renders items of every type with their subtitles', () => {
      const container = byId('recentList');
      const items = [
        EPISODE,
        { ...EPISODE, Id: 'ep-2', ParentIndexNumber: undefined, IndexNumber: undefined },
        { ...EPISODE, Id: 'ep-3', SeriesName: undefined },
        SERIES,
        MOVIE,
        ALBUM,
        { ...ALBUM, Id: 'album-2', AlbumArtist: undefined },
        SONG,
        { ...SONG, Id: 'song-2', AlbumArtist: undefined, Artists: ['A', 'B'], Album: undefined },
        { ...SONG, Id: 'song-3', AlbumArtist: undefined, Artists: undefined, Album: undefined },
        { Id: 'other', Type: 'BoxSet', AlbumArtist: 'Z', Album: 'Q' },
        { ...MOVIE, Id: 'movie-2', SeriesName: 'Not a show' },
      ];
      sidebar.renderMediaList(items, container);

      const rows = container.querySelectorAll('.media-item');
      expect(rows).toHaveLength(items.length);
      const subtitle = (index) => rows[index].querySelector('.media-subtitle')?.textContent;
      expect(subtitle(0)).toBe('Show - S0E0');
      expect(subtitle(1)).toBe('Show - S?E?');
      expect(subtitle(2)).toBeUndefined();
      expect(subtitle(3)).toBe('TV Series');
      expect(subtitle(4)).toBe('Movie');
      expect(subtitle(5)).toBe('Band');
      expect(subtitle(6)).toBe('Album');
      expect(subtitle(7)).toBe('Band — Record');
      expect(subtitle(8)).toBe('A, B');
      expect(subtitle(9)).toBeUndefined();
      expect(subtitle(10)).toBeUndefined();
      expect(subtitle(11)).toBe('Movie');
      expect(rows[10].querySelector('.media-title').textContent).toBe('Unknown Title');
      expect(strayText(container)).toBe('');
      expect(container.childNodes).toHaveLength(items.length);
      expect(rows[4].querySelector('.media-title').textContent).toBe('Big Film (2020)');
      expect(rows[4].querySelector('.list-duration').textContent).toBe('1h 6m');
      expect(rows[10].querySelector('.list-duration')).toBeNull();

      expect(rows[3].querySelector('[data-action="select"]').textContent.trim()).toBe(
        'Browse Episodes'
      );
      expect(rows[5].querySelector('[data-action="select"]').textContent.trim()).toBe(
        'View Tracks'
      );
      expect(rows[4].querySelector('[data-action="select"]').textContent.trim()).toBe('Play');
      expect(rows[4].querySelector('[data-action="download"]').textContent).toBe('⬇ Offline');
      expect(rows[3].querySelector('[data-action="download"]')).toBeNull();
      expect(rows[4].querySelector('.list-thumb')).not.toBeNull();
      expect(rows[10].querySelector('.thumb-wrapper.thumb-fallback')).not.toBeNull();
    });

    it('wires the row and its buttons', () => {
      const container = byId('recentList');
      sidebar.renderMediaList([MOVIE], container);
      const row = container.querySelector('.media-item');
      const select = vi.spyOn(sidebar, 'selectMediaItem').mockImplementation(() => {});
      const open = vi.spyOn(sidebar, 'openInJellyfin').mockImplementation(() => {});
      const download = vi.spyOn(sidebar, 'handleDownloadButtonClick').mockImplementation(() => {});

      click(row.querySelector('[data-action="select"]'));
      click(row.querySelector('[data-action="open-jellyfin"]'));
      click(row.querySelector('[data-action="download"]'));
      click(row);

      expect(select).toHaveBeenCalledTimes(2);
      expect(open).toHaveBeenCalledWith(MOVIE);
      expect(download).toHaveBeenCalledWith(MOVIE);
    });

    it('marks the selected item and routes by type', () => {
      const container = byId('recentList');
      sidebar.renderMediaList([MOVIE, SERIES, ALBUM], container);
      const episodes = vi.spyOn(sidebar, 'showEpisodeSelection').mockImplementation(() => {});
      const tracks = vi.spyOn(sidebar, 'showAlbumTracks').mockImplementation(() => {});
      const play = vi.spyOn(sidebar, 'playMedia').mockImplementation(() => {});

      sidebar.selectMediaItem(SERIES);
      expect(
        container.querySelector('[data-item-id="series-1"]').classList.contains('selected')
      ).toBe(true);
      sidebar.selectMediaItem(ALBUM);
      expect(container.querySelectorAll('.selected')).toHaveLength(1);
      sidebar.selectMediaItem({ Id: 'not-rendered', Type: 'Movie' });

      expect(episodes).toHaveBeenCalledWith(SERIES);
      expect(tracks).toHaveBeenCalledWith(ALBUM);
      expect(play).toHaveBeenCalledWith({ Id: 'not-rendered', Type: 'Movie' });
    });
  });

  describe('rendering search results', () => {
    const hints = [
      { ItemId: 'h1', Type: 'Series', Name: 'S', ThumbImageTag: 't', ThumbImageItemId: 'ti' },
      { ItemId: 'h2', Type: 'MusicAlbum', Name: 'A', PrimaryImageTag: 'p' },
      { ItemId: 'h3', Type: 'Movie', Name: 'M', BackdropImageTag: 'b', BackdropImageItemId: 'bi' },
      { ItemId: 'h4', Type: 'Movie' },
      { ItemId: 'h5', Type: 'Movie', ThumbImageTag: 't', BackdropImageItemId: 'bi' },
      {
        ItemId: 'h6',
        Type: 'Movie',
        ThumbImageItemId: 'ti',
        BackdropImageTag: 'b',
        RunTimeTicks: 600000000,
      },
    ];

    it('renders hints with thumbnails and actions', () => {
      const container = byId('searchResults');
      sidebar.renderSearchResults(hints, container);
      const rows = container.querySelectorAll('.media-item');
      expect(rows[0].querySelector('.list-thumb').src).toContain('/Items/ti/Images/Thumb');
      expect(rows[1].querySelector('.list-thumb').src).toContain('/Items/h2/Images/Primary');
      expect(rows[2].querySelector('.list-thumb').src).toContain('/Items/bi/Images/Backdrop');
      expect(rows[3].querySelector('.thumb-fallback')).not.toBeNull();
      expect(rows[4].querySelector('.thumb-fallback')).not.toBeNull();
      expect(rows[5].querySelector('.thumb-fallback')).not.toBeNull();
      expect(rows[5].querySelector('.list-duration').textContent).toBe('1m');
      expect(rows[3].querySelector('.list-duration')).toBeNull();
      expect(strayText(container)).toBe('');
      expect(rows[0].querySelector('[data-action="select"]').textContent.trim()).toBe(
        'Browse Episodes'
      );
      expect(rows[1].querySelector('[data-action="select"]').textContent.trim()).toBe(
        'View Tracks'
      );
      expect(rows[2].querySelector('[data-action="select"]').textContent.trim()).toBe('Play');
      expect(rows[0].querySelector('[data-action="download"]')).toBeNull();
      expect(rows[2].querySelector('[data-action="download"]').textContent).toBe('⬇ Offline');
      expect(rows[3].querySelector('.media-title').textContent).toBe('Unknown Title');

      sidebar.currentServer = null;
      sidebar.renderSearchResults([hints[0]], container);
      expect(container.querySelector('.thumb-fallback')).not.toBeNull();
    });

    it('wires the hint buttons', async () => {
      const container = byId('searchResults');
      sidebar.renderSearchResults([hints[2]], container);
      const row = container.querySelector('.media-item');
      const select = vi.spyOn(sidebar, 'selectSearchItem').mockImplementation(() => {});
      const open = vi.spyOn(sidebar, 'openInJellyfin').mockImplementation(() => {});
      const request = vi
        .spyOn(sidebar, 'requestOfflineDownloadForHint')
        .mockImplementation(() => {});
      const play = vi.spyOn(sidebar, 'playOfflineDownload').mockImplementation(() => {});

      click(row.querySelector('[data-action="select"]'));
      click(row);
      expect(select).toHaveBeenCalledTimes(2);

      click(row.querySelector('[data-action="open-jellyfin"]'));
      expect(open).toHaveBeenCalledWith({
        Id: 'h3',
        Type: 'Movie',
        Name: 'M',
        ProductionYear: undefined,
      });

      click(row.querySelector('[data-action="download"]'));
      expect(request).toHaveBeenCalledWith(hints[2]);

      sidebar.offlineDownloads = [{ itemId: 'h3', status: 'completed', fileMissing: false }];
      click(row.querySelector('[data-action="download"]'));
      expect(play).toHaveBeenCalledWith('h3');
    });
  });

  describe('episodes', () => {
    it('shows the season picker for a series', async () => {
      const fetchMock = mockFetch([
        ['/Shows/series-1/Seasons', { Items: [{ Id: 's1', IndexNumber: 1 }, { Id: 'sx' }] }],
      ]);
      sidebar.selectedEpisode = EPISODE;
      byId('playEpisodeBtn').disabled = false;
      byId('openEpisodeInJellyfinBtn').disabled = false;
      byId('episodeList').innerHTML = '<div>stale</div>';

      await sidebar.showEpisodeSelection(SERIES);

      expect(byId('episodeSection').style.display).toBe('block');
      expect(byId('mainContent').style.display).toBe('none');
      expect(sidebar.selectedEpisode).toBeNull();
      expect(sidebar.selectedSeason).toBeNull();
      expect(byId('playEpisodeBtn').disabled).toBe(true);
      expect(byId('downloadEpisodeBtn').disabled).toBe(true);
      expect(byId('openEpisodeInJellyfinBtn').disabled).toBe(true);
      expect(byId('episodeList').textContent).toBe('Select a season');
      expect(expectAuthed(fetchMock, 0).pathname).toBe('/Shows/series-1/Seasons');
      const options = Array.from(byId('seasonSelect').options).map((option) => option.textContent);
      expect(options).toEqual(['Select a season...', 'Season 1']);
    });

    it('handles empty and failed season responses', async () => {
      mockFetch([['/Shows/series-1/Seasons', {}]]);
      await sidebar.showEpisodeSelection(SERIES);
      expect(byId('seasonSelect').options).toHaveLength(1);

      mockFetch([['/Shows/series-1/Seasons', new Error('x')]]);
      await sidebar.showEpisodeSelection(SERIES);
      expect(byId('episodeList').textContent).toContain('Failed to load seasons');
    });

    it('lists episodes with availability and selection', async () => {
      sidebar.selectedItem = SERIES;
      const episodes = [
        { ...EPISODE, MediaSources: [{}], ImageTags: { Primary: 'p' } },
        { Id: 'ep-v', Name: 'Virtual', IndexNumber: 3, LocationType: 'Virtual' },
        { Id: 'ep-n', MediaSources: [{}] },
      ];
      const fetchMock = mockFetch([['/Shows/series-1/Episodes', { Items: episodes }]]);

      await sidebar.loadEpisodes('s1');

      const url = expectAuthed(fetchMock, 0);
      expect(url.pathname).toBe('/Shows/series-1/Episodes');
      expect(url.searchParams.get('seasonId')).toBe('s1');
      expect(url.searchParams.get('fields')).toContain('MediaSources');
      const rows = byId('episodeList').querySelectorAll('.episode-item');
      expect(rows).toHaveLength(3);
      expect(byId('episodeList').childNodes).toHaveLength(3);
      expect(strayText(byId('episodeList'))).toBe('');
      expect(rows[0].className.trim()).toBe('episode-item');
      expect(rows[0].dataset.available).toBe('true');
      expect(rows[0].style.cursor).toBe('');
      expect(rows[1].className).toBe('episode-item unavailable');
      expect(rows[1].dataset.available).toBe('false');
      expect(rows[1].style.cursor).toBe('not-allowed');
      expect(rows[2].querySelector('.ep-duration')).toBeNull();
      expect(rows[0].querySelector('.ep-thumb').src).toContain('/Items/ep-1/Images/Primary');
      expect(rows[2].querySelector('.ep-thumb').src).toContain('/Items/series-1/Images/Thumb');
      expect(rows[1].classList.contains('unavailable')).toBe(true);
      expect(rows[1].title).toBe('This episode is not available on the server');
      expect(rows[1].querySelector('.unavailable-icon')).not.toBeNull();
      expect(rows[2].querySelector('.ep-title').textContent).toBe('?. Episode ?');
      expect(rows[0].querySelector('.ep-duration').textContent).toBe('25m');

      click(rows[0]);
      expect(sidebar.selectedEpisode).toEqual(episodes[0]);
      expect(rows[0].classList.contains('selected')).toBe(true);
      expect(byId('playEpisodeBtn').disabled).toBe(false);
      expect(byId('downloadEpisodeBtn').disabled).toBe(false);
      expect(byId('openEpisodeInJellyfinBtn').disabled).toBe(false);

      click(rows[2]);
      expect(rows[0].classList.contains('selected')).toBe(false);
      click(rows[1]);
      expect(sidebar.selectedEpisode).toEqual(episodes[2]);
    });

    it('renders episodes without thumbnails when the server is gone', async () => {
      sidebar.selectedItem = SERIES;
      const gate = deferred();
      globalThis.fetch = vi.fn(async () => {
        await gate.promise;
        return {
          status: 200,
          statusText: 'OK',
          headers: new Headers(),
          text: async () => JSON.stringify({ Items: [{ Id: 'e', MediaSources: [{}] }] }),
        };
      });
      const load = sidebar.loadEpisodes('s1');
      sidebar.currentServer = null;
      gate.resolve();
      await load;
      expect(byId('episodeList').querySelector('.ep-thumb-wrapper.thumb-fallback')).not.toBeNull();

      sidebar.currentServer = { url: BASE, accessToken: 'tok' };
      sidebar.selectedItem = {};
      mockFetch([['/Episodes', { Items: [{ Id: 'e', MediaSources: [{}] }] }]]);
      await sidebar.loadEpisodes('s1');
      expect(byId('episodeList').querySelector('.ep-thumb-wrapper.thumb-fallback')).not.toBeNull();
    });

    it('handles empty seasons, errors and stale responses', async () => {
      sidebar.selectedItem = SERIES;
      await sidebar.loadEpisodes('');
      expect(byId('episodeList').textContent).toContain('Select a season');

      mockFetch([['/Episodes', {}]]);
      await sidebar.loadEpisodes('s1');
      expect(byId('episodeList').textContent).toContain('No episodes found');

      mockFetch([['/Episodes', new Error('x')]]);
      await sidebar.loadEpisodes('s1');
      expect(byId('episodeList').textContent).toContain('Failed to load episodes');

      const gate = deferred();
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls++;
        if (calls === 1) {
          await gate.promise;
          throw new Error('old');
        }
        if (calls === 2) {
          await gate.promise;
          return {
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
            text: async () => JSON.stringify({ Items: [{ Id: 'old', MediaSources: [{}] }] }),
          };
        }
        return {
          status: 200,
          statusText: 'OK',
          headers: new Headers(),
          text: async () => JSON.stringify({ Items: [] }),
        };
      });
      const staleFailure = sidebar.loadEpisodes('s1');
      const staleSuccess = sidebar.loadEpisodes('s2');
      await sidebar.loadEpisodes('s3');
      gate.resolve();
      await Promise.all([staleFailure, staleSuccess]);
      expect(byId('episodeList').querySelectorAll('.episode-item')).toHaveLength(0);
      expect(byId('episodeList').textContent).not.toContain('Failed');
    });

    it('plays or opens the selected episode', () => {
      const play = vi.spyOn(sidebar, 'playMedia').mockImplementation(() => {});
      const open = vi.spyOn(sidebar, 'openInJellyfin').mockImplementation(() => {});
      sidebar.playSelectedEpisode();
      sidebar.openSelectedEpisodeInJellyfin();
      expect(play).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();

      sidebar.selectedEpisode = EPISODE;
      sidebar.playSelectedEpisode();
      sidebar.openSelectedEpisodeInJellyfin();
      expect(play).toHaveBeenCalledWith(EPISODE);
      expect(open).toHaveBeenCalledWith(EPISODE);
    });

    it('hides the picker and optionally returns to the main content', () => {
      byId('episodeSection').style.display = 'block';
      byId('mainContent').style.display = 'none';
      sidebar.selectedEpisode = EPISODE;

      byId('playEpisodeBtn').disabled = false;
      byId('openEpisodeInJellyfinBtn').disabled = false;
      byId('episodeList').innerHTML = '<div>stale</div>';
      byId('seasonSelect').innerHTML = '<option>stale</option>';
      sidebar.selectedSeason = 's1';

      sidebar.hideEpisodeSelection(false);
      expect(byId('episodeSection').style.display).toBe('none');
      expect(byId('mainContent').style.display).toBe('none');
      expect(sidebar.selectedEpisode).toBeNull();
      expect(sidebar.selectedSeason).toBeNull();
      expect(byId('playEpisodeBtn').disabled).toBe(true);
      expect(byId('downloadEpisodeBtn').disabled).toBe(true);
      expect(byId('openEpisodeInJellyfinBtn').disabled).toBe(true);
      expect(byId('episodeList').innerHTML).toBe('');
      expect(byId('seasonSelect').innerHTML).toBe('');

      sidebar.hideEpisodeSelection();
      expect(byId('mainContent').style.display).toBe('block');
    });

    it('checks episode availability', () => {
      expect(sidebar.isEpisodeAvailable({ Name: 'v', LocationType: 'Virtual' })).toBe(false);
      expect(sidebar.isEpisodeAvailable({ Name: 'n', MediaSources: [] })).toBe(false);
      expect(sidebar.isEpisodeAvailable({ Name: 'n' })).toBe(false);
      expect(sidebar.isEpisodeAvailable({ Name: 'f', MediaSources: [{}], IsFolder: true })).toBe(
        false
      );
      expect(sidebar.isEpisodeAvailable({ Name: 'ok', MediaSources: [{}] })).toBe(true);
      expect(
        sidebar.isEpisodeAvailable({ Name: 'fs', LocationType: 'FileSystem', MediaSources: [{}] })
      ).toBe(true);
      expect(sidebar.isEpisodeAvailable({ Name: 'nf', MediaSources: [{}], IsFolder: false })).toBe(
        true
      );
      const broken = {
        Name: 'broken',
        get LocationType() {
          throw new Error('bad');
        },
      };
      expect(sidebar.isEpisodeAvailable(broken)).toBe(false);
    });
  });

  describe('opening in Jellyfin', () => {
    it('posts the details url to the plugin', () => {
      sidebar.openInJellyfin(MOVIE);
      expect(bridge.postMessage).toHaveBeenCalledWith('open-external-url', {
        url: `${BASE}/web/index.html#!/details?id=movie-1`,
        title: 'Big Film - Jellyfin',
      });
    });

    it('ignores missing data and postMessage failures', () => {
      sidebar.openInJellyfin(null);
      expect(bridge.postMessage).not.toHaveBeenCalled();
      sidebar.currentServer = null;
      sidebar.openInJellyfin(MOVIE);
      expect(bridge.postMessage).not.toHaveBeenCalled();

      connect(sidebar);
      bridge.postMessage.mockImplementation(() => {
        throw new Error('bridge down');
      });
      expect(() => sidebar.openInJellyfin(MOVIE)).not.toThrow();
    });
  });

  describe('music', () => {
    it('loads albums, artists and songs by view mode', async () => {
      const fetchMock = mockFetch([
        ['/Artists?', { Items: [{ Id: 'ar', Type: 'MusicArtist', Name: 'Band' }] }],
        ['/Items?', { Items: [ALBUM] }],
      ]);

      await sidebar.loadMusic();
      expect(byId('musicList').querySelectorAll('.music-item')).toHaveLength(1);
      const albums = expectAuthed(fetchMock, 0);
      expect(albums.searchParams.get('IncludeItemTypes')).toBe('MusicAlbum');
      expect(albums.searchParams.get('Recursive')).toBe('true');
      expect(albums.searchParams.get('Genres')).toBeNull();
      expect(albums.searchParams.get('EnableImageTypes')).toBe('Primary');
      expect(albums.searchParams.get('Fields')).toContain('ChildCount');
      expect(albums.searchParams.get('Limit')).toBe('50');

      byId('musicViewSelect').value = 'artists';
      byId('musicGenreSelect').innerHTML = '<option value="Jazz" selected>Jazz</option>';
      await sidebar.loadMusic();
      const artists = expectAuthed(fetchMock, 1);
      expect(artists.pathname).toBe('/Artists');
      expect(artists.searchParams.get('Genres')).toBe('Jazz');
      expect(artists.searchParams.get('EnableImageTypes')).toBe('Primary');
      expect(artists.searchParams.get('Fields')).toContain('ImageTags');
      expect(byId('musicList').querySelector('.media-subtitle').textContent).toBe('Artist');

      byId('musicViewSelect').value = 'songs';
      await sidebar.loadMusic();
      const songs = expectAuthed(fetchMock, 2);
      expect(songs.searchParams.get('IncludeItemTypes')).toBe('Audio');
      expect(songs.searchParams.get('Recursive')).toBe('true');
      expect(songs.searchParams.get('Genres')).toBe('Jazz');
      expect(songs.searchParams.get('Fields')).toContain('AlbumId');
      expect(byId('musicList').querySelector('[data-action="select"]').textContent).toBe('Play');

      byId('musicViewSelect').value = 'albums';
      await sidebar.loadMusic();
      expect(new URL(fetchMock.mock.calls[3][0]).searchParams.get('Genres')).toBe('Jazz');
      expect(byId('musicList').querySelector('[data-action="select"]').textContent).toBe(
        'View Tracks'
      );

      byId('musicViewSelect').value = 'artists';
      byId('musicGenreSelect').innerHTML = '<option value="all" selected>All</option>';
      await sidebar.loadMusic();
      expect(new URL(fetchMock.mock.calls[4][0]).searchParams.get('Genres')).toBeNull();
      byId('musicViewSelect').value = 'songs';
      await sidebar.loadMusic();
      expect(new URL(fetchMock.mock.calls[5][0]).searchParams.get('Genres')).toBeNull();
    });

    it('shows empty and error states for each view', async () => {
      for (const payload of [{ Items: [] }, {}, null]) {
        mockFetch([
          ['/Artists?', payload],
          ['/Items?', payload],
        ]);
        byId('musicViewSelect').value = 'albums';
        await sidebar.loadMusic();
        expect(byId('musicList').textContent).toContain('No albums found');
        byId('musicViewSelect').value = 'artists';
        await sidebar.loadMusic();
        expect(byId('musicList').textContent).toContain('No artists found');
        byId('musicViewSelect').value = 'songs';
        await sidebar.loadMusic();
        expect(byId('musicList').textContent).toContain('No songs found');
        await sidebar.showArtistAlbums({ Id: 'ar', Name: 'Band' });
        expect(byId('musicList').textContent).toContain('No albums found for Band');
      }
      byId('musicViewSelect').value = 'albums';

      mockFetch([['/Items?', new Error('x')]]);
      await sidebar.loadMusic();
      expect(byId('musicList').textContent).toContain('Failed to load music');

      sidebar.currentUser = null;
      const fetchMock = mockFetch([]);
      await sidebar.loadMusic();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('drops stale music responses', async () => {
      const gate = deferred();
      let calls = 0;
      globalThis.fetch = vi.fn(async (url) => {
        const call = ++calls;
        if (call <= 6) {
          await gate.promise;
          if (call === 4 || call === 5) throw new Error('old');
        }
        const stale = call <= 6;
        return {
          status: 200,
          statusText: 'OK',
          headers: new Headers(),
          text: async () =>
            JSON.stringify({
              Items: [
                url.includes('/Artists')
                  ? { Id: 'a', Name: stale ? 'Stale Artist' : 'Fresh Artist' }
                  : { ...ALBUM, Name: stale ? 'Stale Album' : 'Fresh Album' },
              ],
            }),
        };
      });

      const staleAlbums = sidebar.loadMusic();
      byId('musicViewSelect').value = 'artists';
      const staleArtists = sidebar.loadMusic();
      byId('musicViewSelect').value = 'songs';
      const staleSongs = sidebar.loadMusic();
      const staleArtistFailure = sidebar.showArtistAlbums({ Id: 'ar', Name: 'Band' });
      const staleMusicFailure = sidebar.loadMusic();
      const staleArtistSuccess = sidebar.showArtistAlbums({ Id: 'ar', Name: 'Band' });
      byId('musicViewSelect').value = 'albums';
      await sidebar.loadMusic();
      gate.resolve();
      await Promise.all([
        staleAlbums,
        staleArtists,
        staleSongs,
        staleArtistFailure,
        staleMusicFailure,
        staleArtistSuccess,
      ]);

      expect(byId('musicList').querySelectorAll('.music-item')).toHaveLength(1);
      expect(byId('musicList').textContent).toContain('Fresh Album');
      expect(byId('musicList').textContent).not.toContain('Stale');
    });

    it('picks music thumbnails', () => {
      expect(sidebar.getMusicThumbnailUrl({ Id: 'a', ImageTags: { Primary: 'p' } })).toContain(
        '/Items/a/Images/Primary?maxWidth=96'
      );
      expect(sidebar.getMusicThumbnailUrl({ Id: 'a', AlbumId: 'al' })).toContain(
        '/Items/al/Images/Primary'
      );
      expect(sidebar.getMusicThumbnailUrl({ Id: 'a', BackdropImageTags: ['b'] })).toContain(
        '/Items/a/Images/Backdrop?maxWidth=192'
      );
      expect(sidebar.getMusicThumbnailUrl({ Id: 'a', BackdropImageTags: [] })).toBeNull();
      expect(sidebar.getMusicThumbnailUrl({ Id: 'a' })).toBeNull();
      sidebar.currentServer = null;
      expect(sidebar.getMusicThumbnailUrl({ Id: 'a', ImageTags: { Primary: 'p' } })).toBeNull();
    });

    it('renders music rows of every view type', () => {
      const container = byId('musicList');
      sidebar.renderMusicList([], container);
      expect(container.textContent).toContain('No items found');
      sidebar.renderMusicList(null, container);

      sidebar.renderMusicList(
        [
          { ...ALBUM, ChildCount: 12, ProductionYear: 1999, ImageTags: { Primary: 'p' } },
          { ...ALBUM, Id: 'album-2', AlbumArtist: undefined, AlbumArtists: [{ Name: 'X' }] },
          { ...ALBUM, Id: 'album-3', AlbumArtist: undefined },
        ],
        container,
        'album'
      );
      let rows = container.querySelectorAll('.music-item');
      expect(rows[0].querySelector('.media-subtitle').textContent).toBe('Band — 1999 · 12 tracks');
      expect(rows[0].querySelector('.album-thumb')).not.toBeNull();
      expect(rows[1].querySelector('.media-subtitle').textContent).toBe('X');
      expect(rows[2].querySelector('.media-subtitle')).toBeNull();
      expect(rows[2].querySelector('.album-thumb-wrapper.thumb-fallback').textContent).toBe('💿');
      expect(rows[0].querySelector('[data-action="select"]').textContent).toBe('View Tracks');
      expect(rows[0].querySelector('[data-action="download"]')).toBeNull();

      sidebar.renderMusicList(
        [{ Id: 'ar', Type: 'MusicArtist', Name: 'Band' }],
        container,
        'artist'
      );
      rows = container.querySelectorAll('.music-item');
      expect(rows[0].querySelector('.media-subtitle').textContent).toBe('Artist');
      expect(rows[0].querySelector('[data-action="select"]').textContent).toBe('View Albums');
      expect(rows[0].querySelector('.thumb-fallback').textContent).toBe('🎤');

      sidebar.renderMusicList(
        [
          { ...SONG, RunTimeTicks: 3 * 600000000 },
          {
            ...SONG,
            Id: 'song-2',
            AlbumArtist: undefined,
            AlbumArtists: [{ Name: 'Y' }],
            Album: undefined,
          },
          { ...SONG, Id: 'song-3', AlbumArtist: undefined, Album: undefined },
        ],
        container,
        'song'
      );
      rows = container.querySelectorAll('.music-item');
      expect(rows[0].querySelector('.media-subtitle').textContent).toBe('Band — Record');
      expect(rows[0].querySelector('.list-duration').textContent).toBe('3m');
      expect(rows[0].querySelector('[data-action="download"]').textContent).toBe('⬇ Offline');
      expect(rows[1].querySelector('.media-subtitle').textContent).toBe('Y');
      expect(rows[2].querySelector('.media-subtitle')).toBeNull();
      expect(rows[2].querySelector('.thumb-fallback').textContent).toBe('🎵');

      expect(strayText(container)).toBe('');
      expect(container.childNodes).toHaveLength(3);

      sidebar.renderMusicList([{ Id: 'x' }], container, 'other');
      expect(container.querySelector('.media-title').textContent).toBe('Unknown Title');
      expect(container.querySelector('.media-subtitle')).toBeNull();
      expect(container.querySelector('[data-action="select"]').textContent).toBe('Play');
      expect(container.querySelector('[data-action="download"]')).toBeNull();
      expect(container.querySelector('.thumb-fallback').textContent).toBe('🎵');
      expect(container.querySelector('.list-duration')).toBeNull();
      expect(strayText(container)).toBe('');
    });

    it('wires music row actions', () => {
      const container = byId('musicList');
      sidebar.renderMusicList([SONG], container, 'song');
      const row = container.querySelector('.music-item');
      const select = vi.spyOn(sidebar, 'selectMusicItem').mockImplementation(() => {});
      const open = vi.spyOn(sidebar, 'openInJellyfin').mockImplementation(() => {});
      const download = vi.spyOn(sidebar, 'handleDownloadButtonClick').mockImplementation(() => {});

      click(row.querySelector('[data-action="select"]'));
      click(row);
      click(row.querySelector('[data-action="open-jellyfin"]'));
      click(row.querySelector('[data-action="download"]'));

      expect(select).toHaveBeenCalledTimes(2);
      expect(select).toHaveBeenCalledWith(SONG, 'song');
      expect(open).toHaveBeenCalledWith(SONG);
      expect(download).toHaveBeenCalledWith(SONG);
    });

    it('routes music selections', () => {
      const tracks = vi.spyOn(sidebar, 'showAlbumTracks').mockImplementation(() => {});
      const albums = vi.spyOn(sidebar, 'showArtistAlbums').mockImplementation(() => {});
      const play = vi.spyOn(sidebar, 'playMedia').mockImplementation(() => {});

      sidebar.selectMusicItem(ALBUM, 'album');
      sidebar.selectMusicItem(ALBUM, 'song');
      sidebar.selectMusicItem({ Id: 'x', Type: 'Audio' }, 'album');
      sidebar.selectMusicItem({ Id: 'ar', Type: 'MusicArtist' }, 'artist');
      sidebar.selectMusicItem({ Id: 'ar', Type: 'MusicArtist' }, 'song');
      sidebar.selectMusicItem({ Id: 'x', Type: 'Audio' }, 'artist');
      sidebar.selectMusicItem(SONG, 'song');

      expect(tracks).toHaveBeenCalledTimes(3);
      expect(albums).toHaveBeenCalledTimes(3);
      expect(play).toHaveBeenCalledTimes(1);
      expect(play).toHaveBeenCalledWith(SONG);
    });

    it('shows the albums of an artist', async () => {
      const fetchMock = mockFetch([['/Items?', { Items: [ALBUM] }]]);
      await sidebar.showArtistAlbums({ Id: 'ar', Name: 'Band' });
      const url = expectAuthed(fetchMock, 0);
      expect(url.searchParams.get('AlbumArtistIds')).toBe('ar');
      expect(url.searchParams.get('IncludeItemTypes')).toBe('MusicAlbum');
      expect(url.searchParams.get('Recursive')).toBe('true');
      expect(url.searchParams.get('SortBy')).toBe('ProductionYear,SortName');
      expect(url.searchParams.get('SortOrder')).toBe('Descending');
      expect(url.searchParams.get('Fields')).toContain('ChildCount');
      expect(url.searchParams.get('EnableImageTypes')).toBe('Primary');
      expect(url.searchParams.get('Limit')).toBe('50');
      expect(byId('musicList').querySelectorAll('.music-item')).toHaveLength(1);
      expect(byId('musicList').querySelector('[data-action="select"]').textContent).toBe(
        'View Tracks'
      );

      mockFetch([['/Items?', { Items: [] }]]);
      await sidebar.showArtistAlbums({ Id: 'ar', Name: 'B<and>' });
      expect(byId('musicList').textContent).toContain('No albums found for B<and>');

      mockFetch([['/Items?', new Error('x')]]);
      await sidebar.showArtistAlbums({ Id: 'ar', Name: 'Band' });
      expect(byId('musicList').textContent).toContain('Failed to load albums');

      sidebar.currentUser = null;
      const idle = mockFetch([]);
      await sidebar.showArtistAlbums({ Id: 'ar' });
      expect(idle).not.toHaveBeenCalled();
    });

    it('shows and renders album tracks', async () => {
      const tracks = [
        { Id: 't1', Name: 'One', IndexNumber: 1, RunTimeTicks: 600000000, Artists: ['A', 'B'] },
        { Id: 't2', AlbumArtist: 'Band' },
        { Id: 't3', Name: 'Three' },
      ];
      const fetchMock = mockFetch([['/Items?', { Items: tracks }]]);

      await sidebar.showAlbumTracks(ALBUM);

      expect(byId('albumTracksSection').style.display).toBe('block');
      expect(byId('mainContent').style.display).toBe('none');
      expect(byId('albumTracksTitle').textContent).toBe('Record — Band');
      const url = expectAuthed(fetchMock, 0);
      expect(url.searchParams.get('ParentId')).toBe('album-1');
      expect(url.searchParams.get('IncludeItemTypes')).toBe('Audio');
      expect(url.searchParams.get('SortBy')).toBe('ParentIndexNumber,IndexNumber,SortName');
      expect(url.searchParams.get('SortOrder')).toBe('Ascending');
      expect(url.searchParams.get('Fields')).toContain('Artists');
      expect(sidebar.albumTracks).toEqual(tracks);
      expect(sidebar.selectedAlbum).toEqual(ALBUM);
      expect(byId('playAllTracksBtn').disabled).toBe(false);
      expect(byId('openAlbumInJellyfinBtn').disabled).toBe(false);

      const rows = byId('albumTracksList').querySelectorAll('.track-item');
      expect(byId('albumTracksList').childNodes).toHaveLength(3);
      expect(strayText(byId('albumTracksList'))).toBe('');
      expect(rows[2].querySelector('.track-duration')).toBeNull();
      expect(rows[0].querySelector('.track-title').textContent).toBe('One');
      expect(rows[0].querySelector('.track-artist').textContent).toBe('A, B');
      expect(rows[0].querySelector('.track-duration').textContent).toBe('1m');
      expect(rows[1].querySelector('.track-number').textContent).toBe('2');
      expect(rows[1].querySelector('.track-title').textContent).toBe('Track 2');
      expect(rows[1].querySelector('.track-artist').textContent).toBe('Band');
      expect(rows[2].querySelector('.track-artist')).toBeNull();

      const play = vi.spyOn(sidebar, 'playMedia').mockImplementation(() => {});
      click(rows[1]);
      expect(sidebar.selectedTrack).toEqual(tracks[1]);
      expect(rows[1].classList.contains('selected')).toBe(true);
      expect(play).toHaveBeenCalledWith(tracks[1]);

      mockFetch([['/Items?', { Items: [] }]]);
      await sidebar.showAlbumTracks({ ...ALBUM, AlbumArtist: undefined });
      expect(byId('albumTracksTitle').textContent).toBe('Record');
      expect(byId('albumTracksList').textContent).toContain('No tracks found');
      expect(sidebar.albumTracks).toEqual([]);

      mockFetch([['/Items?', new Error('x')]]);
      await sidebar.showAlbumTracks(ALBUM);
      expect(byId('albumTracksList').textContent).toContain('Failed to load tracks');
    });

    it('drops stale album track responses', async () => {
      const gate = deferred();
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls++;
        if (calls === 1) {
          await gate.promise;
          throw new Error('old');
        }
        if (calls === 2) {
          await gate.promise;
          return {
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
            text: async () => JSON.stringify({ Items: [{ Id: 'old' }] }),
          };
        }
        return {
          status: 200,
          statusText: 'OK',
          headers: new Headers(),
          text: async () => JSON.stringify({ Items: [{ Id: 'new', Name: 'New' }] }),
        };
      });
      const staleFailure = sidebar.showAlbumTracks(ALBUM);
      const staleSuccess = sidebar.showAlbumTracks(ALBUM);
      await sidebar.showAlbumTracks(ALBUM);
      gate.resolve();
      await Promise.all([staleFailure, staleSuccess]);
      expect(byId('albumTracksList').textContent).toContain('New');
      expect(sidebar.albumTracks).toEqual([{ Id: 'new', Name: 'New' }]);
    });

    it('plays all album tracks through the plugin', () => {
      sidebar.playAllAlbumTracks();
      expect(bridge.postMessage).not.toHaveBeenCalled();

      sidebar.albumTracks = [SONG, { Id: 't2' }];
      sidebar.playAllAlbumTracks();
      expect(bridge.postMessage).toHaveBeenCalledWith('play-media-list', {
        items: [
          { streamUrl: `${BASE}/Audio/song-1/stream?static=true&api_key=tok`, title: 'Tune' },
          { streamUrl: `${BASE}/Videos/t2/stream?static=true&api_key=tok`, title: 'Unknown Title' },
        ],
      });

      const play = vi.spyOn(sidebar, 'playMedia').mockImplementation(() => {});
      delete bridge.postMessage;
      sidebar.playAllAlbumTracks();
      expect(play).toHaveBeenCalledWith(SONG);

      sidebar.currentServer = null;
      sidebar.playAllAlbumTracks();
      expect(play).toHaveBeenCalledTimes(1);
    });

    it('opens the album in Jellyfin and hides the track list', () => {
      const open = vi.spyOn(sidebar, 'openInJellyfin').mockImplementation(() => {});
      sidebar.openAlbumInJellyfin();
      expect(open).not.toHaveBeenCalled();
      sidebar.selectedAlbum = ALBUM;
      sidebar.openAlbumInJellyfin();
      expect(open).toHaveBeenCalledWith(ALBUM);

      byId('albumTracksSection').style.display = 'block';
      byId('mainContent').style.display = 'none';
      byId('albumTracksList').innerHTML = '<div>stale</div>';
      byId('playAllTracksBtn').disabled = false;
      byId('openAlbumInJellyfinBtn').disabled = false;
      sidebar.selectedTrack = SONG;
      sidebar.albumTracks = [SONG];
      sidebar.hideAlbumTracks(false);
      expect(byId('albumTracksSection').style.display).toBe('none');
      expect(byId('mainContent').style.display).toBe('none');
      expect(sidebar.selectedAlbum).toBeNull();
      expect(sidebar.selectedTrack).toBeNull();
      expect(sidebar.albumTracks).toEqual([]);
      expect(byId('albumTracksList').innerHTML).toBe('');
      expect(byId('playAllTracksBtn').disabled).toBe(true);
      expect(byId('openAlbumInJellyfinBtn').disabled).toBe(true);
      sidebar.hideAlbumTracks();
      expect(byId('mainContent').style.display).toBe('block');
    });
  });

  describe('playback', () => {
    it('builds stream urls', () => {
      expect(sidebar.buildStreamUrl(MOVIE)).toBe(
        `${BASE}/Videos/movie-1/stream?static=true&api_key=tok`
      );
      expect(sidebar.buildStreamUrl(SONG)).toBe(
        `${BASE}/Audio/song-1/stream?static=true&api_key=tok`
      );
      expect(sidebar.buildStreamUrl({})).toBeNull();
      expect(sidebar.buildStreamUrl(null)).toBeNull();
      sidebar.currentServer = null;
      expect(sidebar.buildStreamUrl(MOVIE)).toBeNull();
    });

    it('sends play requests to the plugin', async () => {
      await sidebar.playMedia(MOVIE);
      expect(bridge.postMessage).toHaveBeenCalledWith('play-media', {
        streamUrl: `${BASE}/Videos/movie-1/stream?static=true&api_key=tok`,
        title: 'Big Film',
      });

      byId('episodeSection').style.display = 'block';
      await sidebar.playMedia({ Id: 'x', Type: 'Episode' });
      expect(bridge.postMessage).toHaveBeenLastCalledWith(
        'play-media',
        expect.objectContaining({ title: 'Unknown Title' })
      );
      expect(byId('episodeSection').style.display).toBe('none');

      const hide = vi.spyOn(sidebar, 'hideEpisodeSelection');
      await sidebar.playMedia(MOVIE);
      expect(hide).not.toHaveBeenCalled();
    });

    it('falls back to window.open and survives errors', async () => {
      const open = vi.spyOn(window, 'open').mockImplementation(() => null);
      delete bridge.postMessage;
      await sidebar.playMedia(MOVIE);
      expect(open).toHaveBeenCalledWith(
        `${BASE}/Videos/movie-1/stream?static=true&api_key=tok`,
        '_blank'
      );

      bridge.postMessage = vi.fn(() => {
        throw new Error('bridge down');
      });
      await expect(sidebar.playMedia(MOVIE)).resolves.toBeUndefined();

      sidebar.currentServer = null;
      await sidebar.playMedia(MOVIE);
      expect(open).toHaveBeenCalledTimes(1);
    });
  });
});
