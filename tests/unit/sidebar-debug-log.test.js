// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(here, '../../src/ui/sidebar/lib/debug-log.js');

async function createLogger() {
  vi.resetModules();
  await import(/* @vite-ignore */ modulePath);
  return window.createSidebarDebugLogger();
}

describe('sidebar debug logger', () => {
  let log;

  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    delete globalThis.iina;
  });

  it('stays silent without the iina bridge or with debug logging off', async () => {
    const debugLog = await createLogger();
    debugLog('hidden');
    globalThis.iina = {};
    debugLog('still hidden');
    globalThis.iina = { preferences: { get: () => false } };
    debugLog('off');
    expect(log).not.toHaveBeenCalled();
  });

  it('logs joined and redacted parts when enabled', async () => {
    globalThis.iina = { preferences: { get: (key) => key === 'debug_logging' } };
    const debugLog = await createLogger();

    debugLog('GET http://x/Items?api_key=secret12345', 'Token="abcdefgh1234"');

    expect(log).toHaveBeenCalledWith(
      'DEBUG: GET http://x/Items?api_key=[redacted] | Token="[redacted]"'
    );
  });

  it('exposes the redaction helper', async () => {
    const debugLog = await createLogger();
    expect(debugLog.redactSecrets('x-emby-token=abcdefghijk&b=1')).toBe(
      'x-emby-token=[redacted]&b=1'
    );
    expect(debugLog.redactSecrets('accessToken: "shortpw"')).toBe('accessToken: "shortpw"');
  });

  describe('serializeDebugArg', () => {
    it('handles primitives', async () => {
      const { serializeDebugArg } = await createLogger();
      expect(serializeDebugArg(null)).toBe('null');
      expect(serializeDebugArg(undefined)).toBe('undefined');
      expect(serializeDebugArg('text')).toBe('text');
      expect(serializeDebugArg(42)).toBe('42');
      expect(serializeDebugArg(true)).toBe('true');
      expect(serializeDebugArg(BigInt(7))).toBe('7');
      expect(serializeDebugArg(Symbol('s'))).toBe('Symbol(s)');
      expect(serializeDebugArg(() => 1)).toBe('() => 1');
    });

    it('truncates long strings', async () => {
      const { serializeDebugArg } = await createLogger();
      const long = 'x'.repeat(700);
      expect(serializeDebugArg(long)).toBe(`${'x'.repeat(600)}…[truncated 100 chars]`);
      expect(serializeDebugArg('x'.repeat(600))).toHaveLength(600);
    });

    it('summarises errors and arrays', async () => {
      const { serializeDebugArg } = await createLogger();
      expect(serializeDebugArg(new TypeError('bad'))).toBe('TypeError: bad');
      expect(serializeDebugArg([1, 2, 3])).toBe('[Array(3)]');
    });

    it('previews objects by value type and caps the key count', async () => {
      const { serializeDebugArg } = await createLogger();
      const preview = JSON.parse(
        serializeDebugArg({
          n: null,
          u: undefined,
          num: 1,
          bool: false,
          str: 'y'.repeat(130),
          arr: [1],
          obj: { a: 1 },
          fn() {},
          extra1: 1,
          extra2: 2,
        })
      );
      expect(preview).toEqual({
        n: null,
        num: 1,
        bool: false,
        str: `${'y'.repeat(120)}…[truncated 10 chars]`,
        arr: '[Array(1)]',
        obj: '[Object]',
        fn: 'fn() {}',
        __extraKeys: 2,
      });
      expect(serializeDebugArg({ a: 1 })).toBe('{"a":1}');
    });
  });
});
