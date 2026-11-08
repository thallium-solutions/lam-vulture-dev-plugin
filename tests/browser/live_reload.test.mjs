#!/usr/bin/env node
// Browser test of the live reload client: headless Google Chrome driven over
// the DevTools protocol (Node 22: built-in fetch and WebSocket, no packages).
//
//   node tests/browser/live_reload.test.mjs --server <binary> [--chrome <path>]
//
// <binary> is tests/browser/live_reload_server.lam built against an extlibs
// install of the package (tests/run_tests.py does this). The test opens
// eight tabs plus rapid same-tab navigations and checks that the browser
// keeps at most one /__lam/live-reload stream open (counted from DevTools
// Network events and, through a TCP proxy in front of the server, as
// connections), that page requests are never queued behind streams, that
// stylesheet swaps and server restarts reach every tab, that a closed or
// navigating leader hands over, that pagehide / a persisted pageshow leave
// and rejoin, that pages back from history show the new server, and that
// the per-tab fallback (no Web Locks) works and releases its connection
// when the page enters the back/forward cache.
//
// LAM_BROWSER_TEST_DEBUG=1 logs stream and navigation events.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const StreamPath = "/__lam/live-reload";
const Tabs = 8;
const MaxSendStartMs = 500;
// Two streams may overlap for a moment while the lock changes hands (the
// old page's cancel and the new leader's request are reported by different
// renderers); a second stream that stays open longer is a failure.
const OverlapGraceMs = 250;

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 && at + 1 < args.length ? args[at + 1] : fallback;
};
const serverBinary = option("--server", "");
const chromeBinary = option("--chrome", process.env.CHROME || "google-chrome");
if (!serverBinary) {
  console.error("usage: live_reload.test.mjs --server <binary> [--chrome <path>]");
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(label);
  return ok;
};

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(label, probe, timeoutMs, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      // A probe can hang (a DevTools call into a tab whose navigation is
      // stuck), so each attempt is bounded by the remaining time.
      last = await Promise.race([
        probe(),
        sleep(Math.max(deadline - Date.now(), 0)).then(() => { throw new Error("probe did not answer"); }),
      ]);
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}${last instanceof Error ? `: ${last.message}` : ""}`);
}

// ── Test server ──────────────────────────────────────────────────────────
const work = mkdtempSync(join(tmpdir(), "lam-live-reload-browser-"));
mkdirSync(join(work, "assets"));
const stylesheet = join(work, "assets", "app.css");
writeFileSync(stylesheet, "body { color: rgb(0, 0, 1); }\n");
const port = await freePort();
const backendPort = await freePort();
const origin = `http://127.0.0.1:${port}`;
let server = null;

// ── Socket-level count ───────────────────────────────────────────────────
// The browser talks to a TCP proxy in front of the test server, which counts
// the connections carrying a stream: the scarce resource itself, and an
// independent check of the DevTools count (DevTools reports nothing for the
// requests of a document entering the back/forward cache).
const streamSockets = new Set();
const socketOverlaps = [];
let allowedSockets = 1;
let peakSockets = 0;
const streamRequest = new RegExp(`^GET ${StreamPath.replace(/[/.]/g, "\\$&")}(?:\\?[^ ]*)? HTTP/1\\.1\r$`, "m");

const debug = process.env.LAM_BROWSER_TEST_DEBUG ? (...parts) => console.log("debug", ...parts) : () => {};

function socketCountChanged() {
  debug(`stream connections: ${streamSockets.size}`);
  peakSockets = Math.max(peakSockets, streamSockets.size);
  if (streamSockets.size > allowedSockets) {
    const allowed = allowedSockets;
    setTimeout(() => {
      if (streamSockets.size > allowed) {
        socketOverlaps.push(`${streamSockets.size} stream connections open for over ${OverlapGraceMs} ms (allowed ${allowed})`);
      }
    }, OverlapGraceMs);
  }
}

const proxy = createServer((client) => {
  const upstream = connect(backendPort, "127.0.0.1");
  const close = () => {
    client.destroy();
    upstream.destroy();
    if (streamSockets.delete(client)) socketCountChanged();
  };
  client.on("data", (chunk) => {
    if (!streamSockets.has(client) && streamRequest.test(chunk.toString("latin1"))) {
      streamSockets.add(client);
      socketCountChanged();
    }
  });
  client.pipe(upstream);
  upstream.pipe(client);
  client.on("error", close).on("close", close);
  upstream.on("error", close).on("close", close);
});
await new Promise((resolve) => proxy.listen(port, "127.0.0.1", resolve));

async function startServer() {
  const child = spawn(serverBinary, [], {
    cwd: work,
    env: { ...process.env, PORT: String(backendPort), LAMC_DEV: "" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  child.exited = new Promise((resolve) => child.once("exit", resolve));
  server = child;
  const page = await waitFor("the test server", async () => {
    const response = await fetch(origin + "/");
    return response.ok ? response.text() : null;
  }, 15000);
  const boot = /data-boot="([^"]+)"/.exec(page);
  if (!boot) throw new Error("the page has no live reload script tag");
  return boot[1];
}

async function stopServer() {
  if (!server) return;
  const child = server;
  server = null;
  child.kill("SIGTERM");
  await Promise.race([child.exited, sleep(5000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

// ── Chrome and the DevTools protocol ─────────────────────────────────────
let chrome = null;
const profile = join(work, "profile");

async function startChrome() {
  chrome = spawn(chromeBinary, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "ignore"] });
  const active = join(profile, "DevToolsActivePort");
  const [devtoolsPort, path] = await waitFor("Chrome's DevTools port", () =>
    existsSync(active) && readFileSync(active, "utf8").trim().split("\n").length === 2
      ? readFileSync(active, "utf8").trim().split("\n")
      : null, 20000);
  return `ws://127.0.0.1:${devtoolsPort}${path}`;
}

class Cdp {
  constructor(url) {
    this.next = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", () => reject(new Error("DevTools connection failed")), { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const waiter = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (!waiter) return;
        if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
        else waiter.resolve(message.result);
      } else {
        for (const listener of this.listeners) listener(message);
      }
    });
  }

  send(method, params = {}, sessionId = undefined) {
    const id = ++this.next;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.socket.send(JSON.stringify(message));
    });
  }

  close() {
    this.socket.close();
  }
}

// ── Network bookkeeping across every tab ─────────────────────────────────
// Streams are counted from Network.requestWillBeSent (which a queued request
// gets too) to loadingFinished/loadingFailed or the tab going away.
const sessions = new Map(); // sessionId -> { targetId, label, shared }
const openStreams = new Map(); // requestId -> sessionId (shared tabs only)
const fallbackStreams = new Map(); // requestId -> sessionId (fallback tab)
const requests = new Map(); // requestId -> { url, type, at }
const documentTimings = []; // { url, sendStartMs, totalMs }
const overlaps = [];
let peakStreams = 0;
let bfcacheBlocked = null;

function streamCountChanged() {
  const count = openStreams.size;
  peakStreams = Math.max(peakStreams, count);
  if (count > 1) {
    const snapshot = [...openStreams.values()].map((id) => sessions.get(id)?.label ?? id);
    setTimeout(() => {
      if (openStreams.size > 1) {
        overlaps.push(`${openStreams.size} streams open for over ${OverlapGraceMs} ms (${snapshot.join(", ")})`);
      }
    }, OverlapGraceMs);
  }
}

function forgetSession(sessionId) {
  for (const [requestId, owner] of [...openStreams]) {
    if (owner === sessionId) openStreams.delete(requestId);
  }
  for (const [requestId, owner] of [...fallbackStreams]) {
    if (owner === sessionId) fallbackStreams.delete(requestId);
  }
  sessions.delete(sessionId);
  streamCountChanged();
}

function onEvent(message) {
  const { method, params, sessionId } = message;
  if (method === "Target.detachedFromTarget") {
    forgetSession(params.sessionId);
    return;
  }
  const tab = sessions.get(sessionId);
  if (!tab) return;
  if (method === "Network.requestWillBeSent") {
    const url = new URL(params.request.url);
    requests.set(params.requestId, { url: params.request.url, type: params.type, at: params.timestamp });
    if (url.origin === origin && url.pathname === StreamPath) {
      (tab.shared ? openStreams : fallbackStreams).set(params.requestId, sessionId);
      debug(`${tab.label} opens stream ${params.requestId} (${params.loaderId})`);
      streamCountChanged();
    }
  } else if (method === "Network.responseReceived") {
    const request = requests.get(params.requestId);
    if (request) request.answered = true;
    if (request && params.type === "Document" && params.response.timing) {
      documentTimings.push({
        url: request.url,
        sendStartMs: params.response.timing.sendStart,
        totalMs: (params.timestamp - request.at) * 1000,
      });
    }
  } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
    requests.delete(params.requestId);
    if (openStreams.has(params.requestId) || fallbackStreams.has(params.requestId)) {
      debug(`${tab.label} ends stream ${params.requestId} ${params.errorText ?? ""}`);
    }
    if (openStreams.delete(params.requestId)) streamCountChanged();
    fallbackStreams.delete(params.requestId);
  } else if (method === "Page.frameNavigated" && !params.frame.parentId) {
    debug(`${tab.label} shows ${params.frame.url} (${params.frame.loaderId}, ${params.type})`);
  } else if (method === "Page.backForwardCacheNotUsed") {
    bfcacheBlocked = (params.notRestoredExplanations || []).map((reason) => reason.reason);
  }
}

// ── Tabs ─────────────────────────────────────────────────────────────────
let cdp = null;

async function openTab(label, url, { shared = true, beforeNavigate = null } = {}) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  sessions.set(sessionId, { targetId, label, shared });
  await cdp.send("Network.enable", {}, sessionId);
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: false }, sessionId);
  await cdp.send("Page.enable", {}, sessionId);
  if (beforeNavigate) await beforeNavigate(sessionId);
  navigate(sessionId, url);
  return sessionId;
}

// Page.navigate answers once the document response arrives: a request queued
// behind open streams would stall the test instead of failing a check, so
// navigations are not awaited (the checks wait for the page instead).
function navigate(sessionId, url) {
  cdp.send("Page.navigate", { url }, sessionId).catch(() => {});
}

const step = (text) => console.log(`--   ${text}`);

async function evaluate(sessionId, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

const loaded = (sessionId) => evaluate(sessionId,
  `document.readyState === "complete" && !!document.querySelector("script[data-boot]")`);

const tabBoot = (sessionId) => evaluate(sessionId,
  `document.readyState === "complete" ? document.querySelector("script[data-boot]")?.dataset.boot ?? null : null`);

const bodyColor = (sessionId) => evaluate(sessionId, "getComputedStyle(document.body).color");

// Wait for the tabs to load; returns the labels of those that did not.
async function waitLoaded(sessionIds, timeoutMs = 10000) {
  const results = await Promise.allSettled(sessionIds.map((id) =>
    waitFor(`${sessions.get(id)?.label ?? id} to load`, () => loaded(id), timeoutMs)));
  return results.flatMap((result, i) => result.status === "rejected" ? [sessions.get(sessionIds[i])?.label] : []);
}

async function markAll(sessionIds, mark) {
  await Promise.all(sessionIds.map((id) => evaluate(id, `window.__lamMark = ${JSON.stringify(mark)}`)));
}

async function waitColor(sessionIds, color, mark, timeoutMs = 5000) {
  const results = await Promise.allSettled(sessionIds.map((id) =>
    waitFor(`${sessions.get(id).label} to show ${color}`, async () =>
      (await bodyColor(id)) === color, timeoutMs)));
  const missing = results.flatMap((result, i) => result.status === "rejected" ? [sessions.get(sessionIds[i])?.label] : []);
  const marks = await Promise.all(sessionIds.map((id) => evaluate(id, "window.__lamMark ?? null").catch(() => null)));
  const reloaded = marks.flatMap((value, i) => value === mark ? [] : [sessions.get(sessionIds[i])?.label]);
  return { missing, reloaded };
}

async function waitBoot(sessionIds, boot, timeoutMs = 10000) {
  const results = await Promise.allSettled(sessionIds.map((id) =>
    waitFor(`${sessions.get(id).label} to reload`, async () => (await tabBoot(id)) === boot, timeoutMs)));
  return results.flatMap((result, i) => result.status === "rejected" ? [sessions.get(sessionIds[i])?.label] : []);
}

function leaderSession() {
  const owners = new Set(openStreams.values());
  return owners.size === 1 ? [...owners][0] : null;
}

// One stream for the shared tabs (DevTools) and the expected number of
// stream connections (proxy): one, plus one for the fallback tab.
function checkStreams(label) {
  return check(label, openStreams.size === 1 && streamSockets.size === allowedSockets,
    `requests=${openStreams.size} connections=${streamSockets.size}/${allowedSockets} ` +
    `peak requests=${peakStreams} peak connections=${peakSockets}`);
}

const sharedTabs = () => [...sessions].filter(([, tab]) => tab.shared).map(([id]) => id);

// Navigate `id` forward twice, restart the server, go back one entry and
// check that the page shows the new server's boot. Pages restored from the
// back/forward cache record it in sessionStorage (`restoredProbe`).
async function historyRoundTrip(label, id, all) {
  for (const hop of [1, 2]) {
    navigate(id, `${origin}/next?${label}=${hop}`);
    await waitFor(`${label} history page ${hop}`, async () =>
      (await evaluate(id, "location.pathname + location.search")) === `/next?${label}=${hop}` && loaded(id), 10000);
  }
  await evaluate(id, `sessionStorage.removeItem("test:restored"); true`);
  await stopServer();
  await sleep(700);
  const boot = await startServer();
  let stale = await waitBoot(all, boot);
  check(`a restart reloads every tab (${label})`, stale.length === 0, stale.join(", "));
  bfcacheBlocked = null;
  const entries = await cdp.send("Page.getNavigationHistory", {}, id);
  cdp.send("Page.navigateToHistoryEntry", { entryId: entries.entries[entries.currentIndex - 1].id }, id).catch(() => {});
  stale = await waitBoot([id], boot);
  const restored = (await evaluate(id, `sessionStorage.getItem("test:restored")`).catch(() => null)) === "1";
  const how = restored ? "restored from the back/forward cache, then reloaded"
    : `not from the back/forward cache: ${(bfcacheBlocked || []).join(", ") || "unknown"}`;
  check(`a ${label} page back from history shows the new server`, stale.length === 0, how);
  await sleep(1000);
  checkStreams(`one shared stream after the ${label} history navigation`);
  return restored;
}

// ── Scenario ─────────────────────────────────────────────────────────────
async function scenario() {
  let boot = await startServer();
  cdp = new Cdp(await startChrome());
  await cdp.ready;
  cdp.listeners.add(onEvent);

  // 1. Eight tabs share one stream.
  step("eight tabs");
  const tabs = [];
  for (let i = 0; i < Tabs; i++) tabs.push(await openTab(`tab${i}`, `${origin}/?tab=${i}`));
  let unloaded = await waitLoaded(tabs);
  check(`${Tabs} tabs load`, unloaded.length === 0, unloaded.length ? `still loading: ${unloaded.join(", ")}` : "");
  await sleep(1000);
  checkStreams(`${Tabs} tabs keep one stream open`);

  // 2. Rapid same-tab navigations (the previous documents must let go of
  //    their stream at once) and a new tab meanwhile.
  step("rapid navigations");
  for (let i = 0; i < 12; i++) {
    navigate(tabs[0], `${origin}/next?hop=${i}`);
    await sleep(i % 3 === 0 ? 40 : 150);
  }
  tabs.push(await openTab(`tab${Tabs}`, `${origin}/?tab=${Tabs}`));
  const hopped = await waitFor("tab0 to finish navigating", async () =>
    (await evaluate(tabs[0], "location.search")) === "?hop=11" && loaded(tabs[0]), 10000).catch(() => false);
  unloaded = await waitLoaded(tabs);
  check("rapid navigations and a new tab load", hopped && unloaded.length === 0,
    `${hopped ? "" : "tab0 did not reach ?hop=11 "}${unloaded.join(", ")}`.trim());
  await sleep(1000);
  checkStreams("rapid navigations keep one stream open");
  const slowest = documentTimings.reduce((worst, t) => (t.sendStartMs > worst.sendStartMs ? t : worst), { sendStartMs: 0, totalMs: 0 });
  // Documents still waiting for an answer were queued (superseded
  // navigations are reported as failed and dropped from `requests`).
  const waiting = [...requests.values()].filter((r) => r.type === "Document" && !r.answered);
  check(`page requests are not queued (sendStart < ${MaxSendStartMs} ms)`,
    slowest.sendStartMs < MaxSendStartMs && waiting.length === 0,
    `${documentTimings.length} documents, max sendStart=${slowest.sendStartMs.toFixed(1)} ms, ` +
    `total=${slowest.totalMs.toFixed(1)} ms ${slowest.url ?? ""}, still waiting=${waiting.length}`);

  // 3. A changed stylesheet reaches every tab without a reload.
  step("stylesheet swap");
  await markAll(tabs, "styles-1");
  writeFileSync(stylesheet, "body { color: rgb(1, 2, 3); }\n");
  let styles = await waitColor(tabs, "rgb(1, 2, 3)", "styles-1");
  check("stylesheet swap reaches every tab", styles.missing.length === 0, styles.missing.join(", "));
  check("stylesheet swap does not reload", styles.reloaded.length === 0, styles.reloaded.join(", "));

  // 4. A server restart (new boot id) reloads every tab.
  step("server restart");
  await stopServer();
  await sleep(700);
  boot = await startServer();
  let stale = await waitBoot(tabs, boot);
  check("server restart reloads every tab", stale.length === 0, stale.join(", "));
  await sleep(1000);
  checkStreams("one stream after the restart");

  // 5. Closing the leader hands the stream over at once.
  step("leader handover");
  const leader = leaderSession();
  if (check("a leader holds the stream", leader !== null)) {
    const label = sessions.get(leader).label;
    const handedAt = Date.now();
    await cdp.send("Target.closeTarget", { targetId: sessions.get(leader).targetId });
    tabs.splice(tabs.indexOf(leader), 1);
    const next = await waitFor("a new leader", () => {
      const id = leaderSession();
      return id && id !== leader ? id : null;
    }, 3000).catch(() => null);
    check(`closing the leader (${label}) hands over`, next !== null,
      next ? `${sessions.get(next).label} after ${Date.now() - handedAt} ms` : "no new stream");
    await markAll(tabs, "styles-2");
    writeFileSync(stylesheet, "body { color: rgb(4, 5, 6); }\n");
    styles = await waitColor(tabs, "rgb(4, 5, 6)", "styles-2");
    check("the new leader relays stylesheet swaps", styles.missing.length === 0 && styles.reloaded.length === 0,
      [...styles.missing, ...styles.reloaded].join(", "));
  }

  // 6. A leader navigating in its own tab lets go of the stream.
  step("leader navigation");
  const mover = leaderSession();
  if (mover) {
    navigate(mover, `${origin}/next?leader=moved`);
    await waitFor("the moved leader to load", async () =>
      (await evaluate(mover, "location.search")) === "?leader=moved" && loaded(mover), 10000);
    await sleep(1000);
    checkStreams("a navigating leader leaves one stream");
  }

  // 7. pagehide releases the stream and the lock; pageshow from the
  //    back/forward cache joins again and reloads when the boot changed.
  //    (Synthetic events: headless Chrome keeps pages that used Web Locks
  //    out of the back/forward cache, see step 8.)
  step("leave and rejoin (pagehide, persisted pageshow)");
  const leaving = leaderSession();
  if (check("a leader before pagehide", leaving !== null)) {
    const label = sessions.get(leaving).label;
    const before = await tabBoot(leaving);
    await evaluate(leaving, `window.__lamMark = "left";
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })); true`);
    const next = await waitFor("a leader after pagehide", () => {
      const id = leaderSession();
      return id && id !== leaving ? id : null;
    }, 3000).catch(() => null);
    check(`pagehide frees ${label}'s stream and hands over`, next !== null,
      next ? `${sessions.get(next).label} leads` : `open=${openStreams.size}`);
    await stopServer();
    await sleep(700);
    boot = await startServer();
    const others = tabs.filter((id) => id !== leaving);
    stale = await waitBoot(others, boot);
    check("a restart while a page is hidden reloads the others", stale.length === 0, stale.join(", "));
    const kept = (await evaluate(leaving, "window.__lamMark ?? null")) === "left" && (await tabBoot(leaving)) === before;
    check("the hidden page is left alone", kept);
    await evaluate(leaving, `window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })); true`);
    stale = await waitBoot([leaving], boot);
    check("a persisted pageshow rejoins and reloads on a new boot", stale.length === 0);
    await sleep(1000);
    checkStreams("one stream after rejoining");
  }

  // 8. Real history navigations: a page coming back after a restart shows
  //    the new server's page, from the back/forward cache or not.
  step("history navigation");
  const history = tabs[1];
  const restoredProbe = `addEventListener("pageshow", (event) => {
    if (event.persisted) sessionStorage.setItem("test:restored", "1"); });`;
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: restoredProbe }, history);
  await historyRoundTrip("shared", history, tabs);

  // 9. Without Web Locks a tab falls back to its own stream.
  step("fallback without Web Locks");
  allowedSockets = 2;
  const fallback = await openTab("fallback", `${origin}/?mode=fallback`, {
    shared: false,
    beforeNavigate: (sessionId) => cdp.send("Page.addScriptToEvaluateOnNewDocument",
      { source: "delete Navigator.prototype.locks;" + restoredProbe }, sessionId),
  });
  unloaded = await waitLoaded([fallback]);
  check("the fallback tab loads", unloaded.length === 0);
  await waitFor("the fallback stream", () => fallbackStreams.size === 1 && streamSockets.size === 2, 3000).catch(() => null);
  check("a tab without Web Locks opens its own stream", fallbackStreams.size === 1 && streamSockets.size === 2,
    `fallback requests=${fallbackStreams.size} connections=${streamSockets.size}`);
  await markAll([...tabs, fallback], "styles-3");
  writeFileSync(stylesheet, "body { color: rgb(7, 8, 9); }\n");
  styles = await waitColor([...tabs, fallback], "rgb(7, 8, 9)", "styles-3");
  check("stylesheet swap reaches shared and fallback tabs", styles.missing.length === 0 && styles.reloaded.length === 0,
    [...styles.missing, ...styles.reloaded].join(", "));
  await historyRoundTrip("fallback", fallback, [...tabs, fallback]);

  check(`never more than one shared stream for over ${OverlapGraceMs} ms`, overlaps.length === 0,
    overlaps.length ? overlaps.slice(0, 3).join("; ") : `peak=${peakStreams}`);
  check(`never more stream connections than expected for over ${OverlapGraceMs} ms`, socketOverlaps.length === 0,
    socketOverlaps.length ? socketOverlaps.slice(0, 3).join("; ") : `peak=${peakSockets}`);
}

let exitCode = 0;
const watchdog = setTimeout(() => {
  console.error("FAIL browser test timed out");
  cleanup().finally(() => process.exit(1));
}, 180000);

async function cleanup() {
  if (chrome && chrome.exitCode === null) {
    const exited = new Promise((resolve) => chrome.once("exit", resolve));
    await Promise.race([cdp?.send("Browser.close").catch(() => {}), sleep(3000)]);
    await Promise.race([exited, sleep(3000)]);
    if (chrome.exitCode === null) {
      chrome.kill("SIGKILL");
      await Promise.race([exited, sleep(2000)]);
    }
  }
  try { cdp?.close(); } catch {}
  await stopServer();
  proxy.close();
  for (const socket of streamSockets) socket.destroy();
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    console.error(`warning: could not remove ${work}: ${error.message}`);
  }
}

try {
  await scenario();
} catch (error) {
  failures.push(error.message);
  console.log(`FAIL ${error.message}`);
} finally {
  clearTimeout(watchdog);
  await cleanup();
}
if (failures.length) {
  console.log(`\n${failures.length} browser check(s) failed`);
  exitCode = 1;
} else {
  console.log("\nall browser checks passed");
}
process.exit(exitCode);
