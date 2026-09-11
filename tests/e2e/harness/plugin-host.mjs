import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '../../..');
const require = createRequire(import.meta.url);

/**
 * Runs the plugin's real main entry (src/index.js) inside the test process on
 * top of a Node implementation of IINA's `iina` API: files go to a temporary
 * data folder, `utils.exec` runs real processes (so downloads use real curl),
 * `http` uses fetch, and the sidebar webview is the Playwright page, bridged
 * through exposed functions. Player actions (open, OSD, subtitle tracks) are
 * recorded so tests can assert what IINA would have been told to do.
 */
export function createPluginHost({ page, dataDir, preferences = {} }) {
  const prefs = new Map(Object.entries(preferences));
  const events = {};
  const record = { osd: [], opened: [], subtitleTracks: [], mpvSet: [], mpvCommands: [] };
  const sidebarHandlers = {};
  let pageReady = false;
  const pendingToPage = [];

  function resolvePath(target) {
    const value = String(target);
    if (value.startsWith('@data/')) return path.join(dataDir, value.slice('@data/'.length));
    if (value === '@data') return dataDir;
    if (value.startsWith('@tmp/')) return path.join(dataDir, 'tmp', value.slice('@tmp/'.length));
    if (value.startsWith('~/')) return path.join(process.env.HOME || dataDir, value.slice(2));
    return value;
  }

  async function deliverToPage(name, data) {
    if (!pageReady) {
      pendingToPage.push([name, data]);
      return;
    }
    try {
      await page.evaluate(
        ([messageName, payload]) => window.__iinaDeliver(messageName, payload),
        [name, data]
      );
    } catch (error) {
      // The page may be navigating away; the next load asks for state again.
      record.osd.push(`[bridge] could not deliver ${name}: ${error.message}`);
    }
  }

  const sidebar = {
    loadFile() {},
    show() {},
    onMessage(name, callback) {
      sidebarHandlers[name] = callback;
    },
    postMessage(name, data) {
      deliverToPage(name, data);
    },
  };

  const iina = {
    core: {
      osd: (message) => record.osd.push(message),
      open: (url) => {
        record.opened.push(url);
        iina.core.status.url = url;
        // IINA reports the load back through this event once mpv has it.
        setTimeout(() => host.emit('iina.file-loaded', url), 20);
      },
      seekTo() {},
      status: { url: null, position: 0, duration: 0, paused: false },
      window: { loaded: true, visible: true },
      subtitle: { loadTrack: (trackPath) => record.subtitleTracks.push(trackPath) },
    },
    console: { log: (...parts) => process.env.E2E_DEBUG && console.log(...parts) },
    menu: {
      addItem() {},
      item: (label, callback, options) => ({ label, callback, options }),
    },
    event: {
      on(name, callback) {
        events[name] = events[name] || [];
        events[name].push(callback);
      },
    },
    http: {
      async get(url, options = {}) {
        const response = await fetch(url, { headers: options.headers || {} });
        const text = await response.text();
        let data = text;
        try {
          data = JSON.parse(text);
        } catch {
          // keep text
        }
        return { data, text, statusCode: response.status, reason: response.statusText };
      },
      async post(url, options = {}) {
        const response = await fetch(url, {
          method: 'POST',
          headers: options.headers || {},
          body: options.data ? JSON.stringify(options.data) : undefined,
        });
        const text = await response.text();
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = text;
        }
        return { data, text, statusCode: response.status, reason: response.statusText };
      },
      async download(url, destination, options = {}) {
        const response = await fetch(url, { headers: options.headers || {} });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        fs.writeFileSync(resolvePath(destination), Buffer.from(await response.arrayBuffer()));
      },
    },
    utils: {
      resolvePath,
      open: () => true,
      // The system folder picker: tests preload the answer
      chooseFile: () => {
        record.folderPickerOpened = (record.folderPickerOpened || 0) + 1;
        return host.nextChosenFolder;
      },
      fileInPath(name) {
        const dirs = (process.env.PATH || '').split(path.delimiter);
        return dirs.some((dir) => fs.existsSync(path.join(dir, name)));
      },
      exec(file, args, cwd, stdoutHook, stderrHook) {
        return new Promise((resolve) => {
          const child = execFile(
            file,
            args,
            { cwd: cwd || undefined, maxBuffer: 16 * 1024 * 1024 },
            (error, stdout, stderr) => {
              resolve({ status: error ? (error.code ?? 1) : 0, stdout, stderr });
            }
          );
          if (stdoutHook) child.stdout.on('data', (chunk) => stdoutHook(String(chunk)));
          if (stderrHook) child.stderr.on('data', (chunk) => stderrHook(String(chunk)));
        });
      },
    },
    file: {
      exists: (target) => fs.existsSync(resolvePath(target)),
      read: (target) => fs.readFileSync(resolvePath(target), 'utf8'),
      write: (target, content) => fs.writeFileSync(resolvePath(target), content),
      delete: (target) => fs.rmSync(resolvePath(target), { force: true }),
      showInFinder: (target) => record.osd.push(`[finder] ${resolvePath(target)}`),
      list: () => [],
    },
    preferences: {
      get: (key) => prefs.get(key),
      set: (key, value) => prefs.set(key, value),
      sync() {},
    },
    mpv: {
      set: (name, value) => record.mpvSet.push([name, value]),
      command: (name, args) => record.mpvCommands.push([name, args]),
      getNumber: () => 0,
    },
    sidebar,
    global: { onMessage() {}, postMessage() {} },
    standaloneWindow: {
      loadFile() {},
      onMessage() {},
      postMessage() {},
      open() {},
      close() {},
      setFrame() {},
      setProperty() {},
    },
  };

  const host = {
    iina,
    record,
    prefs,
    dataDir,
    nextChosenFolder: '',
    emit(name, ...args) {
      for (const callback of events[name] || []) callback(...args);
    },
    /**
     * Load the plugin entry fresh (module cache cleared) so each test starts
     * with a clean plugin state, then behave like IINA opening its window.
     */
    async boot() {
      for (const key of Object.keys(require.cache)) {
        if (key.startsWith(path.join(projectRoot, 'src'))) delete require.cache[key];
      }
      globalThis.iina = iina;
      require(path.join(projectRoot, 'src/index.js'));
      host.emit('iina.window-loaded');
    },
    /** Deliver a message coming from the sidebar webview to the plugin. */
    receiveFromPage(name, data) {
      const handler = sidebarHandlers[name];
      if (handler) handler(data);
    },
    markPageReady() {
      pageReady = true;
      const queued = pendingToPage.splice(0);
      for (const [name, data] of queued) deliverToPage(name, data);
    },
    markPageGone() {
      pageReady = false;
    },
    manifest() {
      const manifestPath = path.join(dataDir, 'offline/manifest.json');
      return fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : [];
    },
  };

  return host;
}

/**
 * Script injected into the sidebar page before its own scripts run: the same
 * two-method `iina` object IINA gives a webview, wired to the exposed
 * functions of the test process.
 */
export const PAGE_BRIDGE_SCRIPT = `
  (() => {
    const handlers = {};
    window.iina = {
      postMessage(name, data) {
        window.__iinaSend(name, data === undefined ? null : data);
      },
      onMessage(name, callback) {
        handlers[name] = callback;
      },
      preferences: { get: (key) => (key === 'debug_logging' ? false : undefined) },
    };
    window.__iinaDeliver = (name, data) => {
      if (handlers[name]) handlers[name](data);
    };
  })();
`;
