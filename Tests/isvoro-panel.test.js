"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const scriptPath = path.join(root, "Scripts", "isvoro-panel.js");
const modulePath = path.join(root, "Modules", "isvoro-panel.sgmodule");
const source = fs.readFileSync(scriptPath, "utf8");
const fixture = require("./Fixtures/isvoro-api.json");
const key = "isv_" + "a".repeat(40);
const base = "https://isvoro.com/api/v1/open";
const covered = new Set();
const now = Date.parse("2026-09-30T12:00:00+08:00");
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
}
let cases = 0;

function endpoint(request) {
  const url = new URL(request.url);
  const p = url.pathname.slice("/api/v1/open".length);
  const found = fixture.endpoints.find((e) => {
    const pattern = "^" + e.path.replace(/:[A-Za-z]+/g, "[1-9]\\d*") + "$";
    return new RegExp(pattern).test(p);
  });
  assert.ok(found, "request must be a documented read endpoint: " + p);
  assert.equal(found.method, "GET");
  assert.equal(found.scope, "read");
  assert.equal(url.origin, "https://isvoro.com");
  assert.equal(request.headers.Authorization, "Bearer " + key);
  assert.equal(request.headers.Accept, "application/json");
  assert.equal(request["auto-redirect"], false);
  assert.equal(request["auto-cookie"], false);
  assert.ok(request.timeout > 0 && request.timeout < 20);
  assert.equal(request.body, undefined);
  assert.ok(!request.url.includes(key));
  covered.add(found.id);
  return found;
}

function officialResponse(request) {
  const e = endpoint(request);
  return { envelope: { code: 0, message: "success", data: e.data, ...(Array.isArray(e.data) ? { meta: { total: 1, page: 1, per_page: 5, total_pages: 1 } } : {}) } };
}

function start(argument, responder = officialResponse) {
  const timers = [];
  const requests = [];
  const callbacks = [];
  const doneCalls = [];
  const logs = [];
  let resolve;
  let reject;
  const result = new Promise((yes, no) => { resolve = yes; reject = no; });
  const unexpected = () => { const error = new Error("unexpected write or storage operation"); reject(error); throw error; };
  const sandbox = {
    Date: FixedDate,
    $argument: argument,
    $httpClient: {
      get(request, callback) {
        requests.push(request);
        callbacks.push(callback);
        try {
          endpoint(request);
          const response = responder(request);
          if (response.defer) return;
          queueMicrotask(() => {
            callback(response.error || null, response.response || { status: 200 }, response.body === undefined ? JSON.stringify(response.envelope) : response.body);
            if (response.duplicate) callback(null, { status: 200 }, JSON.stringify(response.envelope));
          });
        } catch (error) { reject(error); }
      },
      post: unexpected, put: unexpected, patch: unexpected, delete: unexpected,
    },
    $persistentStore: { read: unexpected, write: unexpected },
    $notification: { post: unexpected },
    $done(panel) { doneCalls.push(panel); resolve(panel); },
    setTimeout(callback, milliseconds) { timers.push({ callback, milliseconds }); },
    console: { log: (...values) => logs.push(values) },
  };
  try { vm.runInNewContext(source, sandbox, { filename: scriptPath, timeout: 1000 }); }
  catch (error) { reject(error); }
  return { result, timers, requests, callbacks, doneCalls, logs };
}

async function run(extra, responder) {
  cases += 1;
  const argument = extra.includes("api_key=") ? extra : "api_key=" + key + "&" + extra;
  const h = start(argument, responder);
  let guard;
  try {
    h.panel = await Promise.race([h.result, new Promise((_, reject) => { guard = setTimeout(() => reject(new Error("script did not finish: " + extra)), 1000); })]);
    await new Promise((resolve) => setImmediate(resolve));
  } finally { clearTimeout(guard); }
  assert.equal(h.doneCalls.length, 1);
  assert.deepEqual(Object.keys(h.panel).sort(), ["content", "title"]);
  assert.equal(typeof h.panel.content, "string");
  assert.equal(h.logs.length, 0);
  assert.ok(!h.panel.content.includes(key));
  assert.doesNotMatch(h.panel.content, /NaN|undefined|Infinity/);
  return h;
}

async function main() {
  assert.equal(fixture.endpoints.length, 14);
  const overview = await run("mode=overview");
  assert.equal(overview.requests.length, 2);
  assert.equal(overview.panel.title, "ISVORO");
  assert.match(overview.panel.content, /^余额 ¥128\.50/);
  assert.match(overview.panel.content, /hk-web-01.*运行中/);
  assert.match(overview.panel.content, /流量剩余/);
  assert.match(overview.panel.content, /21天后到期/);
  assert.ok(overview.panel.content.split("\n").length <= 6, "one server must fit in a short overview");
  assert.doesNotMatch(overview.panel.content, /邮箱|VM |NAT|产品:|规格:|页码/);
  const defaultOverview = await run("");
  assert.equal(defaultOverview.panel.content, overview.panel.content);

  const server = fixture.endpoints.find((e) => e.id === "servers-get").data;
  const priority = await run("mode=overview&max_rows=2", (r) => {
    if (r.url.endsWith("/account")) return officialResponse(r);
    return { envelope: { code: 0, data: [
      { ...server, id: 1, hostname: "healthy" },
      { ...server, id: 2, hostname: "expiring", expires_at: new Date(now + 86400000).toISOString() },
      { ...server, id: 3, hostname: "suspended", status: "suspended", suspend_reason: "traffic" },
    ], meta: { total: 3, page: 1, total_pages: 1 } } };
  });
  assert.match(priority.panel.content, /2台需关注/);
  assert.ok(priority.panel.content.indexOf("suspended") < priority.panel.content.indexOf("expiring"));
  assert.doesNotMatch(priority.panel.content, /healthy/);
  assert.match(priority.panel.content, /显示2\/3台/);

  const lowTraffic = await run("mode=overview", (r) => r.url.endsWith("/account") ? officialResponse(r) : {
    envelope: { code: 0, data: [{ ...server, traffic: { used_bytes: 95 * 1024 ** 3, limit_bytes: 100 * 1024 ** 3 } }], meta: { total: 1, total_pages: 1 } },
  });
  assert.match(lowTraffic.panel.content, /流量将耗尽.*5 GiB.*5%/);

  const unbounded = await run("mode=overview", (r) => r.url.endsWith("/account") ? officialResponse(r) : {
    envelope: { code: 0, data: [{ ...server, traffic: { used_bytes: 0, limit_bytes: 0 }, expires_at: null, power_status: null }], meta: { total: 1, total_pages: 1 } },
  });
  assert.match(unbounded.panel.content, /配额未知/);
  assert.match(unbounded.panel.content, /到期时间未知/);
  assert.doesNotMatch(unbounded.panel.content, /无限|运行中/);

  const pagedOverview = await run("mode=overview", (r) => {
    if (r.url.endsWith("/account")) return officialResponse(r);
    const page = Number(new URL(r.url).searchParams.get("page"));
    return { envelope: { code: 0, data: [{ ...server, id: page, hostname: "page-" + page }], meta: { total: 2, page, total_pages: 2 } } };
  });
  assert.equal(pagedOverview.requests.length, 3);
  assert.match(pagedOverview.panel.content, /page-1/);
  assert.match(pagedOverview.panel.content, /page-2/);
  const partialOverview = await run("mode=overview", (r) => {
    if (r.url.endsWith("/account")) return officialResponse(r);
    if (new URL(r.url).searchParams.get("page") === "2") return { error: "offline" };
    return { envelope: { code: 0, data: [server], meta: { total: 2, page: 1, total_pages: 2 } } };
  });
  assert.match(partialOverview.panel.content, /余额 ¥128\.50/);
  assert.match(partialOverview.panel.content, /hk-web-01/);
  assert.match(partialOverview.panel.content, /数据不完整/);

  const selectedOverview = await run("mode=overview&server_id=1234");
  assert.equal(selectedOverview.requests.length, 2);
  assert.ok(selectedOverview.requests.some((r) => r.url === base + "/servers/1234"));
  const balanceFailure = await run("mode=overview", (r) => r.url.endsWith("/account") ? { error: "offline" } : officialResponse(r));
  assert.match(balanceFailure.panel.content, /余额查询失败/);
  assert.match(balanceFailure.panel.content, /hk-web-01/);
  const expired = await run("mode=overview", (r) => r.url.endsWith("/account") ? officialResponse(r) : {
    envelope: { code: 0, data: [{ ...server, expires_at: new Date(now - 1).toISOString(), traffic: { used_bytes: 110, limit_bytes: 100 } }], meta: { total: 1, total_pages: 1 } },
  });
  assert.match(expired.panel.content, /1台需关注/);
  assert.match(expired.panel.content, /流量已耗尽 0 B · 0%/);
  assert.match(expired.panel.content, /已到期/);
  const noServers = await run("mode=overview", (r) => r.url.endsWith("/account") ? officialResponse(r) : {
    envelope: { code: 0, data: [], meta: { total: 0, total_pages: 0 } },
  });
  assert.match(noServers.panel.content, /暂无服务器/);
  assert.doesNotMatch(noServers.panel.content, /数据不完整/);
  const repeatedPage = await run("mode=overview", (r) => r.url.endsWith("/account") ? officialResponse(r) : {
    envelope: { code: 0, data: [server], meta: { total: 2, total_pages: 2 } },
  });
  assert.equal(repeatedPage.requests.length, 3);
  assert.match(repeatedPage.panel.content, /数据不完整/);
  assert.equal(repeatedPage.panel.content.match(/hk-web-01/g).length, 1);
  const pageLimit = await run("mode=overview&max_rows=1", (r) => {
    if (r.url.endsWith("/account")) return officialResponse(r);
    const page = Number(new URL(r.url).searchParams.get("page"));
    return { envelope: { code: 0, data: [{ ...server, id: page, hostname: "page-" + page, status: page === 10 ? "suspended" : "active" }], meta: { total: 11, page, total_pages: 11 } } };
  });
  assert.equal(pageLimit.requests.length, 11);
  assert.match(pageLimit.panel.content, /数据不完整/);
  assert.match(pageLimit.panel.content, /已知1台需关注/);
  assert.match(pageLimit.panel.content, /page-10 · 已暂停/);
  assert.match(pageLimit.panel.content, /显示1\/10台（已获取）/);

  const overviewTimeout = start("mode=overview&api_key=" + key, () => ({ defer: true }));
  overviewTimeout.callbacks[0](null, { status: 200 }, JSON.stringify(officialResponse(overviewTimeout.requests[0]).envelope));
  overviewTimeout.timers[0].callback();
  const partialTimeout = await overviewTimeout.result;
  assert.match(partialTimeout.content, /余额 ¥128\.50/);
  assert.match(partialTimeout.content, /服务器数据不完整：查询超时/);
  overviewTimeout.callbacks[1](null, { status: 200 }, JSON.stringify(officialResponse(overviewTimeout.requests[1]).envelope));
  assert.equal(overviewTimeout.doneCalls.length, 1);

  const blocked = await run("mode=account", () => ({ response: { status: 403 }, envelope: {
    cloudflare_error: true, error_code: 1010, error_name: "browser_signature_banned", status: 403,
  } }));
  assert.match(blocked.panel.content, /Cloudflare 1010/);
  assert.doesNotMatch(blocked.panel.content, /Key 无效/);

  const account = await run("mode=account");
  assert.match(account.panel.content, /张三 \(#1\)/);
  assert.match(account.panel.content, /CNY 128\.50/);
  assert.match(account.panel.content, /已验证 是/);

  for (const extra of ["mode=products", "mode=products&product_id=12"]) {
    const products = await run(extra);
    assert.match(products.panel.content, /#12 HK CN2 基础/);
    assert.match(products.panel.content, /2 核 \/ 2048 MB \/ 20 GB \/ 100 Mbps \/ 1000 GB/);
    assert.match(products.panel.content, /库存 8/);
    assert.match(products.panel.content, /#34 月付 39\.00/);
    assert.match(products.panel.content, /#7 Debian 12/);
    assert.doesNotMatch(products.panel.content, /<p>/);
  }

  for (const extra of ["mode=servers", "mode=servers&server_id=1234"]) {
    const servers = await run(extra);
    assert.match(servers.panel.content, /#1234 hk-web-01/);
    assert.match(servers.panel.content, /active \/ VM active \/ 电源 running/);
    assert.match(servers.panel.content, /1\.2\.3\.4/);
    assert.match(servers.panel.content, /123 B \/ 1000\.00 GiB/);
    assert.match(servers.panel.content, /自动续费 是/);
  }

  const live = await run("mode=live&server_id=1234&timeframe=week");
  assert.equal(live.requests.length, 3);
  assert.match(live.panel.content, /CPU: 12\.0%/);
  assert.match(live.panel.content, /运行 1天 0时 0分/);
  assert.match(live.panel.content, /↓ 1\.21 KiB\/s \/ ↑ 457 B\/s/);
  assert.match(live.panel.content, /历史 week: 1 个采样 \/ CPU 均值 2\.0% \/ 峰值 2\.0%/);
  assert.match(live.panel.content, /磁盘 读 0 B\/s \/ 写 1\.00 KiB\/s/);
  const metricRequest = live.requests.find((r) => r.url.includes("/metrics"));
  assert.equal(new URL(metricRequest.url).searchParams.get("timeframe"), "week");

  const unset = await run("mode=servers&server_id=NONE&status=NONE&q=NONE");
  assert.equal(unset.requests[0].url, base + "/servers?page=1&per_page=5");
  await run("mode=servers&server_id=NONE&q=%4EONE", (r) => {
    assert.equal(new URL(r.url).searchParams.get("q"), "NONE");
    return officialResponse(r);
  });
  const unsetLive = await run("mode=live&server_id=NONE");
  assert.equal(unsetLive.requests.length, 0);
  assert.match(unsetLive.panel.content, /填写 SERVER_ID/);

  const traffic = await run("mode=traffic&server_id=1234&days=90");
  assert.equal(traffic.requests.length, 2);
  assert.match(traffic.panel.content, /90 天 \/ 1 条: 入 2\.00 GiB \/ 出 8\.00 GiB/);
  assert.match(traffic.panel.content, /monthly \/ 重置前 1000\.00 GiB/);
  assert.equal(new URL(traffic.requests[1].url).searchParams.get("days"), "90");

  const storage = await run("mode=storage&server_id=1234");
  assert.equal(storage.requests.length, 3);
  assert.match(storage.panel.content, /备份: 1/);
  assert.match(storage.panel.content, /vzdump-qemu-123/);
  assert.match(storage.panel.content, /tcp 20001 → 10\.0\.0\.5:22 \/ 启用 是/);
  assert.match(storage.panel.content, /#7 Debian 12 \(qemu\)/);

  for (const extra of ["mode=billing", "mode=billing&invoice_id=555"]) {
    const billing = await run(extra);
    assert.match(billing.panel.content, /#555 INV-000555 \/ pending/);
    assert.match(billing.panel.content, /总额 CNY 39\.00 \/ 待付 CNY 39\.00/);
    assert.match(billing.panel.content, /HK CN2 基础 - 月付 CNY 39\.00 \/ 服务器 #1234/);
  }

  const paginated = await run("mode=servers&page=3&per_page=20&status=active&q=" + encodeURIComponent("香港 & + a=b"), (r) => {
    const url = new URL(r.url);
    assert.equal(url.searchParams.get("page"), "3");
    assert.equal(url.searchParams.get("per_page"), "20");
    assert.equal(url.searchParams.get("status"), "active");
    assert.equal(url.searchParams.get("q"), "香港 & + a=b");
    return { envelope: { code: 0, data: endpoint(r).data, meta: { total: 57, page: 3, per_page: 20, total_pages: 3 } } };
  });
  assert.match(paginated.panel.content, /本页 1 条 \/ 总计 57/);
  assert.match(paginated.panel.content, /页码: 3 \/ 3 \/ 每页 20/);
  await run("mode=billing&status=pending&page=2&per_page=10", (r) => {
    assert.equal(new URL(r.url).searchParams.get("status"), "pending");
    assert.equal(new URL(r.url).searchParams.get("page"), "2");
    return officialResponse(r);
  });

  for (const extra of ["mode=products&product_id=0012", "mode=servers&server_id=01234", "mode=billing&invoice_id=0555"]) {
    const result = await run(extra);
    assert.doesNotMatch(result.requests[0].url, /\/0/);
  }

  for (const extra of ["mode=products", "mode=servers", "mode=billing"]) {
    const empty = await run(extra, () => ({ envelope: { code: 0, data: [], meta: { total: 0, page: 1, per_page: 5, total_pages: 0 } } }));
    assert.match(empty.panel.content, /总计 0/);
    assert.match(empty.panel.content, /暂无记录/);
  }

  const trimmed = await run("mode=traffic&server_id=1234&max_rows=1", (r) => {
    if (!r.url.includes("traffic-daily")) return officialResponse(r);
    return { envelope: { code: 0, data: { days: [
      { date: "2026-09-29", inbound_bytes: 1024, outbound_bytes: 2048 },
      { date: "2026-09-30", inbound_bytes: 4096, outbound_bytes: 8192 },
    ], resets: [] } } };
  });
  assert.match(trimmed.panel.content, /入 5\.00 KiB \/ 出 10\.00 KiB/);
  assert.match(trimmed.panel.content, /2026-09-30 ↓ 4\.00 KiB/);
  assert.doesNotMatch(trimmed.panel.content, /2026-09-29/);
  assert.match(trimmed.panel.content, /仅显示 1\/2 条/);

  const sparse = await run("mode=live&server_id=1234", (r) => {
    const p = new URL(r.url).pathname;
    if (p.endsWith("status")) return { envelope: { code: 0, data: { cpu_usage: 0, memory_used_bytes: 0, memory_total_bytes: 0, uptime_seconds: 0, netin_bytes: 0, netout_bytes: 0 } } };
    if (p.endsWith("netrate")) return { envelope: { code: 0, data: { sampled: false, rx: 0, tx: 0 } } };
    return { envelope: { code: 0, data: [{ time: 100, cpu: null }, { time: 101, cpu: 0, mem: 0 }, { time: 102, cpu: 0.2 }] } };
  });
  assert.match(sparse.panel.content, /CPU: 0\.0% \/ 内存 0 B \/ 0 B/);
  assert.match(sparse.panel.content, /暂无有效采样/);
  assert.match(sparse.panel.content, /CPU 均值 10\.0% \/ 峰值 20\.0%/);
  assert.match(sparse.panel.content, /磁盘 读 — \/ 写 —/);

  const partial = await run("mode=storage&server_id=1234", (r) => r.url.endsWith("/backups") ? { response: { status: 403 }, envelope: { code: -1, message: "API_KEY_SCOPE_DENIED" } } : officialResponse(r));
  assert.match(partial.panel.content, /备份: HTTP 403 \/ API_KEY_SCOPE_DENIED/);
  assert.match(partial.panel.content, /端口转发: 1/);
  assert.match(partial.panel.content, /可用系统: 1/);

  const range = await run("mode=storage&server_id=1234", (r) => {
    const response = officialResponse(r);
    if (r.url.endsWith("/port-forwards")) response.envelope.data = [{ ...response.envelope.data[0], is_range: true, range_size: 3 }];
    return response;
  });
  assert.match(range.panel.content, /20001–20003 → 10\.0\.0\.5:22–24/);

  for (const code of ["API_KEY_INVALID", "API_KEY_REVOKED", "API_KEY_EXPIRED", "API_KEY_IP_NOT_ALLOWED", "API_KEY_SCOPE_DENIED", "API_ACCOUNT_SUSPENDED", "API_EMAIL_NOT_VERIFIED", "OPEN_API_DISABLED", "OPEN_API_ACCESS_DENIED"]) {
    const failed = await run("mode=account", () => ({ response: { status: 403 }, envelope: { code: -1, message: code } }));
    assert.match(failed.panel.content, new RegExp(code));
  }
  const limited = await run("mode=account", () => ({ response: { status: 429, headers: { "retry-after": "60" } }, body: "<html>rate limit</html>" }));
  assert.match(limited.panel.content, /HTTP 429.*60 秒后重试/);
  const serviceError = await run("mode=account", () => ({ envelope: { code: -1, message: "OPEN_API_DISABLED" } }));
  assert.match(serviceError.panel.content, /OPEN_API_DISABLED/);
  for (const response of [
    { body: "<html>login</html>" },
    { envelope: { code: 0, data: [] } },
    { envelope: { code: 0, data: null } },
    { envelope: { data: {} } },
    { envelope: { code: "0", data: {} } },
  ]) {
    const invalid = await run("mode=account", () => response);
    assert.match(invalid.panel.content, /响应.*格式错误/);
  }
  for (const data of [{}, [null], ["bad"], [[]]]) {
    const invalid = await run("mode=servers", () => ({ envelope: { code: 0, data } }));
    assert.match(invalid.panel.content, /响应数据格式错误/);
  }
  const unavailable = await run("mode=account", () => ({ response: { status: 503 }, body: "<html>unavailable</html>" }));
  assert.match(unavailable.panel.content, /HTTP 503/);
  const redirected = await run("mode=account", () => ({ response: { status: 302, headers: { Location: "https://other.example/" } }, body: "" }));
  assert.match(redirected.panel.content, /HTTP 302/);
  const network = await run("mode=account", () => ({ error: "failed Authorization: Bearer " + key }));
  assert.match(network.panel.content, /网络错误或请求超时/);
  const echoedSecret = await run("mode=account", () => ({ envelope: { code: -1, message: "Authorization: Bearer " + key } }));
  assert.equal(echoedSecret.panel.content, "HTTP 200 / 查询失败");
  const duplicate = await run("mode=live&server_id=1234", (r) => ({ ...officialResponse(r), duplicate: true }));
  assert.equal(duplicate.doneCalls.length, 1);

  for (const extra of [
    "api_key=YOUR_API_KEY&mode=account", "api_key=&mode=account", "mode=password", "mode=constructor", "mode=__proto__",
    "mode=live", "mode=traffic", "mode=storage", "mode=servers&server_id=0", "mode=servers&server_id=1/password",
    "mode=products&product_id=-1", "mode=billing&invoice_id=1e2", "mode=servers&page=0", "mode=servers&per_page=101",
    "mode=servers&max_rows=0", "mode=live&server_id=1&timeframe=minute", "mode=traffic&server_id=1&days=31",
  ]) {
    const invalid = await run(extra);
    assert.equal(invalid.requests.length, 0, extra);
    assert.ok(invalid.panel.content.length > 0);
  }

  const outOfOrder = start("mode=live&api_key=" + key + "&server_id=1234", () => ({ defer: true }));
  assert.equal(outOfOrder.requests.length, 3);
  [2, 0, 1].forEach((i) => outOfOrder.callbacks[i](null, { status: 200 }, JSON.stringify(officialResponse(outOfOrder.requests[i]).envelope)));
  const orderedPanel = await outOfOrder.result;
  assert.ok(orderedPanel.content.indexOf("电源:") < orderedPanel.content.indexOf("网速:"));
  assert.ok(orderedPanel.content.indexOf("网速:") < orderedPanel.content.indexOf("历史 hour:"));
  assert.equal(outOfOrder.doneCalls.length, 1);

  const hung = start("mode=account&api_key=" + key, () => ({ defer: true }));
  assert.equal(hung.timers.length, 1);
  assert.ok(hung.timers[0].milliseconds < 20000);
  hung.timers[0].callback();
  const timedOut = await hung.result;
  assert.match(timedOut.content, /查询超时/);
  hung.callbacks[0](null, { status: 200 }, JSON.stringify(officialResponse(hung.requests[0]).envelope));
  hung.timers[0].callback();
  assert.equal(hung.doneCalls.length, 1);

  // Exercise the actual module arguments after Surge-style placeholder expansion.
  const moduleSource = fs.readFileSync(modulePath, "utf8");
  const defaults = Object.fromEntries(moduleSource.match(/^#!arguments=(.*)$/m)[1].split(",").map((part) => {
    const components = part.split(":");
    assert.equal(components.length, 2, "module header must use an unambiguous name:default declaration: " + part);
    assert.ok(components[1], "module header defaults must not be empty: " + part);
    return components;
  }));
  assert.ok(Object.keys(defaults).every((name) => /^[A-Za-z0-9_]+$/.test(name)));
  const placeholders = [...moduleSource.matchAll(/\{\{\{(.*?)\}\}\}/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(placeholders)].sort(), Object.keys(defaults).sort());
  const remoteScript = "https://raw.githubusercontent.com/gogrhw/surge/refs/heads/main/Scripts/isvoro-panel.js";
  assert.equal(defaults.SCRIPT_PATH, "auto");
  assert.equal(defaults.SHOW_DETAILS, "false");
  assert.doesNotMatch(moduleSource, /\[MITM\]|\[Rule\]|type=http-|\bicon(?:-color)?=/);
  function enabled(line) {
    const condition = line.match(/#!REQUIREMENT "(.*)"$/);
    if (!condition) return true;
    return condition[1].split(" && ").map((clause) => {
      const comparison = clause.match(/^'([^']*)' (==|!=) '([^']*)'$/);
      assert.ok(comparison, "unsupported module requirement: " + clause);
      return comparison[2] === "==" ? comparison[1] === comparison[3] : comparison[1] !== comparison[3];
    }).every(Boolean);
  }
  for (const selectedPath of ["auto", scriptPath]) for (const details of ["false", "true"]) {
    const values = { ...defaults, API_KEY: key, SERVER_ID: "1234", SCRIPT_PATH: selectedPath, SHOW_DETAILS: details };
    const expanded = moduleSource.replace(/\{\{\{(.*?)\}\}\}/g, (_, name) => values[name]);
    const declarations = expanded.split("[Script]\n")[1].trim().split("\n");
    const panels = expanded.split("[Panel]\n")[1].split("\n\n[Script]")[0].trim().split("\n");
    assert.equal(declarations.length, 16);
    assert.equal(panels.length, 8);
    const scripts = declarations.filter(enabled);
    const visible = panels.filter(enabled);
    const count = details === "true" ? 8 : 1;
    assert.equal(scripts.length, count);
    assert.equal(visible.length, count);
    assert.equal(new Set(scripts.map((line) => line.split(" = ")[0])).size, count);
    if (details === "false") assert.ok(visible[0].startsWith("ISVORO Overview ="));
    for (const line of scripts) {
      const name = line.split(" = ")[0];
      assert.match(line, /type=generic,timeout=20/);
      assert.ok(line.includes("script-path=" + (selectedPath === "auto" ? remoteScript : scriptPath) + ","));
      const panel = visible.find((p) => p.includes("script-name=" + name + ","));
      assert.ok(panel, name);
      const argument = line.match(/argument="(.*?)"/)[1];
      const result = await run(argument);
      assert.equal(result.panel.title, panel.match(/title="(.*?)"/)[1]);
    }
  }
  for (const flag of Object.keys(defaults).filter((name) => name.startsWith("SHOW_"))) {
    const hidden = moduleSource.replace(/\{\{\{(.*?)\}\}\}/g, (_, name) => name === flag ? "false" : name === "SHOW_DETAILS" ? "true" : defaults[name]);
    const panels = hidden.split("[Panel]\n")[1].split("\n\n[Script]")[0].trim().split("\n").filter(enabled);
    const scripts = hidden.split("[Script]\n")[1].trim().split("\n").filter(enabled);
    assert.equal(panels.length, flag === "SHOW_DETAILS" ? 1 : 7);
    assert.equal(scripts.length, panels.length);
  }
  assert.deepEqual([...covered].sort(), fixture.endpoints.map((e) => e.id).sort());
  if (process.argv.includes("--preview")) {
    for (const result of [overview, priority, lowTraffic, partialOverview]) console.log(result.panel.title + "\n" + result.panel.content + "\n");
  }
  console.log("isvoro-panel: " + cases + " simulations passed; all 14 read endpoints; overview and 7 optional detail panels verified");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
