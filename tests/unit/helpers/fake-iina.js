import { vi } from 'vitest';

/**
 * Message hub used for sidebar, standalone window and global entry fakes:
 * onMessage stores the callback, and tests fire messages through `emit`.
 */
export function createMessageView(extra = {}) {
  const handlers = {};
  return {
    handlers,
    onMessage: vi.fn((name, callback) => {
      handlers[name] = callback;
    }),
    postMessage: vi.fn(),
    emit(name, data) {
      if (!handlers[name]) {
        throw new Error(`No handler registered for message "${name}"`);
      }
      return handlers[name](data);
    },
    ...extra,
  };
}

/**
 * A fake of the `iina` global exposed to the plugin's main entry. Everything is
 * a spy, preferences live in a Map and the file system in a Map of paths.
 */
export function createFakeIina({ preferences = {}, files = {} } = {}) {
  const prefs = new Map(Object.entries(preferences));
  const fileStore = new Map(Object.entries(files));
  const eventHandlers = {};
  const menuItems = [];

  const iina = {
    core: {
      osd: vi.fn(),
      open: vi.fn(),
      seekTo: vi.fn(),
      status: { url: null, position: 0, duration: 0, paused: false },
      window: { loaded: true, visible: true },
      subtitle: { loadTrack: vi.fn() },
    },
    console: { log: vi.fn() },
    menu: {
      addItem: vi.fn((item) => menuItems.push(item)),
      item: vi.fn((label, callback, options) => ({ label, callback, options })),
    },
    event: {
      on: vi.fn((name, callback) => {
        eventHandlers[name] = eventHandlers[name] || [];
        eventHandlers[name].push(callback);
      }),
    },
    http: {
      get: vi.fn(async () => ({ data: null, statusCode: 404 })),
      post: vi.fn(async () => ({ statusCode: 204 })),
      download: vi.fn(async () => undefined),
    },
    utils: {
      resolvePath: vi.fn((path) => String(path).replace(/^@data/, '/abs/data')),
      open: vi.fn(() => true),
      fileInPath: vi.fn(() => false),
      chooseFile: vi.fn(() => ''),
      exec: vi.fn(async (command, args) => {
        if (command === 'mkdir') {
          fileStore.set(String(args[1]).replace('/abs/data', '@data'), '<dir>');
        }
        return { status: 0, stdout: '', stderr: '' };
      }),
    },
    file: {
      exists: vi.fn((path) => fileStore.has(path)),
      read: vi.fn((path) => fileStore.get(path)),
      write: vi.fn((path, content) => fileStore.set(path, content)),
      delete: vi.fn((path) => fileStore.delete(path)),
      showInFinder: vi.fn(),
    },
    preferences: {
      get: vi.fn((key) => prefs.get(key)),
      set: vi.fn((key, value) => prefs.set(key, value)),
      sync: vi.fn(),
    },
    mpv: {
      set: vi.fn(),
      command: vi.fn(),
      getNumber: vi.fn(() => 0),
    },
    sidebar: createMessageView({ loadFile: vi.fn(), show: vi.fn() }),
    global: createMessageView(),
    standaloneWindow: createMessageView({
      loadFile: vi.fn(),
      open: vi.fn(),
      close: vi.fn(),
      setFrame: vi.fn(),
      setProperty: vi.fn(),
    }),
  };

  return {
    iina,
    prefs,
    files: fileStore,
    menuItems,
    eventHandlers,
    emit(name, ...args) {
      for (const handler of eventHandlers[name] || []) {
        handler(...args);
      }
    },
    menuItem(label) {
      const item = menuItems.find((entry) => entry.label === label);
      if (!item) {
        throw new Error(`No menu item "${label}"`);
      }
      return item;
    },
  };
}

export async function flushPromises(rounds = 5) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}
