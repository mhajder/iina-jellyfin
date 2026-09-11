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

### Offline Downloads

- **Download for offline playback**: Save movies, episodes and songs to disk with one click (⬇ Offline)
- **Subtitles included**: Every external text subtitle of the item is downloaded next to the media file
- **Works without Internet**: The Downloads panel, playback and subtitles need no server connection
- **Progress, cancel, retry**: Live progress in the sidebar, cancel running downloads, retry failed ones
- **Configurable folder**: Keep downloads in the plugin data folder or any folder you choose (e.g. an external drive), picked with the system folder dialog
- **Quality presets**: Download the original file or let the server transcode to a smaller progressive MP4 (8 Mb/s down to 250 Kb/s) for laptops on the go

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

## Installation

1. Open IINA
2. Go to Preferences → Plugins
3. Click "Install from GitHub..."
4. Paste `mhajder/iina-jellyfin` and click Install
5. The plugin will appear in IINA's Plugin preferences

## Getting Started

### Automatic Subtitle Downloading

The plugin automatically detects and downloads subtitles when you open Jellyfin URLs:

1. Copy a Jellyfin media URL (e.g., from a Jellyfin download link containing `/Items/` and `api_key=`)
2. Open the URL in IINA using File → Open URL
3. Subtitles will be downloaded automatically based on your language preferences
4. Manually download subtitles anytime using: Menu → "Download Jellyfin Subtitles" (or `Cmd+Shift+D`)

### Using the Jellyfin Browser Sidebar

Open the browser sidebar using: View menu → "Show Jellyfin Browser" or press `Cmd+Shift+J`

#### First Time Setup

**Option 1: Automatic Login via URL (Recommended)**

1. Copy any Jellyfin media download URL containing an API key from your server (e.g., `http://server:8096/Items/{ItemId}/Download?api_key={key}`)
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

#### Offline Downloads

Movies, episodes and songs can be saved to disk and played later without any connection to the server:

1. Click **⬇ Offline** on a movie or song row, or select an episode and click **⬇ Offline** in the episode picker. Search results have the same button.
2. The plugin downloads the original file (no transcoding) together with all of its external text subtitles (SRT, VTT, ASS). Progress is shown on the button and in the Downloads panel; the **Downloads** button carries a badge while something is downloading.
3. When the download is complete the button turns into **▶ Offline**. Clicking it plays the local copy, even while you are online.
4. The **Downloads** button (always visible, connected or not) opens the Downloads panel. From there you can **Play**, **Reveal** the file in Finder, **Remove** a download (asks for confirmation), **Cancel** a running download or **Retry** a failed one. **Open Folder** shows the download folder itself.

When a downloaded file is played, its subtitles are loaded automatically and the window title is set from the stored metadata, so nothing is requested from the server. If the server is unreachable the sidebar still shows the Downloads panel, so your offline library is always accessible.

Downloads are stored in the plugin data folder by default (`Show Offline Downloads Folder` in the menu opens it). A different folder can be picked with `Choose Offline Downloads Folder…` in the menu, the **Change Folder…** button of the Downloads panel, or typed into the preferences; the list of downloads (`manifest.json`) lives next to the files, so a folder on an external drive carries its library with it. Access tokens are never written to that folder.

**Download quality.** The _Offline download quality_ picker in the sidebar (also in the preferences) decides what the next downloads fetch. _Original quality_ saves the file exactly as stored on the server. Any bitrate preset (8 Mb/s, 4 Mb/s, 2 Mb/s, 1 Mb/s, 500 Kb/s, 250 Kb/s) sends a device profile and the bitrate cap with the PlaybackInfo request, the same negotiation Jellyfin's own clients use: when the source is above the cap the server transcodes to a progressive MP4 (H.264/HEVC with AAC or AC3 audio, resolution chosen by the server) that streams to disk while it is encoded, otherwise the original file is downloaded because it is already small enough. Transcoded files lose their embedded text subtitles, so every text subtitle track is saved as a sidecar file; image subtitles are burned into the picture. The Downloads panel shows which quality an entry was made with.

Downloading uses `curl` (present on every Mac) so multi-gigabyte files stream straight to disk with progress reporting; if `curl` is unavailable the plugin falls back to IINA's built-in downloader without progress.

## Supported URL Formats

The plugin automatically detects and processes Jellyfin URLs in these formats:

- Download URLs: `http://server:port/Items/{ItemId}/Download?api_key={key}` _(automatically stores credentials for sidebar login)_
- URLs containing `/Items/` and `api_key=` _(automatically stores credentials for sidebar login)_
- URLs containing "jellyfin", "/Audio/", or "/Videos/"

**Note**: URLs with API keys will automatically store authentication data for the sidebar browser, eliminating the need for manual login on first use.

## Configuration

Access plugin settings through IINA → Preferences → Plugins → Jellyfin:

### Authentication Settings

- **Enable automatic login from Jellyfin URLs**: Automatically extract server URL and API key from Jellyfin URLs for seamless login. Server credentials are stored permanently in your plugin preferences until manually removed via the sidebar server management panel.

### Media Playback Settings

- **Enable automatic subtitle download**: Toggle automatic downloading when opening Jellyfin URLs
- **Synchronize playback progress**: Enable bi-directional progress sync with Jellyfin server
  - Automatically resumes from last watched position when opening a video
  - Reports current playback position to Jellyfin every 10 seconds
  - Automatically marks items as watched at 95% completion
  - Resume positions sync across all your devices
- **Report to my connected account (ignore link's API key)**: When enabled, playback progress, resume, and watched status are reported to the Jellyfin account you're logged into via the browser sidebar, instead of the account whose `api_key` is embedded in the playing URL. Useful when several people open the same shared link (e.g. via Syncplay) — each viewer's progress records into their own account. Requires a logged-in server; falls back to the URL's `api_key` if none is connected.
- **Show on-screen notifications**: Display OSD messages when subtitles are downloaded
- **Preferred Languages**: Comma-separated language codes (e.g., `en,eng,pol,pl`)
- **Download all available subtitles**: Download all subtitle tracks, ignoring language preferences
- **Set video title from Jellyfin metadata**: Replace filenames with proper movie/show titles
- **Open media in new IINA window**: Play media from browser in separate windows
- **Enable autoplay**: Automatically queue the next episode when the current episode finishes, supporting cross-season playback

### Offline Downloads

- **Download folder**: Where offline downloads and their subtitles are stored. Leave empty for the plugin's data folder, or enter a path such as `~/Movies/Jellyfin Offline`.

### Menu Options

The plugin adds these menu items to IINA:

- **Show Jellyfin Browser** (`Cmd+Shift+J`): Open the media browser sidebar
- **Download Jellyfin Subtitles**: Manually download subtitles for current media
- **Set Jellyfin Title**: Manually set video title from Jellyfin metadata
- **Show Offline Downloads Folder**: Reveal the folder with your offline downloads in Finder

## Development

### Development Scripts

- `pnpm run check`: Run ESLint, Prettier and the unit tests with coverage thresholds
- `pnpm run lint`: Run ESLint
- `pnpm run lint:fix`: Auto-fix ESLint issues
- `pnpm run format`: Check Prettier formatting
- `pnpm run format:fix`: Auto-fix Prettier formatting
- `pnpm test`: Run the unit tests (Vitest)
- `pnpm test:coverage`: Unit tests with coverage; the files listed in `vitest.config.mjs` must stay at 100%
- `pnpm test:mutation`: Mutation tests (Stryker) over the same files; fails below the configured score
- `pnpm test:e2e`: End-to-end tests (Playwright); run `pnpm test:e2e:install` once to get Chromium
- `/Applications/IINA.app/Contents/MacOS/iina-plugin link .`: Link plugin to IINA for testing
- `/Applications/IINA.app/Contents/MacOS/iina-plugin unlink .`: Unlink plugin from IINA

### Testing

Three layers of tests run in CI (`.github/workflows/tests.yml`):

- **Unit tests** (`tests/unit`, Vitest): the plugin's main entry runs against a fake `iina` object, and the sidebar scripts run in jsdom against the real `index.html`. Coverage of the files touched by the offline downloads feature is enforced at 100% for statements, branches, functions and lines.
- **Mutation tests** (`stryker.config.mjs`): Stryker mutates the same files and re-runs the unit tests; a mutant that survives points at behaviour no test checks. Mutants inside debug log calls are ignored by a small local plugin (`tests/mutation/ignore-debug-logging.mjs`) since log wording is not behaviour. The HTML report lands in `reports/mutation/`.
- **End-to-end tests** (`tests/e2e`, Playwright): the real sidebar page runs in Chromium and talks to the real plugin entry, which runs in the test process on a Node implementation of the IINA API (files on disk, real `curl`, `fetch`). A mock Jellyfin server serves the API and media. The scenarios download a movie and an episode, verify the bytes and subtitles on disk, play them with subtitles attached, cancel and retry downloads, and finally take the server offline and check that browsing, playing and removing downloads still work.

## Contributing

Feel free to submit issues and pull requests to improve the plugin functionality.

## License

GNU Affero General Public License - see [LICENSE](LICENSE) file for details.
