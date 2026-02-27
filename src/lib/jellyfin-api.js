'use strict';

const CLIENT_NAME = 'IINA Jellyfin Plugin';
const DEVICE_NAME = 'IINA';
const CLIENT_VERSION = '0.6.0'; // x-release-please-version

function createJellyfinApi({ http, preferences, log }) {
  function getDeviceId() {
    let deviceId = preferences.get('jellyfin_device_id');
    if (!deviceId) {
      deviceId = `iina-jellyfin-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
      preferences.set('jellyfin_device_id', deviceId);
      preferences.sync();
    }
    return deviceId;
  }

  function buildAuthorizationHeader(apiKey) {
    const parts = [
      `Client="${CLIENT_NAME}"`,
      `Device="${DEVICE_NAME}"`,
      `DeviceId="${getDeviceId()}"`,
      `Version="${CLIENT_VERSION}"`,
    ];

    if (apiKey) {
      parts.push(`Token="${apiKey}"`);
    }

    return `MediaBrowser ${parts.join(', ')}`;
  }

  function buildJellyfinHeaders(apiKey, extraHeaders) {
    return {
      Authorization: buildAuthorizationHeader(apiKey),
      ...(extraHeaders || {}),
    };
  }

  function parseJellyfinUrl(url) {
    try {
      log(`Attempting to parse URL: "${url}"`);

      if (!url) {
        log('URL is null or undefined');
        return null;
      }

      const protocolMatch = url.match(/^(https?):\/\/([^/]+)/);
      if (!protocolMatch) {
        log('Invalid URL format - no protocol/host found');
        return null;
      }

      const protocol = protocolMatch[1];
      const host = protocolMatch[2];
      const serverBase = `${protocol}://${host}`;

      log(`Extracted serverBase: ${serverBase}`);

      const urlParts = url.split('?');
      const pathname = urlParts[0].replace(/^https?:\/\/[^/]+/, '');
      const queryString = urlParts[1] || '';

      log(`Extracted pathname: ${pathname}`);
      log(`Extracted queryString: ${queryString}`);

      const pathMatch = pathname.match(/\/Items\/([^/]+)/);
      log(`Path match result: ${pathMatch ? pathMatch[0] : 'no match'}`);

      if (!pathMatch) {
        log(`No /Items/ pattern found in pathname: ${pathname}`);
        return null;
      }

      const itemId = pathMatch[1];

      let apiKey = null;
      if (queryString) {
        const apiKeyMatch = queryString.match(/(?:^|&)api_key=([^&]+)/);
        if (apiKeyMatch) {
          apiKey = decodeURIComponent(apiKeyMatch[1]);
        }
      }

      log(
        `Extracted - itemId: ${itemId}, apiKey: ${apiKey ? 'present' : 'missing'}, serverBase: ${serverBase}`
      );

      if (!apiKey) {
        log('No API key found in URL parameters');
        return null;
      }

      return {
        serverBase,
        itemId,
        apiKey,
      };
    } catch (error) {
      log(`Error parsing Jellyfin URL: ${error.message}`);
      log(`Failed URL was: "${url}"`);
      return null;
    }
  }

  function isJellyfinUrl(url) {
    return (
      url &&
      ((url.includes('/Items/') && url.includes('api_key=')) ||
        url.includes('jellyfin') ||
        url.includes('/Audio/') ||
        url.includes('/Videos/'))
    );
  }

  async function fetchPlaybackInfo(serverBase, itemId, apiKey) {
    try {
      const playbackUrl = `${serverBase}/Items/${itemId}/PlaybackInfo?api_key=${apiKey}`;
      log(`Fetching playback info from: ${playbackUrl}`);

      const response = await http.get(playbackUrl, {
        headers: buildJellyfinHeaders(apiKey, {
          Accept: 'application/json',
        }),
      });

      log('Response received');

      if (!response.data) {
        throw new Error('No data received from Jellyfin API');
      }

      if (typeof response.data === 'object') {
        log('Response data is already parsed object');
        log(
          `MediaSources found: ${response.data.MediaSources ? response.data.MediaSources.length : 'none'}`
        );
        return response.data;
      }

      log('Response data is string, parsing manually');
      log(`Response.data preview: ${response.data.substring(0, 200)}`);
      return JSON.parse(response.data);
    } catch (error) {
      log(`Error fetching playback info: ${error.message}`);
      throw error;
    }
  }

  async function fetchItemMetadata(serverBase, itemId, apiKey) {
    try {
      const metadataUrl = `${serverBase}/Items/${itemId}?api_key=${apiKey}`;
      log(`Fetching item metadata from: ${metadataUrl}`);

      const response = await http.get(metadataUrl, {
        headers: buildJellyfinHeaders(apiKey, {
          Accept: 'application/json',
        }),
      });

      log('Metadata response received');

      if (!response.data) {
        throw new Error('No metadata received from Jellyfin API');
      }

      if (typeof response.data === 'object') {
        log('Metadata is already parsed object');
        log(`Item name: ${response.data.Name}`);
        log(`Item type: ${response.data.Type}`);
        return response.data;
      }

      log('Metadata is string, parsing manually');
      log(`Metadata preview: ${response.data.substring(0, 200)}`);
      return JSON.parse(response.data);
    } catch (error) {
      log(`Error fetching item metadata: ${error.message}`);
      throw error;
    }
  }

  function secondsToTicks(seconds) {
    return Math.round(seconds * 10000000);
  }

  function ticksToSeconds(ticks) {
    return ticks / 10000000;
  }

  return {
    buildJellyfinHeaders,
    parseJellyfinUrl,
    isJellyfinUrl,
    fetchPlaybackInfo,
    fetchItemMetadata,
    secondsToTicks,
    ticksToSeconds,
  };
}

module.exports = {
  createJellyfinApi,
};
