import { describe, expect, it, vi } from 'vitest';
import { createDownloadTransport, parseCurlProgress } from '../../src/lib/download-transport.js';

describe('parseCurlProgress', () => {
  it('returns null when the chunk has no percentage', () => {
    expect(parseCurlProgress('###')).toBeNull();
    expect(parseCurlProgress('')).toBeNull();
    expect(parseCurlProgress(null)).toBeNull();
    expect(parseCurlProgress(undefined)).toBeNull();
  });

  it('returns the last percentage of a chunk', () => {
    expect(parseCurlProgress('#####  12.3%\r######  45.0%')).toBe(45);
    expect(parseCurlProgress('100.0%')).toBe(100);
    expect(parseCurlProgress('0.0%')).toBe(0);
  });

  it('ignores values above 100', () => {
    expect(parseCurlProgress('150%')).toBeNull();
    expect(parseCurlProgress('12% 150%')).toBe(12);
  });

  it('is not affected by previous calls', () => {
    expect(parseCurlProgress('50%')).toBe(50);
    expect(parseCurlProgress('75%')).toBe(75);
  });
});

function createUtils({ curl = true, execResult = { status: 0, stdout: '', stderr: '' } } = {}) {
  return {
    fileInPath: vi.fn(() => curl),
    resolvePath: vi.fn((path) => path.replace('@data', '/abs/data')),
    exec: vi.fn(async () => execResult),
  };
}

describe('createDownloadTransport', () => {
  it('probes curl once and logs the result', () => {
    const utils = createUtils();
    const log = vi.fn();
    const transport = createDownloadTransport({ utils, http: {}, log });

    expect(transport.hasCurl()).toBe(true);
    expect(transport.hasCurl()).toBe(true);
    expect(utils.fileInPath).toHaveBeenCalledTimes(1);
    expect(utils.fileInPath).toHaveBeenCalledWith('curl');
    expect(log).toHaveBeenCalledWith('curl available for downloads: true');
  });

  it('treats a failing probe as no curl', () => {
    const utils = createUtils();
    utils.fileInPath.mockImplementation(() => {
      throw new Error('boom');
    });
    const log = vi.fn();
    const transport = createDownloadTransport({ utils, http: {}, log });

    expect(transport.hasCurl()).toBe(false);
    expect(log).toHaveBeenCalledWith('Could not probe for curl: boom');
  });

  describe('download with curl', () => {
    it('runs curl with the resolved destination, headers and url', async () => {
      const utils = createUtils();
      const transport = createDownloadTransport({ utils, http: {}, log: vi.fn() });

      await transport.download('http://srv/Videos/1/stream', '@data/offline/1.mkv', {
        headers: { Authorization: 'MediaBrowser Token="abc"', Accept: '*/*' },
      });

      expect(utils.exec).toHaveBeenCalledTimes(1);
      const [command, args, cwd, stdoutHook, stderrHook] = utils.exec.mock.calls[0];
      expect(command).toBe('curl');
      expect(args).toEqual([
        '--location',
        '--fail',
        '--show-error',
        '--progress-bar',
        '--output',
        '/abs/data/offline/1.mkv',
        '-H',
        'Authorization: MediaBrowser Token="abc"',
        '-H',
        'Accept: */*',
        'http://srv/Videos/1/stream',
      ]);
      expect(cwd).toBeNull();
      expect(stdoutHook).toBeNull();
      expect(typeof stderrHook).toBe('function');
    });

    it('works without options or headers', async () => {
      const utils = createUtils();
      const transport = createDownloadTransport({ utils, http: {}, log: vi.fn() });

      await transport.download('http://srv/file', '@data/x');

      const args = utils.exec.mock.calls[0][1];
      expect(args).toEqual([
        '--location',
        '--fail',
        '--show-error',
        '--progress-bar',
        '--output',
        '/abs/data/x',
        'http://srv/file',
      ]);
    });

    it('reports progress parsed from stderr chunks', async () => {
      const utils = createUtils();
      utils.exec.mockImplementation(async (command, args, cwd, stdoutHook, stderrHook) => {
        stderrHook('#####   10.5%');
        stderrHook('no progress here');
        stderrHook('##########  55.0%\r############ 60.2%');
        return { status: 0, stdout: '', stderr: '' };
      });
      const transport = createDownloadTransport({ utils, http: {}, log: vi.fn() });
      const onProgress = vi.fn();

      await transport.download('http://srv/file', '@data/x', { onProgress });

      expect(onProgress.mock.calls.map((call) => call[0])).toEqual([10.5, 60.2]);
    });

    it('ignores progress when no callback is given', async () => {
      const utils = createUtils();
      utils.exec.mockImplementation(async (command, args, cwd, stdoutHook, stderrHook) => {
        stderrHook('50%');
        return { status: 0 };
      });
      const transport = createDownloadTransport({ utils, http: {}, log: vi.fn() });

      await expect(transport.download('http://srv/file', '@data/x', {})).resolves.toBeUndefined();
    });

    it('fails with the stderr tail when curl exits non-zero', async () => {
      const utils = createUtils();
      utils.exec.mockImplementation(async (command, args, cwd, stdoutHook, stderrHook) => {
        stderrHook('curl: (22) The requested URL returned error: 401');
        return { status: 22, stdout: '', stderr: '' };
      });
      const transport = createDownloadTransport({ utils, http: {}, log: vi.fn() });

      await expect(transport.download('http://srv/file', '@data/x')).rejects.toThrow(
        'curl exited with status 22: curl: (22) The requested URL returned error: 401'
      );
    });

    it('keeps only the tail of long stderr output', async () => {
      const utils = createUtils();
      utils.exec.mockImplementation(async (command, args, cwd, stdoutHook, stderrHook) => {
        stderrHook('a'.repeat(500));
        stderrHook('b'.repeat(100));
        return { status: 1 };
      });
      const transport = createDownloadTransport({ utils, http: {}, log: vi.fn() });

      let error;
      try {
        await transport.download('http://srv/file', '@data/x');
      } catch (caught) {
        error = caught;
      }
      expect(error.message).toBe(`curl exited with status 1: ${'a'.repeat(200)}${'b'.repeat(100)}`);
    });

    it('falls back to the returned stderr when no chunks arrived', async () => {
      const utils = createUtils({ execResult: { status: 7, stdout: '', stderr: ' refused ' } });
      const transport = createDownloadTransport({ utils, http: {}, log: vi.fn() });

      await expect(transport.download('http://srv/file', '@data/x')).rejects.toThrow(
        'curl exited with status 7: refused'
      );
    });

    it('omits the detail when there is none', async () => {
      const utils = createUtils({ execResult: { status: 3 } });
      const transport = createDownloadTransport({ utils, http: {}, log: vi.fn() });

      await expect(transport.download('http://srv/file', '@data/x')).rejects.toThrow(
        /^curl exited with status 3$/
      );
    });

    it('treats a missing exec result as a failure', async () => {
      const utils = createUtils({ execResult: null });
      const transport = createDownloadTransport({ utils, http: {}, log: vi.fn() });

      await expect(transport.download('http://srv/file', '@data/x')).rejects.toThrow(
        /^curl exited with status unknown$/
      );
    });
  });

  describe('download without curl', () => {
    it('uses http.download with the headers', async () => {
      const utils = createUtils({ curl: false });
      const http = { download: vi.fn(async () => undefined) };
      const log = vi.fn();
      const transport = createDownloadTransport({ utils, http, log });

      await transport.download('http://srv/file', '@data/x', { headers: { A: 'b' } });

      expect(utils.exec).not.toHaveBeenCalled();
      expect(http.download).toHaveBeenCalledWith('http://srv/file', '@data/x', {
        headers: { A: 'b' },
      });
      expect(log).toHaveBeenCalledWith(
        'Downloading with http.download (no progress reporting available)'
      );
    });

    it('sends empty headers when none are given', async () => {
      const utils = createUtils({ curl: false });
      const http = { download: vi.fn(async () => undefined) };
      const transport = createDownloadTransport({ utils, http, log: vi.fn() });

      await transport.download('http://srv/file', '@data/x');

      expect(http.download).toHaveBeenCalledWith('http://srv/file', '@data/x', { headers: {} });
    });

    it('propagates http.download failures', async () => {
      const utils = createUtils({ curl: false });
      const http = { download: vi.fn(async () => Promise.reject(new Error('offline'))) };
      const transport = createDownloadTransport({ utils, http, log: vi.fn() });

      await expect(transport.download('http://srv/file', '@data/x')).rejects.toThrow('offline');
    });
  });

  describe('cancel', () => {
    it('cannot cancel http.download transfers', async () => {
      const utils = createUtils({ curl: false });
      const log = vi.fn();
      const transport = createDownloadTransport({ utils, http: {}, log });

      await expect(transport.cancel('@data/x')).resolves.toBe(false);
      expect(utils.exec).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith('Cannot cancel an http.download in flight');
    });

    it('kills the curl process writing to the destination', async () => {
      const utils = createUtils();
      const log = vi.fn();
      const transport = createDownloadTransport({ utils, http: {}, log });

      await expect(transport.cancel('@data/offline/a.b (1).mkv')).resolves.toBe(true);

      expect(utils.exec).toHaveBeenCalledWith('pkill', [
        '-f',
        'curl .*--output /abs/data/offline/a\\.b \\(1\\)\\.mkv ',
      ]);
      expect(log).toHaveBeenCalledWith('pkill for /abs/data/offline/a.b (1).mkv exited with 0');
    });

    it('returns false when pkill finds nothing', async () => {
      const utils = createUtils({ execResult: { status: 1 } });
      const transport = createDownloadTransport({ utils, http: {}, log: vi.fn() });

      await expect(transport.cancel('@data/x')).resolves.toBe(false);
    });

    it('returns false when exec yields no result', async () => {
      const utils = createUtils({ execResult: null });
      const log = vi.fn();
      const transport = createDownloadTransport({ utils, http: {}, log });

      await expect(transport.cancel('@data/x')).resolves.toBe(false);
      expect(log).toHaveBeenCalledWith('pkill for /abs/data/x exited with unknown');
    });

    it('returns false when exec throws', async () => {
      const utils = createUtils();
      utils.exec.mockRejectedValue(new Error('no pkill'));
      const log = vi.fn();
      const transport = createDownloadTransport({ utils, http: {}, log });

      await expect(transport.cancel('@data/x')).resolves.toBe(false);
      expect(log).toHaveBeenCalledWith('Could not cancel download: no pkill');
    });
  });
});
