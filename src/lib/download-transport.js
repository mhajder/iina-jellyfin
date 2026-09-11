'use strict';

// curl's --progress-bar writes lines like "######    12.3%" to stderr.
const PROGRESS_PATTERN = /(\d{1,3}(?:\.\d+)?)%/g;
const STDERR_TAIL_LENGTH = 300;

/**
 * Last percentage in a chunk of curl progress output, or null when the chunk
 * carries none.
 */
function parseCurlProgress(chunk) {
  const text = String(chunk ?? '');
  let last = null;
  let match;
  PROGRESS_PATTERN.lastIndex = 0;
  while ((match = PROGRESS_PATTERN.exec(text)) !== null) {
    const value = Number(match[1]);
    if (value <= 100) {
      last = value;
    }
  }
  return last;
}

function headerArguments(headers) {
  return Object.entries(headers || {}).flatMap(([name, value]) => ['-H', `${name}: ${value}`]);
}

/**
 * Downloads files to disk. curl is preferred because it streams straight to
 * the destination and reports progress; IINA's http.download buffers the whole
 * response in memory, which is not workable for multi-gigabyte remuxes. It is
 * kept as a fallback for systems without curl in PATH.
 */
function createDownloadTransport({ utils, http, log }) {
  let curlAvailable = null;

  function hasCurl() {
    if (curlAvailable === null) {
      try {
        curlAvailable = Boolean(utils.fileInPath('curl'));
      } catch (error) {
        log(`Could not probe for curl: ${error.message}`);
        curlAvailable = false;
      }
      log(`curl available for downloads: ${curlAvailable}`);
    }
    return curlAvailable;
  }

  async function downloadWithCurl(url, destination, headers, onProgress) {
    const resolvedDestination = utils.resolvePath(destination);
    const args = [
      '--location',
      '--fail',
      '--show-error',
      '--progress-bar',
      '--output',
      resolvedDestination,
      ...headerArguments(headers),
      url,
    ];

    let stderr = '';
    const result = await utils.exec('curl', args, null, null, (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-STDERR_TAIL_LENGTH);
      const percent = parseCurlProgress(chunk);
      if (percent !== null && typeof onProgress === 'function') {
        onProgress(percent);
      }
    });

    if (!result || result.status !== 0) {
      const status = result ? result.status : 'unknown';
      const detail = stderr.trim() || (result && result.stderr ? String(result.stderr).trim() : '');
      throw new Error(`curl exited with status ${status}${detail ? `: ${detail}` : ''}`);
    }
  }

  async function downloadWithHttp(url, destination, headers) {
    log('Downloading with http.download (no progress reporting available)');
    await http.download(url, destination, { headers: headers || {} });
  }

  /**
   * Download url to destination (IINA path notation such as @data/...).
   * Resolves when the file is complete, rejects on any failure.
   */
  async function download(url, destination, options) {
    const { headers, onProgress } = options || {};
    if (hasCurl()) {
      await downloadWithCurl(url, destination, headers, onProgress);
      return;
    }
    await downloadWithHttp(url, destination, headers);
  }

  /**
   * Best-effort abort of an in-flight curl download. utils.exec exposes no
   * handle to the child process, so the process writing to the destination is
   * looked up by its command line instead. Returns whether a kill was issued.
   */
  async function cancel(destination) {
    if (!hasCurl()) {
      log('Cannot cancel an http.download in flight');
      return false;
    }
    try {
      const resolvedDestination = utils.resolvePath(destination);
      const escapedDestination = resolvedDestination.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const result = await utils.exec('pkill', ['-f', `curl .*--output ${escapedDestination} `]);
      log(`pkill for ${resolvedDestination} exited with ${result ? result.status : 'unknown'}`);
      return Boolean(result) && result.status === 0;
    } catch (error) {
      log(`Could not cancel download: ${error.message}`);
      return false;
    }
  }

  return { download, cancel, hasCurl };
}

module.exports = {
  createDownloadTransport,
  parseCurlProgress,
};
