# @lam/vulture/dev-plugin

Development helpers for [`@lam/vulture`](https://github.com/thallium-solutions/lam-vulture)
servers, written in the [Lammergeier language](https://github.com/thallium-solutions/lammergeier-lang).
Today: **browser live reload** for `lamc dev`, the compiler's rebuild-and-restart
loop.

- `lamc dev` rebuilds and restarts the server on source changes; every open page
  notices the new server and reloads.
- Changed stylesheets (for example a Tailwind watcher's output) are swapped in
  place, without reloading; other watched assets reload the page.
- Inert outside `lamc dev`: the plugin registers nothing unless the process has
  `LAMC_DEV=1` (set by `lamc dev`) or `force=true`, so the same server code runs
  in production.

## Requirements

- `lamc` 4.0 or newer (`>=4.0, <5`); `lamc dev` comes with 4.5.0.
- `@lam/vulture` 3.6.0 (`SseEmitter.wait`), installed transitively.

## Installation

```toml
[dependencies]
"@lam/vulture/dev-plugin" = { git = "https://github.com/thallium-solutions/lam-vulture-dev-plugin.git", ref = "1.0.0" }
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
  changed. Assets are files or directories (recursive) hashed every
  `intervalMs`; a change is reported once the files are the same on two
  consecutive polls, so half-written files do not trigger. The stream ends when
  the client leaves or the server shuts down (`SseEmitter.wait`), so graceful
  shutdowns stay fast.
- `GET <path>.js`: the browser script (`no-store`).
- An `onSend` hook inserting `<script src="<path>.js" ... defer>` before
  `</body>` of `text/html` responses that contain `</body>`; fragments (htmx
  partials) and other content types are untouched, and `Content-Length` is
  updated when set. The script is same-origin, so a `script-src 'self'`
  Content Security Policy allows it.

The script reconnects every 300 ms while the server restarts, and reloads when
the `boot` id differs from the one of the server that rendered the page.
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

## License

Apache-2.0.
