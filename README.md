<div align="center">

# IINA Jellyfin Plugin

**Browse your Jellyfin library, play it, get subtitles and sync progress, all inside IINA on macOS**

[![Release](https://img.shields.io/github/v/release/mhajder/iina-jellyfin?logo=github)](https://github.com/mhajder/iina-jellyfin/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/mhajder/iina-jellyfin/total?logo=github)](https://github.com/mhajder/iina-jellyfin/releases)
[![License](https://img.shields.io/github/license/mhajder/iina-jellyfin)](https://github.com/mhajder/iina-jellyfin/blob/main/LICENSE)
[![Pre-commit Checks](https://github.com/mhajder/iina-jellyfin/actions/workflows/pre-commit.yml/badge.svg)](https://github.com/mhajder/iina-jellyfin/actions/workflows/pre-commit.yml)

[![IINA plugin](https://img.shields.io/badge/IINA-plugin-6E40C9?logo=apple&logoColor=white)](https://iina.io/)
[![Jellyfin](https://img.shields.io/badge/Jellyfin-client-00A4DC?logo=jellyfin&logoColor=white)](https://jellyfin.org/)
[![Stars](https://img.shields.io/github/stars/mhajder/iina-jellyfin?style=flat&logo=github)](https://github.com/mhajder/iina-jellyfin/stargazers)

[Installation](https://github.com/mhajder/iina-jellyfin#-installation) · [Getting started](https://github.com/mhajder/iina-jellyfin#-getting-started) · [Configuration](https://github.com/mhajder/iina-jellyfin#-configuration) · [Contributing](https://github.com/mhajder/iina-jellyfin#-contributing)

</div>

A comprehensive IINA plugin that provides Jellyfin media server integration, including automatic subtitle downloading and a full media browser sidebar.

## ✨ Features

### Subtitle Management

- **Automatic subtitle detection**: Automatically detects when you're opening Jellyfin media URLs
- **Smart subtitle downloading**: Downloads subtitles based on your language preferences
- **Multiple subtitle support**: Can download all available subtitles or filter by preferred languages
- **External subtitle support**: Handles both embedded and external subtitle files
- **Manual download option**: Menu option to manually trigger subtitle download

### Jellyfin Browser Sidebar

- **Multi-server support**: Save multiple Jellyfin servers and switch between them effortlessly
- **Multiple user support**: Store different user accounts on the same server as separate entries
- **Secure authentication**: Login with username/password or use Quick Connect (Jellyfin's QR-code alternative)
- **Persistent sessions**: Credentials stored permanently until manually removed
- **Server management**: Easily add/remove servers and view saved server connections in the sidebar
- **Recent items browser**: Browse recently added movies and TV shows
- **Music library browser**: Browse your music library by albums, artists, or songs with album artwork
- **Album track listing**: View and play individual tracks from any album
- **Search functionality**: Search your Jellyfin library for specific content
- **Advanced filtering & sorting**: Sort by name, date added, release date, or rating; filter by watch status, favorites, and genre
- **Series episode selection**: Browse seasons and episodes for TV shows
- **Episode availability detection**: Unavailable episodes are visually marked and cannot be clicked
- **Direct playback**: Click to play media directly in IINA

### General Features

- **Video title enhancement**: Sets proper movie/show titles instead of generic filenames
- **Playback progress sync**: Bi-directional synchronization of playback progress with Jellyfin server
  - Automatic resume from last watched position (synced from Jellyfin)
  - Periodic progress reporting to Jellyfin (every 10 seconds)
  - Automatic "watched" status marking at 95% completion
  - Accurate resume positions across devices
- **Configurable preferences**: Customizable settings through IINA's preferences panel
- **On-screen notifications**: Optional OSD messages to keep you informed
- **Keyboard shortcuts**: Quick access to browser sidebar (Cmd+Shift+J)
- **Autoplay support**: Automatically queues the next episode in a series when available, with cross-season support
- **Version switching**: For items with several versions in Jellyfin (e.g. 4K and 1080p files), switch between them during playback from the plugin menu, keeping your position

## 📦 Installation

1. Open IINA
2. Go to Preferences → Plugins
3. Click "Install from GitHub..."
4. Paste `mhajder/iina-jellyfin` and click Install
5. The plugin will appear in IINA's Plugin preferences

## 🎬 Getting Started

### Automatic Subtitle Downloading

The plugin automatically detects and downloads subtitles when you open Jellyfin URLs:

1. Copy a Jellyfin media URL (e.g., from a Jellyfin download link containing `/Items/` and `ApiKey=`)
2. Open the URL in IINA using File → Open URL
3. Subtitles will be downloaded automatically based on your language preferences
4. Manually download subtitles anytime using: Plugin → "Download Jellyfin Subtitles"

### Using the Jellyfin Browser Sidebar

Open the browser sidebar using: View menu → "Show Jellyfin Browser" or press `Cmd+Shift+J`

#### First Time Setup

**Option 1: Automatic Login via URL (Recommended)**

1. Copy any Jellyfin media download URL containing an API key from your server (e.g., `http://server:8096/Items/{ItemId}/Download?ApiKey={key}`)
2. Open the URL in IINA using File → Open URL
3. The plugin automatically extracts and stores your server credentials
4. When you open the sidebar, it will auto-connect to your server

**Option 2: Manual Login**

1. Open the sidebar: `Cmd+Shift+J`
2. Click "Add Server" to show the login screen
3. Choose your login method:

   **Password Login:**
   - Enter your Jellyfin server URL (e.g., `http://192.168.1.100:8096`)
   - Enter your username and password
   - Click "Login"

   **Quick Connect (No Password Needed):**
   - Enter your server URL
   - Click "Start Quick Connect"
   - Go to your Jellyfin server (User Settings → Quick Connect)
   - Enter the displayed code
   - Click "Connect" in IINA when approval is granted

4. Your server will be saved for future use

#### Multi-Server Management

Once you have servers saved:

- **View saved servers**: The sidebar shows all saved server connections with their usernames
- **Switch servers**: Click any saved server to switch to it
- **Disconnect**: Click the "Disconnect" button to disconnect without removing the server
- **Remove server**: Click the "✕" button next to a server to permanently remove it from your saved list

#### Browsing and Playback

1. Browse media in the tabs: Home (Continue Watching, Up Next, Recently Added), Movies, TV Series, Music, or Search
2. Click any media item to play it in IINA
3. Use the player controls or keyboard shortcuts to control playback
4. Your progress will automatically sync back to Jellyfin

##### Music Library

The Music tab provides three views for browsing your music collection:

**View Modes:**

- **Albums**: Browse music albums with cover artwork, artist names, and track counts
- **Artists**: Browse by artist and drill down into their albums
- **Songs**: Browse individual tracks directly

Click an album to view its track listing. From there you can play individual tracks or use "Play All" to start the album. Use the Filter/Sort button to sort by name, date, or rating, and filter by genre.

Search also supports music content — use the "Albums" and "Songs" filter chips to find music across your library.

##### Advanced Filtering & Sorting

The Movies and TV Series tabs include powerful filtering and sorting tools to help you navigate large libraries:

**Sort Options:**

- **A-Z**: Sort alphabetically by title
- **Z-A**: Reverse alphabetical order
- **Date Added (Newest)**: Show recently added items first
- **Date Added (Oldest)**: Show oldest added items first
- **Release Date (Newest)**: Sort by year of release (newest first)
- **Rating (Highest)**: Sort by community rating (highest first)

**Filter Options:**

- **All**: Show all items
- **Unwatched**: Show only items you haven't watched yet
- **Favorites**: Show only items marked as favorites

**Genre Filter:**

- Dynamically populated list of genres from your library
- Select a specific genre to view only items in that category

Click the "Filter/Sort" button in the Movies or TV Series tab header to toggle the filter panel and customize your view.

## 🔗 Supported URL Formats

The plugin automatically detects and processes Jellyfin URLs in these formats:

- Download URLs: `http://server:port/Items/{ItemId}/Download?ApiKey={key}` _(automatically stores credentials for sidebar login)_
- URLs containing `/Items/` and `ApiKey=` _(automatically stores credentials for sidebar login)_
- URLs containing "jellyfin", "/Audio/", or "/Videos/"

**Note**: URLs with API keys will automatically store authentication data for the sidebar browser, eliminating the need for manual login on first use.

## 🔧 Configuration

Access plugin settings through IINA → Settings → Plugins → Jellyfin. They are grouped the same way there:

### Playback

- **Open media in a new IINA window**: Play what you pick in the Jellyfin browser in a separate window, so you can keep browsing.
- **Show the Jellyfin title**: Show the movie or episode title from Jellyfin instead of the file name from the stream URL
- **Autoplay the next episode**: Queue the next episode while one plays, continuing into the next season

### Languages & Subtitles

- **Preferred languages**: Comma-separated language codes, most preferred first (e.g. `pol,eng`). 2- and 3-letter codes both work. Used for subtitle downloads and track selection.
- **Pick audio and subtitles in my languages**: When playback starts, switch to the audio in your most preferred language (never a commentary or audio description). Unless **Always show subtitles** is on, full subtitles are turned on only when the audio is not in a language you rank higher, otherwise just a signs/songs track in the audio's language, and downloaded subtitles are ranked the same way. Preferred audio/subtitle languages set in IINA's own settings take precedence. Jellyfin direct-play hands mpv the original file, so without this mpv keeps the container's default tracks — usually the original language.
  - **Always show subtitles**: Also turn on full subtitles in the audio's own language; subtitles in a language you rank below the audio's stay off. Has no effect when a preferred subtitle language is set in IINA's own settings.
- **Download subtitles automatically**: Download the item's external subtitle files in your preferred languages when Jellyfin media opens
- **Download subtitles in every language**: Ignore the preferred languages when downloading external subtitles

### Progress & Account

- **Sync playback progress with Jellyfin**:
  - Resumes from the last watched position when opening a video
  - Reports the current position to Jellyfin every 10 seconds
  - Marks items as watched at 95% completion
- **Report to my signed-in account, not the link's**: Record progress, resume and watched status in the Jellyfin account you signed into in the browser, instead of the account whose `api_key` is in the playing URL. Useful when several people open the same shared link (e.g. via Syncplay) — each viewer's progress records into their own account. Falls back to the URL's `api_key` when you are not signed in to that server.
- **Sign in from Jellyfin links**: When you open a Jellyfin link that contains an API key, save that server so the browser signs in automatically. Saved servers stay until you remove them in the browser.

### Notifications & Troubleshooting

- **Show subtitle notifications**: Show an on-screen message when subtitles are downloaded, when none match, or when the download fails
- **Debug logging**: Write detailed logs to IINA's log for troubleshooting and bug reports; API keys and tokens are removed

### Menu Options

The plugin adds these menu items to IINA:

- **Show Jellyfin Browser** (`Cmd+Shift+J`): Open the media browser sidebar
- **Download Jellyfin Subtitles**: Manually download subtitles for current media
- **Set Jellyfin Title**: Manually set video title from Jellyfin metadata
- **Jellyfin Version**: Shown when the playing item has more than one version; lists each one (name, video format and bitrate) and reopens the item in the chosen version at the current position

## 🔨 Development

```sh
pnpm install
prek install
/Applications/IINA.app/Contents/MacOS/iina-plugin link .
```

| Command                | What it does                   |
| ---------------------- | ------------------------------ |
| `pnpm test`            | Run the tests in `tests/`      |
| `pnpm run check`       | Run ESLint and Prettier checks |
| `pnpm run lint:fix`    | Auto-fix ESLint issues         |
| `pnpm run format:fix`  | Auto-fix Prettier formatting   |
| `iina-plugin unlink .` | Unlink the plugin from IINA    |

## 🤝 Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](https://github.com/mhajder/iina-jellyfin/blob/main/CONTRIBUTING.md) for the dev setup, checks and commit message format.

Found a security problem? Please report it privately as described in [SECURITY.md](https://github.com/mhajder/iina-jellyfin/blob/main/SECURITY.md).

## 📜 License

GNU General Public License v3.0 only - see [LICENSE](https://github.com/mhajder/iina-jellyfin/blob/main/LICENSE) for details.
