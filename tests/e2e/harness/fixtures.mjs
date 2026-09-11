import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect } from '@playwright/test';
import { createMockJellyfin, TOKEN } from './mock-jellyfin.mjs';
import { createPluginHost, PAGE_BRIDGE_SCRIPT } from './plugin-host.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.resolve(here, '../../../src/ui/sidebar');

/**
 * Fixtures for the offline download scenarios:
 * - `jellyfin`: the mock server (per test, on a random port)
 * - `plugin`: an object that boots the real plugin against a page and opens
 *   the sidebar in it. Calling `open` again reuses the data folder, which is
 *   how a restart of IINA is simulated.
 */
export const test = base.extend({
  jellyfin: async ({}, use) => {
    const server = createMockJellyfin({ uiDir });
    await server.start();
    await use(server);
    await server.stop();
  },

  plugin: async ({ page, jellyfin }, use) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iina-jellyfin-e2e-'));
    fs.mkdirSync(path.join(dataDir, 'tmp'));
    let host = null;
    let bridged = false;

    const plugin = {
      dataDir,
      get host() {
        return host;
      },
      /**
       * Boot the plugin with the given preferences and load the sidebar page.
       * With `storedServer: true` the mock server is pre-configured, so the
       * sidebar auto-connects (or fails to, when the server is offline).
       */
      async open({ storedServer = true, preferences = {} } = {}) {
        if (host) host.markPageGone();
        const prefs = { ...preferences };
        if (storedServer) {
          prefs.jellyfin_servers = JSON.stringify([
            {
              id: 'srv-e2e',
              serverUrl: jellyfin.baseUrl,
              serverName: 'Mock Jellyfin',
              accessToken: TOKEN,
              userId: 'user-1',
              username: 'tester',
            },
          ]);
          prefs.jellyfin_active_server_id = 'srv-e2e';
        }
        host = createPluginHost({ page, dataDir, preferences: prefs });
        if (!bridged) {
          await page.exposeFunction('__iinaSend', (name, data) => host.receiveFromPage(name, data));
          await page.addInitScript(PAGE_BRIDGE_SCRIPT);
          bridged = true;
        }
        await host.boot();
        await page.goto(`${jellyfin.baseUrl}/ui/index.html`);
        host.markPageReady();
        return host;
      },
    };

    await use(plugin);
    fs.rmSync(dataDir, { recursive: true, force: true });
  },
});

export { expect };
