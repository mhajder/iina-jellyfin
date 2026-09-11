import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './harness/fixtures.mjs';
import { mediaBytes, subtitleText } from './harness/mock-jellyfin.mjs';

const movieRow = (page) => page.locator('#recentList .media-item[data-item-id="movie-1"]');
const downloadButton = (page, itemId) => page.locator(`[data-offline-item-id="${itemId}"]`).first();
const downloadEntry = (page, itemId) =>
  page.locator(`.download-item[data-download-id="${itemId}"]`);

async function expectConnected(page) {
  await expect(page.locator('#serverStatus')).toHaveText(/Connected to Mock Jellyfin as tester/);
  await expect(movieRow(page)).toBeVisible();
}

async function downloadMovie(page, plugin) {
  await expectConnected(page);
  await expect(downloadButton(page, 'movie-1')).toHaveText('⬇ Offline');
  await downloadButton(page, 'movie-1').click();
  await expect(page.locator('#downloadsNotice')).toHaveText('Queued for download: Big Film');
  await expect(downloadButton(page, 'movie-1')).toHaveText('▶ Offline', { timeout: 30000 });
  return path.join(plugin.dataDir, 'offline/movie-1.mkv');
}

test.describe('offline downloads', () => {
  test('downloads a movie with its subtitles from the sidebar', async ({
    page,
    plugin,
    jellyfin,
  }) => {
    await plugin.open();
    const mediaPath = await downloadMovie(page, plugin);

    // Real bytes on disk, fetched by curl straight from the (mock) server
    expect(fs.readFileSync(mediaPath).equals(mediaBytes('movie-1'))).toBe(true);
    expect(
      fs.readFileSync(path.join(plugin.dataDir, 'offline/movie-1_sub_2_eng.srt'), 'utf8')
    ).toBe(subtitleText('movie-1', 2));
    expect(
      fs.readFileSync(path.join(plugin.dataDir, 'offline/movie-1_sub_3_pol.srt'), 'utf8')
    ).toBe(subtitleText('movie-1', 3));
    // The image based subtitle stream is embedded work for the player, not a download
    expect(fs.existsSync(path.join(plugin.dataDir, 'offline/movie-1_sub_4_ger.srt'))).toBe(false);

    const [entry] = plugin.host.manifest();
    expect(entry).toMatchObject({
      itemId: 'movie-1',
      status: 'completed',
      progress: 100,
      title: 'Big Film (2020)',
      container: 'mkv',
      expectedBytes: mediaBytes('movie-1').length,
      mediaAbsolutePath: mediaPath,
    });
    expect(entry.subtitles.map((subtitle) => subtitle.language)).toEqual(['eng', 'pol']);
    expect(JSON.stringify(plugin.host.manifest())).not.toContain('e2e-access-token');
    expect(plugin.host.record.osd).toContain('Downloaded for offline: Big Film (2020)');

    // Authenticated with the MediaBrowser header, not a token in the URL
    const streamRequest = jellyfin.requestsTo('/Videos/movie-1/stream')[0];
    expect(streamRequest.query).toBe('?static=true&mediaSourceId=src-movie-1');

    await page.locator('#downloadsBtn').click();
    await expect(page.locator('#downloadsSection')).toBeVisible();
    await expect(page.locator('#mainContent')).toBeHidden();
    await expect(downloadEntry(page, 'movie-1')).toContainText('Big Film');
    await expect(downloadEntry(page, 'movie-1')).toContainText(
      'Ready to play offline · 256.0 KB · 2 subtitles'
    );
    await expect(page.locator('#downloadsSummary')).toHaveText('1 ready');
    await expect(page.locator('#downloadsDirectory')).toHaveText(
      `Folder: ${path.join(plugin.dataDir, 'offline')}`
    );

    await page.locator('#closeDownloadsBtn').click();
    await expect(page.locator('#mainContent')).toBeVisible();
    await expect(page.locator('#downloadsSection')).toBeHidden();
  });

  test('plays the offline copy with its subtitles attached', async ({ page, plugin }) => {
    await plugin.open({ preferences: { show_notifications: true } });
    const mediaPath = await downloadMovie(page, plugin);

    await page.locator('#downloadsBtn').click();
    await downloadEntry(page, 'movie-1').locator('[data-action="play"]').click();

    await expect.poll(() => plugin.host.record.opened).toEqual([mediaPath]);
    await expect
      .poll(() => plugin.host.record.subtitleTracks)
      .toEqual([
        path.join(plugin.dataDir, 'offline/movie-1_sub_2_eng.srt'),
        path.join(plugin.dataDir, 'offline/movie-1_sub_3_pol.srt'),
      ]);
    expect(plugin.host.record.mpvSet).toContainEqual(['force-media-title', 'Big Film (2020)']);
    expect(plugin.host.record.osd).toContain('Loaded 2 offline subtitle(s)');

    // The ▶ Offline button in the media list plays the local copy too
    await page.locator('#closeDownloadsBtn').click();
    await downloadButton(page, 'movie-1').click();
    await expect.poll(() => plugin.host.record.opened).toEqual([mediaPath, mediaPath]);
  });

  test('keeps working without the server: browse, play and remove downloads', async ({
    page,
    plugin,
    jellyfin,
  }) => {
    await plugin.open();
    const mediaPath = await downloadMovie(page, plugin);

    // The server disappears and IINA is restarted with the same data folder
    jellyfin.state.online = false;
    await plugin.open();

    await expect(page.locator('#serverStatus')).toHaveText('Connection failed - check server');
    await expect(page.locator('#mainContent')).toBeHidden();

    await page.locator('#downloadsBtn').click();
    await expect(page.locator('#downloadsSection')).toBeVisible();
    await expect(page.locator('#loginSection')).toBeHidden();
    await expect(downloadEntry(page, 'movie-1')).toContainText('Ready to play offline');

    await downloadEntry(page, 'movie-1').locator('[data-action="play"]').click();
    await expect.poll(() => plugin.host.record.opened).toEqual([mediaPath]);
    await expect.poll(() => plugin.host.record.subtitleTracks.length).toBe(2);
    // Nothing was asked of the server after it went away
    expect(jellyfin.requestsTo('/Videos/movie-1/stream')).toHaveLength(1);

    // Removing asks for confirmation, then deletes the files
    const removeButton = downloadEntry(page, 'movie-1').locator('[data-action="remove"]');
    await removeButton.click();
    await expect(removeButton).toHaveText('Confirm?');
    await removeButton.click();

    await expect(page.locator('#downloadsList')).toContainText('No downloads yet');
    await expect.poll(() => fs.existsSync(mediaPath)).toBe(false);
    expect(fs.existsSync(path.join(plugin.dataDir, 'offline/movie-1_sub_2_eng.srt'))).toBe(false);
    expect(plugin.host.manifest()).toEqual([]);

    // Back returns to the login form, which is what a disconnected sidebar shows
    await page.locator('#closeDownloadsBtn').click();
    await expect(page.locator('#loginSection')).toBeVisible();
  });

  test('downloads an episode from the series picker', async ({ page, plugin }) => {
    await plugin.open();
    await expectConnected(page);

    await page
      .locator('#recentList .media-item[data-item-id="series-1"] [data-action="select"]')
      .click();
    await expect(page.locator('#episodeSection')).toBeVisible();
    await page.locator('#seasonSelect').selectOption('season-1');
    await page.locator('.episode-item[data-episode-id="ep-1"]').click();
    await expect(page.locator('#downloadEpisodeBtn')).toBeEnabled();

    await page.locator('#downloadEpisodeBtn').click();
    await expect(page.locator('#downloadsNotice')).toHaveText('Queued for download: Pilot');

    await page.locator('#downloadsBtn').click();
    await expect(downloadEntry(page, 'ep-1')).toContainText('Show · S1E1');
    await expect(downloadEntry(page, 'ep-1')).toContainText(
      'Ready to play offline · 64.0 KB · 1 subtitle',
      {
        timeout: 30000,
      }
    );

    const episodePath = path.join(plugin.dataDir, 'offline/ep-1.mkv');
    expect(fs.readFileSync(episodePath).equals(mediaBytes('ep-1'))).toBe(true);
    expect(plugin.host.manifest()[0]).toMatchObject({
      itemId: 'ep-1',
      title: 'Show S01E01 - Pilot',
      type: 'Episode',
    });

    await downloadEntry(page, 'ep-1').locator('[data-action="play"]').click();
    await expect.poll(() => plugin.host.record.opened).toEqual([episodePath]);
    await expect
      .poll(() => plugin.host.record.subtitleTracks)
      .toEqual([path.join(plugin.dataDir, 'offline/ep-1_sub_2_eng.srt')]);
    expect(plugin.host.record.mpvSet).toContainEqual(['force-media-title', 'Show S01E01 - Pilot']);
  });

  test('reports failed downloads and retries them', async ({ page, plugin, jellyfin }) => {
    await plugin.open();
    await expectConnected(page);
    await page.locator('.tab-button[data-tab="movies"]').click();

    const brokenButton = page.locator('#moviesList [data-offline-item-id="broken-1"]');
    await brokenButton.click();
    await expect(brokenButton).toHaveText('Retry ⬇', { timeout: 30000 });
    await expect(brokenButton).toHaveAttribute('title', /curl exited with status 22/);

    await page.locator('#downloadsBtn').click();
    await expect(downloadEntry(page, 'broken-1')).toContainText(
      'Failed: curl exited with status 22'
    );
    expect(fs.existsSync(path.join(plugin.dataDir, 'offline/broken-1.mkv'))).toBe(false);
    expect(plugin.host.record.osd).toContain('Download failed: Broken Film (2021)');

    // Once the server behaves, Retry completes the download
    jellyfin.state.brokenItems.clear();
    await downloadEntry(page, 'broken-1').locator('[data-action="retry"]').click();
    await expect(downloadEntry(page, 'broken-1')).toContainText('Ready to play offline', {
      timeout: 30000,
    });
    expect(
      fs
        .readFileSync(path.join(plugin.dataDir, 'offline/broken-1.mkv'))
        .equals(mediaBytes('broken-1'))
    ).toBe(true);
  });

  test('shows progress and cancels a running download', async ({ page, plugin }) => {
    await plugin.open();
    await expectConnected(page);
    await page.locator('.tab-button[data-tab="movies"]').click();

    const slowButton = page.locator('#moviesList [data-offline-item-id="slow-1"]');
    await slowButton.click();
    await expect(slowButton).toHaveAttribute('data-offline-state', 'downloading');
    await expect(page.locator('#downloadsBadge')).toHaveText('1');

    await page.locator('#downloadsBtn').click();
    await expect(downloadEntry(page, 'slow-1')).toContainText(/Downloading [1-9]\d?% of 2\.0 MB/);
    await expect(downloadEntry(page, 'slow-1').locator('.download-progress-bar')).toBeVisible();

    await downloadEntry(page, 'slow-1').locator('[data-action="cancel"]').click();

    await expect(page.locator('#downloadsList')).toContainText('No downloads yet', {
      timeout: 30000,
    });
    await expect(page.locator('#downloadsBadge')).toBeHidden();
    await expect
      .poll(() => fs.existsSync(path.join(plugin.dataDir, 'offline/slow-1.mkv')))
      .toBe(false);
    expect(plugin.host.manifest()).toEqual([]);
    expect(plugin.host.record.osd).not.toContain('Download failed: Slow Film (2022)');
  });

  test('downloads from search results and opens the downloads folder', async ({ page, plugin }) => {
    await plugin.open();
    await expectConnected(page);

    await page.locator('.tab-button[data-tab="search"]').click();
    await page.locator('#searchInput').fill('big');
    const hintButton = page.locator('#searchResults [data-offline-item-id="movie-1"]');
    await hintButton.click();
    await expect(hintButton).toHaveText('▶ Offline', { timeout: 30000 });

    await page.locator('#downloadsBtn').click();
    await page.locator('#openDownloadsFolderBtn').click();
    await expect
      .poll(() => plugin.host.record.osd)
      .toContain(`[finder] ${path.join(plugin.dataDir, 'offline')}`);
  });
});
