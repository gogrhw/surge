/**
 * ISVORO read-scope panels for Surge. API reference: https://isvoro.com/docs/api
 * Only the 14 documented read endpoints are allowed; no credentials are stored.
 */
(function () {
  "use strict";

  var args = parseArguments(typeof $argument === "string" ? $argument : "");
  var mode = args.mode || "overview";
  var labels = {
    overview: "总览",
    account: "账户", products: "产品", servers: "服务器", live: "实时监控",
    traffic: "流量", storage: "备份与配置", billing: "账单",
  };
  var finished = false;
  var rows;
  var page;
  var perPage;
  var serverId;
  var productId;
  var invoiceId;
  var timeframe;
  var days;
  var key = String(args.api_key || "").trim();
  var onTimeout = function () { finish(["查询超时，请刷新重试"]); };

  try {
    if (!Object.prototype.hasOwnProperty.call(labels, mode)) throw new Error("未知面板模式");
    if (!/^isv_[A-Za-z0-9]+$/.test(key)) throw new Error("请填写 ISVORO Open API Key（isv_ 开头），只需 read 权限");
    rows = integer(args.max_rows, 5, 1, 100, "MAX_ROWS");
    if (mode === "products" || mode === "servers" || mode === "billing") {
      page = integer(args.page, 1, 1, 1000000, "PAGE");
      perPage = integer(args.per_page, 5, 1, 100, "PER_PAGE");
    }
    if (mode === "products" && args.product_id) productId = integer(args.product_id, 0, 1, 9007199254740991, "PRODUCT_ID");
    if (mode === "billing" && args.invoice_id) invoiceId = integer(args.invoice_id, 0, 1, 9007199254740991, "INVOICE_ID");
    if (["overview", "servers", "live", "traffic", "storage"].indexOf(mode) >= 0 && args.server_id) {
      serverId = integer(args.server_id, 0, 1, 9007199254740991, "SERVER_ID");
    }
    if (["live", "traffic", "storage"].indexOf(mode) >= 0 && !serverId) {
      throw new Error("请先在服务器面板查看 ID，再填写 SERVER_ID");
    }
    if (mode === "live") {
      timeframe = args.timeframe || "hour";
      if (["hour", "day", "week", "month", "year"].indexOf(timeframe) < 0) throw new Error("TIMEFRAME 需为 hour、day、week、month 或 year");
    }
    if (mode === "traffic") {
      days = integer(args.days, 30, 30, 90, "TRAFFIC_DAYS");
      if ([30, 60, 90].indexOf(days) < 0) throw new Error("TRAFFIC_DAYS 需为 30、60 或 90");
    }
  } catch (error) {
    finish([error.message]);
    return;
  }

  // Leave time for $done before the module's 20-second session timeout.
  setTimeout(function () { onTimeout(); }, 18000);
  var runners = {
    overview: runOverview,
    account: runAccount, products: runProducts, servers: runServers, live: runLive,
    traffic: runTraffic, storage: runStorage, billing: runBilling,
  };
  runners[mode]();

  function runOverview() {
    var account;
    var accountError;
    var serverError;
    var accountReady = false;
    var serversReady = false;
    var servers = [];
    var seen = Object.create(null);
    var total;
    onTimeout = function () {
      if (!accountReady) accountError = "查询超时";
      if (!serversReady) serverError = "查询超时";
      accountReady = serversReady = true;
      render();
    };
    request("/account", {}, "object", function (error, result) {
      accountReady = true;
      accountError = error;
      account = result && result.data;
      render();
    });
    if (serverId) {
      request("/servers/" + serverId, {}, "object", function (error, result) {
        serversReady = true;
        serverError = error;
        if (result) servers.push(result.data);
        render();
      });
    } else {
      fetchPage(1);
    }

    function fetchPage(nextPage) {
      request("/servers", { page: nextPage, per_page: 100 }, "array", function (error, result) {
        if (error) return stop(error);
        var meta = result.meta || {};
        var pages = finite(meta.total_pages);
        var reportedTotal = finite(meta.total);
        var duplicate = false;
        result.data.forEach(function (s) {
          if (s.id === undefined || s.id === null || seen[s.id]) { duplicate = true; return; }
          seen[s.id] = true;
          servers.push(s);
        });
        if (nextPage === 1) total = reportedTotal;
        // Keep collected servers when pagination changes or a later page fails.
        var invalidPages = pages === null || pages < 0 || Math.floor(pages) !== pages || (pages === 0 && total !== 0);
        var invalidTotal = total === null || total < 0 || Math.floor(total) !== total || total !== reportedTotal;
        var wrongPage = meta.page !== undefined && Number(meta.page) !== nextPage;
        if (duplicate || invalidPages || invalidTotal || wrongPage) return stop("分页信息异常");
        if (nextPage < pages) {
          if (!result.data.length || nextPage >= 10) return stop("未取完服务器列表");
          return fetchPage(nextPage + 1);
        }
        stop(servers.length === total ? null : "服务器列表数量不一致");
      });
    }
    function stop(error) {
      serversReady = true;
      serverError = error;
      render();
    }
    function render() {
      if (!accountReady || !serversReady) return;
      var cards = servers.map(function (s, index) { return overviewServer(s, index); });
      cards.sort(function (a, b) { return b.priority - a.priority || a.expires - b.expires || a.index - b.index; });
      var alerts = cards.filter(function (c) { return c.priority > 0; }).length;
      var balance = accountError ? "余额查询失败：" + accountError : "余额 " + compactMoney(account.balance, account.currency);
      var lines = [balance + (alerts ? " · " + (serverError ? "已知" : "") + alerts + "台需关注" : "")];
      if (serverError) lines.push("服务器数据不完整：" + serverError);
      if (!cards.length && !serverError) lines.push("暂无服务器");
      cards.slice(0, rows).forEach(function (card) {
        lines.push("");
        Array.prototype.push.apply(lines, card.lines);
      });
      if (cards.length > rows) lines.push("显示" + rows + "/" + cards.length + "台" + (serverError ? "（已获取）" : ""));
      finish(lines);
    }
  }

  function overviewServer(s, index) {
    var states = {
      suspended: "已暂停", stopped: "已关机", stopping: "正在关机", pending: "开通中",
      creating: "创建中", installing: "安装中", reinstalling: "重装中", failed: "故障",
      error: "故障", expired: "已到期", terminated: "已终止", cancelled: "已取消",
    };
    var serviceProblem = s.status && s.status !== "active";
    var vmProblem = s.vm_status && s.vm_status !== "active" && s.vm_status !== "running";
    var state = serviceProblem ? s.status : vmProblem ? s.vm_status : s.power_status;
    var running = !serviceProblem && !vmProblem && state === "running";
    var status = running ? "运行中" : Object.prototype.hasOwnProperty.call(states, state) ? states[state] : state ? text(state) : "状态未知";
    var priority = running ? 0 : 3;
    if (s.locked) { status += " · 已锁定"; priority = 3; }
    var t = s.traffic || {};
    var used = finite(t.used_bytes);
    var limit = finite(t.limit_bytes);
    var traffic = "流量配额未知";
    if (limit !== null && limit > 0) {
      traffic = "流量用量未知";
      if (used !== null && used >= 0) {
        var remaining = Math.max(0, limit - used);
        var fraction = remaining / limit;
        var label = remaining === 0 ? "流量已耗尽" : fraction <= 0.1 ? "流量将耗尽" : "流量剩余";
        traffic = label + " " + compactBytes(remaining) + " · " + Number((fraction * 100).toFixed(1)) + "%";
        if (fraction <= 0.1) priority = Math.max(priority, remaining === 0 ? 3 : 2);
      }
    }
    var expires = s.expires_at ? new Date(s.expires_at).getTime() : NaN;
    var expiry = "到期时间未知";
    if (isFinite(expires)) {
      var left = expires - Date.now();
      expiry = left <= 0 ? "已到期" : left <= 86400000 ? "24小时内到期" : Math.ceil(left / 86400000) + "天后到期";
      expiry += " · " + date(s.expires_at).slice(5, 10).replace("-", "/");
      if (left <= 7 * 86400000) priority = Math.max(priority, left <= 0 ? 3 : 2);
    }
    expiry += s.auto_renew === true ? " · 自动续费" : s.auto_renew === false ? " · 手动续费" : "";
    var location = (s.location || {}).name;
    return { priority: priority, expires: isFinite(expires) ? expires : Infinity, index: index, lines: [
      (location ? text(location) + " · " : "") + text(s.hostname || "#" + s.id) + " · " + status,
      traffic,
      expiry,
    ] };
  }

  function runAccount() {
    request("/account", {}, "object", function (error, result) {
      if (error) return finish([error]);
      var a = result.data;
      finish([
        "余额: " + money(a.balance, a.currency),
        "账户: " + text(a.name) + " (#" + text(a.id) + ")",
        "邮箱: " + text(a.email) + " / 已验证 " + yesNo(a.email_verified),
      ]);
    });
  }

  function runProducts() {
    var single = !!productId;
    request(single ? "/products/" + productId : "/products", single ? {} : listQuery(), single ? "object" : "array", function (error, result) {
      if (error) return finish([error]);
      var items = single ? [result.data] : result.data;
      var lines = single ? [] : listHeading("产品", result);
      appendRows(lines, items, function (p) {
        var s = p.specs || {};
        return [
          "#" + text(p.id) + " " + text(p.name) + " / " + text((p.location || {}).name),
          "分类: " + text((p.category || {}).name) + " / 可订购 " + yesNo(p.available) + " / 库存 " + text(p.stock),
          "规格: " + specs(s),
          "网络: IPv4 " + text(s.ipv4) + " / IPv6 " + text(s.ipv6) + " / NAT " + yesNo(s.nat) + " / 端口 " + text(s.nat_ports),
          "套餐: " + array(p.plans).map(function (plan) {
            return "#" + text(plan.id) + " " + text(plan.name) + " " + amount(plan.price) + "/" + text(plan.billing_period) + " " + text(plan.billing_unit) + " (开通费 " + amount(plan.setup_fee) + ")";
          }).join("; "),
          "限购: " + text(p.per_user_limit) + " / 实名 " + yesNo(p.require_kyc),
          "系统: " + array(p.os_templates).map(osLabel).join("; "),
        ].concat(p.unavailable_reason ? ["不可订购: " + plain(p.unavailable_reason)] : [], p.description ? ["说明: " + plain(p.description)] : []);
      });
      finish(lines);
    });
  }

  function runServers() {
    var query = serverId ? {} : listQuery();
    if (!serverId && args.status) query.status = args.status;
    if (!serverId && args.q) query.q = args.q;
    request(serverId ? "/servers/" + serverId : "/servers", query, serverId ? "object" : "array", function (error, result) {
      if (error) return finish([error]);
      var lines = serverId ? [] : listHeading("服务器", result);
      appendRows(lines, serverId ? [result.data] : result.data, serverLines);
      finish(lines);
    });
  }

  function serverLines(s) {
    var net = s.network || {};
    var plan = s.plan || {};
    return [
      "#" + text(s.id) + " " + text(s.hostname),
      "状态: " + text(s.status) + " / VM " + text(s.vm_status) + " / 电源 " + text(s.power_status),
      "产品: " + text((s.product || {}).name) + " / " + text((s.location || {}).name),
      "套餐: " + text(plan.name) + " " + amount(plan.price) + "/" + text(plan.billing_period) + " " + text(plan.billing_unit),
      "规格: " + specs(s.specs || {}) + " / " + text((s.os || {}).name),
      "IPv4: " + text(net.ipv4) + " / IPv6: " + text(net.ipv6),
      "NAT: " + yesNo(net.is_nat) + " / " + text(net.nat_ip),
      "流量: " + trafficSummary(s.traffic || {}),
      "重置: " + date((s.traffic || {}).next_reset_at),
      "到期: " + date(s.expires_at) + " / 自动续费 " + yesNo(s.auto_renew),
      "锁定: " + yesNo(s.locked) + " / 创建 " + date(s.created_at),
    ].concat(s.note ? ["备注: " + plain(s.note)] : [], s.suspend_source || s.suspend_reason ? ["暂停: " + text(s.suspend_source) + " / " + text(s.suspend_reason)] : []);
  }

  function runLive() {
    getMany([
      { label: "实时状态", suffix: "status", shape: "object" },
      { label: "当前网速", suffix: "netrate", shape: "object" },
      { label: "历史指标", suffix: "metrics", shape: "array", query: { timeframe: timeframe } },
    ], function (results) {
      var lines = ["服务器 #" + serverId];
      results.forEach(function (r) {
        if (r.error) return lines.push(r.label + ": " + r.error);
        var d = r.data;
        if (r.suffix === "status") {
          lines.push("电源: " + text(d.power_status) + " / 运行 " + duration(d.uptime_seconds));
          lines.push("CPU: " + percent(d.cpu_usage) + " / 内存 " + bytes(d.memory_used_bytes) + " / " + bytes(d.memory_total_bytes));
          lines.push("累计入/出: " + bytes(d.netin_bytes) + " / " + bytes(d.netout_bytes));
        } else if (r.suffix === "netrate") {
          lines.push("网速: " + (d.sampled === true ? "↓ " + rate(d.rx) + " / ↑ " + rate(d.tx) : "暂无有效采样") + " / " + text(d.status));
          lines.push("网速采样: " + unix(d.ts, true) + " / 累计入/出 " + bytes(d.netin) + " / " + bytes(d.netout));
        } else {
          var points = d.filter(function (p) { return finite(p.time) !== null; }).sort(function (a, b) { return a.time - b.time; });
          lines.push("历史 " + timeframe + ": " + points.length + " 个采样 / CPU 均值 " + percent(average(points, "cpu")) + " / 峰值 " + percent(maximum(points, "cpu")));
          appendRows(lines, points.slice().reverse(), function (p) {
            return [unix(p.time) + " CPU " + percent(p.cpu) + " / 核数 " + text(p.maxcpu),
              "内存 " + bytes(p.mem) + " / " + bytes(p.maxmem) + " / 网络 ↓ " + rate(p.netin) + " ↑ " + rate(p.netout),
              "磁盘 读 " + rate(p.diskread) + " / 写 " + rate(p.diskwrite)];
          });
        }
      });
      finish(lines);
    });
  }

  function runTraffic() {
    getMany([
      { label: "配额", shape: "object" },
      { label: "每日流量", suffix: "traffic-daily", shape: "object", query: { days: days } },
    ], function (results) {
      var lines = ["服务器 #" + serverId];
      results.forEach(function (r) {
        if (r.error) return lines.push(r.label + ": " + r.error);
        if (!r.suffix) {
          lines.push("流量: " + trafficSummary(r.data.traffic || {}));
          lines.push("重置: " + date((r.data.traffic || {}).next_reset_at));
          return;
        }
        var daily = array(r.data.days).slice().sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
        var resets = array(r.data.resets).slice().sort(function (a, b) { return String(b.occurred_at || b.date).localeCompare(String(a.occurred_at || a.date)); });
        lines.push(days + " 天 / " + daily.length + " 条: 入 " + bytes(sum(daily, "inbound_bytes")) + " / 出 " + bytes(sum(daily, "outbound_bytes")));
        appendRows(lines, daily, function (d) { return [text(d.date) + " ↓ " + bytes(d.inbound_bytes) + " / ↑ " + bytes(d.outbound_bytes)]; });
        lines.push("重置记录: " + resets.length);
        appendRows(lines, resets, function (r) { return [date(r.occurred_at || r.date) + " " + text(r.reset_type) + " / 重置前 " + bytes(r.previous_usage_bytes)]; });
      });
      finish(lines);
    });
  }

  function runStorage() {
    getMany([
      { label: "备份", suffix: "backups", shape: "array" },
      { label: "端口转发", suffix: "port-forwards", shape: "array" },
      { label: "可用系统", suffix: "os-templates", shape: "array" },
    ], function (results) {
      var lines = ["服务器 #" + serverId];
      results.forEach(function (r) {
        if (r.error) return lines.push(r.label + ": " + r.error);
        var items = r.data.slice();
        if (r.suffix === "backups") items.sort(function (a, b) { return Number(b.ctime || 0) - Number(a.ctime || 0); });
        lines.push(r.label + ": " + items.length);
        appendRows(lines, items, function (item) {
          if (r.suffix === "backups") return [unix(item.ctime) + " / " + bytes(item.size) + " / " + text(item.format), text(item.volid)].concat(item.notes ? ["备注: " + plain(item.notes)] : []);
          if (r.suffix === "os-templates") return [osLabel(item)];
          var size = item.is_range === true ? finite(item.range_size) : 1;
          var external = portRange(item.external_port, size);
          var internal = portRange(item.internal_port, size);
          return ["#" + text(item.id) + " " + text(item.protocol) + " " + external + " → " + text(item.internal_ip) + ":" + internal + " / 启用 " + yesNo(item.is_active),
            "服务器 #" + text(item.server_id) + " / IP 池 #" + text(item.ip_pool_id) + " / " + text(item.description),
            "创建 " + date(item.created_at) + " / 更新 " + date(item.updated_at)];
        });
      });
      finish(lines);
    });
  }

  function runBilling() {
    var single = !!invoiceId;
    var query = single ? {} : listQuery();
    if (!single && args.status) query.status = args.status;
    request(single ? "/invoices/" + invoiceId : "/invoices", query, single ? "object" : "array", function (error, result) {
      if (error) return finish([error]);
      var lines = single ? [] : listHeading("账单", result);
      appendRows(lines, single ? [result.data] : result.data, function (invoice) {
        return [
          "#" + text(invoice.id) + " " + text(invoice.number) + " / " + text(invoice.status),
          "类型: " + text(invoice.type) + " / 总额 " + money(invoice.total, invoice.currency) + " / 待付 " + money(invoice.remaining, invoice.currency),
          "截止: " + date(invoice.due_at) + " / 已付 " + date(invoice.paid_at),
          "创建: " + date(invoice.created_at),
        ].concat(array(invoice.items).map(function (item) { return text(item.description) + " " + money(item.amount, invoice.currency) + " / 服务器 #" + text(item.service_id); }));
      });
      finish(lines);
    });
  }

  function getMany(specs, callback) {
    var pending = specs.length;
    var results = new Array(pending);
    specs.forEach(function (spec, index) {
      request("/servers/" + serverId + (spec.suffix ? "/" + spec.suffix : ""), spec.query || {}, spec.shape, function (error, result) {
        results[index] = { label: spec.label, suffix: spec.suffix, error: error, data: result && result.data };
        pending -= 1;
        if (!pending && !finished) callback(results);
      });
    });
  }

  function request(path, query, shape, callback) {
    if (finished) return;
    // GET alone is insufficient: /password is a GET requiring operate scope.
    var allowed = /^(?:\/account|\/products(?:\/[1-9]\d*)?|\/invoices(?:\/[1-9]\d*)?|\/servers(?:\/[1-9]\d*(?:\/(?:status|metrics|netrate|traffic-daily|os-templates|port-forwards|backups))?)?)$/;
    if (!allowed.test(path)) return callback("接口不属于 read 范围");
    var encoded = Object.keys(query).map(function (name) { return encodeURIComponent(name) + "=" + encodeURIComponent(query[name]); }).join("&");
    var responded = false;
    function respond(error, result) {
      if (responded || finished) return;
      responded = true;
      callback(error, result);
    }
    try {
      $httpClient.get({
        url: "https://isvoro.com/api/v1/open" + path + (encoded ? "?" + encoded : ""),
        headers: { Authorization: "Bearer " + key, Accept: "application/json" },
        timeout: 6,
        "auto-redirect": false,
        "auto-cookie": false,
      }, function (error, response, body) {
        if (responded || finished) return;
        if (error) return respond("网络错误或请求超时");
        var status = Number(response && response.status);
        var envelope;
        try { envelope = JSON.parse(body); } catch (_) { /* Report HTTP errors even for non-JSON responses. */ }
        if (!(status >= 200 && status < 300)) {
          return respond(apiError(status, envelope, response && response.headers));
        }
        if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) || typeof envelope.code !== "number") return respond("响应格式错误（缺少 code/data）");
        if (envelope.code !== 0) return respond(apiError(status, envelope));
        var data = envelope.data;
        if ((shape === "array" && (!Array.isArray(data) || data.some(function (item) { return !item || typeof item !== "object" || Array.isArray(item); }))) || (shape === "object" && (!data || typeof data !== "object" || Array.isArray(data)))) return respond("响应数据格式错误");
        respond(null, envelope);
      });
    } catch (_) {
      respond("请求执行失败");
    }
  }

  function apiError(status, envelope, headers) {
    if (status === 403 && envelope && envelope.cloudflare_error === true && Number(envelope.error_code) === 1010) return "站点拦截请求（Cloudflare 1010）";
    var code = envelope && envelope.message;
    // Do not echo arbitrary server text or transport errors containing secrets.
    if (typeof code !== "string" || !/^[A-Z][A-Z0-9_]{0,100}$/.test(code)) code = "查询失败";
    var hints = {
      API_KEY_INVALID: "API Key 无效", API_KEY_REVOKED: "API Key 已撤销",
      API_KEY_EXPIRED: "API Key 已过期", API_KEY_IP_NOT_ALLOWED: "出口 IP 不在白名单",
      API_KEY_SCOPE_DENIED: "缺少 read 权限", API_ACCOUNT_SUSPENDED: "账户已暂停",
      API_EMAIL_NOT_VERIFIED: "邮箱未验证", OPEN_API_DISABLED: "Open API 已关闭",
      OPEN_API_ACCESS_DENIED: "账户未获 Open API 授权", SERVER_NOT_FOUND: "服务器不存在",
    };
    var message = (isFinite(status) && status > 0 ? "HTTP " + status + " / " : "") + code;
    if (hints[code]) message += "（" + hints[code] + "）";
    if (status === 429) {
      var retry = headers && (headers["Retry-After"] || headers["retry-after"]);
      message += /^\d{1,6}$/.test(String(retry)) ? " / " + retry + " 秒后重试" : " / 请求过于频繁，请稍后刷新";
    }
    return message;
  }

  function listQuery() { return { page: page, per_page: perPage }; }
  function listHeading(label, result) {
    var meta = result.meta || {};
    return [label + ": 本页 " + result.data.length + " 条 / 总计 " + text(meta.total),
      "页码: " + text(meta.page === undefined ? page : meta.page) + " / " + text(meta.total_pages) + " / 每页 " + text(meta.per_page === undefined ? perPage : meta.per_page)];
  }
  function appendRows(lines, items, render) {
    if (!items.length) { lines.push("暂无记录"); return; }
    items.slice(0, rows).forEach(function (item) {
      var block = render(item || {});
      if (block.length > 1 && lines.length) lines.push("");
      Array.prototype.push.apply(lines, block);
    });
    if (items.length > rows) lines.push("仅显示 " + rows + "/" + items.length + " 条，可增大 MAX_ROWS");
  }
  function finish(lines) {
    if (finished) return;
    finished = true;
    $done({ title: mode === "overview" ? "ISVORO" : "ISVORO / " + (Object.prototype.hasOwnProperty.call(labels, mode) ? labels[mode] : "配置错误"), content: lines.join("\n") });
  }
  function parseArguments(input) {
    var out = Object.create(null);
    input.split("&").forEach(function (part) {
      var pos = part.indexOf("=");
      if (pos < 0) return;
      var name = decode(part.slice(0, pos));
      var raw = part.slice(pos + 1);
      // Surge module defaults stay nonempty; encode NONE to search that literal.
      var optional = ["server_id", "product_id", "invoice_id", "status", "q"].indexOf(name) >= 0;
      out[name] = optional && raw === "NONE" ? "" : decode(raw);
    });
    return out;
  }
  function decode(s) { try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch (_) { return s; } }
  function integer(raw, fallback, min, max, name) {
    if (raw === undefined || raw === "") return fallback;
    var n = Number(raw);
    if (!/^\d+$/.test(String(raw)) || !isFinite(n) || Math.floor(n) !== n || n < min || n > max) throw new Error(name + " 需为 " + min + "–" + max + " 的整数");
    return n;
  }
  function finite(n) { return n === null || n === undefined || n === "" || typeof n === "boolean" || !isFinite(Number(n)) ? null : Number(n); }
  function text(s) { return s === undefined || s === null || s === "" ? "—" : String(s).replace(/[\r\n]+/g, " "); }
  function array(a) { return Array.isArray(a) ? a : []; }
  function yesNo(b) { return b === true || b === 1 ? "是" : b === false || b === 0 ? "否" : "—"; }
  function amount(n) { n = finite(n); return n === null ? "—" : n.toFixed(2); }
  function money(n, currency) { return text(currency) + " " + amount(n); }
  function compactMoney(n, currency) { return currency === "CNY" ? "¥" + amount(n) : money(n, currency); }
  function compactBytes(n) { return bytes(n).replace(/\.00 /, " ").replace(/(\.\d)0 /, "$1 "); }
  function percent(n) { n = finite(n); return n === null ? "—" : (n * 100).toFixed(1) + "%"; }
  function bytes(n) {
    n = finite(n);
    if (n === null || n < 0) return "—";
    var units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
    var i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
    return n.toFixed(i ? 2 : 0) + " " + units[i];
  }
  function rate(n) { return finite(n) === null ? "—" : bytes(n) + "/s"; }
  function trafficSummary(t) {
    var used = finite(t.used_bytes);
    var limit = finite(t.limit_bytes);
    return bytes(used) + " / " + bytes(limit) + (used !== null && limit !== null && limit > 0 ? " (" + percent(used / limit) + ")" : "");
  }
  function specs(s) { return text(s.cores) + " 核 / " + text(s.memory_mb) + " MB / " + text(s.disk_gb) + " GB / " + text(s.bandwidth_mbps) + " Mbps / " + text(s.traffic_gb) + " GB"; }
  function osLabel(os) { return "#" + text(os.id) + " " + text(os.name) + " (" + text(os.type) + ")"; }
  function portRange(port, size) { return finite(port) !== null && size !== null && size > 1 ? text(port) + "–" + (Number(port) + size - 1) : text(port); }
  function plain(s) { return text(String(s).replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim()); }
  function date(s) {
    if (s === null || s === undefined || s === "") return "—";
    var d = new Date(s);
    if (isNaN(d.getTime())) return text(s);
    function pad(n) { return n < 10 ? "0" + n : String(n); }
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function unix(n, milliseconds) { n = finite(n); return n === null ? "—" : date(n * (milliseconds ? 1 : 1000)); }
  function duration(n) { n = finite(n); return n === null || n < 0 ? "—" : Math.floor(n / 86400) + "天 " + Math.floor(n % 86400 / 3600) + "时 " + Math.floor(n % 3600 / 60) + "分"; }
  function numbers(items, field) { return items.map(function (item) { return finite(item[field]); }).filter(function (n) { return n !== null; }); }
  function sum(items, field) { var ns = numbers(items, field); return ns.length ? ns.reduce(function (a, b) { return a + b; }, 0) : items.length ? null : 0; }
  function average(items, field) { var ns = numbers(items, field); return ns.length ? ns.reduce(function (a, b) { return a + b; }, 0) / ns.length : null; }
  function maximum(items, field) { var ns = numbers(items, field); return ns.length ? ns.reduce(function (a, b) { return Math.max(a, b); }) : null; }
})();
