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
    const i = part.indexOf(":");
    return [part.slice(0, i), part.slice(i + 1)];
  }));
  assert.ok(Object.keys(defaults).every((name) => /^[A-Za-z0-9_]+$/.test(name)));
  const placeholders = [...moduleSource.matchAll(/\{\{\{(.*?)\}\}\}/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(placeholders)].sort(), Object.keys(defaults).sort());
  const values = { ...defaults, API_KEY: key, SERVER_ID: "1234", SCRIPT_PATH: scriptPath };
  const expanded = moduleSource.replace(/\{\{\{(.*?)\}\}\}/g, (_, name) => values[name]);
  const scripts = expanded.split("[Script]\n")[1].trim().split("\n");
  const panels = expanded.split("[Panel]\n")[1].split("\n\n[Script]")[0].trim().split("\n");
  assert.equal(scripts.length, 7);
  assert.equal(panels.length, 7);
  assert.doesNotMatch(moduleSource, /\[MITM\]|\[Rule\]|type=http-|\bicon(?:-color)?=/);
  for (const line of scripts) {
    const name = line.split(" = ")[0];
    assert.match(line, /type=generic,timeout=20/);
    assert.ok(line.includes("script-path=" + scriptPath));
    const requirement = line.match(/#!REQUIREMENT "(.*?)"$/)[1];
    assert.equal(requirement, "'true' == 'true'");
    const panel = panels.find((p) => p.includes("script-name=" + name + ","));
    assert.ok(panel, name);
    assert.ok(panel.endsWith('#!REQUIREMENT "' + requirement + '"'));
    const argument = line.match(/argument="(.*?)"/)[1];
    const result = await run(argument);
    assert.equal(result.panel.title, panel.match(/title="(.*?)"/)[1]);
  }
  for (const flag of Object.keys(defaults).filter((name) => name.startsWith("SHOW_"))) {
    const hidden = moduleSource.replace(/\{\{\{(.*?)\}\}\}/g, (_, name) => name === flag ? "false" : values[name]);
    assert.equal(hidden.split("\n").filter((line) => line.endsWith('#!REQUIREMENT "\'false\' == \'true\'"')).length, 2);
  }
  assert.deepEqual([...covered].sort(), fixture.endpoints.map((e) => e.id).sort());
  console.log("isvoro-panel: " + cases + " simulations passed; all 14 read endpoints and 7 module panels verified");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
