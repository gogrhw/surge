/**
 * Read-only sub2api quota panel for every upstream account.
 * https://github.com/Wei-Shaw/sub2api
 * Uses the account list and the batch usage endpoint the admin account page loads.
 * No force probe, refresh, reset, scheduling, or configuration API is called.
 */
(function () {
  "use strict";

  var args = parseArguments(typeof $argument === "string" ? $argument : "");
  var key = String(args.admin_api_key || "").trim();
  var base;
  var finished = false;
  var started = Date.now();
  var cacheKey;
  var cached = [];
  var accounts = null;
  var results = [];
  var pageSize = 500;
  var maxPages = 10;
  var chunkSize = 10;

  try {
    base = String(args.base_url || "").trim().replace(/\/+$/, "").replace(/\/api\/v1$/, "");
    if (!/^https:\/\/[a-zA-Z0-9.-]+(?::\d{1,5})?(?:\/[a-zA-Z0-9._~%/-]*)?$/.test(base) || /YOUR_|\{\{\{/.test(base)) {
      throw new Error("请填写 sub2api 的 HTTPS 地址 BASE_URL（不含 /v1）");
    }
    if (/\/v1$/.test(base)) throw new Error("BASE_URL 应填写 sub2api 地址，不含 /v1");
    if (!key || /^YOUR_|\{\{\{/.test(key) || /[\r\n]/.test(key)) throw new Error("请填写 ADMIN_API_KEY（管理员 API Key）");
    if (!/^admin-/.test(key)) throw new Error("ADMIN_API_KEY 应为 admin- 开头的管理员 API Key，不是用户 API Key");
    cacheKey = "sub2api-panel-v1-" + encodeURIComponent(base);
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

  var listed = [];
  listPage(1);

  function listPage(page) {
    request("list", page, function (error, data, status) {
      if (error) return listFailure(error, status === 401 || status === 403);
      if (!object(data) || !Array.isArray(data.items) || data.items.some(function (a) { return !object(a); })) {
        return listFailure("账号列表格式错误");
      }
      listed = listed.concat(data.items);
      var pages = number(data.pages);
      if (data.items.length && pages !== null && page < pages && page < maxPages) return listPage(page + 1);
      loaded();
    });
  }

  function loaded() {
    var seen = Object.create(null);
    accounts = listed.filter(function (a) {
      var id = number(a.id);
      if (id === null || seen[id]) return false;
      seen[id] = true;
      return true;
    }).map(function (a, i) {
      var platform = String(a.platform || "unknown").toLowerCase();
      var type = String(a.type || "").toLowerCase();
      return {
        id: String(a.id),
        platform: platform,
        type: type,
        label: text(a.name || "账号 " + (i + 1)),
        disabled: a.status === "disabled",
        states: states(a),
        local: localQuota(a),
        usage: usageSupported(platform, type),
      };
    });
    if (!accounts.length) return render(true);

    var pending = [];
    accounts.forEach(function (account, i) {
      if (account.disabled) results[i] = { id: account.id, platform: account.platform, label: account.label, disabled: true, states: [], data: null, updatedAt: null };
      else if (!account.usage) results[i] = account.local ? fresh(account, account.local) :
        { id: account.id, platform: account.platform, label: account.label, states: account.states, note: "暂不可查询：该账号类型无额度接口", data: null, updatedAt: null };
      else pending.push(i);
    });
    var chunks = [];
    for (var c = 0; c < pending.length; c += chunkSize) chunks.push(pending.slice(c, c + chunkSize));
    var next = 0;
    var active = 0;
    var completed = 0;
    function pump() {
      if (finished) return;
      if (completed === chunks.length) return render(true);
      while (!finished && active < 2 && next < chunks.length) {
        (function (chunk) {
          active += 1;
          request("usage", chunk.map(function (i) { return Number(accounts[i].id); }), function (error, data) {
            if (finished) return;
            var usage = object(data) && object(data.usage) ? data.usage : null;
            var errors = object(data) && object(data.errors) ? data.errors : {};
            if (!error && !usage) error = "额度响应格式错误";
            chunk.forEach(function (i) {
              var account = accounts[i];
              if (error) { results[i] = failedAccount(account, error); return; }
              var info = usage[account.id];
              if (!object(info)) {
                results[i] = failedAccount(account, errors[account.id] ? text(errors[account.id]) : "未返回额度数据");
                return;
              }
              var parsed = usageQuota(account, info);
              if (!parsed.data) {
                results[i] = parsed.error ? failedAccount(account, parsed.error) :
                  { id: account.id, platform: account.platform, label: account.label, states: account.states, note: "暂无额度数据", data: null, updatedAt: null };
              } else {
                results[i] = fresh(account, parsed.data);
                if (parsed.error) results[i].error = parsed.error;
              }
            });
            active -= 1;
            completed += 1;
            pump();
          });
        })(chunks[next++]);
      }
    }
    pump();
  }

  // Only these two sub2api reads can be sent. Batch usage is always unforced.
  function request(operation, input, callback) {
    if (finished) return;
    var responded = false;
    var options = {
      headers: { "x-api-key": key, Accept: "application/json" },
      "auto-redirect": false, "auto-cookie": false,
    };
    if (operation === "list") {
      options.url = base + "/api/v1/admin/accounts?page=" + input + "&page_size=" + pageSize + "&sort_by=name&sort_order=asc";
      options.timeout = 10;
    } else if (operation === "usage") {
      options.url = base + "/api/v1/admin/accounts/usage/batch";
      options.timeout = 20;
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify({ account_ids: input, force: false });
    } else return callback("不支持的查询操作");
    function respond(error, data, status) {
      if (responded || finished) return;
      responded = true;
      callback(error, data, status);
    }
    try {
      $httpClient[options.body ? "post" : "get"](options, function (error, response, raw) {
        if (responded || finished) return;
        if (error) return respond("网络错误或请求超时");
        var status = Number(response && (response.status || response.statusCode));
        if (!(status >= 200 && status < 300)) return respond(httpError(status), null, status);
        var json;
        try { json = JSON.parse(raw); } catch (_) { return respond("sub2api 响应不是有效 JSON"); }
        if (!object(json) || json.code !== 0) return respond("sub2api 返回错误" + (object(json) && json.message ? "：" + text(json.message) : ""));
        respond(null, json.data, status);
      });
    } catch (_) { respond("请求执行失败"); }
  }

  function usageSupported(platform, type) {
    if (platform === "anthropic") return type === "oauth" || type === "setup-token";
    if (platform === "openai") return type === "oauth";
    return platform === "gemini" || platform === "antigravity" || platform === "grok";
  }

  function usageQuota(account, info) {
    var tiers = { FREE: "Free", PRO: "Pro", ULTRA: "Ultra" };
    var data = { plan: Object.prototype.hasOwnProperty.call(tiers, info.subscription_tier) ? tiers[info.subscription_tier] : typeLabel(account.type), windows: [], summary: [] };
    var labels = [
      ["five_hour", "5小时"], ["seven_day", "周"], ["seven_day_sonnet", "周 · Sonnet"], ["seven_day_fable", "周 · Fable"], ["thirty_day", "30天"],
      ["gemini_shared_daily", "共享 · 日"], ["gemini_pro_daily", "Pro · 日"], ["gemini_flash_daily", "Flash · 日"],
    ];
    // Antigravity copies one model quota into five_hour; per-model groups below replace it.
    if (account.platform === "antigravity") labels.shift();
    labels.forEach(function (pair) {
      var w = info[pair[0]];
      if (!object(w)) return;
      var used = number(w.utilization);
      data.windows.push({ label: pair[1], remaining: used === null || used < 0 ? null : Math.max(0, 100 - used), resetAt: timestamp(w.resets_at) });
    });
    var groups = Object.create(null);
    var order = [];
    if (object(info.antigravity_quota)) Object.keys(info.antigravity_quota).sort().forEach(function (model) {
      var q = info.antigravity_quota[model];
      if (!object(q)) return;
      var used = number(q.utilization);
      var remaining = used === null || used < 0 ? null : Math.max(0, 100 - used);
      var name = /claude|gpt/i.test(model) ? "Claude/GPT" : /gemini/i.test(model) ? "Gemini" : text(model);
      var reset = timestamp(q.reset_time);
      if (!groups[name]) { groups[name] = { label: name, remaining: remaining, resetAt: reset }; order.push(name); return; }
      var g = groups[name];
      // Show the most constrained model of each group.
      if (remaining !== null && (g.remaining === null || remaining < g.remaining)) { g.remaining = remaining; g.resetAt = reset; }
    });
    order.forEach(function (name) { data.windows.push(groups[name]); });
    [["grok_request_quota", "请求"], ["grok_token_quota", "Token"]].forEach(function (pair) {
      var q = info[pair[0]];
      if (!object(q)) return;
      var limit = number(q.limit);
      var left = number(q.remaining);
      if (limit === null || limit <= 0) return;
      data.windows.push({
        label: pair[1], remaining: left !== null && left >= 0 ? Math.min(100, left / limit * 100) : null,
        resetAt: timestamp(q.reset_at) !== null ? timestamp(q.reset_at) : timestamp(q.reset_unix),
      });
    });
    array(info.ai_credits).forEach(function (credit) {
      if (!object(credit)) return;
      var amount = number(credit.amount);
      if (amount !== null) data.summary.push({ label: "Credits" + (credit.credit_type ? " " + text(credit.credit_type) : ""), value: String(amount) });
    });
    if (account.local) {
      data.windows = data.windows.concat(account.local.windows);
      data.summary = data.summary.concat(account.local.summary);
    }

    var codes = { forbidden: "上游拒绝访问", unauthenticated: "账号授权已失效", rate_limited: "上游限流", network_error: "上游网络错误" };
    var error = info.is_banned === true ? "账号已被封禁" : info.needs_verify === true ? "需要人工验证" : info.needs_reauth === true ? "需要重新授权" :
      info.is_forbidden === true ? "上游拒绝访问" : Object.prototype.hasOwnProperty.call(codes, info.error_code) ? codes[info.error_code] : info.error ? text(info.error) : null;
    if (!data.windows.length && !data.summary.length) return { data: null, error: error };
    return { data: data, error: error };
  }

  // Local spending caps configured on API-key style accounts.
  function localQuota(a) {
    var data = { plan: typeLabel(String(a.type || "").toLowerCase()), windows: [], summary: [] };
    [["quota_daily_limit", "quota_daily_used", "日额度", "quota_daily_reset_at"], ["quota_weekly_limit", "quota_weekly_used", "周额度", "quota_weekly_reset_at"],
      ["quota_limit", "quota_used", "总额度", null]].forEach(function (f) {
      var limit = number(a[f[0]]);
      var used = number(a[f[1]]);
      if (limit === null || limit <= 0) return;
      used = used === null || used < 0 ? 0 : used;
      data.windows.push({
        label: f[2] + " $" + money(used) + "/$" + money(limit),
        remaining: Math.max(0, Math.min(100, (limit - used) / limit * 100)),
        resetAt: f[3] ? timestamp(a[f[3]]) : null, noReset: !f[3],
      });
    });
    return data.windows.length ? data : null;
  }

  // Scheduling states come from the list itself and are never cached.
  function states(a) {
    var out = [];
    if (a.status === "error") out.push("账号异常" + (a.error_message ? "：" + text(a.error_message) : ""));
    var limited = timestamp(a.rate_limit_reset_at);
    if (limited !== null && limited > started) out.push("当前已限流 · " + until(limited, "解除") + "（" + date(limited) + "）");
    var overload = timestamp(a.overload_until);
    if (overload !== null && overload > started) out.push("过载中 · " + until(overload, "恢复"));
    var temp = timestamp(a.temp_unschedulable_until);
    if (temp !== null && temp > started) out.push("临时不可调度" + (a.temp_unschedulable_reason ? "（" + text(a.temp_unschedulable_reason) + "）" : "") + " · " + until(temp, "恢复"));
    if (a.schedulable === false && a.status !== "disabled") out.push("已暂停调度");
    return out;
  }

  function fresh(account, data) {
    return { id: account.id, platform: account.platform, label: account.label, states: account.states, updatedAt: Date.now(), data: data };
  }

  function failedAccount(account, error) {
    var old = cached.filter(function (c) { return c.id === account.id && c.platform === account.platform; })[0];
    return { id: account.id, platform: account.platform, label: account.label, states: account.states, error: error, stale: !!old,
      updatedAt: old ? old.updatedAt : null, data: old ? old.data : null };
  }

  function listFailure(error, denied) {
    if (finished) return;
    results = denied ? [] : cached.map(function (c) {
      return { id: c.id, platform: c.platform, label: c.label, states: [], updatedAt: c.updatedAt, data: c.data, error: "账号列表未更新", stale: true };
    });
    render(false, "账号列表查询失败：" + error);
  }

  function render(save, listError) {
    if (finished) return;
    if (save) writeCache();
    var cards = results.filter(Boolean).sort(function (a, b) { return priority(b) - priority(a) || a.label.localeCompare(b.label); });
    var alerts = cards.filter(function (c) { return priority(c) > 0; }).length;
    var platforms = Object.create(null);
    cards.forEach(function (c) { platforms[c.platform] = true; });
    var lines = [Object.keys(platforms).length + "个平台 · " + cards.length + "个账号" + (alerts ? " · " + alerts + "个需关注" : "")];
    if (listError) lines.push(listError);
    if (!cards.length && !listError) lines.push("sub2api 暂无上游账号");
    var names = { anthropic: "Anthropic", openai: "OpenAI", gemini: "Gemini", antigravity: "Antigravity", grok: "Grok", kimi: "Kimi", zhipu: "智谱",
      deepseek: "DeepSeek", minimax: "MiniMax", kiro: "Kiro", cline: "Cline", opencode_go: "OpenCode Go", command_code: "Command Code", composite: "组合", unknown: "未知平台" };
    cards.forEach(function (card) {
      var data = card.data;
      var name = Object.prototype.hasOwnProperty.call(names, card.platform) ? names[card.platform] : text(card.platform);
      lines.push("", name + " · " + text(card.label) + (data && data.plan ? " · " + text(data.plan) : ""));
      if (card.disabled) { lines.push("已停用（未查询）"); return; }
      card.states.forEach(function (s) { lines.push(s); });
      if (card.error) lines.push("查询失败：" + card.error + (card.stale ? " · 缓存 " + date(card.updatedAt) : ""));
      if (card.note) lines.push(card.note);
      if (!data) return;
      data.windows.forEach(function (w) {
        var reset = w.noReset ? "不自动重置" : w.resetAt === null ? "重置时间未知" : until(w.resetAt, "重置") + "（" + date(w.resetAt) + "）";
        lines.push(text(w.label) + " 剩余 " + (w.remaining === null ? "未知" : Number(w.remaining.toFixed(1)) + "%") + " · " + reset);
      });
      data.summary.forEach(function (metric) { lines.push(text(metric.label) + " " + text(metric.value)); });
    });
    finish(lines);
  }

  function priority(card) {
    if (card.disabled) return 0;
    if (card.error || card.states.length) return 3;
    if (!card.data) return 0;
    if (card.data.windows.some(function (w) { return w.remaining !== null && w.remaining <= 10; })) return 2;
    if (card.data.windows.some(function (w) { return w.remaining === null; })) return 1;
    return 0;
  }

  function readCache() {
    try {
      var saved = JSON.parse($persistentStore.read(cacheKey) || "null");
      if (!object(saved) || saved.version !== 1) return [];
      return array(saved.accounts).filter(function (c) {
        return object(c) && typeof c.id === "string" && typeof c.label === "string" &&
          typeof c.platform === "string" && c.platform.length > 0 &&
          typeof c.updatedAt === "number" && c.updatedAt <= started && started - c.updatedAt <= 86400000 &&
          object(c.data) && typeof c.data.plan === "string" &&
          Array.isArray(c.data.summary) && c.data.summary.every(function (m) { return object(m) && typeof m.label === "string" && typeof m.value === "string"; }) &&
          Array.isArray(c.data.windows) && c.data.windows.every(function (w) {
            return object(w) && typeof w.label === "string" && (w.remaining === null || typeof w.remaining === "number" && w.remaining >= 0 && w.remaining <= 100) &&
              (w.resetAt === null || typeof w.resetAt === "number" && isFinite(w.resetAt)) && (w.noReset === undefined || typeof w.noReset === "boolean");
          });
      });
    } catch (_) { return []; }
  }

  function writeCache() {
    // Persist normalized quota only. Never serialize credentials or raw responses.
    var good = results.filter(function (c) { return c && c.data && c.updatedAt; }).map(function (c) {
      return { id: c.id, platform: c.platform, label: c.label, updatedAt: c.updatedAt, data: c.data };
    });
    try { $persistentStore.write(JSON.stringify({ version: 1, accounts: good }), cacheKey); } catch (_) { /* Cache is optional. */ }
  }

  function finish(lines) {
    if (finished) return;
    finished = true;
    $done({ title: "Sub2API", content: lines.join("\n") });
  }
  function httpError(status) {
    if (status === 401) return "sub2api HTTP 401（管理员 API Key 无效）";
    if (status === 403) return "sub2api HTTP 403（访问被拒绝）";
    if (status === 404) return "sub2api HTTP 404（检查地址）";
    if (status === 423) return "sub2api HTTP 423（需先在后台确认合规声明）";
    if (status === 429) return "sub2api HTTP 429（请求过于频繁）";
    return "sub2api" + (status > 0 && isFinite(status) ? " HTTP " + status : " 响应状态无效");
  }
  function typeLabel(type) {
    var types = { oauth: "OAuth", "setup-token": "Setup Token", apikey: "API Key", upstream: "上游", bedrock: "Bedrock", service_account: "服务账号" };
    return Object.prototype.hasOwnProperty.call(types, type) ? types[type] : "";
  }
  function parseArguments(input) {
    var out = Object.create(null);
    input.split("&").forEach(function (part) {
      var pos = part.indexOf("=");
      if (pos < 0) return;
      out[decode(part.slice(0, pos))] = decode(part.slice(pos + 1));
    });
    return out;
  }
  function decode(s) { try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch (_) { return s; } }
  function object(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
  function array(v) { return Array.isArray(v) ? v : []; }
  function number(v) { return (typeof v !== "number" && typeof v !== "string") || String(v).trim() === "" || !isFinite(Number(v)) ? null : Number(v); }
  function money(n) { return String(Number(n.toFixed(2))); }
  function text(v) {
    var s = String(v === undefined || v === null ? "" : v).replace(/[\x00-\x1f\x7f]/g, " ");
    if (key) s = s.split(key).join("[已隐藏]");
    return s.replace(/([a-zA-Z0-9._%+-]+)@([a-zA-Z0-9.-]+)/g, function (_, user, host) { return user.slice(0, 2) + "***@" + host; }).slice(0, 80);
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
  function until(n, action) {
    var minutes = Math.ceil((n - Date.now()) / 60000);
    if (minutes <= 0) return action === "重置" ? "重置时间已到，待刷新" : "即将" + action;
    if (minutes >= 1440) return Math.floor(minutes / 1440) + "天" + Math.floor(minutes % 1440 / 60) + "时后" + action;
    if (minutes >= 60) return Math.floor(minutes / 60) + "时" + minutes % 60 + "分后" + action;
    return minutes + "分后" + action;
  }
})();
