# @lam/vulture/dev-plugin Changelog

All notable changes to `@lam/vulture/dev-plugin` are documented here.

## [1.0.0] - 2026-11-07

### Added

- Browser live reload for `lamc dev`: `liveReload`, `liveReloadPlugin` and
  `LiveReload`. An event stream announces the server's boot id (pages reload
  after a restart), swaps changed stylesheets in place and reloads on other
  watched asset changes; an `onSend` hook adds the script to HTML documents.
  Inert unless `LAMC_DEV=1` or `force=true`.
