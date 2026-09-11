import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const sidebarDir = path.resolve(here, '../../../src/ui/sidebar');

/**
 * The sidebar's markup (without its script tags), for loading into jsdom.
 */
export function sidebarBodyHtml() {
  const html = fs.readFileSync(path.join(sidebarDir, 'index.html'), 'utf8');
  const body = html.slice(html.indexOf('<body>') + '<body>'.length, html.lastIndexOf('</body>'));
  return body.replace(/<script[^>]*><\/script>/g, '');
}

/**
 * Minimal `iina` bridge of a webview: postMessage/onMessage spies plus a way
 * for tests to deliver messages from the "plugin" side.
 */
export function createWebviewBridge({ debug = false } = {}) {
  const handlers = {};
  return {
    handlers,
    postMessage: vi.fn(),
    onMessage: vi.fn((name, callback) => {
      handlers[name] = callback;
    }),
    preferences: { get: vi.fn((key) => (key === 'debug_logging' ? debug : undefined)) },
    deliver(name, data) {
      if (!handlers[name]) {
        throw new Error(`No sidebar handler for "${name}"`);
      }
      return handlers[name](data);
    },
  };
}

/**
 * Load the sidebar scripts into the current jsdom document exactly as the
 * HTML page does, and return the constructed JellyfinSidebar instance.
 */
export async function bootSidebar({ bridge, scripts } = {}) {
  document.body.innerHTML = sidebarBodyHtml();
  window.scrollTo = vi.fn();
  delete window.jellyfinSidebar;
  if (bridge === null) {
    delete globalThis.iina;
  } else {
    globalThis.iina = bridge || createWebviewBridge();
  }

  vi.resetModules();
  // Literal import paths keep Vite's module graph aware of which sources these
  // tests exercise (Stryker relies on it to pick the related test files).
  const loaders = {
    'lib/debug-log.js': () => import('../../../src/ui/sidebar/lib/debug-log.js'),
    'lib/media-methods.js': () => import('../../../src/ui/sidebar/lib/media-methods.js'),
    'lib/auth-server-methods.js': () =>
      import('../../../src/ui/sidebar/lib/auth-server-methods.js'),
    'lib/offline-methods.js': () => import('../../../src/ui/sidebar/lib/offline-methods.js'),
    'sidebar.js': () => import('../../../src/ui/sidebar/sidebar.js'),
  };
  for (const file of scripts || Object.keys(loaders)) {
    await loaders[file]();
  }
  return window.jellyfinSidebar;
}

/**
 * A fetch replacement routed by URL substring. Each route value is the parsed
 * body (or a function of the url returning it); strings are sent verbatim.
 */
export function mockFetch(routes = [], { status = 200 } = {}) {
  const calls = [];
  const fetchMock = vi.fn(async (url, options) => {
    calls.push({ url, options });
    const match = routes.find(([fragment]) => url.includes(fragment));
    if (match && match[1] instanceof Error) {
      throw match[1];
    }
    const value = match ? (typeof match[1] === 'function' ? match[1](url) : match[1]) : null;
    const body = typeof value === 'string' ? value : JSON.stringify(value);
    return {
      status: match && match[2] ? match[2] : status,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => body,
    };
  });
  globalThis.fetch = fetchMock;
  fetchMock.calls = calls;
  return fetchMock;
}

export function connect(sidebar, overrides = {}) {
  sidebar.currentServer = {
    name: 'Home',
    url: 'http://jf.local:8096',
    userId: 'user-1',
    accessToken: 'tok',
    serverId: 'srv-1',
    ...overrides,
  };
  sidebar.currentUser = { Id: 'user-1', Name: 'me' };
  document.getElementById('mainContent').style.display = 'block';
  return sidebar;
}

export async function flushPromises(rounds = 5) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

export function click(element) {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}
