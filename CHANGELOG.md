# Changelog

## [0.7.2](https://github.com/mhajder/iina-jellyfin/compare/v0.7.1...v0.7.2) (2026-08-14)


### 🐛 Bug Fixes

* actually hide the media area when disconnecting ([e0d4dbc](https://github.com/mhajder/iina-jellyfin/commit/e0d4dbc5c1396fb0d099298bd2c6d6d73e323e2e))
* authenticate the sidebar with the plugin's own Jellyfin device id ([#84](https://github.com/mhajder/iina-jellyfin/issues/84)) ([09d6299](https://github.com/mhajder/iina-jellyfin/commit/09d6299bf1c3957a265e1325352d282eac47e121))
* bind the browser shortcut to Cmd+Shift+J, not Shift+J ([8fad4c4](https://github.com/mhajder/iina-jellyfin/commit/8fad4c4f023550c37d99dcb5ad04c262194f98c2))
* continue autoplay across gaps in episode numbering ([a144e88](https://github.com/mhajder/iina-jellyfin/commit/a144e886d48755b549b54d5d0fa44794a167ff6f))
* discard a playback session whose start request went stale ([#86](https://github.com/mhajder/iina-jellyfin/issues/86)) ([cc6e8f1](https://github.com/mhajder/iina-jellyfin/commit/cc6e8f19781d3a792bcc97f025774460d94142a8))
* do not add a second entry for an already signed-in server ([a2ff1ec](https://github.com/mhajder/iina-jellyfin/commit/a2ff1ecc40da27cae6282a8707c8e033978da22d))
* do not apply a stale resume position to a newly loaded file ([#83](https://github.com/mhajder/iina-jellyfin/issues/83)) ([094a406](https://github.com/mhajder/iina-jellyfin/commit/094a4062f598fb5e9309b65f1961a9ebc26c6e34))
* do not require Path on subtitles or /Items/ in queued URLs ([3996e5a](https://github.com/mhajder/iina-jellyfin/commit/3996e5ae08dd2fc70c8aa4a4a54653571de902b7))
* download only external subtitles, over a route that exists ([25f4641](https://github.com/mhajder/iina-jellyfin/commit/25f464195aae4a17a35272f30ac559fa1808f5ac))
* drop stale sidebar responses instead of rendering them ([#88](https://github.com/mhajder/iina-jellyfin/issues/88)) ([33b3b55](https://github.com/mhajder/iina-jellyfin/commit/33b3b55a08cdf7870aa577e7a5982dacbb8e0dcb))
* drop stored credentials when disconnecting from a server ([#85](https://github.com/mhajder/iina-jellyfin/issues/85)) ([9e29716](https://github.com/mhajder/iina-jellyfin/commit/9e29716d1697ddd022b4e8ce593cc0dc6396b0db))
* drop subscriptions to mpv events that never fire ([881b8c0](https://github.com/mhajder/iina-jellyfin/commit/881b8c04e74c810f500c99471f4d7d466da855ee))
* escape server-provided values before injecting into sidebar HTML ([#79](https://github.com/mhajder/iina-jellyfin/issues/79)) ([1d787eb](https://github.com/mhajder/iina-jellyfin/commit/1d787ebbc4530cebf1f030ad68ccabba71f2fb71))
* expire the playback replacement guard ([2926111](https://github.com/mhajder/iina-jellyfin/commit/29261110d48c10c7fb22ba570903c9581b255342))
* guard Quick Connect, ignore local paths, notify both browser views ([8d40fcf](https://github.com/mhajder/iina-jellyfin/commit/8d40fcfb4a43926ff5752c6223f65a289cbb0039))
* guard the selected-item lookup in the sidebar ([9786a32](https://github.com/mhajder/iina-jellyfin/commit/9786a323648e33accc7edf119809df52009269f8))
* honour reverse proxy subpaths and other spellings of the token ([360a96d](https://github.com/mhajder/iina-jellyfin/commit/360a96d34acebef89a93b317904aaba76e257260))
* honour the auto_login_enabled preference ([#87](https://github.com/mhajder/iina-jellyfin/issues/87)) ([d80dad7](https://github.com/mhajder/iina-jellyfin/commit/d80dad7bf8679aaf958263a65bcd6b7d65937fa9))
* judge episode availability without filesystem paths ([22e04c1](https://github.com/mhajder/iina-jellyfin/commit/22e04c1d7c7428b4ed6729ff5de3ba0dfdd14419))
* keep sessions captured from played Jellyfin URLs ([929c572](https://github.com/mhajder/iina-jellyfin/commit/929c5725d9c401d91c8f67a286686086a784c9b4))
* keep the rest of an album in the playlist ([95f8064](https://github.com/mhajder/iina-jellyfin/commit/95f80646d07b3ebf28aae521296a5dff1ed91484))
* keep URL credentials when the connected account is on another server ([51293b9](https://github.com/mhajder/iina-jellyfin/commit/51293b98682e30d58fa591b7cf80a51603448283))
* label specials as season 0 ([d8d65d3](https://github.com/mhajder/iina-jellyfin/commit/d8d65d3723cd3dfd6fb87c7e0c77088470a68996))
* mark an item watched when the tick detects the end of playback ([fa60476](https://github.com/mhajder/iina-jellyfin/commit/fa60476a212cc6b9f99cc7b94774a25fedbba9a1))
* open the browser again after a player window has been closed ([5d406f4](https://github.com/mhajder/iina-jellyfin/commit/5d406f4d4a733407578edd8b1a299ec30c3c6bdb))
* pass the shapes standaloneWindow.setFrame and setProperty expect ([ea6b639](https://github.com/mhajder/iina-jellyfin/commit/ea6b639251044f488f3507f706995f21d935280b))
* queue the whole album when playing all tracks ([#89](https://github.com/mhajder/iina-jellyfin/issues/89)) ([a1fa55e](https://github.com/mhajder/iina-jellyfin/commit/a1fa55eb906fa99b04408b08093fe8dc90bd24c0))
* reach standalone browser fallback when sidebar API is missing ([#82](https://github.com/mhajder/iina-jellyfin/issues/82)) ([28d01bc](https://github.com/mhajder/iina-jellyfin/commit/28d01bce8fe96d54fc6efe48901db66f20b1f34f))
* really clear the playlist before opening new media ([688625b](https://github.com/mhajder/iina-jellyfin/commit/688625b36295eb3366284a11aa2f0db25b96cbd0))
* redact credentials from debug logs ([c3e5c5c](https://github.com/mhajder/iina-jellyfin/commit/c3e5c5cf822f370370cf3c4b0c3e7ee5dc40e601))
* register global entry reply handlers once instead of patching onMessage ([#81](https://github.com/mhajder/iina-jellyfin/issues/81)) ([79ae1ab](https://github.com/mhajder/iina-jellyfin/commit/79ae1ab76a9f28edd711cd35b56d0c931752a4d1))
* register standalone window handlers only once ([9e4c4cc](https://github.com/mhajder/iina-jellyfin/commit/9e4c4cc4d8ad68927439ee616e18fb98c4e93e67))
* report a rewind to the start, and stop subtitle files colliding ([e621034](https://github.com/mhajder/iina-jellyfin/commit/e6210342d37fe4e81a981079c4a034523b082538))
* resolve the server id from either payload shape ([f82d75f](https://github.com/mhajder/iina-jellyfin/commit/f82d75f95f29e7e1fba373630503c1f7de43e49e))
* restore standalone window messaging ([b8de230](https://github.com/mhajder/iina-jellyfin/commit/b8de230c38f60e42036700f5e8b840b87429cfff))
* retry sidebar auto-connect when the first server list is empty ([6c9355f](https://github.com/mhajder/iina-jellyfin/commit/6c9355fef814e1ecd467e38585f6b644063b6f24))
* show an error when the login server URL is invalid ([5d2f465](https://github.com/mhajder/iina-jellyfin/commit/5d2f46514c0121e18c6fe3f84eed0cb5ef82b90a))
* stop calling the core API from the sidebar webview ([62a736c](https://github.com/mhajder/iina-jellyfin/commit/62a736cfb627b06731a006dc86e67a15b4ac6293))
* stop writing autoplay preferences nothing reads ([3eeca44](https://github.com/mhajder/iina-jellyfin/commit/3eeca4423aded5e8e66cb8cb97b80f8e095f4918))
* stream media instead of downloading it ([210767f](https://github.com/mhajder/iina-jellyfin/commit/210767f09b8e15b309706e8077fd0dfc945c63ad))
* use the current Jellyfin item routes in the sidebar ([6f6feb3](https://github.com/mhajder/iina-jellyfin/commit/6f6feb3cb67092d8a8cee561e30c65674726f2cf))


### 🧹 Refactoring

* drop the clipboard fallback that cannot run ([505ab52](https://github.com/mhajder/iina-jellyfin/commit/505ab52b6f49991c7f0a954f616393a2360a37d8))
* drop the core.status.path fallback that never resolves ([e612a0d](https://github.com/mhajder/iina-jellyfin/commit/e612a0ddb81db7cd6043ab30ea01581be2c29c73))
* make sidebar init idempotent and submit forms on Enter ([85a19cb](https://github.com/mhajder/iina-jellyfin/commit/85a19cb250356dc4cc798eaad49cb6945e57c1cc))
* remove unreachable logout and global playMedia paths ([e200f6b](https://github.com/mhajder/iina-jellyfin/commit/e200f6bd08816dfb52c6affa9353040ce4d9188e))

## [0.7.1](https://github.com/mhajder/iina-jellyfin/compare/v0.7.0...v0.7.1) (2026-08-07)


### 🐛 Bug Fixes

* remove deprecated sidebar permission ([#76](https://github.com/mhajder/iina-jellyfin/issues/76)) ([e2143c3](https://github.com/mhajder/iina-jellyfin/commit/e2143c3c5cc00e8c3143763b172a7c2fc4417bef))

## [0.7.0](https://github.com/mhajder/iina-jellyfin/compare/v0.6.2...v0.7.0) (2026-07-02)


### 🚀 Features

* report playback to the connected account instead of URL api_key ([#67](https://github.com/mhajder/iina-jellyfin/issues/67)) ([bf09128](https://github.com/mhajder/iina-jellyfin/commit/bf0912810d2dab73d508cf5c381986fef9681b30))

## [0.6.2](https://github.com/mhajder/iina-jellyfin/compare/v0.6.1...v0.6.2) (2026-05-22)


### 🐛 Bug Fixes

* resolve macOS sleep prevention and stale title bugs during playback ([#56](https://github.com/mhajder/iina-jellyfin/issues/56)) ([7a8a8d8](https://github.com/mhajder/iina-jellyfin/commit/7a8a8d8c6360e0ddf7bde9a2473a8ac536f64b32))

## [0.6.1](https://github.com/mhajder/iina-jellyfin/compare/v0.6.0...v0.6.1) (2026-04-06)


### 🐛 Bug Fixes

* ensure correct episode transitions ([#45](https://github.com/mhajder/iina-jellyfin/issues/45)) ([37fc964](https://github.com/mhajder/iina-jellyfin/commit/37fc9647c9ce473c24042af4af3c407b64fa7bee))

## [0.6.0](https://github.com/mhajder/iina-jellyfin/compare/v0.5.0...v0.6.0) (2026-02-27)


### 🚀 Features

* add music library browsing and album track support ([#33](https://github.com/mhajder/iina-jellyfin/issues/33)) ([6bb0368](https://github.com/mhajder/iina-jellyfin/commit/6bb0368340f939956477d7e178a30d534ddc684a))
* add pre-commit/prek configuration for code quality ([#36](https://github.com/mhajder/iina-jellyfin/issues/36)) ([d021c68](https://github.com/mhajder/iina-jellyfin/commit/d021c686cf76d3fc3aec4c6e7a9866f8e04130bf))
* **sidebar:** add filter and sort controls for movies/series ([#26](https://github.com/mhajder/iina-jellyfin/issues/26)) ([fe8f4fc](https://github.com/mhajder/iina-jellyfin/commit/fe8f4fce977bb6031742789ea3b3493ccb6dfe9d))
* **sidebar:** add search type filter chips for media search ([#31](https://github.com/mhajder/iina-jellyfin/issues/31)) ([6d8aab8](https://github.com/mhajder/iina-jellyfin/commit/6d8aab84c8197d1ad635c94b865173e6a98be24f))


### 🐛 Bug Fixes

* **sidebar:** clear media content and state on server disconnect/logout ([#34](https://github.com/mhajder/iina-jellyfin/issues/34)) ([c070eae](https://github.com/mhajder/iina-jellyfin/commit/c070eaee2f1504322eeb2f57eeafba1803ec2b6c))
* **ui:** clear stale episode and season state on series change ([#32](https://github.com/mhajder/iina-jellyfin/issues/32)) ([0ab792d](https://github.com/mhajder/iina-jellyfin/commit/0ab792da59c1361bf6e4e8ca7619fe8d1ad6799d))


### 🧹 Refactoring

* **logging:** improve debug log clarity and structure ([#29](https://github.com/mhajder/iina-jellyfin/issues/29)) ([cf5fd88](https://github.com/mhajder/iina-jellyfin/commit/cf5fd88da107cff519ed8ab6a1d03025bc976185))
* migrate inline styles to CSS file with theme vars ([#30](https://github.com/mhajder/iina-jellyfin/issues/30)) ([dbf543d](https://github.com/mhajder/iina-jellyfin/commit/dbf543df72fc83c954bca8aa55935839da684f06))
* modularize plugin logic and improve sidebar ([#28](https://github.com/mhajder/iina-jellyfin/issues/28)) ([3e2533a](https://github.com/mhajder/iina-jellyfin/commit/3e2533ac155e8b1ba00544f9843db8b85fb34df8))


### 🧩 CI

* update client version using release please ([#35](https://github.com/mhajder/iina-jellyfin/issues/35)) ([3ced64a](https://github.com/mhajder/iina-jellyfin/commit/3ced64a403420b27ea66f47c4afb47eed3bf6ee0))

## [0.5.0](https://github.com/mhajder/iina-jellyfin/compare/v0.4.0...v0.5.0) (2026-02-11)


### 🚀 Features

* Adds Jellyfin authorization header builder ([dc4aef5](https://github.com/mhajder/iina-jellyfin/commit/dc4aef5b994ae27c15e6d9c42719b47879a919bd))
* **playback:** Improves playback progress tracking ([713ce72](https://github.com/mhajder/iina-jellyfin/commit/713ce72ea48726d81688a229b16c3da9c36c0362))
* **sidebar:** Add Home, Movies, and Series tabs to sidebar ([2462dc7](https://github.com/mhajder/iina-jellyfin/commit/2462dc73630e91deecdd505c9de99773402de2cd))
* **sidebar:** add thumbnails and durations ([70a2c6b](https://github.com/mhajder/iina-jellyfin/commit/70a2c6b2c37d92c1d2d2af09fb7aad142d34f8f8))
* **sidebar:** Adds multi-server support and Quick Connect ([c876964](https://github.com/mhajder/iina-jellyfin/commit/c8769641cafdecea2a3a8565abda54071e7f9323))


### 🐛 Bug Fixes

* enhance playlist entry titles and clear previous entries before opening media ([#21](https://github.com/mhajder/iina-jellyfin/issues/21)) ([c8977f4](https://github.com/mhajder/iina-jellyfin/commit/c8977f492dfc49ce105cf23ab0849305d87b7d0d))


### 📚 Documentation

* Adds multi-server, auth, and usage docs ([03238b0](https://github.com/mhajder/iina-jellyfin/commit/03238b05f24549a453d8155b55c91327e6bfe0e8))


### 🧩 CI

* Removes workflow concurrency ([23732bb](https://github.com/mhajder/iina-jellyfin/commit/23732bb6ddb029dad17312c568ed99556c25c705))

## [0.4.0](https://github.com/mhajder/iina-jellyfin/compare/v0.3.0...v0.4.0) (2026-02-03)


### 🚀 Features

* Adds Jellyfin playback progress sync ([54d4b33](https://github.com/mhajder/iina-jellyfin/commit/54d4b335632358093353669108e35229a825f5fe))


### 🐛 Bug Fixes

* updates lint workflow triggers ([1df8b45](https://github.com/mhajder/iina-jellyfin/commit/1df8b450948527d1f8e58dc55e77c36cfa92f1e5))


### 🧩 CI

* migrate to release-please and improve workflows ([#18](https://github.com/mhajder/iina-jellyfin/issues/18)) ([9ae5172](https://github.com/mhajder/iina-jellyfin/commit/9ae5172d769006589c7add3f1950ae40c82f0bf3))
