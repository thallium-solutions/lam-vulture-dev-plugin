# @lam/vulture/dev-plugin Changelog

All notable changes to `@lam/vulture/dev-plugin` are documented here.

## [1.2.3] - 2026-11-14

### Fixed

- A stream reports every change made after its `boot` event. The stream sent
  `boot` and then took its first snapshot of the watched files, so a file
  written right after a client received `boot` could land in that snapshot
  and never be reported (a stylesheet saved just as a tab connected was not
  swapped; `test_live_reload_stream.lam` failed with `styles event: timeout`
  about 1 run in 3, 16 of 30 runs under load). The first snapshot is now
  taken before `boot` is sent: 0 failures in 40 runs.

### Tests

- `tests/test_live_reload_snapshot_order.lam` (regression, deterministic: a
  subclass slows the first `snapshot()` so the old order failed every run): a
  change made right after `boot` is reported; a same-content rewrite is quiet;
  created and deleted files reload; a second stream starts from the current
  files.
- `tests/test_live_reload_composed.lam`: several roots (nested directory,
  non-ASCII file names, a missing root) served to three concurrent streams
  awaited from async tasks; multi-stylesheet `styles` events, nested script
  and rename reloads, the 50 ms interval floor, injection into an upper-case
  `TEXT/HTML` response before the last `</body>`, and every stream closed on
  shutdown.

## [1.2.2] - 2026-11-14

### Fixed

- The `Content-Length` of an HTML response the script tag is injected into
  is its size in bytes (`len(bytes(body))`). It was `len(body)`, which counts
  characters from lamc 4.14 on (strings are sequences of characters), so a
  page with non-ASCII text announced fewer bytes than it sent and browsers cut
  it short. Correct with lamc 4.13 and 4.14; tested with a non-ASCII page.

## [1.2.1] - 2026-11-09

### Changed

- Pins `@lam/vulture` 3.7.0 (json bodies encoded once), so a project can
  depend on both.

## [1.2.0] - 2026-11-09

### Fixed

- An open page no longer makes the server read every watched asset twice a
  second. Each stream read and hashed all the files every `intervalMs`
  (Luxyt: 5.1 MB, mostly a 4.9 MB bundle, every 500 ms: about 10 MB/s
  allocated while a tab was open, 15% of everything a load test allocated).
  `snapshot()` now reads a file only when its size or modification time
  changed, or when it was modified in the last 2 seconds (a rewrite within
  one tick of the file system's clock); the hashes are shared by the streams.
  Changes are still detected by content, so an editor rewriting a file
  unchanged reloads nothing.

### Added

- `LiveReload.reads`: the files `snapshot()` has read so far.

### Changed

- Requires lamc 4.8.0 (`Os.modTime`).

## [1.1.0] - 2026-11-08

### Fixed

- Open pages no longer use up the browser's connections to the dev server.
  Each page kept its own `/__lam/live-reload` stream open, and browsers allow
  only 6 HTTP/1.1 connections per host: with several tabs, quick navigations
  or pages in the back/forward cache, ordinary requests were queued behind
  the streams (a navigation waited 57 s in headless Chrome; users saw 2–10 s
  document loads while the server answered in milliseconds).

### Changed

- The pages of a browser share one stream: a leader elected with the Web
  Locks API opens the `EventSource` and relays its `boot`, `reload` and
  `styles` events to the other tabs over a `BroadcastChannel`; a tab that
  joins asks for the current `boot` id; when the leader leaves, a waiting tab
  takes over at once. Without Web Locks (an insecure context such as a LAN
  address) or `BroadcastChannel`, each page keeps its own stream.
- Pages close their stream and release the lock when they are left
  (`beforeunload`, `pagehide`) and join again when restored from the
  back/forward cache (`pageshow` with `persisted`), reloading if the server
  changed. Reload reasons, the `lam:live-reload` and `lam:live-styles`
  events, stylesheet swaps and the scroll restore are unchanged, as are the
  endpoint and the API.
- Tests: a headless Chrome test (`tests/browser/`, Node 22, optional) checks
  the shared stream, handover, restarts, stylesheet swaps, the back/forward
  cache and the fallback; the Lam tests cover the new script and a second
  stream and a restarted server's boot id.

## [1.0.0] - 2026-11-07

### Added

- Browser live reload for `lamc dev`: `liveReload`, `liveReloadPlugin` and
  `LiveReload`. An event stream announces the server's boot id (pages reload
  after a restart), swaps changed stylesheets in place and reloads on other
  watched asset changes; an `onSend` hook adds the script to HTML documents.
  Inert unless `LAMC_DEV=1` or `force=true`.
