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
  // No real browser from a test. Set before the overrides so a test can opt out.
  const fullEnv = { ...process.env, BUTTERSTACK_NO_BROWSER: "1", HOME: env.home };
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

// -- #1938: the builds read path ---------------------------------------------
//
// Three defects, all of which made a build's data look absent rather than
// unreachable: `builds show` was never wired into the dispatcher (silent
// exit 0), `--json` before a positional swallowed it as the flag's value,
// and there was no GET counterpart to `investigate`, so checking a result
// meant paying for a new one.

// A server that answers the build endpoints with fixed JSON and records
// every request, so a test can assert on the METHOD used, not just output.
function startApiServer(routes) {
  const requests = createQueue();
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    const key = `${req.method} ${req.url.split("?")[0]}`;
    const route = routes[key];
    const status = route ? route.status || 200 : 404;
    const body = JSON.stringify(route ? route.body : { error: "not_found", message: "no route" });
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, requests }));
  });
}

const BUILD_ID = "aeae7611-6d48-4601-8654-80169314e5ec";

const BUILD_DETAIL = {
  id: BUILD_ID,
  status: "failed",
  overall_status: "failed",
  build_type: "custom",
  target_type: null,
  commit_hash: "p4-207",
  ci_job_name: "PilotLight_Verify",
  duration: 0.764199,
  created_at: "2026-09-18T10:55:02-04:00",
  log_available: false,
  log_unavailable_reason:
    "TeamCity cannot be polled by ButterStack, so its logs must be pushed on the webhook payload as `logs_tail`.",
  steps: [{ step_type: "external_build", status: "failed", duration: null, message: "TeamCity build failed" }],
  investigation: null
};

const INVESTIGATION = {
  investigation_id: "inv-1",
  status: "completed",
  diagnosis_category: "compile_error",
  severity: "high",
  confidence: "medium",
  summary: "Godot parse error in main.gd",
  diagnosis: "main.gd calls show_results() with 7 arguments against a 6-parameter definition.",
  suggested_fix: "Reconcile screen_flow.gd with the current show_results() signature.",
  attributed_user_id: null,
  attributed_changelist: null,
  affected_files: ["src/main.gd"],
  evidence: ["SCRIPT ERROR: Parse Error: Too many arguments"],
  error_message: null,
  steps: [{ step: 1, step_type: "tool_use", content: null }]
};

test("#1938: `builds show` renders a build instead of exiting 0 with no output", async () => {
  const home = mkHome();
  const { server, port } = await startApiServer({
    [`GET /api/v1/projects/108/build_runs/${BUILD_ID}`]: { body: BUILD_DETAIL }
  });
  try {
    writeCredentials(home, { host: `http://127.0.0.1:${port}` });
    const { stdout, success } = await runButter(["builds", "show", BUILD_ID, "--project", "108"], { home });

    assert.equal(success, true);
    assert.ok(stdout.includes(BUILD_ID), "the build id should be printed");
    assert.ok(stdout.includes("PilotLight_Verify"), "the job name should be printed");
    assert.ok(stdout.includes("p4-207"), "the commit should be printed");
    assert.ok(stdout.trim().length > 0, "the whole defect was that this printed nothing");
  } finally {
    await stopCaptureServer(server);
    rmHome(home);
  }
});

test("#1940: `builds show` says the build log is missing, and why", async () => {
  const home = mkHome();
  const { server, port } = await startApiServer({
    [`GET /api/v1/projects/108/build_runs/${BUILD_ID}`]: { body: BUILD_DETAIL }
  });
  try {
    writeCredentials(home, { host: `http://127.0.0.1:${port}` });
    const { stdout } = await runButter(["builds", "show", BUILD_ID, "--project", "108"], { home });

    assert.ok(stdout.includes("not available"), "a missing log must be called out");
    assert.ok(stdout.includes("logs_tail"), "and the reason must name the fix");
  } finally {
    await stopCaptureServer(server);
    rmHome(home);
  }
});

test("#1938: a boolean flag before a positional no longer swallows it", async () => {
  const home = mkHome();
  const { server, port } = await startApiServer({
    [`GET /api/v1/projects/108/build_runs/${BUILD_ID}`]: { body: BUILD_DETAIL }
  });
  try {
    writeCredentials(home, { host: `http://127.0.0.1:${port}` });

    // --json BEFORE the build id: the exact shape that used to parse as
    // json: "<build id>" and leave no positional argument behind.
    const before = await runButter(["builds", "show", "--json", BUILD_ID, "--project", "108"], { home });
    assert.equal(before.success, true, `expected success, got stderr: ${before.stderr}`);
    assert.equal(JSON.parse(before.stdout).id, BUILD_ID);

    // ...and after it, which always worked, must keep working.
    const after = await runButter(["builds", "show", BUILD_ID, "--project", "108", "--json"], { home });
    assert.equal(after.success, true);
    assert.equal(JSON.parse(after.stdout).id, BUILD_ID);
  } finally {
    await stopCaptureServer(server);
    rmHome(home);
  }
});

test("#1938: `builds investigation` reads the result with GET, never POST", async () => {
  const home = mkHome();
  const { server, port, requests } = await startApiServer({
    [`GET /api/v1/projects/108/build_runs/${BUILD_ID}/investigation`]: { body: INVESTIGATION }
  });
  try {
    writeCredentials(home, { host: `http://127.0.0.1:${port}` });
    const { stdout, success } = await runButter(
      ["builds", "investigation", BUILD_ID, "--project", "108"],
      { home }
    );

    assert.equal(success, true);
    assert.ok(stdout.includes("Godot parse error in main.gd"));
    assert.ok(stdout.includes("compile_error"));

    const req = await requests.pop(2000);
    assert.equal(req.method, "GET", "reading a result must not be a POST -- a POST is a paid AI call");
    assert.ok(req.url.endsWith("/investigation"));
  } finally {
    await stopCaptureServer(server);
    rmHome(home);
  }
});

test("#1940: an unattributed investigation prints 'unattributed', not a guess", async () => {
  const home = mkHome();
  const { server, port } = await startApiServer({
    [`GET /api/v1/projects/108/build_runs/${BUILD_ID}/investigation`]: { body: INVESTIGATION }
  });
  try {
    writeCredentials(home, { host: `http://127.0.0.1:${port}` });
    const { stdout } = await runButter(["builds", "investigation", BUILD_ID, "--project", "108"], { home });
    assert.ok(stdout.includes("unattributed"));
  } finally {
    await stopCaptureServer(server);
    rmHome(home);
  }
});

test("#1938: a missing investigation is an explicit message, not an empty success", async () => {
  const home = mkHome();
  const { server, port } = await startApiServer({});
  try {
    writeCredentials(home, { host: `http://127.0.0.1:${port}` });
    const { stderr, success } = await runButter(
      ["builds", "investigation", BUILD_ID, "--project", "108"],
      { home }
    );

    assert.equal(success, false, "nothing to read is a failure exit, not a silent 0");
    assert.ok(stderr.includes("No investigation has been run"));
  } finally {
    await stopCaptureServer(server);
    rmHome(home);
  }
});

test("#1938: an unknown subcommand fails loudly instead of exiting 0 silently", async () => {
  const home = mkHome();
  try {
    const { stderr, success } = await runButter(["builds", "frobnicate", "--project", "108"], { home });
    assert.equal(success, false);
    assert.ok(stderr.includes("Unknown subcommand"));
  } finally {
    rmHome(home);
  }
});

test("#1938: a server with no investigation key is not reported as 'no investigation'", async () => {
  const home = mkHome();
  const { investigation, ...withoutKey } = BUILD_DETAIL; // eslint-disable-line no-unused-vars
  const { server, port } = await startApiServer({
    [`GET /api/v1/projects/108/build_runs/${BUILD_ID}`]: { body: withoutKey }
  });
  try {
    writeCredentials(home, { host: `http://127.0.0.1:${port}` });
    const { stdout } = await runButter(["builds", "show", BUILD_ID, "--project", "108"], { home });

    assert.ok(stdout.includes("does not expose investigations"));
    assert.ok(
      !stdout.includes("No AI investigation has been run"),
      "an old server must not be reported as a build with no investigation"
    );
  } finally {
    await stopCaptureServer(server);
    rmHome(home);
  }
});

// -- #6: `projects show` was advertised in help but never dispatched ---------

const PROJECT_DETAIL = {
  id: 108,
  name: "PilotLight",
  project_type: "godot",
  tasks_count: 12,
  build_runs_count: 34,
  assets_count: 56,
  pending_assets_count: 3,
  latest_build: {
    id: BUILD_ID,
    status: "failed",
    target_type: null,
    commit_hash: "p4-207",
    duration: 0.764199,
    created_at: "2026-09-18T10:55:02-04:00"
  }
};

test("#6: `projects show` renders a project instead of failing as an unknown subcommand", async () => {
  const home = mkHome();
  const { server, port, requests } = await startApiServer({
    "GET /api/v1/projects/108": { body: PROJECT_DETAIL }
  });
  try {
    writeCredentials(home, { host: `http://127.0.0.1:${port}` });
    const { stdout, stderr, success } = await runButter(["projects", "show", "108"], { home });

    assert.equal(success, true, `expected success, got stderr: ${stderr}`);
    assert.ok(!stderr.includes("Unknown subcommand"));
    assert.ok(stdout.includes("PROJECT 108"), "the project id should be printed");
    assert.ok(stdout.includes("PilotLight"), "the project name should be printed");
    assert.ok(stdout.includes("godot"), "the project type should be printed");
    assert.ok(stdout.includes(BUILD_ID), "the latest build should be printed");
    assert.ok(stdout.includes("p4-207"), "the latest build's commit should be printed");

    const req = await requests.pop(2000);
    assert.equal(req.method, "GET");
    assert.equal(req.url, "/api/v1/projects/108");
  } finally {
    await stopCaptureServer(server);
    rmHome(home);
  }
});

test("#6: `projects show` says 'none' when the project has no builds", async () => {
  const home = mkHome();
  const { server, port } = await startApiServer({
    "GET /api/v1/projects/108": { body: { ...PROJECT_DETAIL, latest_build: null } }
  });
  try {
    writeCredentials(home, { host: `http://127.0.0.1:${port}` });
    const { stdout, success } = await runButter(["projects", "show", "108"], { home });
    assert.equal(success, true);
    assert.match(stdout, /Latest build:\s+(\x1b\[[0-9;]*m)*none/);
  } finally {
    await stopCaptureServer(server);
    rmHome(home);
  }
});

test("#6: `projects show --json` works with the flag on either side of the id", async () => {
  const home = mkHome();
  const { server, port } = await startApiServer({
    "GET /api/v1/projects/108": { body: PROJECT_DETAIL }
  });
  try {
    writeCredentials(home, { host: `http://127.0.0.1:${port}` });

    const before = await runButter(["projects", "show", "--json", "108"], { home });
    assert.equal(before.success, true, `expected success, got stderr: ${before.stderr}`);
    assert.deepEqual(JSON.parse(before.stdout), PROJECT_DETAIL);

    const after = await runButter(["projects", "show", "108", "--json"], { home });
    assert.equal(after.success, true, `expected success, got stderr: ${after.stderr}`);
    assert.deepEqual(JSON.parse(after.stdout), PROJECT_DETAIL);
  } finally {
    await stopCaptureServer(server);
    rmHome(home);
  }
});

test("#6: `projects show` without an id prints usage and exits non-zero", async () => {
  const home = mkHome();
  try {
    const { stderr, success } = await runButter(["projects", "show"], { home });
    assert.equal(success, false);
    assert.ok(stderr.includes("Usage: butter projects show"));
  } finally {
    rmHome(home);
  }
});

test("#6: `projects show` for a missing project fails loudly", async () => {
  const home = mkHome();
  const { server, port } = await startApiServer({
    "GET /api/v1/projects/999": { status: 404, body: { error: "Project not found" } }
  });
  try {
    writeCredentials(home, { host: `http://127.0.0.1:${port}` });
    const { stderr, success } = await runButter(["projects", "show", "999"], { home });
    assert.equal(success, false);
    assert.ok(stderr.includes("Failed to show project"));
    assert.ok(stderr.includes("Project not found"), "the server's error should be surfaced");
  } finally {
    await stopCaptureServer(server);
    rmHome(home);
  }
});

// buildEnv sets BUTTERSTACK_NO_BROWSER for every test; this pins that the
// binary honors it.
// Buffers the child's full stdout, so tests can assert on the whole block.
function captureStdout(child) {
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  return () => out;
}

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// readAuthUrl's (\S+) swallows the trailing ANSI reset. Fine for `new URL()`,
// fatal for string comparison.
function cleanUrl(u) {
  return stripAnsi(u);
}

// -- changes: the read path for commits and changelists ----------------------
//
// The changes API existed with no client. A build carries a commit_hash, and
// these commands are how that hash is resolved to the change it belongs to
// without the web UI.

const GIT_SHA = "3f9c2a7be41d5e6f7a8b9c0d1e2f3a4b5c6d7e8f";

const CHANGES_PAGE = {
  changes: [
    {
      id: 456,
      identifier: "207",
      display_identifier: "#207",
      source_type: "Changelist",
      author: "jdoe",
      description: "Fix spawn timing\n\nLonger body",
      timestamp: "2026-09-18T10:50:00Z",
      orphaned_at: null,
      file_count: 3,
      approval_count: 1
    },
    {
      id: 457,
      identifier: "lore-12",
      display_identifier: "lore-12",
      source_type: "Changelist",
      author: "asmith",
      description: "Lore revision",
      timestamp: "2026-09-18T11:00:00Z",
      orphaned_at: null,
      file_count: 1,
      approval_count: 0
    },
    {
      id: 458,
      identifier: GIT_SHA,
      display_identifier: "3f9c2a7",
      source_type: "GitCommit",
      author: "kdev",
      description: "Ghost commit",
      timestamp: "2026-09-18T12:00:00Z",
      orphaned_at: "2026-09-19T00:00:00Z",
      file_count: null,
      approval_count: 0
    }
  ],
  pagination: { limit: 20, has_more: true, next_cursor: "CURSOR123" }
};

const CHANGE_DETAIL = {
  ...CHANGES_PAGE.changes[0],
  files: [{ path: "//depot/Game/main.gd", action: "edit" }],
  files_available: true,
  approvals: { pending: 0, approved: 1, denied: 0, ignored: 0 },
  build_runs: [{ id: BUILD_ID, status: "failed", commit_hash: "p4-207", ci_job_name: "PilotLight_Verify" }],
  latest_build: { id: BUILD_ID, status: "failed", commit_hash: "p4-207", ci_job_name: "PilotLight_Verify" },
  task_ids: [12]
};

test("changes: `changes list` renders a project's changes and says how to get the next page", async () => {
  const home = mkHome();
  const { server, port, requests } = await startApiServer({
    "GET /api/v1/projects/108/changes": { body: CHANGES_PAGE }
  });
  try {
    writeCredentials(home, { host: `http://127.0.0.1:${port}` });
    const { stdout, stderr, success } = await runButter(["changes", "list", "--project", "108"], { home });

    assert.equal(success, true, `expected success, got stderr: ${stderr}`);
    const out = stripAnsi(stdout);
    assert.ok(out.includes("CHANGES for Project #108 (3)"));
    assert.match(out, /Change #456\s+\[perforce\] #207 jdoe Fix spawn timing/);
    assert.ok(!out.includes("Longer body"), "only the first line of the description belongs in the list");
    assert.match(out, /\[lore\] lore-12/);
    assert.match(out, /\[git\] 3f9c2a7 kdev Ghost commit \(orphaned\)/);
    assert.ok(out.includes("--after CURSOR123"), "a caller needs the cursor to reach the next page");

    const req = await requests.pop(2000);
    assert.equal(req.url, "/api/v1/projects/108/changes");
  } finally {
    await stopCaptureServer(server);
    rmHome(home);
  }
});

test("changes: `changes list` maps its flags onto the API's query params", async () => {
  const home = mkHome();
  const { server, port, requests } = await startApiServer({
    "GET /api/v1/projects/108/changes": { body: CHANGES_PAGE }
  });
  try {
    writeCredentials(home, { host: `http://127.0.0.1:${port}` });
    const { success } = await runButter(
      ["changes", "list", "--project", "108", "--source", "git", "--since", "2026-09-01", "--limit", "5", "--orphaned", "--after", "abc"],
      { home }
    );
    assert.equal(success, true);

    const req = await requests.pop(2000);
    const params = new URL(req.url, "http://x").searchParams;
    assert.equal(params.get("source_type"), "GitCommit");
    assert.equal(params.get("updated_since"), "2026-09-01");
    assert.equal(params.get("limit"), "5");
    assert.equal(params.get("orphaned"), "true");
    assert.equal(params.get("cursor"), "abc");
  } finally {
    await stopCaptureServer(server);
    rmHome(home);
  }
});

test("changes: --source lore and --source perforce split the shared Changelist type", async () => {
  const home = mkHome();
  const { server, port, requests } = await startApiServer({
    "GET /api/v1/projects/108/changes": { body: CHANGES_PAGE }
  });
  try {
    writeCredentials(home, { host: `http://127.0.0.1:${port}` });

    const lore = await runButter(["changes", "list", "--project", "108", "--source", "lore", "--json"], { home });
    assert.equal(lore.success, true);
    assert.deepEqual(JSON.parse(lore.stdout).changes.map((c) => c.id), [457]);
    const loreReq = await requests.pop(2000);
    assert.equal(new URL(loreReq.url, "http://x").searchParams.get("source_type"), "Changelist");

    const p4 = await runButter(["changes", "list", "--project", "108", "--source", "perforce", "--json"], { home });
    assert.equal(p4.success, true);
    assert.deepEqual(JSON.parse(p4.stdout).changes.map((c) => c.id), [456]);
  } finally {
    await stopCaptureServer(server);
    rmHome(home);
  }
});

test("changes: `changes list --json` keeps the pagination envelope", async () => {
  const home = mkHome();
  const { server, port } = await startApiServer({
    "GET /api/v1/projects/108/changes": { body: CHANGES_PAGE }
  });
  try {
    writeCredentials(home, { host: `http://127.0.0.1:${port}` });
    const { stdout, success } = await runButter(["changes", "list", "--json", "--project", "108"], { home });
    assert.equal(success, true);
    assert.deepEqual(JSON.parse(stdout), CHANGES_PAGE);
  } finally {
    await stopCaptureServer(server);
    rmHome(home);
  }
});

test("changes: an unknown --source fails loudly and sends nothing", async () => {
  const home = mkHome();
  const { server, port, requests } = await startApiServer({});
  try {
    writeCredentials(home, { host: `http://127.0.0.1:${port}` });
    const { stderr, success } = await runButter(["changes", "list", "--project", "108", "--source", "svn"], { home });
    assert.equal(success, false);
    assert.ok(stderr.includes('Unknown --source "svn"'));
    assert.equal(await requests.pop(200), null, "no request should be sent for a bad flag");
  } finally {
    await stopCaptureServer(server);
    rmHome(home);
  }
});

test("changes: `changes show <id>` renders one change with its builds and files", async () => {
  const home = mkHome();
  const { server, port, requests } = await startApiServer({
    "GET /api/v1/projects/108/changes/456": { body: CHANGE_DETAIL }
  });
  try {
    writeCredentials(home, { host: `http://127.0.0.1:${port}` });
    const { stdout, stderr, success } = await runButter(["changes", "show", "456", "--project", "108"], { home });

    assert.equal(success, true, `expected success, got stderr: ${stderr}`);
    const out = stripAnsi(stdout);
    assert.ok(out.includes("CHANGE 456"));
    assert.match(out, /Identifier:\s+207/);
    assert.match(out, /Source:\s+perforce \(Changelist\)/);
    assert.match(out, /Approvals:\s+1 approved, 0 pending/);
    assert.match(out, /Tasks:\s+#12/);
    assert.ok(out.includes("Longer body"), "the full description belongs on the detail view");
    assert.ok(out.includes(BUILD_ID), "linked builds should be listed");
    assert.ok(out.includes("//depot/Game/main.gd"), "files should be listed");

    const req = await requests.pop(2000);
    assert.equal(req.url, "/api/v1/projects/108/changes/456");
  } finally {
    await stopCaptureServer(server);
    rmHome(home);
  }
});

test("changes: `changes show p4-<n>` resolves a Perforce build's commit to its change", async () => {
  const home = mkHome();
  const { server, port, requests } = await startApiServer({
    "GET /api/v1/projects/108/changes": { body: { changes: [CHANGES_PAGE.changes[0]], pagination: { has_more: false } } },
    "GET /api/v1/projects/108/changes/456": { body: CHANGE_DETAIL }
  });
  try {
    writeCredentials(home, { host: `http://127.0.0.1:${port}` });
    const { stdout, stderr, success } = await runButter(["changes", "show", "p4-207", "--project", "108"], { home });
    assert.equal(success, true, `expected success, got stderr: ${stderr}`);
    assert.ok(stripAnsi(stdout).includes("CHANGE 456"));

    // The change stores the bare number, so "p4-207" verbatim would match nothing.
    const lookup = await requests.pop(2000);
    const params = new URL(lookup.url, "http://x").searchParams;
    assert.equal(params.get("identifier"), "207");
    assert.equal(params.get("source_type"), "Changelist");
    assert.equal(params.get("orphaned"), "true", "a build's commit can belong to an orphaned change");

    const detail = await requests.pop(2000);
    assert.equal(detail.url, "/api/v1/projects/108/changes/456");
  } finally {
    await stopCaptureServer(server);
    rmHome(home);
  }
});

test("changes: `changes show <sha> --json` resolves a git commit and prints the detail", async () => {
  const home = mkHome();
  const gitDetail = { ...CHANGE_DETAIL, id: 458, identifier: GIT_SHA, source_type: "GitCommit" };
  const { server, port, requests } = await startApiServer({
    "GET /api/v1/projects/108/changes": { body: { changes: [CHANGES_PAGE.changes[2]], pagination: { has_more: false } } },
    "GET /api/v1/projects/108/changes/458": { body: gitDetail }
  });
  try {
    writeCredentials(home, { host: `http://127.0.0.1:${port}` });
    const { stdout, success } = await runButter(["changes", "show", "--json", GIT_SHA, "--project", "108"], { home });
    assert.equal(success, true);
    assert.deepEqual(JSON.parse(stdout), gitDetail);

    const lookup = await requests.pop(2000);
    const params = new URL(lookup.url, "http://x").searchParams;
    assert.equal(params.get("identifier"), GIT_SHA);
    assert.equal(params.get("source_type"), null);
  } finally {
    await stopCaptureServer(server);
    rmHome(home);
  }
});

test("changes: a commit with no matching change fails loudly instead of printing nothing", async () => {
  const home = mkHome();
  const { server, port } = await startApiServer({
    "GET /api/v1/projects/108/changes": { body: { changes: [], pagination: { has_more: false } } }
  });
  try {
    writeCredentials(home, { host: `http://127.0.0.1:${port}` });
    const { stderr, success } = await runButter(["changes", "show", "deadbeef", "--project", "108"], { home });
    assert.equal(success, false);
    assert.ok(stderr.includes('No change with identifier "deadbeef" in project 108'));
  } finally {
    await stopCaptureServer(server);
    rmHome(home);
  }
});

test("changes: a token without read:changes is told to log in again", async () => {
  const home = mkHome();
  const { server, port } = await startApiServer({
    "GET /api/v1/projects/108/changes": {
      status: 403,
      body: { error: "insufficient_scope", required_scope: "read:changes", token_scopes: ["read:builds"] }
    }
  });
  try {
    writeCredentials(home, { host: `http://127.0.0.1:${port}` });
    const { stderr, success } = await runButter(["changes", "list", "--project", "108"], { home });
    assert.equal(success, false);
    assert.ok(stderr.includes("insufficient_scope"));
    assert.ok(stderr.includes("butter auth login"), "the fix for an old token should be named");
  } finally {
    await stopCaptureServer(server);
    rmHome(home);
  }
});

test("changes: `changes show` without an id prints usage and exits non-zero", async () => {
  const home = mkHome();
  try {
    const { stderr, success } = await runButter(["changes", "show", "--project", "108"], { home });
    assert.equal(success, false);
    assert.ok(stderr.includes("Usage: butter changes show"));
  } finally {
    rmHome(home);
  }
});

test("changes: `builds show` points at the change for the build's commit", async () => {
  const home = mkHome();
  const { server, port } = await startApiServer({
    [`GET /api/v1/projects/108/build_runs/${BUILD_ID}`]: { body: BUILD_DETAIL }
  });
  try {
    writeCredentials(home, { host: `http://127.0.0.1:${port}` });
    const { stdout, success } = await runButter(["builds", "show", BUILD_ID, "--project", "108"], { home });
    assert.equal(success, true);
    assert.ok(stripAnsi(stdout).includes("butter changes show p4-207 --project 108"));
  } finally {
    await stopCaptureServer(server);
    rmHome(home);
  }
});

test("auth login prints the URL exactly once, and does not claim to open a browser", async () => {
  const home = mkHome();
  const { server, port } = await startCaptureServer();
  try {
    const child = spawn(
      process.execPath,
      [BUTTER_BIN, "auth", "login", "--host", `http://127.0.0.1:${port}`],
      { env: buildEnv({ home }) }
    );
    const readOut = captureStdout(child);

    const authUrl = cleanUrl(await readAuthUrl(child));
    const parsed = new URL(authUrl);
    await hitCallback(
      `http://127.0.0.1:${parsed.searchParams.get("port")}/callback?code=c&state=${parsed.searchParams.get("state")}`
    );
    await waitForExit(child);

    const out = stripAnsi(readOut());

    // Printed twice before the fix: authLogin's line, then openBrowser's.
    const occurrences = out.split(authUrl).length - 1;
    assert.equal(occurrences, 1, `the auth URL should appear exactly once, saw ${occurrences}:\n${out}`);

    assert.ok(
      !out.includes("Opening your browser"),
      `must not claim to open a browser when BUTTERSTACK_NO_BROWSER is set:\n${out}`
    );
    assert.ok(out.includes("Visit this URL to authorize:"), `expected the no-browser prompt:\n${out}`);

    // Those belong to the spawn-failure path, not this one.
    assert.ok(!out.includes("Could not automatically open browser"), out);
    assert.ok(!out.includes("Please visit this URL to authenticate"), out);
  } finally {
    await stopCaptureServer(server);
    rmHome(home);
  }
});

test("the no-browser prompt replaces the browser line rather than adding to it", async () => {
  const home = mkHome();
  const { server, port } = await startCaptureServer();
  try {
    const child = spawn(
      process.execPath,
      [BUTTER_BIN, "auth", "login", "--host", `http://127.0.0.1:${port}`],
      { env: buildEnv({ home }) }
    );
    const readOut = captureStdout(child);
    const authUrl = cleanUrl(await readAuthUrl(child));
    const parsed = new URL(authUrl);
    await hitCallback(
      `http://127.0.0.1:${parsed.searchParams.get("port")}/callback?code=c&state=${parsed.searchParams.get("state")}`
    );
    await waitForExit(child);

    const lines = stripAnsi(readOut()).split("\n").map((l) => l.trim()).filter(Boolean);

    const intro = lines.filter((l) => /^Visit this URL to authorize:$/.test(l));
    const urlLines = lines.filter((l) => l.startsWith("URL: "));
    assert.equal(intro.length, 1, `expected one intro line, got ${intro.length}:\n${lines.join("\n")}`);
    assert.equal(urlLines.length, 1, `expected one URL line, got ${urlLines.length}:\n${lines.join("\n")}`);
    assert.equal(urlLines[0], `URL: ${authUrl}`);
  } finally {
    await stopCaptureServer(server);
    rmHome(home);
  }
});

test("auth login honors BUTTERSTACK_NO_BROWSER and prints the URL instead", async () => {
  const home = mkHome();
  const { server, port } = await startCaptureServer();
  try {
    const child = spawn(
      process.execPath,
      [BUTTER_BIN, "auth", "login", "--host", `http://127.0.0.1:${port}`],
      { env: buildEnv({ home }) }
    );

    const authUrl = await readAuthUrl(child);
    assert.ok(authUrl.startsWith("http://127.0.0.1:"), "the URL must still be printed for the user");

    let stdout = "";
    child.stdout.on("data", (c) => (stdout += c));

    const parsed = new URL(authUrl);
    await hitCallback(
      `http://127.0.0.1:${parsed.searchParams.get("port")}/callback?code=c&state=${parsed.searchParams.get("state")}`
    );
    await waitForExit(child);

    assert.ok(
      !stdout.includes("Could not automatically open browser"),
      "the no-browser path must not fall through to the spawn-error branch"
    );
  } finally {
    await stopCaptureServer(server);
    rmHome(home);
  }
});

// The branch a real user hits. A shim `open`/`xdg-open` first on PATH records
// its argv, so the real path runs and nothing launches.
test("without the flag, auth login says it is opening a browser and hands it the URL", async () => {
  const home = mkHome();
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "butter-shim-"));
  const argvLog = path.join(shimDir, "argv.txt");
  const shimName = process.platform === "darwin" ? "open" : "xdg-open";
  fs.writeFileSync(
    path.join(shimDir, shimName),
    `#!/bin/sh\nprintf '%s\\n' "$1" >> ${JSON.stringify(argvLog)}\n`,
    { mode: 0o755 }
  );

  const { server, port } = await startCaptureServer();
  try {
    const child = spawn(process.execPath, [BUTTER_BIN, "auth", "login", "--host", `http://127.0.0.1:${port}`], {
      env: {
        ...buildEnv({ home, overrides: { BUTTERSTACK_NO_BROWSER: null } }),
        PATH: `${shimDir}:${process.env.PATH}`
      }
    });
    const readOut = captureStdout(child);

    const authUrl = cleanUrl(await readAuthUrl(child));
    const parsed = new URL(authUrl);
    await hitCallback(
      `http://127.0.0.1:${parsed.searchParams.get("port")}/callback?code=c&state=${parsed.searchParams.get("state")}`
    );
    await waitForExit(child);

    const out = stripAnsi(readOut());
    assert.ok(out.includes("Opening your browser"), `expected the browser line:\n${out}`);
    assert.ok(!out.includes("Visit this URL to authorize:"), `no-browser prompt must not appear:\n${out}`);

    assert.equal(out.split(authUrl).length - 1, 1, `URL should appear once:\n${out}`);

    // openBrowser spawns without waiting, so the shim may still be writing.
    for (let i = 0; i < 50 && !fs.existsSync(argvLog); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(fs.existsSync(argvLog), "the browser helper should have been spawned");
    const handed = stripAnsi(fs.readFileSync(argvLog, "utf-8")).trim();
    assert.equal(handed, authUrl, "the browser must receive the URL that was printed");
  } finally {
    await stopCaptureServer(server);
    fs.rmSync(shimDir, { recursive: true, force: true });
    rmHome(home);
  }
});

// -- #7: MCP client setup ----------------------------------------------------
//
// Every `mcp install` case runs against a temp HOME, so no test can touch a
// real client config.

const { parseJsonc } = require(BUTTER_BIN);

const OPENCODE_ENTRY = { type: "local", command: ["npx", "-y", "butterstack-mcp"], enabled: true };
const CLAUDE_SHAPE_ENTRY = { command: "npx", args: ["-y", "butterstack-mcp"] };

function opencodeDir(home) {
  return path.join(home, ".config", "opencode");
}

test("#7: parseJsonc strips comments and trailing commas, but never inside strings", () => {
  const text = [
    "﻿{",
    "  // a line comment",
    '  "url": "https://example.com/a//b", /* inline */',
    '  "glob": "src/**/*.ts",',
    '  "quote": "say \\"hi\\" // not a comment",',
    '  "comma": ",}",',
    '  "list": [1, 2, 3,],',
    '  "nested": { "a": 1, },',
    "  /* a",
    "     block */",
    "}"
  ].join("\n");
  const { value, hadComments } = parseJsonc(text);
  assert.equal(hadComments, true);
  assert.deepEqual(value, {
    url: "https://example.com/a//b",
    glob: "src/**/*.ts",
    quote: 'say "hi" // not a comment',
    comma: ",}",
    list: [1, 2, 3],
    nested: { a: 1 }
  });

  assert.equal(parseJsonc('{"a": [1,],}').hadComments, false, "trailing commas alone are not comments");
  assert.throws(() => parseJsonc('{"a": 1 /* never closed'), /Unterminated/);
  assert.throws(() => parseJsonc('{"a": }'), SyntaxError);
});

test("#7: mcp install fixes a wrong-shaped OpenCode entry, keeps everything else, and is idempotent", async () => {
  const home = mkHome();
  try {
    const file = path.join(opencodeDir(home), "opencode.json");
    fs.mkdirSync(opencodeDir(home), { recursive: true });
    // The Claude-shaped entry that makes OpenCode refuse to start.
    fs.writeFileSync(
      file,
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        theme: "dark",
        mcp: { other: { type: "local", command: ["other-mcp"], enabled: true }, butterstack: { command: "butterstack-mcp" } }
      })
    );

    const first = await runButter(["mcp", "install", "--opencode"], { home });
    assert.equal(first.success, true, first.stderr);
    assert.ok(stripAnsi(first.stdout).includes(file), `the written file should be printed:\n${first.stdout}`);

    const written = JSON.parse(fs.readFileSync(file, "utf-8"));
    assert.deepEqual(written.mcp.butterstack, OPENCODE_ENTRY);
    assert.deepEqual(written.mcp.other, { type: "local", command: ["other-mcp"], enabled: true }, "other servers must survive");
    assert.equal(written.theme, "dark");
    assert.equal(written.$schema, "https://opencode.ai/config.json");
    assert.deepEqual(Object.keys(written.mcp), ["other", "butterstack"], "no duplicate, and the entry stays in place");

    const before = fs.readFileSync(file, "utf-8");
    const second = await runButter(["mcp", "install", "--opencode"], { home });
    assert.equal(second.success, true);
    assert.match(stripAnsi(second.stdout), /OpenCode: already configured/);
    assert.equal(fs.readFileSync(file, "utf-8"), before, "a re-run must not rewrite the file");
  } finally {
    rmHome(home);
  }
});

test("#7: mcp install --cursor creates ~/.cursor/mcp.json when it does not exist", async () => {
  const home = mkHome();
  try {
    const file = path.join(home, ".cursor", "mcp.json");
    const { stdout, success } = await runButter(["mcp", "install", "--cursor"], { home });
    assert.equal(success, true);
    assert.ok(stripAnsi(stdout).includes(`created ${file}`), stdout);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf-8")), { mcpServers: { butterstack: CLAUDE_SHAPE_ENTRY } });
    assert.equal(fs.existsSync(opencodeDir(home)), false, "a client flag limits the install to that client");
  } finally {
    rmHome(home);
  }
});

test("#7: with no flag, mcp install configures only the clients that are installed", async () => {
  const home = mkHome();
  try {
    fs.mkdirSync(path.join(home, ".cursor"));
    const { success } = await runButter(["mcp", "install"], { home });
    assert.equal(success, true);
    assert.ok(fs.existsSync(path.join(home, ".cursor", "mcp.json")));
    assert.equal(fs.existsSync(opencodeDir(home)), false, "OpenCode is not installed, so nothing is created for it");

  } finally {
    rmHome(home);
  }
});

test("#7: with no flag and no client installed, mcp install fails loudly", async () => {
  const home = mkHome();
  try {
    const { stderr, success } = await runButter(["mcp", "install"], { home });
    assert.equal(success, false);
    assert.match(stderr, /No supported AI client found/);
  } finally {
    rmHome(home);
  }
});

test("#7: a config with comments is never rewritten; the snippet and path are printed instead", async () => {
  const home = mkHome();
  try {
    const file = path.join(opencodeDir(home), "opencode.jsonc");
    fs.mkdirSync(opencodeDir(home), { recursive: true });
    const original = '{\n  // keep me\n  "theme": "dark",\n  "mcp": {},\n}\n';
    fs.writeFileSync(file, original);

    const { stdout, success } = await runButter(["mcp", "install", "--opencode"], { home });
    const out = stripAnsi(stdout);
    assert.equal(success, true, "printing the snippet is a normal outcome, not a failure");
    assert.equal(fs.readFileSync(file, "utf-8"), original, "the commented file must be left byte-for-byte");
    assert.ok(out.includes(file), `the path to edit should be printed:\n${out}`);
    assert.ok(out.includes('inside the existing "mcp" object'), out);
    assert.ok(out.includes('"type": "local"') && out.includes('"enabled": true'), `the OpenCode shape should be printed:\n${out}`);
  } finally {
    rmHome(home);
  }
});

test("#7: mcp install --dry-run writes nothing", async () => {
  const home = mkHome();
  try {
    const { stdout, success } = await runButter(["mcp", "install", "--cursor", "--opencode", "--dry-run"], { home });
    assert.equal(success, true);
    assert.match(stripAnsi(stdout), /would create .*mcp\.json/);
    assert.equal(fs.existsSync(path.join(home, ".cursor")), false);
    assert.equal(fs.existsSync(opencodeDir(home)), false);
  } finally {
    rmHome(home);
  }
});

async function loginOutput(extraArgs) {
  const { server, port } = await startFakeExchangeServer(["ping"]);
  const home = mkHome();
  try {
    const child = spawn(
      process.execPath,
      [BUTTER_BIN, "auth", "login", "--host", `http://127.0.0.1:${port}`, ...extraArgs],
      { env: buildEnv({ home }) }
    );
    const readOut = captureStdout(child);
    const parsed = new URL(cleanUrl(await readAuthUrl(child)));
    await hitCallback(
      `http://127.0.0.1:${parsed.searchParams.get("port")}/callback?code=c&state=${parsed.searchParams.get("state")}`
    );
    const { success } = await waitForExit(child);
    assert.equal(success, true);
    return stripAnsi(readOut());
  } finally {
    await stopCaptureServer(server);
    rmHome(home);
  }
}

test("#7: a successful login prints how to connect an AI client", async () => {
  const out = await loginOutput([]);
  assert.ok(out.includes("Successfully authenticated"), out);
  assert.ok(out.includes("Connect your AI client to ButterStack:"), out);
  assert.ok(out.includes("claude mcp add butterstack -- npx -y butterstack-mcp"), out);
  assert.ok(out.includes("opencode mcp add butterstack"), out);
  assert.ok(out.includes("butter mcp install"), out);
  assert.ok(out.includes("https://butterstack.com/docs/guides/mcp"), out);
});

test("#7: the MCP hint is skipped under --json", async () => {
  const out = await loginOutput(["--json"]);
  assert.ok(out.includes("Successfully authenticated"), out);
  assert.ok(!out.includes("Connect your AI client"), out);
});
