# Contributing

Thanks for helping out. Bug reports and feature requests go through [GitHub issues](https://github.com/mhajder/iina-jellyfin/issues). For security problems, follow [SECURITY.md](SECURITY.md) instead.

## Development setup

```sh
git clone https://github.com/mhajder/iina-jellyfin.git
cd iina-jellyfin
pnpm install
prek install
```

[prek](https://prek.j178.dev/) runs ESLint, Prettier and the tests on commit and checks the commit message. Install it first, for example with `brew install prek`.

To try your changes in IINA, link the plugin and restart IINA:

```sh
/Applications/IINA.app/Contents/MacOS/iina-plugin link .
```

Run `iina-plugin unlink .` from the same directory to remove the link again.

## Before opening a pull request

```sh
pnpm test
pnpm run check
```

- Add or update tests in `tests/` for the change.
- Try it in IINA against a real Jellyfin server: open a Jellyfin URL and play something from the sidebar.
- Update the README when you add a setting or change behavior.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/), for example `feat(sidebar): add a favorites tab` or `fix: keep subtitles in the preferred language`. Pull requests are squash-merged, and release-please builds the changelog and the next version from them.

## License

By contributing, you agree that your contributions are licensed under the project's GPL-3.0-only license.
