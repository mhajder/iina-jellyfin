# Changelog

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
