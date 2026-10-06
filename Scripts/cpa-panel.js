/**
 * Read-only CPA v8 quota panel for every listed upstream provider.
 * https://help.router-for.me/management/apiv8
 * Mirrors the Codex/Antigravity queries in CPA's management UI; other providers
 * use the server's normalized quota fetch interface.
 * POST transports quota reads; no refresh, reset, or configuration API is called.
 */
(function () {
  "use strict";

  var args = parseArguments(typeof $argument === "string" ? $argument : "");
  var key = String(args.management_key || "").trim();
  var base;
  var finished = false;
  var started = Date.now();
  var cacheKey;
  var cached = [];
  var accounts = null;
  var results = [];
  var queries = {
    codex: { method: "GET", urls: ["https://chatgpt.com/backend-api/wham/usage"] },
    antigravity: { method: "POST", urls: [
      "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
      "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary",
      "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
    ] },
  };

  try {
    base = String(args.base_url || "").trim().replace(/\/+$/, "").replace(/\/v8\/management$/, "");
    if (!/^https:\/\/[a-zA-Z0-9.-]+(?::\d{1,5})?(?:\/[a-zA-Z0-9._~%/-]*)?$/.test(base) || /YOUR_|\{\{\{/.test(base)) {
      throw new Error("请填写 CPA 的 HTTPS 地址 BASE_URL（不含 /v1）");
    }
    if (/\/v1$/.test(base)) throw new Error("BASE_URL 应填写 CPA 地址，不含 /v1");
    if (!key || /^YOUR_|\{\{\{/.test(key) || /[\r\n]/.test(key)) throw new Error("请填写 MANAGEMENT_KEY（不是客户端 API Key）");
    cacheKey = "cpa-panel-v2-" + encodeURIComponent(base);
    cached = readCache();
  } catch (error) {
    finish([error.message]);
    return;
  }

  // Surge JSC has no clearTimeout; $done cancels outstanding timers.
  setTimeout(function () {
    if (finished) return;
    if (accounts === null) return listFailure("查询超时");
    accounts.forEach(function (account, i) {
      if (!results[i]) results[i] = failedAccount(account, "查询超时或尚未查询");
    });
    render(true);
  }, 28000);

  request("credentials", null, function (error, json, status) {
    if (error) return listFailure(error, status === 401 || status === 403);
    if (!object(json) || !Array.isArray(json.files) || json.files.some(function (f) { return !object(f); })) {
      return listFailure("账号列表格式错误");
    }
    var seen = Object.create(null);
    accounts = json.files.filter(function (f) {
      var identity = String(f.provider || f.type || "") + "|" + String(f.auth_index || "");
      if (f.auth_index && seen[identity]) return false;
      if (f.auth_index) seen[identity] = true;
      return true;
    }).map(function (f, i) {
      return {
        id: String(f.auth_index || ""),
        provider: String(f.provider || f.type || "unknown").toLowerCase(),
        label: text(f.label || f.email || f.name || "账号 " + (i + 1)),
        disabled: f.disabled === true || f.disabled === "true",
        file: f,
      };
    });
    if (!accounts.length) return render(true);
    var next = 0;
    var active = 0;
    var completed = 0;
    function pump() {
      if (finished) return;
      if (completed === accounts.length) return render(true);
      while (!finished && active < 3 && next < accounts.length) {
        (function (i) {
          active += 1;
          queryAccount(accounts[i], function (failure, data) {
            if (finished) return;
            results[i] = failure ? failedAccount(accounts[i], failure) : {
              id: accounts[i].id, provider: accounts[i].provider, label: accounts[i].label,
              updatedAt: Date.now(), data: data,
            };
            active -= 1;
            completed += 1;
            pump();
          });
        })(next++);
      }
    }
    pump();
  });

  function queryAccount(account, callback) {
    if (account.disabled) return callback("已停用（未查询）");
    if (!account.id) return callback("缺少 auth_index");
    var provider = account.provider;
    var f = account.file;
    if (!Object.prototype.hasOwnProperty.call(queries, provider)) {
      return request("quota", { auth_index: account.id }, function (error, json, status) {
        if (error) return callback(status === 501 || status === 404 ? "暂不可查询：该厂商未提供额度接口" : error);
        var data;
        try { data = groupedQuota(json); } catch (_) { return callback("暂无有效额度数据"); }
        callback(null, data);
      });
    }
    if (provider === "antigravity" && !f.project_id) return callback("缺少 project_id");
    var headers = { Authorization: "Bearer $TOKEN$", "Content-Type": "application/json" };
    if (provider === "codex") {
      headers["User-Agent"] = "codex-tui/0.149.1 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.149.1)";
      var accountId = object(f.id_token) && f.id_token.chatgpt_account_id || f.account_id;
      if (typeof accountId === "string" && accountId) headers["Chatgpt-Account-Id"] = accountId;
    } else {
      headers["User-Agent"] = "antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)";
    }
    function attempt(index) {
      var query = queries[provider];
      var payload = { auth_index: account.id, method: query.method, url: query.urls[index], header: headers };
      if (provider === "antigravity") payload.data = JSON.stringify({ project: f.project_id });
      request("proxy", payload, function (error, envelope) {
        if (error) return callback(error);
        if (!object(envelope)) return callback("额度响应格式错误");
        var status = number(envelope.status_code);
        if (!(status >= 200 && status < 300)) {
          // The management UI uses these three Google endpoints as fallbacks.
          if (provider === "antigravity" && [403, 404].indexOf(status) >= 0 && index + 1 < query.urls.length) return attempt(index + 1);
          return callback(httpError(status, true));
        }
        var body;
        try { body = typeof envelope.body === "string" ? JSON.parse(envelope.body) : envelope.body; }
        catch (_) { return callback("额度响应不是有效 JSON"); }
        var data;
        try { data = provider === "codex" ? codexQuota(body) : groupedQuota(body); }
        catch (_) { return callback("暂无有效额度数据"); }
        callback(null, data);
      });
    }
    attempt(0);
  }

  // Only these three CPA reads can be sent. Upstream payloads are built above
  // from fixed URLs, never from a module argument or a returned credential URL.
  function request(operation, payload, callback) {
    if (finished) return;
    var responded = false;
    var routes = { credentials: "credentials", proxy: "requests/api-call", quota: "credentials/quota/fetch" };
    if (!Object.prototype.hasOwnProperty.call(routes, operation)) return callback("不支持的查询操作");
    var options = {
      url: base + "/v8/management/" + routes[operation],
      headers: { Authorization: "Bearer " + key, Accept: "application/json" },
      timeout: 8, "auto-redirect": false, "auto-cookie": false,
    };
    if (payload) {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(payload);
    }
    function respond(error, data, status) {
      if (responded || finished) return;
      responded = true;
      callback(error, data, status);
    }
    try {
      $httpClient[payload ? "post" : "get"](options, function (error, response, raw) {
        if (responded || finished) return;
        if (error) return respond("网络错误或请求超时");
        var status = Number(response && (response.status || response.statusCode));
        if (!(status >= 200 && status < 300)) return respond(httpError(status, false), null, status);
        var json;
        try { json = JSON.parse(raw); } catch (_) { return respond("CPA 响应不是有效 JSON"); }
        respond(null, json, status);
      });
    } catch (_) { respond("请求执行失败"); }
  }

  function codexQuota(json) {
    if (!object(json)) throw new Error();
    var data = { plan: text(json.plan_type || json.planType || "未知套餐"), windows: [], credits: null, limited: false, summary: [] };
    addLimits(json.rate_limit || json.rateLimit, "", false);
    addLimits(json.code_review_rate_limit || json.codeReviewRateLimit, "代码审查 · ", true);
    array(json.additional_rate_limits || json.additionalRateLimits).forEach(function (extra) {
      if (!object(extra)) return;
      addLimits(extra.rate_limit || extra.rateLimit, text(extra.limit_name || extra.limitName || "附加额度") + " · ", true);
    });
    var credits = json.credits;
    if (object(credits)) {
      var balance = number(credits.balance);
      if (credits.unlimited === true) data.credits = "无限额";
      else if (balance !== null && balance >= 0) data.credits = String(balance);
    }
    if (!data.windows.length && data.credits === null) throw new Error();
    return data;

    function addLimits(limits, prefix, detail) {
      if (!object(limits)) return;
      if (!detail && (limits.limit_reached === true || limits.limitReached === true || limits.allowed === false)) data.limited = true;
      [limits.primary_window || limits.primaryWindow, limits.secondary_window || limits.secondaryWindow].forEach(function (window, i) {
        if (!object(window)) return;
        var used = number(pick(window, "used_percent", "usedPercent"));
        var seconds = number(pick(window, "limit_window_seconds", "limitWindowSeconds"));
        var reset = timestamp(pick(window, "reset_at", "resetAt"));
        var after = number(pick(window, "reset_after_seconds", "resetAfterSeconds"));
        if (reset === null && after !== null && after >= 0) reset = Date.now() + after * 1000;
        data.windows.push({
          label: prefix + period(seconds, i === 0 ? "主窗口" : "次窗口"),
          remaining: used !== null && used >= 0 && used <= 100 ? 100 - used : null,
          resetAt: reset, detail: detail,
        });
      });
    }
  }

  function groupedQuota(json) {
    if (!object(json)) throw new Error();
    var subscription = object(json.subscription) ? json.subscription : {};
    var data = { plan: text(subscription.plan || subscription.tierName || subscription.tier_name || ""), windows: [], credits: null, limited: false, summary: [] };
    array(json.groups).forEach(function (group) {
      if (!object(group)) return;
      var name = text(group.displayName || group.display_name || "模型组");
      if (name === "Gemini Models") name = "Gemini";
      if (name === "Claude and GPT models") name = "Claude/GPT";
      array(group.buckets).forEach(function (bucket) {
        if (!object(bucket)) return;
        var fraction = number(pick(bucket, "remainingFraction", "remaining_fraction"));
        var windows = { "5h": "5小时", weekly: "周", daily: "日", monthly: "月" };
        var label = Object.prototype.hasOwnProperty.call(windows, bucket.window) ? windows[bucket.window] : text(bucket.displayName || bucket.display_name || bucket.window || "额度");
        data.windows.push({
          label: name + " · " + label,
          remaining: fraction !== null && fraction >= 0 && fraction <= 1 ? fraction * 100 : null,
          resetAt: timestamp(pick(bucket, "resetTime", "reset_time")), detail: false,
        });
      });
    });
    array(json.summary).forEach(function (metric) {
      if (!object(metric)) return;
      var value = number(metric.value);
      if (value === null) return;
      var unit = text(metric.format === "currency" ? metric.currency : metric.unit);
      data.summary.push({ label: text(metric.label || metric.key || "额度"), value: String(value) + (unit ? " " + unit : "") });
    });
    if (!data.windows.length && !data.summary.length) throw new Error();
    return data;
  }

  function failedAccount(account, error) {
    var old = !account.disabled && cached.filter(function (c) { return c.id === account.id && c.provider === account.provider; })[0];
    return { id: account.id, provider: account.provider, label: account.label, error: error, disabled: account.disabled,
      updatedAt: old ? old.updatedAt : null, data: old ? old.data : null };
  }

  function listFailure(error, denied) {
    if (finished) return;
    results = denied ? [] : cached.map(function (c) {
      return { id: c.id, provider: c.provider, label: c.label, updatedAt: c.updatedAt, data: c.data, error: "账号列表未更新" };
    });
    render(false, "账号列表查询失败：" + error);
  }

  function render(save, listError) {
    if (finished) return;
    if (save) writeCache();
    var cards = results.slice().sort(function (a, b) { return priority(b) - priority(a) || a.label.localeCompare(b.label); });
    var alerts = cards.filter(function (c) { return priority(c) > 0; }).length;
    var providers = Object.create(null);
    cards.forEach(function (c) { providers[c.provider] = true; });
    var lines = [Object.keys(providers).length + "个厂商 · " + cards.length + "个账号" + (alerts ? " · " + alerts + "个需关注" : "")];
    if (listError) lines.push(listError);
    if (!cards.length && !listError) lines.push("CPA 暂无上游账号");
    cards.forEach(function (card) {
      var data = card.data;
      var names = { codex: "Codex", antigravity: "Antigravity", claude: "Claude", gemini: "Gemini", "gemini-cli": "Gemini CLI", qwen: "Qwen", kimi: "Kimi", iflow: "iFlow", xai: "xAI", openai: "OpenAI", unknown: "未知厂商" };
      var name = Object.prototype.hasOwnProperty.call(names, card.provider) ? names[card.provider] : text(card.provider);
      lines.push("", name + " · " + text(card.label) + (data && data.plan ? " · " + text(data.plan) : ""));
      if (card.disabled) { lines.push("已停用（未查询）"); return; }
      if (card.error) lines.push("查询失败：" + card.error + (data ? " · 缓存 " + date(card.updatedAt) : ""));
      if (!data) return;
      if (data.limited) lines.push("当前已限流");
      if (!data.windows.length && !data.summary.length) lines.push("暂无窗口额度");
      data.windows.forEach(function (w) {
        var reset = w.resetAt === null ? "重置时间未知" : until(w.resetAt) + "（" + date(w.resetAt) + "）";
        lines.push(text(w.label) + " 剩余 " + (w.remaining === null ? "未知" : Number(w.remaining.toFixed(1)) + "%") + " · " + reset);
      });
      if (data.credits !== null) lines.push("Credits " + data.credits);
      data.summary.forEach(function (metric) { lines.push(text(metric.label) + " " + text(metric.value)); });
    });
    lines.push("", (listError ? "尝试查询 " : "本次查询 ") + date(Date.now()));
    finish(lines);
  }

  function priority(card) {
    if (card.disabled) return 0;
    if (card.error || !card.data) return 3;
    if (card.data.limited) return 3;
    if (card.data.windows.some(function (w) { return w.remaining !== null && w.remaining <= 10; })) return 2;
    if (card.data.windows.some(function (w) { return w.remaining === null; })) return 1;
    return 0;
  }

  function readCache() {
    try {
      var saved = JSON.parse($persistentStore.read(cacheKey) || "null");
      if (!object(saved) || saved.version !== 2) return [];
      return array(saved.accounts).filter(function (c) {
        return object(c) && typeof c.id === "string" && typeof c.label === "string" &&
          typeof c.provider === "string" && c.provider.length > 0 &&
          typeof c.updatedAt === "number" && c.updatedAt <= started && started - c.updatedAt <= 86400000 &&
          object(c.data) && typeof c.data.plan === "string" && typeof c.data.limited === "boolean" &&
          (c.data.credits === null || typeof c.data.credits === "string") &&
          Array.isArray(c.data.summary) && c.data.summary.every(function (m) { return object(m) && typeof m.label === "string" && typeof m.value === "string"; }) &&
          Array.isArray(c.data.windows) && c.data.windows.every(function (w) {
            return object(w) && typeof w.label === "string" && (w.remaining === null || typeof w.remaining === "number" && w.remaining >= 0 && w.remaining <= 100) &&
              (w.resetAt === null || typeof w.resetAt === "number" && isFinite(w.resetAt));
          });
      });
    } catch (_) { return []; }
  }

  function writeCache() {
    // Persist normalized quota only. Never serialize credentials or raw responses.
    var good = results.filter(function (c) { return c.data && c.updatedAt; }).map(function (c) {
      return { id: c.id, provider: c.provider, label: c.label, updatedAt: c.updatedAt, data: c.data };
    });
    try { $persistentStore.write(JSON.stringify({ version: 2, accounts: good }), cacheKey); } catch (_) { /* Cache is optional. */ }
  }

  function finish(lines) {
    if (finished) return;
    finished = true;
    $done({ title: "CPA", content: lines.join("\n") });
  }
  function httpError(status, upstream) {
    var label = upstream ? "上游" : "CPA";
    if (status === 401) return label + " HTTP 401（" + (upstream ? "账号授权已失效" : "管理密钥无效") + "）";
    if (status === 403) return label + " HTTP 403（访问被拒绝）";
    if (status === 404 && !upstream) return "CPA HTTP 404（检查地址及 v8 管理接口）";
    if (status === 429) return label + " HTTP 429（请求过于频繁）";
    return label + (status > 0 && isFinite(status) ? " HTTP " + status : " 响应状态无效");
  }
  function parseArguments(input) {
    var out = Object.create(null);
    input.split("&").forEach(function (part) {
      var pos = part.indexOf("=");
      if (pos < 0) return;
      var name = decode(part.slice(0, pos));
      var raw = part.slice(pos + 1);
      out[name] = decode(raw);
    });
    return out;
  }
  function decode(s) { try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch (_) { return s; } }
  function object(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
  function array(v) { return Array.isArray(v) ? v : []; }
  function pick(o, a, b) { return o[a] !== undefined ? o[a] : o[b]; }
  function number(v) { return (typeof v !== "number" && typeof v !== "string") || String(v).trim() === "" || !isFinite(Number(v)) ? null : Number(v); }
  function text(v) {
    var s = String(v === undefined || v === null ? "" : v).replace(/[\x00-\x1f\x7f]/g, " ");
    if (key) s = s.split(key).join("[已隐藏]");
    return s.replace(/([a-zA-Z0-9._%+-]+)@([a-zA-Z0-9.-]+)/g, function (_, user, host) { return user.slice(0, 2) + "***@" + host; }).slice(0, 80);
  }
  function period(seconds, fallback) {
    if (seconds === 604800) return "周";
    if (seconds !== null && seconds >= 2419200 && seconds <= 2678400) return "月";
    if (seconds !== null && seconds > 0) return seconds % 86400 === 0 ? seconds / 86400 + "天" : seconds % 3600 === 0 ? seconds / 3600 + "小时" : Math.round(seconds / 60) + "分钟";
    return fallback + "（周期未知）";
  }
  function timestamp(v) {
    if (v === null || v === undefined || v === "") return null;
    var n = number(v);
    var value = n !== null ? (n < 100000000000 ? n * 1000 : n) : typeof v === "string" ? Date.parse(v) : NaN;
    return isFinite(value) && value > 0 && value <= 8640000000000000 ? value : null;
  }
  function date(n) {
    var d = new Date(n);
    function pad(v) { return v < 10 ? "0" + v : String(v); }
    return pad(d.getMonth() + 1) + "/" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function until(n) {
    var minutes = Math.ceil((n - Date.now()) / 60000);
    if (minutes <= 0) return "重置时间已到，待刷新";
    if (minutes >= 1440) return Math.floor(minutes / 1440) + "天" + Math.floor(minutes % 1440 / 60) + "时后重置";
    if (minutes >= 60) return Math.floor(minutes / 60) + "时" + minutes % 60 + "分后重置";
    return minutes + "分后重置";
  }
})();
