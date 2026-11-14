# @lam/vulture/dev-plugin

Development helpers for [`@lam/vulture`](https://github.com/thallium-solutions/lam-vulture)
servers, written in the [Lammergeier language](https://github.com/thallium-solutions/lammergeier-lang).
Today: **browser live reload** for `lamc dev`, the compiler's rebuild-and-restart
loop.

- `lamc dev` rebuilds and restarts the server on source changes; every open page
  notices the new server and reloads.
- Changed stylesheets (for example a Tailwind watcher's output) are swapped in
  place, without reloading; other watched assets reload the page.
- One event stream per browser, shared by all its tabs, so open pages never
  use up the browser's connections to the dev server.
- Inert outside `lamc dev`: the plugin registers nothing unless the process has
  `LAMC_DEV=1` (set by `lamc dev`) or `force=true`, so the same server code runs
  in production.

## Requirements

- `lamc` 4.8.0 or newer (`>=4.8.0, <5`: `Os.modTime`); `lamc dev` comes with 4.5.0.
- `@lam/vulture` 3.7.0 (`SseEmitter.wait` since 3.6.0), installed transitively.

## Installation

```toml
[dependencies]
"@lam/vulture/dev-plugin" = { git = "https://github.com/thallium-solutions/lam-vulture-dev-plugin.git", ref = "1.2.2" }
```

```bash
lamc install
```

Tags are plain versions, without a `v` prefix.

## Usage

```lam
from @lam/vulture import Server
from @lam/vulture/dev-plugin import liveReloadPlugin

func main() {
    srv: Server = Server()
    srv.register(liveReloadPlugin(["assets/build", "assets/js"]))
    # routes...
    _ = srv.listen(3000)
}
```

```toml
[scripts]
dev = "lamc dev main.lam --watch locales --"
```

`lamc lib run dev` builds and starts the server; edit a `.lam` file and the
open pages reload once the new build serves.

### API

- `liveReload(srv, assets=[], path="/__lam/live-reload", intervalMs=500, force=false)`
  registers live reload on `srv` when `LiveReload.enabled()` or `force`.
- `liveReloadPlugin(...)` returns the same as a `func(Server)` for
  `srv.register(...)`.
- `LiveReload(assets, path, intervalMs)` with `register(srv)`, `tag()` (the
  script element), `snapshot()` and `LiveReload.changes(before, after)`;
  `LiveReload.enabled()` is true under `lamc dev`.
- `LiveReloadPath` is the default endpoint.

What `register` adds:

- `GET <path>`: a Server-Sent Events stream. It sends `boot` (an id of this
  server process) on connect, `styles` with the changed stylesheet file names
  when only `.css` files changed, and `reload` when other watched assets
  changed. Assets are files or directories (recursive) checked every
  `intervalMs` by content hash; a file is read and hashed again only when its
  size or modification time changed or it was modified in the last 2 seconds,
  and the hashes are shared by every stream (`live.reads` counts the files
  read), so an idle tab costs a directory walk, not a read of every asset. A
  change is reported once the files are the same on two consecutive polls, so
  half-written files do not trigger. The stream ends when
  the client leaves or the server shuts down (`SseEmitter.wait`), so graceful
  shutdowns stay fast.
- `GET <path>.js`: the browser script (`no-store`).
- An `onSend` hook inserting `<script src="<path>.js" ... defer>` before
  `</body>` of `text/html` responses that contain `</body>`; fragments (htmx
  partials) and other content types are untouched, and `Content-Length` is
  updated (in bytes) when set. The script is same-origin, so a `script-src 'self'`
  Content Security Policy allows it.

The script reconnects every 300 ms while the server restarts, and reloads when
the `boot` id differs from the one of the server that rendered the page.

### One connection per browser

Browsers open at most 6 HTTP/1.1 connections per host (development servers
speak plain HTTP/1.1), and an open event stream holds one for as long as the
page lives. With one stream per page, a few tabs, quick navigations or pages
kept in the back/forward cache used them all up, and the browser queued
ordinary page and asset requests behind the streams (document loads of
seconds, while the server answered in milliseconds). So the pages of a
browser share one stream:

- The tabs elect a leader with the Web Locks API (`navigator.locks`, a lock
  named after the endpoint, held while the page lives). Only the leader opens
  the `EventSource`, and it relays `boot`, `reload` and `styles` to the other
  tabs over a `BroadcastChannel` of the same name; every tab compares the
  `boot` id with its own, so the behaviour above is unchanged. A tab that
  joins asks the leader for the current `boot` id, so a page rendered by an
  older server still reloads.
- When the leader goes away (closed, navigating, reloading), the lock is
  released and a waiting tab takes over at once; its first `boot` event
  covers a server restart that happened meanwhile.
- Pages let go of the stream and the lock when they are left (`beforeunload`
  and `pagehide`, so the next page can lead) and join again when restored
  from the back/forward cache (`pageshow` with `persisted`), reloading if
  the server changed meanwhile.
- Without Web Locks or `BroadcastChannel` each page opens its own stream, as
  before. Web Locks need a secure context: `localhost` and `127.0.0.1` are,
  but a dev server opened through a LAN address (`http://192.168.x.y:3000`)
  falls back to one stream per page.
Stylesheet swaps load `<link rel="stylesheet">` elements whose path ends with
a changed file name again (`?lam-live-reload=<stamp>`) and remove the old link
once the new one loaded, so the page does not flash; if no link matches, the
page reloads.

Before reloading, the page dispatches a cancelable `lam:live-reload` window
event (`detail.reason`: `server`, `assets` or `styles`), to save state or
cancel; after a stylesheet swap it dispatches `lam:live-styles`. The window
scroll position is restored after the reload.

## Tests

```bash
lamc lib run test
```

The runner stages a sibling `lam-vulture` checkout (`--vulture PATH`) and this
package into a temporary `extlibs/` tree, then compiles and runs every
`tests/test_*.lam` against its `# expect:` lines.

It then runs the browser test `tests/browser/live_reload.test.mjs`: it builds
`tests/browser/live_reload_server.lam` (a server using the plugin, forced on)
against the same `extlibs/` tree and drives headless Google Chrome over the
DevTools protocol with Node 22 (built-in `fetch` and `WebSocket`, no npm
packages). It opens eight tabs and rapid same-tab navigations and checks that
at most one stream is open (from DevTools Network events and, through a TCP
proxy in front of the server, as connections), that page requests are never
queued, that stylesheet swaps and server restarts reach every tab, that the
stream changes hands when the leader closes or navigates, that pages leave
and rejoin around the back/forward cache, and that the per-page fallback
works. The test is skipped with a message when `google-chrome` or Node 22+
is missing.

```bash
python3 tests/run_tests.py --filter browser      # only the browser test
python3 tests/run_tests.py --no-browser          # only the Lam tests
CHROME=chromium python3 tests/run_tests.py       # another Chrome binary
```

`LAM_BROWSER_TEST_DEBUG=1` makes the browser test log stream and navigation
events; `--verbose` prints its checks.

## License

Apache-2.0.
