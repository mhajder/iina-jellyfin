import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './harness/fixtures.mjs';
import { mediaBytes, subtitleText, transcodedBytes } from './harness/mock-jellyfin.mjs';

const downloadButton = (page, itemId) => page.locator(`[data-offline-item-id="${itemId}"]`).first();
const downloadEntry = (page, itemId) =>
  page.locator(`.download-item[data-download-id="${itemId}"]`);

async function expectConnected(page) {
  await expect(page.locator('#serverStatus')).toHaveText(/Connected to Mock Jellyfin as tester/);
  await expect(downloadButton(page, 'movie-1')).toHaveText('⬇ Offline');
}

test.describe('download quality', () => {
  test('offers the quality presets and remembers the choice', async ({ page, plugin }) => {
    await plugin.open();
    const select = page.locator('#downloadQualitySelect');
    await expect(select).toBeEnabled();
    await expect(select).toHaveValue('original');
    const labels = await select.locator('option').allTextContents();
    expect(labels).toEqual([
      'Original quality',
      '8 Mb/s',
      '4 Mb/s',
      '2 Mb/s',
      '1 Mb/s',
      '500 Kb/s',
      '250 Kb/s',
    ]);

    await select.selectOption('2000');
    await expect(page.locator('#downloadsNotice')).toHaveText('New downloads will use 2 mb/s');
    await expect.poll(() => plugin.host.prefs.get('offline_download_quality')).toBe('2000');

    // A restart of IINA keeps the preference and the sidebar shows it again
    await plugin.open({ preferences: { offline_download_quality: '2000' } });
    await expect(page.locator('#downloadQualitySelect')).toHaveValue('2000');
  });

  test('downloads a transcoded copy with all text subtitles when a cap applies', async ({
    page,
    plugin,
    jellyfin,
  }) => {
    await plugin.open({ preferences: { offline_download_quality: '2000' } });
    await expectConnected(page);

    await downloadButton(page, 'movie-1').click();
    await page.locator('#downloadsBtn').click();
    await expect(downloadEntry(page, 'movie-1')).toContainText(
      /Queued · 2 Mb\/s|Transcoding to 2 Mb\/s and downloading…|Ready to play offline/
    );
    await expect(downloadEntry(page, 'movie-1')).toContainText(
      'Ready to play offline · transcoded to 2 Mb/s · 2 subtitles',
      { timeout: 30000 }
    );

    // The server received a device profile with the bitrate cap
    const negotiation = jellyfin.state.playbackInfoRequests.find((r) => r.itemId === 'movie-1');
    expect(negotiation.body.MaxStreamingBitrate).toBe(2000000);
    expect(negotiation.body.DeviceProfile.TranscodingProfiles[0]).toMatchObject({
      Container: 'mp4',
      Protocol: 'http',
    });

    // The file on disk is the transcoder's output, not the original
    const mediaPath = path.join(plugin.dataDir, 'offline/movie-1.mp4');
    expect(fs.readFileSync(mediaPath).equals(transcodedBytes('movie-1', '2000000'))).toBe(true);
    expect(fs.existsSync(path.join(plugin.dataDir, 'offline/movie-1.mkv'))).toBe(false);
    expect(
      fs.readFileSync(path.join(plugin.dataDir, 'offline/movie-1_sub_2_eng.srt'), 'utf8')
    ).toBe(subtitleText('movie-1', 2));
    expect(plugin.host.manifest()[0]).toMatchObject({
      quality: '2000',
      qualityLabel: '2 Mb/s',
      transcoded: true,
      container: 'mp4',
      expectedBytes: null,
    });

    // Playing attaches the sidecar subtitles like any other download
    await downloadEntry(page, 'movie-1').locator('[data-action="play"]').click();
    await expect.poll(() => plugin.host.record.opened).toEqual([mediaPath]);
    await expect.poll(() => plugin.host.record.subtitleTracks.length).toBe(2);
  });

  test('keeps the original file when the source is already below the cap', async ({
    page,
    plugin,
    jellyfin,
  }) => {
    await plugin.open({ preferences: { offline_download_quality: '8000' } });
    await expectConnected(page);

    await downloadButton(page, 'movie-1').click();
    await expect(downloadButton(page, 'movie-1')).toHaveText('▶ Offline', { timeout: 30000 });

    const negotiation = jellyfin.state.playbackInfoRequests.find((r) => r.itemId === 'movie-1');
    expect(negotiation.body.MaxStreamingBitrate).toBe(8000000);
    const mediaPath = path.join(plugin.dataDir, 'offline/movie-1.mkv');
    expect(fs.readFileSync(mediaPath).equals(mediaBytes('movie-1'))).toBe(true);
    expect(plugin.host.manifest()[0]).toMatchObject({ quality: '8000', transcoded: false });

    await page.locator('#downloadsBtn').click();
    await expect(downloadEntry(page, 'movie-1')).toContainText(
      'Ready to play offline · original file, already below the limit · 256.0 KB · 2 subtitles'
    );
  });

  test('changes the download folder with the system picker', async ({ page, plugin }) => {
    await plugin.open();
    const chosen = path.join(plugin.dataDir, 'chosen-folder');
    plugin.host.nextChosenFolder = chosen;

    await page.locator('#downloadsBtn').click();
    await page.locator('#changeDownloadsFolderBtn').click();

    await expect(page.locator('#downloadsDirectory')).toHaveText(`Folder: ${chosen}`);
    expect(plugin.host.record.folderPickerOpened).toBe(1);
    expect(plugin.host.prefs.get('offline_download_dir')).toBe(chosen);
    expect(plugin.host.record.osd).toContain(`Offline downloads folder: ${chosen}`);

    // Downloads now land in the new folder
    await page.locator('#closeDownloadsBtn').click();
    await expectConnected(page);
    await downloadButton(page, 'movie-1').click();
    await expect(downloadButton(page, 'movie-1')).toHaveText('▶ Offline', { timeout: 30000 });
    expect(fs.existsSync(path.join(chosen, 'movie-1.mkv'))).toBe(true);
    expect(fs.existsSync(path.join(chosen, 'manifest.json'))).toBe(true);

    // Cancelling the picker keeps the folder
    plugin.host.nextChosenFolder = '';
    await page.locator('#downloadsBtn').click();
    await page.locator('#changeDownloadsFolderBtn').click();
    await expect.poll(() => plugin.host.record.folderPickerOpened).toBe(2);
    expect(plugin.host.prefs.get('offline_download_dir')).toBe(chosen);
  });
});
