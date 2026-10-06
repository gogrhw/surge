"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
process.env.TZ = "Asia/Shanghai";
const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "Scripts/cpa-panel.js"), "utf8");
const moduleSource = fs.readFileSync(path.join(root, "Modules/cpa-panel.sgmodule"), "utf8");
const fixture = require("./Fixtures/cpa-quota.json");
const base = "https://cpa.example.com";
const key = "test-management-secret";
const now = Date.parse("2026-01-01T00:00:00Z");
let cases = 0;
const clone = (v) => JSON.parse(JSON.stringify(v));

function response(request) {
  if (request.method === "GET") return { json: clone(fixture.credentials) };
  const payload = JSON.parse(request.body);
  return { json: { status_code: 200, body: JSON.stringify(fixture.quotas[payload.auth_index]) } };
}

function start(extra = "", responder = response, options = {}) {
  const storage = options.storage || new Map();
  const requests = [], done = [], callbacks = [], timers = [], logs = [], writes = [];
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  const current = options.now || now;
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [current])); }
    static now() { return current; }
  }
  function unexpected() { const e = new Error("Unexpected management operation"); reject(e); throw e; }
  function send(method, request, callback) {
    requests.push({ ...request, method });
    callbacks.push(callback);
    try {
      const url = new URL(request.url);
      assert.equal(url.origin, options.base || base);
      assert.equal(request.headers.Authorization, "Bearer " + (options.key || key));
      assert.equal(request["auto-redirect"], false);
      assert.equal(request["auto-cookie"], false);
      assert.ok(request.timeout <= 8);
      assert.ok(!request.url.includes(key));
      if (method === "GET") {
        assert.equal(url.pathname, "/v8/management/credentials");
        assert.equal(request.body, undefined);
      } else if (url.pathname === "/v8/management/credentials/quota/fetch") {
        const q = JSON.parse(request.body);
        assert.deepEqual(Object.keys(q), ["auth_index"]);
        assert.equal(typeof q.auth_index, "string");
      } else {
        assert.equal(url.pathname, "/v8/management/requests/api-call");
        const q = JSON.parse(request.body);
        assert.equal(q.header.Authorization, "Bearer $TOKEN$");
        if (q.url === "https://chatgpt.com/backend-api/wham/usage") {
          assert.equal(q.method, "GET");
          assert.equal(q.data, undefined);
        } else {
          assert.match(q.url, /^https:\/\/(?:daily-cloudcode-pa(?:\.sandbox)?|cloudcode-pa)\.googleapis\.com\/v1internal:retrieveUserQuotaSummary$/);
          assert.equal(q.method, "POST");
          assert.deepEqual(JSON.parse(q.data), { project: "test-project" });
        }
      }
      const r = responder({ ...request, method });
      if (r.defer) return;
      queueMicrotask(() => {
        try {
          const invoke = () => callback(r.error || null, { status: r.status || 200 }, r.raw === undefined ? JSON.stringify(r.json) : r.raw);
          invoke();
          if (r.duplicate) invoke();
        } catch (e) { reject(e); }
      });
    } catch (e) { reject(e); }
  }
  const sandbox = {
    Date: FixedDate,
    $argument: options.rawArgs === undefined ? "base_url=" + base + "&management_key=" + key + "&" + extra : options.rawArgs,
    $httpClient: { get: (r, cb) => send("GET", r, cb), post: (r, cb) => send("POST", r, cb), put: unexpected, patch: unexpected, delete: unexpected },
    $persistentStore: {
      read: (name) => storage.get(name) || null,
      write(value, name) {
        assert.doesNotMatch(name, /[\/\\]/);
        assert.ok(!name.includes(key) && !value.includes(key));
        assert.doesNotMatch(value, /access_token|refresh_token|id_token|chatgpt_account_id|test-project|alice@example|bob@example|carol@example/);
        writes.push(value); storage.set(name, value); return true;
      },
    },
    $done: (panel) => { done.push(panel); resolve(panel); },
    $notification: { post: unexpected },
    setTimeout: (callback, ms) => timers.push({ callback, ms }),
    console: { log: (...args) => logs.push(args) },
  };
  try { vm.runInNewContext(source, sandbox, { timeout: 1000 }); } catch (e) { reject(e); }
  return { promise, requests, done, callbacks, timers, logs, storage, writes };
}

async function completed(h) {
  cases += 1;
  let timer;
  try {
    h.panel = await Promise.race([h.promise, new Promise((_, no) => { timer = setTimeout(() => no(new Error("script did not finish")), 1000); })]);
    await new Promise((yes) => setImmediate(yes));
  } finally { clearTimeout(timer); }
  assert.equal(h.done.length, 1);
  assert.equal(h.logs.length, 0);
  assert.deepEqual(Object.keys(h.panel).sort(), ["content", "title"]);
  assert.doesNotMatch(h.panel.content, /NaN|undefined|Infinity/);
  assert.ok(!h.panel.content.includes(key));
  return h;
}
const run = async (...args) => completed(start(...args));
function quotaResponder(id, quota, only = false) {
  return (r) => {
    if (only && r.method === "GET") return { json: { files: clone(fixture.credentials.files.filter((f) => f.auth_index === id)) } };
    return r.method === "POST" && JSON.parse(r.body).auth_index === id ? { json: { status_code: 200, body: JSON.stringify(quota) } } : response(r);
  };
}

async function main() {
  const overview = await run();
  assert.equal(overview.requests.length, 4);
  assert.equal(overview.panel.title, "CPA");
  assert.match(overview.panel.content, /3个账号/);
  assert.match(overview.panel.content, /周 剩余 70%/);
  assert.match(overview.panel.content, /5小时 剩余 100%/);
  assert.match(overview.panel.content, /周 剩余 80%/);
  assert.match(overview.panel.content, /Gemini · 周 剩余 100%/);
  assert.match(overview.panel.content, /Claude\/GPT · 5小时 剩余 100%/);
  assert.match(overview.panel.content, /gpt-reserve · 周 剩余 100%/);
  assert.match(overview.panel.content, /Credits 0/);
  assert.match(overview.panel.content, /2个厂商 · 3个账号/);
  assert.doesNotMatch(overview.panel.content, /alice@/);
  const plusRequest = overview.requests.find((r) => r.body && JSON.parse(r.body).auth_index === "codex-2");
  assert.equal(JSON.parse(plusRequest.body).header["Chatgpt-Account-Id"], "test-plus-account");

  const secretProbe = "synthetic-upstream-token-never-display";
  const privacy = await run("", (r) => {
    if (r.method === "GET") {
      const json = clone(fixture.credentials);
      json.files.forEach((f) => { f.access_token = secretProbe; f.refresh_token = secretProbe; });
      return { json };
    }
    const json = response(r).json;
    const quota = JSON.parse(json.body);
    Object.assign(quota, { access_token: secretProbe, email: "private-address@example.com", user_id: "private-user-id" });
    json.body = JSON.stringify(quota);
    return { json };
  });
  const visible = JSON.stringify([privacy.panel, privacy.writes, privacy.logs]);
  assert.ok(!visible.includes(secretProbe));
  assert.doesNotMatch(visible, /private-address|private-user-id/);
  assert.ok(privacy.requests.every((r) => !(r.body || "").includes(secretProbe)));
  const redirect = await run("", () => ({ status: 302, raw: "https://untrusted.example/" + key }));
  assert.equal(redirect.requests.length, 1);
  assert.match(redirect.panel.content, /HTTP 302/);

  const legacy = await run("mode=codex&auth_index=codex-1&max_rows=1");
  assert.equal(legacy.requests.length, 4, "old selection parameters must no longer hide providers or accounts");
  assert.equal(legacy.panel.content, overview.panel.content);
  const single = await run("", quotaResponder("codex-1", fixture.quotas["codex-1"], true));
  assert.equal(single.requests.length, 2);
  assert.doesNotMatch(single.panel.content, /5小时/);
  assert.match(single.panel.content, /周 剩余 70%/);

  const low = clone(fixture.quotas["codex-2"]);
  low.rate_limit.primary_window.used_percent = 100;
  low.rate_limit.allowed = false;
  const sorted = await run("", quotaResponder("codex-2", low));
  assert.match(sorted.panel.content, /1个需关注/);
  assert.match(sorted.panel.content, /剩余 0%/);
  assert.match(sorted.panel.content, /当前已限流/);
  assert.match(sorted.panel.content, /Antigravity ·/);
  assert.match(sorted.panel.content, /prolite/);
  assert.ok(sorted.panel.content.indexOf("plus") < sorted.panel.content.indexOf("Antigravity ·"));
  assert.equal(sorted.requests.length, 4);

  const missing = clone(fixture.quotas["codex-1"]);
  missing.rate_limit.primary_window = { used_percent: null, limit_window_seconds: null, reset_at: null };
  const unknown = await run("", quotaResponder("codex-1", missing, true));
  assert.match(unknown.panel.content, /主窗口（周期未知） 剩余 未知 · 重置时间未知/);
  assert.doesNotMatch(unknown.panel.content, /剩余 100%|剩余 0%/);
  const camel = { planType: "team", rateLimit: { primaryWindow: { usedPercent: 5, limitWindowSeconds: 2592000, resetAfterSeconds: 3600 } }, credits: { unlimited: true } };
  const monthly = await run("", quotaResponder("codex-1", camel, true));
  assert.match(monthly.panel.content, /月 剩余 95% · 1时0分后重置/);
  assert.match(monthly.panel.content, /Credits 无限额/);
  const agZero = clone(fixture.quotas["ag-1"]);
  agZero.groups[0].buckets[0].remainingFraction = 0;
  agZero.groups[0].buckets[1].remainingFraction = true;
  const agZeros = await run("", quotaResponder("ag-1", agZero, true));
  assert.match(agZeros.panel.content, /Gemini · 周 剩余 0%/);
  assert.match(agZeros.panel.content, /Gemini · 5小时 剩余 未知/);

  const withSkipped = await run("", (r) => r.method === "GET" ? { json: { files: [
    ...clone(fixture.credentials.files), { provider: "codex", auth_index: "off", disabled: true }, { provider: "claude", auth_index: "other" },
  ] } } : r.url.endsWith("/quota/fetch") ? { status: 501, json: { error: "no quota provider" } } : response(r));
  assert.equal(withSkipped.requests.length, 5);
  assert.match(withSkipped.panel.content, /3个厂商 · 5个账号/);
  assert.match(withSkipped.panel.content, /已停用（未查询）/);
  assert.match(withSkipped.panel.content, /Claude ·/);
  assert.match(withSkipped.panel.content, /暂不可查询：该厂商未提供额度接口/);
  assert.ok(!withSkipped.requests.some((r) => r.body && JSON.parse(r.body).auth_index === "off"));
  const noProject = await run("", (r) => r.method === "GET" ? { json: { files: [{ ...fixture.credentials.files[0], project_id: null }] } } : response(r));
  assert.equal(noProject.requests.length, 1);
  assert.match(noProject.panel.content, /缺少 project_id/);

  const genericQuota = {
    subscription: { tierName: "Pro" },
    groups: [{ displayName: "模型额度", buckets: [{ window: "weekly", remainingFraction: 0.75, resetTime: "2026-01-08T00:00:00Z" }] }],
    summary: [{ key: "balance", label: "余额", value: 12.5, format: "currency", currency: "USD" }],
  };
  const allProviders = ["claude", "gemini", "qwen", "kimi", "iflow", "xai", "openai", "future-provider"];
  const additional = allProviders.map((provider, i) => ({ provider, auth_index: "extra-" + i, label: provider + " account" }));
  const auto = await run("", (r) => r.method === "GET" ? { json: { files: [...clone(fixture.credentials.files), ...additional] } } :
    r.url.endsWith("/quota/fetch") ? { json: genericQuota } : response(r));
  assert.equal(auto.requests.length, 12);
  assert.match(auto.panel.content, /10个厂商 · 11个账号/);
  for (const provider of allProviders) assert.ok(auto.panel.content.includes(provider + " account"));
  assert.match(auto.panel.content, /模型额度 · 周 剩余 75%/);
  assert.match(auto.panel.content, /余额 12.5 USD/);
  assert.equal(JSON.parse([...auto.storage.values()][0]).accounts.length, 11);
  const autoOffline = await run("", () => ({ error: "offline" }), { storage: new Map(auto.storage), now: now + 600000 });
  assert.match(autoOffline.panel.content, /future-provider account/);
  assert.match(autoOffline.panel.content, /余额 12.5 USD/);
  const onlyBalance = await run("", (r) => r.method === "GET" ? { json: { files: [additional[0]] } } : { json: { summary: [{ key: "balance", value: 0, format: "currency", currency: "USD" }] } });
  assert.match(onlyBalance.panel.content, /balance 0 USD/);
  assert.doesNotMatch(onlyBalance.panel.content, /暂无有效额度数据/);

  const failure = (r) => r.method === "POST" && JSON.parse(r.body).auth_index === "codex-1" ? { json: { status_code: 401, body: JSON.stringify({ error: key }) } } : response(r);
  const partial = await run("", failure, { storage: new Map(overview.storage), now: now + 600000 });
  assert.match(partial.panel.content, /上游 HTTP 401/);
  assert.match(partial.panel.content, /缓存/);
  assert.match(partial.panel.content, /周 剩余 70%/);
  assert.match(partial.panel.content, /周 剩余 80%/);
  const storedPartial = JSON.parse([...partial.storage.values()][0]);
  assert.equal(storedPartial.accounts.find((c) => c.id === "codex-1").updatedAt, now, "failure must not renew cache age");
  const offline = await run("", () => ({ error: key }), { storage: new Map(overview.storage), now: now + 600000 });
  assert.match(offline.panel.content, /账号列表查询失败/);
  assert.match(offline.panel.content, /缓存/);
  assert.match(offline.panel.content, /周 剩余 70%/);
  assert.equal(offline.writes.length, 0);
  const expired = await run("", () => ({ error: "offline" }), { storage: new Map(overview.storage), now: now + 86400001 });
  assert.doesNotMatch(expired.panel.content, /剩余 70%/);
  const denied = await run("", () => ({ status: 401, raw: key }), { storage: new Map(overview.storage) });
  assert.doesNotMatch(denied.panel.content, /剩余/);
  assert.match(denied.panel.content, /管理密钥无效/);
  const removed = await run("", () => ({ json: { files: [] } }), { storage: new Map(overview.storage) });
  assert.doesNotMatch(removed.panel.content, /剩余/);
  assert.deepEqual(JSON.parse([...removed.storage.values()][0]).accounts, []);
  const corrupt = new Map([...overview.storage.keys()].map((k) => [k, "not-json"]));
  await run("", response, { storage: corrupt });
  const damaged = clone(JSON.parse([...overview.storage.values()][0]));
  damaged.accounts[0].data.credits = { unexpected: true };
  const damagedStorage = new Map([...overview.storage.keys()].map((k) => [k, JSON.stringify(damaged)]));
  const damagedResult = await run("", () => ({ error: "offline" }), { storage: damagedStorage });
  assert.doesNotMatch(damagedResult.panel.content, /\[object Object\]|Antigravity ·/);

  let fallbacks = 0;
  const fallback = await run("", (r) => {
    if (r.method === "GET") return { json: { files: [clone(fixture.credentials.files[0])] } };
    if (r.method === "POST" && ++fallbacks < 3) return { json: { status_code: 404, body: "{}" } };
    return response(r);
  });
  assert.equal(fallback.requests.length, 4);
  assert.match(fallback.panel.content, /剩余 100%/);
  const limited = await run("", (r) => r.method === "POST" ? { json: { status_code: 429, body: key } } : { json: { files: [clone(fixture.credentials.files[0])] } });
  assert.equal(limited.requests.length, 2);
  assert.match(limited.panel.content, /上游 HTTP 429/);
  const empty = await run("", quotaResponder("codex-1", {}, true));
  assert.match(empty.panel.content, /暂无有效额度数据/);
  const html = await run("", () => ({ raw: "<html>" + key + "</html>" }));
  assert.match(html.panel.content, /不是有效 JSON/);
  const wrongList = await run("", () => ({ json: { files: [null] } }));
  assert.match(wrongList.panel.content, /账号列表格式错误/);
  await run("", (r) => ({ ...response(r), duplicate: true }));

  const hanging = start("", (r) => r.method === "POST" ? { defer: true } : response(r));
  await new Promise((yes) => setImmediate(yes));
  assert.equal(hanging.requests.length, 4);
  hanging.timers[0].callback();
  const timed = await completed(hanging);
  assert.match(timed.panel.content, /查询超时/);
  timed.callbacks[1](null, { status: 200 }, JSON.stringify(response(timed.requests[1]).json));
  assert.equal(timed.done.length, 1);
  const listHang = start("", () => ({ defer: true }), { storage: new Map(overview.storage) });
  listHang.timers[0].callback();
  const listTimed = await completed(listHang);
  assert.match(listTimed.panel.content, /缓存/);
  assert.match(listTimed.panel.content, /剩余 70%/);

  const many = start("", (r) => r.method === "GET" ? { json: { files: Array.from({ length: 10 }, (_, i) => ({ ...fixture.credentials.files[1], auth_index: "many-" + i })) } } : { defer: true });
  await new Promise((yes) => setImmediate(yes));
  assert.equal(many.requests.length, 4, "at most three quota requests may be in flight");
  many.timers[0].callback();
  await completed(many);

  for (const invalidBase of ["http://cpa.example.com", "https://user:password@cpa.example.com", base + "/v1", base + "?token=secret"]) {
    const invalid = await run("", response, { rawArgs: "base_url=" + encodeURIComponent(invalidBase) + "&management_key=" + key });
    assert.equal(invalid.requests.length, 0);
  }
  const normalized = await run("", response, { rawArgs: "base_url=" + base + "/v8/management/&management_key=" + key });
  assert.equal(normalized.requests[0].url, base + "/v8/management/credentials");
  const specialKey = "encoded+key&percent%";
  await run("", response, { rawArgs: "base_url=" + base + "&management_key=" + encodeURIComponent(specialKey), key: specialKey });

  // Resolve module conditions as Surge does, checking both local and remote scripts.
  const defaults = Object.fromEntries(moduleSource.match(/^#!arguments=(.*)$/m)[1].split(",").map((s) => { const i = s.indexOf(":"); return [s.slice(0, i), s.slice(i + 1)]; }));
  assert.deepEqual(Object.keys(defaults), ["BASE_URL", "MANAGEMENT_KEY", "SCRIPT_PATH", "UPDATE_INTERVAL"]);
  for (const scriptPath of ["auto", "/tmp/cpa-panel.js"]) {
    const args = { ...defaults, SCRIPT_PATH: scriptPath };
    const rendered = moduleSource.replace(/\{\{\{(\w+)\}\}\}/g, (_, name) => { assert.ok(name in args); return args[name]; });
    assert.doesNotMatch(rendered, /\{\{|\}\}/);
    let section = "";
    const panels = [], scripts = [];
    for (const line of rendered.split("\n")) {
      if (/^\[/.test(line)) { section = line; continue; }
      if (!line || line.startsWith("#")) continue;
      const cond = line.match(/ #!REQUIREMENT "(.*)"$/);
      if (cond && !vm.runInNewContext(cond[1])) continue;
      if (section === "[Panel]") panels.push(line);
      if (section === "[Script]") scripts.push(line);
    }
    assert.equal(panels.length, 1);
    assert.equal(scripts.length, panels.length);
    for (const panel of panels) assert.equal(scripts.filter((s) => s.startsWith(panel.match(/script-name=([^,]+)/)[1] + " =")).length, 1);
    assert.ok(scripts.every((s) => s.includes("script-path=" + (scriptPath === "auto" ? "https://raw.githubusercontent.com/" : scriptPath))));
  }
  assert.doesNotMatch(moduleSource, /\[MITM\]|type=cron|type=http-/);
  if (process.argv.includes("--preview")) console.log(overview.panel.title + "\n" + overview.panel.content);
  console.log("CPA panel: " + cases + " scenarios passed; module variants and read-only request allowlist verified.");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
