# Security Policy

## Supported versions

Only the latest release gets security fixes. If you can, check that the issue still happens on it before reporting.

## Reporting a vulnerability

Please do not open a public issue. Report it privately through [GitHub private vulnerability reporting](https://github.com/mhajder/iina-jellyfin/security/advisories/new).

Include the plugin and IINA versions, how to reproduce it and what an attacker could do with it. Do not send real API keys, access tokens or server URLs you want to keep private; redact them.

I aim to acknowledge a report within 7 days and will keep you updated until it is fixed and released.

## Scope

In scope is this plugin, for example:

- Jellyfin API keys, access tokens or passwords leaking into logs (including with debug logging on), on-screen messages or files on disk
- an API key or token taken from one server being sent to a different host
- Jellyfin metadata (titles, overviews, names) running as script or HTML in the sidebar
- saved credentials surviving after the server is removed from the sidebar

Vulnerabilities in Jellyfin or IINA themselves belong with those projects.
