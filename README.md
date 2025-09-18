# IINA Jellyfin Plugin

An comprehensive IINA plugin that provides Jellyfin media server integration, including automatic subtitle downloading and a full media browser sidebar.

## Features

### Subtitle Management

- **Automatic subtitle detection**: Automatically detects when you're opening Jellyfin media URLs
- **Smart subtitle downloading**: Downloads subtitles based on your language preferences
- **Multiple subtitle support**: Can download all available subtitles or filter by preferred languages
- **External subtitle support**: Handles both embedded and external subtitle files
- **Manual download option**: Menu option to manually trigger subtitle download

### Jellyfin Browser Sidebar

- **Secure authentication**: Login with username/password
- **Recent items browser**: Browse recently added movies and TV shows
- **Search functionality**: Search your Jellyfin library for specific content
- **Series episode selection**: Browse seasons and episodes for TV shows
- **Direct playback**: Click to play media directly in IINA

### General Features

- **Video title enhancement**: Sets proper movie/show titles instead of generic filenames
- **Configurable preferences**: Customizable settings through IINA's preferences panel
- **On-screen notifications**: Optional OSD messages to keep you informed
- **Keyboard shortcuts**: Quick access to browser sidebar (Cmd+Shift+J)

## Installation

1. Open IINA
2. Go to Preferences → Plugins
3. Click "Install from GitHub..."
4. Paste `mhajder/iina-jellyfin` and click Install
5. The plugin will appear in IINA's Plugin preferences

## Getting Started

### Basic Subtitle Downloading

The plugin automatically detects and downloads subtitles when you open Jellyfin URLs directly:

1. Copy a Jellyfin media URL (containing `/Items/` and `api_key=`)
2. Use File → Open URL in IINA
3. Subtitles will be downloaded automatically based on your preferences

### Using the Jellyfin Browser

1. Open the browser sidebar: View menu → "Show Jellyfin Browser" or press `Cmd+Shift+J`
2. Enter your server URL (e.g., `http://192.168.1.100:8096`)
3. Log in with your Jellyfin username and password
4. Browse recent items or search for specific content
5. Click any item to play it directly in IINA

## Supported URL Formats

The plugin automatically detects Jellyfin URLs in these formats:

- Download URLs: `http://server:port/Items/{ItemId}/Download?api_key={key}`
- URLs containing `/Items/` and `api_key=`
- URLs containing "jellyfin", "/Audio/", or "/Videos/"

## Configuration

Access plugin settings through IINA → Preferences → Plugins → Jellyfin:

### Settings

- **Enable automatic subtitle download**: Toggle automatic downloading when opening Jellyfin URLs
- **Show on-screen notifications**: Display OSD messages when subtitles are downloaded
- **Preferred Languages**: Comma-separated language codes (e.g., `en,eng,pol,pl`)
- **Download all available subtitles**: Download all subtitle tracks, ignoring language preferences
- **Set video title from Jellyfin metadata**: Replace filenames with proper movie/show titles
- **Open media in new IINA window**: Play media from browser in separate windows

### Menu Options

The plugin adds these menu items to IINA:

- **Show Jellyfin Browser** (`Cmd+Shift+J`): Open the media browser sidebar
- **Download Jellyfin Subtitles**: Manually download subtitles for current media
- **Set Jellyfin Title**: Manually set video title from Jellyfin metadata

## Development

### Development Scripts

- `pnpm run check`: Run ESLint and Prettier checks
- `pnpm run lint`: Run ESLint
- `pnpm run lint:fix`: Auto-fix ESLint issues
- `pnpm run format`: Check Prettier formatting
- `pnpm run format:fix`: Auto-fix Prettier formatting
- `/Applications/IINA.app/Contents/MacOS/iina-plugin link .`: Link plugin to IINA for testing
- `/Applications/IINA.app/Contents/MacOS/iina-plugin unlink .`: Unlink plugin from IINA

## Contributing

Feel free to submit issues and pull requests to improve the plugin functionality.

## License

GNU Affero General Public License - see [LICENSE](LICENSE) file for details.
