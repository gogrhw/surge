"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
process.env.TZ = "Asia/Shanghai";
const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "Scripts/sub2api-panel.js"), "utf8");
const moduleSource = fs.readFileSync(path.join(root, "Modules/sub2api-panel.sgmodule"), "utf8");
const fixture = require("./Fixtures/sub2api-quota.json");
const base = "https://sub2api.example.com";
const key = "admin-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const now = Date.parse("2026-01-01T00:00:00Z");
let cases = 0;
const clone = (v) => JSON.parse(JSON.stringify(v));
const ok = (data) => ({ json: { code: 0, message: "success", data } });
const page = (items, pages = 1) => ok({ items, total: items.length, page: 1, page_size: 500, pages });

function batch(ids, usage = fixture.usage, errors = {}) {
  const out = { usage: {}, errors: {} };
  for (const id of ids) {
    if (errors[id]) out.errors[id] = errors[id];
    else if (usage[id]) out.usage[id] = clone(usage[id]);
  }
  return ok(out);
}
function response(request) {
  if (request.method === "GET") return page(clone(fixture.accounts));
  return batch(JSON.parse(request.body).account_ids);
}
const withAccounts = (accounts, usage = fixture.usage, errors = {}) => (r) =>
  r.method === "GET" ? page(clone(accounts)) : batch(JSON.parse(r.body).account_ids, usage, errors);

function start(responder = response, options = {}) {
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
      assert.equal(url.origin, base);
      assert.equal(request.headers["x-api-key"], options.key || key);
      assert.equal(request.headers.Authorization, undefined);
      assert.equal(request["auto-redirect"], false);
      assert.equal(request["auto-cookie"], false);
      assert.ok(request.timeout <= 20);
      assert.ok(!request.url.includes(options.key || key));
      if (method === "GET") {
        assert.equal(url.pathname, "/api/v1/admin/accounts");
        assert.equal(url.searchParams.get("page_size"), "500");
        assert.equal(request.body, undefined);
      } else {
        assert.equal(url.pathname, "/api/v1/admin/accounts/usage/batch");
        const q = JSON.parse(request.body);
        assert.deepEqual(Object.keys(q), ["account_ids", "force"]);
        assert.equal(q.force, false);
        assert.ok(q.account_ids.length > 0 && q.account_ids.length <= 10);
        assert.ok(q.account_ids.every((id) => Number.isInteger(id)));
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
    $argument: options.rawArgs === undefined ? "base_url=" + base + "&admin_api_key=" + key : options.rawArgs,
    $httpClient: { get: (r, cb) => send("GET", r, cb), post: (r, cb) => send("POST", r, cb), put: unexpected, patch: unexpected, delete: unexpected },
    $persistentStore: {
      read: (name) => storage.get(name) || null,
      write(value, name) {
        assert.doesNotMatch(name, /[\/\\]/);
        assert.ok(!name.includes(key) && !value.includes(key));
        assert.doesNotMatch(value, /access_token|redacted|session_window_utilization|alice@example|bob@example/);
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
  assert.doesNotMatch(h.panel.content, /NaN|undefined|Infinity|\[object Object\]/);
  assert.ok(!h.panel.content.includes(key));
  return h;
}
const run = async (...args) => completed(start(...args));

async function main() {
  const overview = await run();
  const c = overview.panel.content;
  assert.equal(overview.requests.length, 2);
  assert.deepEqual(JSON.parse(overview.requests[1].body).account_ids, [1, 2, 3, 4], "only accounts with a usage API are batched");
  assert.equal(overview.panel.title, "Sub2API");
  assert.match(c, /^6个平台 · 7个账号 · 1个需关注/);
  assert.match(c, /Anthropic · al\*\*\*@example\.com · OAuth\n5小时 剩余 70% · 3时0分后重置（01\/01 11:00）\n周 剩余 44.5%/);
  assert.match(c, /OpenAI · codex-plus · OAuth\n5小时 剩余 80%[^\n]*\n周 剩余 60%/);
  assert.match(c, /Antigravity · ag-ultra · Ultra\nClaude\/GPT 剩余 65% · 4时0分后重置[^\n]*\nGemini 剩余 100%[^\n]*\nCredits GOOGLE_ONE_AI 1000/);
  assert.doesNotMatch(c, /Antigravity[^\n]*\n5小时/);
  assert.match(c, /Gemini · gemini-cli · OAuth\n共享 · 日 剩余 88%/);
  assert.match(c, /DeepSeek · deepseek-key · API Key\n日额度 \$9.5\/\$10 剩余 5% · 16时0分后重置（01\/02 00:00）\n总额度 \$25\/\$100 剩余 75% · 不自动重置/);
  assert.match(c, /Kimi · kimi-key\n暂不可查询：该账号类型无额度接口/);
  assert.match(c, /OpenAI · bo\*\*\*@example\.com\n已停用（未查询）/);
  assert.ok(c.indexOf("deepseek-key") < c.indexOf("al***"), "low quota sorts first");
  assert.ok(c.indexOf("kimi-key") > c.indexOf("al***"), "unsupported accounts are not alerts");
  assert.equal(JSON.parse([...overview.storage.values()][0]).accounts.length, 5);

  const secretProbe = "synthetic-upstream-token-never-display";
  const privacy = await run((r) => {
    const out = response(r);
    if (r.method === "GET") out.json.data.items.forEach((a) => { a.credentials = { access_token: secretProbe }; a.extra = { token: secretProbe }; });
    else Object.values(out.json.data.usage).forEach((u) => Object.assign(u, { access_token: secretProbe, email: "private-address@example.com" }));
    return out;
  });
  const visible = JSON.stringify([privacy.panel, privacy.writes, privacy.logs]);
  assert.ok(!visible.includes(secretProbe));
  assert.doesNotMatch(visible, /private-address/);
  assert.ok(privacy.requests.every((r) => !(r.body || "").includes(secretProbe)));
  const echoed = await run(withAccounts([{ ...fixture.accounts[0], name: "leak " + key }]));
  assert.match(echoed.panel.content, /leak \[已隐藏\]/);
  const redirect = await run(() => ({ status: 302, raw: "https://untrusted.example/" + key }));
  assert.equal(redirect.requests.length, 1);
  assert.match(redirect.panel.content, /HTTP 302/);

  let pages = 0;
  const paged = await run((r) => {
    if (r.method === "POST") return response(r);
    const n = Number(new URL(r.url).searchParams.get("page"));
    pages += 1;
    return page(clone(fixture.accounts.slice((n - 1) * 4, n * 4)), 2);
  });
  assert.equal(pages, 2);
  assert.match(paged.panel.content, /7个账号/);
  const runaway = await run(() => page([clone(fixture.accounts[5])], 99));
  assert.equal(runaway.requests.length, 10, "pagination is capped");
  assert.match(runaway.panel.content, /1个账号/);

  const limitedAccount = { ...fixture.accounts[1], rate_limit_reset_at: "2026-01-01T01:30:00Z", overload_until: "2025-12-31T00:00:00Z" };
  const limited = await run(withAccounts([fixture.accounts[0], limitedAccount]));
  assert.match(limited.panel.content, /1个需关注/);
  assert.match(limited.panel.content, /^.*\n\nOpenAI · codex-plus · OAuth\n当前已限流 · 1时30分后解除（01\/01 09:30）/);
  assert.doesNotMatch(limited.panel.content, /过载/);
  const states = await run(withAccounts([{ ...fixture.accounts[5], status: "error", error_message: "token refresh failed", schedulable: false,
    temp_unschedulable_until: "2026-01-01T00:10:00Z", temp_unschedulable_reason: "529" }]));
  assert.match(states.panel.content, /账号异常：token refresh failed\n临时不可调度（529） · 10分后恢复\n已暂停调度/);

  const grokUsage = { 8: { grok_request_quota: { limit: 200, remaining: 50, reset_unix: 1767232800 }, grok_token_quota: { limit: 0 }, seven_day: { utilization: 10, resets_at: null } } };
  const grok = await run(withAccounts([{ id: 8, name: "grok", platform: "grok", type: "oauth", status: "active" }], grokUsage));
  assert.match(grok.panel.content, /Grok · grok · OAuth\n周 剩余 90% · 重置时间未知\n请求 剩余 25% · 2时0分后重置（01\/01 10:00）$/);
  assert.doesNotMatch(grok.panel.content, /需关注|Token/);
  const over = await run(withAccounts([fixture.accounts[0]], { 1: { five_hour: { utilization: 130, resets_at: "bad" } } }));
  assert.match(over.panel.content, /5小时 剩余 0% · 重置时间未知/);

  const reauth = await run(withAccounts([fixture.accounts[2]], { 3: { needs_reauth: true, error: "401", error_code: "unauthenticated" } }));
  assert.match(reauth.panel.content, /查询失败：需要重新授权/);
  const partialError = await run(withAccounts([fixture.accounts[2]], { 3: { ...fixture.usage[3], error_code: "rate_limited", error: "429" } }));
  assert.match(partialError.panel.content, /查询失败：上游限流\nClaude\/GPT 剩余 65%/);
  const empty = await run(withAccounts([fixture.accounts[3]], { 4: { five_hour: null } }));
  assert.match(empty.panel.content, /暂无额度数据/);
  assert.doesNotMatch(empty.panel.content, /需关注/);

  const failed = await run(withAccounts(fixture.accounts, fixture.usage, { 2: "get usage failed: " + key }), { storage: new Map(overview.storage), now: now + 600000 });
  assert.match(failed.panel.content, /OpenAI · codex-plus · OAuth\n查询失败：get usage failed: \[已隐藏\] · 缓存 01\/01 08:00\n5小时 剩余 80%/);
  assert.equal(JSON.parse([...failed.storage.values()][0]).accounts.find((a) => a.id === "2").updatedAt, now, "failure must not renew cache age");
  const missing = await run(withAccounts(fixture.accounts, {}));
  assert.match(missing.panel.content, /查询失败：未返回额度数据/);
  const batchDown = await run((r) => r.method === "POST" ? { status: 500, json: { code: 500, message: "internal" } } : response(r), { storage: new Map(overview.storage), now: now + 600000 });
  assert.match(batchDown.panel.content, /HTTP 500 · 缓存/);
  assert.match(batchDown.panel.content, /日额度 \$9.5/, "local quota does not depend on the batch call");

  const offline = await run(() => ({ error: key }), { storage: new Map(overview.storage), now: now + 600000 });
  assert.match(offline.panel.content, /账号列表查询失败：网络错误或请求超时/);
  assert.match(offline.panel.content, /账号列表未更新 · 缓存/);
  assert.match(offline.panel.content, /周 剩余 44.5%/);
  assert.equal(offline.writes.length, 0);
  const expired = await run(() => ({ error: "offline" }), { storage: new Map(overview.storage), now: now + 86400001 });
  assert.doesNotMatch(expired.panel.content, /剩余/);
  const denied = await run(() => ({ status: 401, json: { code: "INVALID_ADMIN_KEY", message: key } }), { storage: new Map(overview.storage) });
  assert.doesNotMatch(denied.panel.content, /剩余/);
  assert.match(denied.panel.content, /管理员 API Key 无效/);
  const compliance = await run(() => ({ status: 423, json: { code: "ADMIN_COMPLIANCE_ACK_REQUIRED" } }));
  assert.match(compliance.panel.content, /需先在后台确认合规声明/);
  const envelope = await run(() => ({ json: { code: 1001, message: "bad " + key } }));
  assert.match(envelope.panel.content, /sub2api 返回错误：bad \[已隐藏\]/);
  const removed = await run(() => page([]), { storage: new Map(overview.storage) });
  assert.match(removed.panel.content, /sub2api 暂无上游账号/);
  assert.deepEqual(JSON.parse([...removed.storage.values()][0]).accounts, []);
  const corrupt = new Map([...overview.storage.keys()].map((k) => [k, "not-json"]));
  await run(response, { storage: corrupt });
  const damaged = clone(JSON.parse([...overview.storage.values()][0]));
  damaged.accounts[0].data.windows[0].remaining = { unexpected: true };
  const damagedStorage = new Map([...overview.storage.keys()].map((k) => [k, JSON.stringify(damaged)]));
  const damagedResult = await run(() => ({ error: "offline" }), { storage: damagedStorage });
  assert.doesNotMatch(damagedResult.panel.content, /al\*\*\*/);
  const html = await run(() => ({ raw: "<html>" + key + "</html>" }));
  assert.match(html.panel.content, /不是有效 JSON/);
  const wrongList = await run(() => ok({ items: [null] }));
  assert.match(wrongList.panel.content, /账号列表格式错误/);
  await run((r) => ({ ...response(r), duplicate: true }));

  const hanging = start((r) => r.method === "POST" ? { defer: true } : response(r));
  await new Promise((yes) => setImmediate(yes));
  assert.equal(hanging.requests.length, 2);
  hanging.timers[0].callback();
  const timed = await completed(hanging);
  assert.match(timed.panel.content, /查询超时/);
  assert.match(timed.panel.content, /日额度 \$9.5/);
  timed.callbacks[1](null, { status: 200 }, JSON.stringify(response(timed.requests[1]).json));
  assert.equal(timed.done.length, 1);
  const listHang = start(() => ({ defer: true }), { storage: new Map(overview.storage) });
  listHang.timers[0].callback();
  const listTimed = await completed(listHang);
  assert.match(listTimed.panel.content, /缓存/);
  assert.match(listTimed.panel.content, /周 剩余 44.5%/);

  const lots = Array.from({ length: 25 }, (_, i) => ({ ...fixture.accounts[1], id: 100 + i, name: "codex-" + i }));
  const many = start((r) => r.method === "GET" ? page(clone(lots)) : { defer: true });
  await new Promise((yes) => setImmediate(yes));
  assert.equal(many.requests.length, 3, "at most two batch requests may be in flight");
  many.timers[0].callback();
  await completed(many);
  const all = await run(withAccounts(lots, Object.fromEntries(lots.map((a) => [a.id, fixture.usage[2]]))));
  assert.equal(all.requests.length, 4);
  assert.match(all.panel.content, /1个平台 · 25个账号/);

  for (const invalidBase of ["http://sub2api.example.com", "https://user:password@sub2api.example.com", base + "/v1", base + "?token=secret"]) {
    const invalid = await run(response, { rawArgs: "base_url=" + encodeURIComponent(invalidBase) + "&admin_api_key=" + key });
    assert.equal(invalid.requests.length, 0);
  }
  const userKey = await run(response, { rawArgs: "base_url=" + base + "&admin_api_key=sk-user-key" });
  assert.equal(userKey.requests.length, 0);
  assert.match(userKey.panel.content, /admin- 开头/);
  const normalized = await run(response, { rawArgs: "base_url=" + base + "/api/v1/&admin_api_key=" + key });
  assert.ok(normalized.requests[0].url.startsWith(base + "/api/v1/admin/accounts?"));
  const specialKey = "admin-encoded+key&percent%";
  await run(response, { rawArgs: "base_url=" + base + "&admin_api_key=" + encodeURIComponent(specialKey), key: specialKey });

  // Resolve module conditions as Surge does, checking both local and remote scripts.
  const defaults = Object.fromEntries(moduleSource.match(/^#!arguments=(.*)$/m)[1].split(",").map((s) => { const i = s.indexOf(":"); return [s.slice(0, i), s.slice(i + 1)]; }));
  assert.deepEqual(Object.keys(defaults), ["BASE_URL", "ADMIN_API_KEY", "SCRIPT_PATH", "UPDATE_INTERVAL"]);
  for (const scriptPath of ["auto", "/tmp/sub2api-panel.js"]) {
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
  console.log("sub2api panel: " + cases + " scenarios passed; module variants and read-only request allowlist verified.");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
