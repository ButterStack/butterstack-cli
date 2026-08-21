"use strict";

// Regression coverage for bin/butter's host resolution + credential/host
// binding fix, and its client-side scope-subset assertion on `auth login`.
// Every case here shells out to the real `node bin/butter ...` binary
// against a throwaway HTTP listener bound to 127.0.0.1 -- driving the
// actual flow, not asserting on unit state. No test ever touches a
// developer's real ~/.config/butterstack: HOME is pointed at a fresh
// temp directory per test.
//
// One related case (MCP server host-binding) is intentionally not covered
// here: it belongs to the separate butterstack-mcp package.

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const BUTTER_BIN = path.join(__dirname, "..", "bin", "butter");

function mkHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "butter-cli-test-"));
}

function rmHome(home) {
  if (home) fs.rmSync(home, { recursive: true, force: true });
}

function writeCredentials(home, { host, token = "test-token" }) {
  const configDir = path.join(home, ".config", "butterstack");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "credentials.json"),
    JSON.stringify({ token, host, scopes: ["ping"], actor: { email: "test@test.com" } })
  );
}

// Mirrors Ruby's Open3.capture3(env, ...): HOME plus whatever `env` adds,
// merged onto (not replacing) the current process environment, with an
// explicit null/undefined value meaning "unset this variable" -- needed
// for the "no BUTTERSTACK_HOST at all" case.
function buildEnv(env) {
  const fullEnv = { ...process.env, HOME: env.home };
  for (const [key, value] of Object.entries(env.overrides || {})) {
    if (value === null || value === undefined) delete fullEnv[key];
    else fullEnv[key] = value;
  }
  return fullEnv;
}

function runButter(args, { home, env = {} }) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BUTTER_BIN, ...args],
      { env: buildEnv({ home, overrides: env }) },
      (error, stdout, stderr) => {
        resolve({ stdout, stderr, success: !error, code: error ? error.code : 0 });
      }
    );
  });
}

// A minimal HTTP capture server: binds an ephemeral port on 127.0.0.1,
// records every request that actually arrives (method, url, headers) via
// a small async queue, and replies 200 with a canned JSON body. Also
// tracks raw connection attempts separately from fully-parsed requests,
// so "the mismatched host must never receive a connection at all" checks
// the strongest thing available (a TCP connection reaching the port), not
// just "no complete HTTP request was parsed."
function createQueue() {
  const items = [];
  const waiters = [];
  return {
    push(item) {
      if (waiters.length) waiters.shift()(item);
      else items.push(item);
    },
    async pop(timeoutMs) {
      if (items.length) return items.shift();
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        waiters.push((item) => {
          clearTimeout(timer);
          resolve(item);
        });
      });
    }
  };
}

function startCaptureServer() {
  const requests = createQueue();
  let connectionCount = 0;
  const server = http.createServer((req, res) => {
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) headers[key.toLowerCase()] = value;
    const body = JSON.stringify({ projects: [] });
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
    requests.push({ requestLine: `${req.method} ${req.url}`, headers });
  });
  server.on("connection", () => {
    connectionCount++;
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        port: server.address().port,
        requests,
        connectionCount: () => connectionCount
      });
    });
  });
}

function stopCaptureServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function readAuthUrl(child) {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const timer = setTimeout(() => reject(new Error("timed out waiting for the printed auth URL")), 5000);
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      const match = buffered.match(/URL: (\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
  });
}

function waitForExit(child) {
  return new Promise((resolve) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ success: code === 0, code, stderr }));
  });
}

function hitCallback(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        res.resume();
        res.on("end", resolve);
      })
      .on("error", reject);
  });
}

// -- F1: --host must be honored, not silently ignored -----------------------

test("F1: --host is honored, not silently ignored", async () => {
  const { server, port, requests } = await startCaptureServer();
  const home = mkHome();
  try {
    const host = `http://127.0.0.1:${port}`;
    writeCredentials(home, { host });

    await runButter(["projects", "list", "--host", host, "--json"], { home });

    const request = await requests.pop(1000);
    assert.ok(
      request,
      "no request ever reached the --host target -- if --host were parsed and ignored, " +
        "this request would have gone to the default host instead"
    );
    assert.match(request.requestLine, /^GET \/api\/v1\/projects/);
    assert.equal(request.headers.authorization, "Bearer test-token");
  } finally {
    await stopCaptureServer(server);
    rmHome(home);
  }
});

test("F1: with no --host and no BUTTERSTACK_HOST, the CLI falls back to the last-logged-in host, not always the default", async () => {
  const { server, port, requests } = await startCaptureServer();
  const home = mkHome();
  try {
    const host = `http://127.0.0.1:${port}`;
    writeCredentials(home, { host });

    await runButter(["projects", "list", "--json"], { home, env: { BUTTERSTACK_HOST: null } });

    const request = await requests.pop(1000);
    assert.ok(request, "expected the CLI to fall back to the host recorded in credentials.json");
  } finally {
    await stopCaptureServer(server);
    rmHome(home);
  }
});

// -- F1: the important one -- refuse to send a credential to a host it ------
// -- wasn't minted for, even though --host now works ------------------------

test("F1: refuses to send a stored credential to a host different from the one it was minted for, and never contacts it", async () => {
  // A real listener on the *target* end, so a regression that still
  // silently sends the request would be caught by an actual captured
  // request, not just inferred from "nothing was listening".
  const { server, port, requests, connectionCount } = await startCaptureServer();
  const home = mkHome();
  try {
    // Simulates: the developer previously ran `butter auth login` against a
    // different host (or their real credential's own host), and now runs a
    // bare command with --host pointed somewhere else entirely.
    writeCredentials(home, { host: "http://127.0.0.1:9999", token: "super-secret-prod-token" });

    const { stdout, stderr, success } = await runButter(
      ["projects", "list", "--host", `http://127.0.0.1:${port}`, "--json"],
      { home }
    );

    assert.equal(success, false, `the CLI must exit non-zero rather than silently retargeting (stdout=${stdout})`);
    // A precise phrase, not a loose /refus/i -- Node's own ECONNREFUSED
    // error text also contains "refus" as a substring, which would make a
    // loose match pass for the wrong reason.
    assert.match(
      `${stdout}${stderr}`,
      /Refusing to send the stored credential/,
      "expected an explicit refusal message explaining the host mismatch"
    );
    assert.doesNotMatch(stdout, /super-secret-prod-token/, "the token must never be printed even in the refusal path");

    const request = await requests.pop(500);
    assert.equal(request, null, "the mismatched-host target must never receive a completed request");
    assert.equal(connectionCount(), 0, "the mismatched-host target must never receive a connection at all");
  } finally {
    await stopCaptureServer(server);
    rmHome(home);
  }
});

test("F1: an explicit BUTTERSTACK_API_TOKEN env override bypasses the host-binding check (explicit user intent)", async () => {
  const { server, port, requests } = await startCaptureServer();
  const home = mkHome();
  try {
    const host = `http://127.0.0.1:${port}`;
    // No credentials.json at all -- BUTTERSTACK_API_TOKEN is the equivalent
    // explicit override on the env side; there's no stored host to compare
    // against, so this must not be blocked.
    const { success } = await runButter(["projects", "list", "--host", host, "--json"], {
      home,
      env: { BUTTERSTACK_API_TOKEN: "env-token" }
    });

    const request = await requests.pop(1000);
    assert.ok(request, "an explicit env-var token override should not be blocked by the host-binding check");
    assert.equal(request.headers.authorization, "Bearer env-token");
    assert.equal(success, true);
  } finally {
    await stopCaptureServer(server);
    rmHome(home);
  }
});

// -- F2: client-side belt-and-suspenders (the real guard is server-side; --
// -- this drives the whole `butter auth login` flow end to end -- real ------
// -- loopback server, real callback request, real token_exchange POST -- ---
// -- against a fake ButterStack server that grants more than what was -------
// -- requested, and proves the CLI notices and refuses to adopt it rather ---
// -- than saving it and reporting success.) ----------------------------------

function startFakeExchangeServer(scopes) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const respBody = JSON.stringify({
          token: "fake-issued-token",
          actor: { email: "a@test.com" },
          scopes,
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 90 * 86400 * 1000).toISOString()
        });
        res.writeHead(201, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(respBody) });
        res.end(respBody);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

test("F2 (real flow): auth login refuses to persist a token granted more scope than --scope requested", async () => {
  const { server, port } = await startFakeExchangeServer(["ping", "read:projects", "write:tasks"]);
  const home = mkHome();
  try {
    const child = spawn(
      process.execPath,
      [BUTTER_BIN, "auth", "login", "--host", `http://127.0.0.1:${port}`, "--scope", "ping,read:projects"],
      { env: buildEnv({ home }) }
    );

    const authUrl = await readAuthUrl(child);
    assert.ok(authUrl, "bin/butter auth login never printed the authorization URL");

    const parsed = new URL(authUrl);
    const callbackPort = parsed.searchParams.get("port");
    const state = parsed.searchParams.get("state");
    assert.ok(callbackPort && state, `could not parse port/state out of the printed auth URL: ${authUrl}`);

    // Simulate the browser hitting the CLI's loopback callback after the
    // (fake, over-scoped) server "approved" the request.
    await hitCallback(`http://127.0.0.1:${callbackPort}/callback?code=fake-auth-code&state=${state}`);

    const { success, stderr } = await waitForExit(child);

    assert.equal(success, false, "auth login must exit non-zero when granted scope exceeds what --scope requested");
    assert.match(stderr, /write:tasks/, "the refusal message should name the unexpected scope");

    const credsPath = path.join(home, ".config", "butterstack", "credentials.json");
    assert.equal(
      fs.existsSync(credsPath),
      false,
      "the over-scoped credential must never be written to disk, even though the fake server returned 201"
    );
  } finally {
    await stopCaptureServer(server);
    rmHome(home);
  }
});

test("F2 (real flow): auth login persists the token when granted scope matches what was requested", async () => {
  const { server, port } = await startFakeExchangeServer(["ping", "read:projects"]);
  const home = mkHome();
  try {
    const child = spawn(
      process.execPath,
      [BUTTER_BIN, "auth", "login", "--host", `http://127.0.0.1:${port}`, "--scope", "ping,read:projects"],
      { env: buildEnv({ home }) }
    );

    const authUrl = await readAuthUrl(child);
    const parsed = new URL(authUrl);
    const callbackPort = parsed.searchParams.get("port");
    const state = parsed.searchParams.get("state");

    await hitCallback(`http://127.0.0.1:${callbackPort}/callback?code=fake-auth-code&state=${state}`);

    const { success } = await waitForExit(child);
    assert.equal(success, true, "a matching grant should succeed normally");

    const credsPath = path.join(home, ".config", "butterstack", "credentials.json");
    assert.ok(fs.existsSync(credsPath));
    const saved = JSON.parse(fs.readFileSync(credsPath, "utf-8"));
    assert.equal(saved.token, "fake-issued-token");

    // The host used for this login is persisted so later commands without
    // --host still target it.
    const configPath = path.join(home, ".config", "butterstack", "config.json");
    assert.ok(fs.existsSync(configPath), "saveConfig() should have persisted the login host to config.json");
    const savedConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    assert.equal(savedConfig.host, `http://127.0.0.1:${port}`);
  } finally {
    await stopCaptureServer(server);
    rmHome(home);
  }
});
