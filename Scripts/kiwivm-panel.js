/**
 * Surge generic panel script - KiwiVM / BandwagonHost.
 */

(function () {
  "use strict";

  var args = parseArguments(typeof $argument === "string" ? $argument : "");
  var mode = String(args.mode || "overview").toLowerCase();
  var config = {
    veid: args.veid || "",
    apiKey: args.api_key || "",
    title: args.title || "KiwiVM",
    icon: args.icon || "",
    color: normalizeColor(args.color || "#6F4A35"),
  };

  var runners = {
    overview: runOverview,
    live: runLive,
    network: runNetwork,
    storage: runStorage,
    security: runSecurity,
    maintenance: runMaintenance,
  };

  if (!runners[mode]) {
    return finishPanel({
      title: config.title + " / 配置错误",
      content: "未知面板模式: " + mode,
      icon: "exclamationmark.triangle.fill",
      color: "#D14343",
    });
  }

  runners[mode]();

  function runOverview() {
    getMany(
      [
        { key: "info", call: "getServiceInfo" },
        { key: "rate", call: "getRateLimitStatus" },
      ],
      function (result) {
        var info = result.data.info;
        if (!info) return finishError("总览读取失败", result.errors.info || "getServiceInfo 无返回");

        var traffic = trafficSummary(info);
        var risk = riskSummary(info);
        var lines = [
          line("主机", value(info.hostname, "unknown")),
          line("机房", value(info.node_location, "unknown")),
          line("套餐", compact([info.plan, info.os, info.vm_type]).join(" / ")),
          line("流量", traffic.used + " / " + traffic.total + " (" + traffic.percent + ")"),
          line("重置", formatUnix(info.data_next_reset)),
          line("IP", ipSummary(info)),
          line("风险", risk.text),
        ];

        if (result.data.rate) {
          lines.push(
            line(
              "API",
              "15m " +
                value(result.data.rate.remaining_points_15min, "?") +
                " / 24h " +
                value(result.data.rate.remaining_points_24h, "?")
            )
          );
        }

        finishPanel({
          title: config.title + " / 总览",
          content: lines.join("\n"),
          icon: iconFor("overview"),
          color: risk.color || config.color,
        });
      }
    );
  }

  function runLive() {
    api("getLiveServiceInfo", {}, function (error, live) {
      if (error) return finishError("实时状态读取失败", error.message);

      var lines = [
        line("状态", live.ve_status || (live.vz_status ? "OVZ live" : "unknown")),
        line("SSH", live.ssh_port ? "port " + live.ssh_port : "not reported"),
      ];

      if (live.load_average) lines.push(line("负载", live.load_average));
      if (live.mem_available_kb) lines.push(line("内存可用", formatBytes(Number(live.mem_available_kb) * 1024)));
      if (live.swap_total_kb || live.swap_available_kb) {
        lines.push(
          line(
            "Swap",
            formatBytes(Number(live.swap_available_kb || 0) * 1024) +
              " / " +
              formatBytes(Number(live.swap_total_kb || 0) * 1024)
          )
        );
      }
      if (live.ve_used_disk_space_b || live.ve_disk_quota_gb) {
        lines.push(
          line(
            "磁盘",
            formatBytes(live.ve_used_disk_space_b) +
              " / " +
              (live.ve_disk_quota_gb ? live.ve_disk_quota_gb + " GB" : "unknown")
          )
        );
      }
      if (live.live_hostname) lines.push(line("系统主机名", live.live_hostname));

      lines.push(line("CPU 限速", yesNo(live.is_cpu_throttled)));
      if (live.is_disk_throttled !== undefined) lines.push(line("IO 限速", yesNo(live.is_disk_throttled)));
      if (live.screendump_png_base64) lines.push(line("VGA 截图", "available"));

      finishPanel({
        title: config.title + " / 实时",
        content: lines.join("\n"),
        icon: iconFor("live"),
        color: live.ve_status === "Stopped" ? "#8A8F98" : config.color,
      });
    });
  }

  function runNetwork() {
    getMany(
      [
        { key: "info", call: "getServiceInfo" },
        { key: "private", call: "privateIp/getAvailableIps", optional: true },
        { key: "migrate", call: "migrate/getLocations", optional: true },
      ],
      function (result) {
        var info = result.data.info;
        if (!info) return finishError("网络信息读取失败", result.errors.info || "getServiceInfo 无返回");

        var privateFree = result.data.private ? count(result.data.private.available_ips) : "n/a";
        var migrateTargets = result.data.migrate ? count(result.data.migrate.locations) : "n/a";

        var lines = [
          line("公网", ipSummary(info)),
          line("IPv6", "ready " + yesNo(info.location_ipv6_ready) + " / limit " + value(info.plan_max_ipv6s, "n/a")),
          line("私网", "assigned " + count(info.private_ip_addresses) + " / free " + privateFree),
          line("私网可用", yesNo(info.plan_private_network_available) + " plan, " + yesNo(info.location_private_network_available) + " location"),
          line("rDNS", yesNo(info.rdns_api_available) + " / PTR " + count(info.ptr)),
          line("迁移", "current " + value(result.data.migrate && result.data.migrate.currentLocation, "n/a") + " / targets " + migrateTargets),
        ];

        appendOptionalErrors(lines, result.errors);

        finishPanel({
          title: config.title + " / 网络",
          content: lines.join("\n"),
          icon: iconFor("network"),
          color: config.color,
        });
      }
    );
  }

  function runStorage() {
    getMany(
      [
        { key: "snapshots", call: "snapshot/list", optional: true },
        { key: "backups", call: "backup/list", optional: true },
      ],
      function (result) {
        if (!result.data.snapshots && !result.data.backups) {
          return finishError("快照备份读取失败", firstError(result.errors) || "无返回");
        }

        var snapshots = asArray(result.data.snapshots && result.data.snapshots.snapshots);
        var backups = asArray(result.data.backups && result.data.backups.backups);
        var latestBackup = newestBackup(backups);
        var firstSnapshot = snapshots[0] || null;
        var stickyCount = snapshots.filter(function (item) {
          return isTruthy(item && item.sticky);
        }).length;

        var lines = [
          line("快照", snapshots.length + " total / " + stickyCount + " sticky"),
          line("最新快照", firstSnapshot ? snapshotLabel(firstSnapshot) : "none"),
          line("备份", backups.length + " total"),
          line("最新备份", latestBackup ? backupLabel(latestBackup) : "none"),
        ];

        appendOptionalErrors(lines, result.errors);

        finishPanel({
          title: config.title + " / 快照备份",
          content: lines.join("\n"),
          icon: iconFor("storage"),
          color: config.color,
        });
      }
    );
  }

  function runSecurity() {
    getMany(
      [
        { key: "info", call: "getServiceInfo", optional: true },
        { key: "suspension", call: "getSuspensionDetails", optional: true },
        { key: "policy", call: "getPolicyViolations", optional: true },
        { key: "rate", call: "getRateLimitStatus", optional: true },
      ],
      function (result) {
        var info = result.data.info || {};
        var suspension = result.data.suspension || {};
        var policy = result.data.policy || {};
        var risk = riskSummary(info);
        var suspensions = asArray(suspension.suspensions);
        var policies = asArray(policy.policy_violations);

        var lines = [
          line("状态", risk.text),
          line("暂停记录", value(suspension.suspension_count || info.suspension_count, 0)),
          line(
            "Abuse",
            value(suspension.total_abuse_points || policy.total_abuse_points || info.total_abuse_points, 0) +
              " / " +
              value(suspension.max_abuse_points || policy.max_abuse_points || info.max_abuse_points, "n/a")
          ),
          line("待处理", "suspension " + suspensions.length + " / policy " + policies.length),
        ];

        if (result.data.rate) {
          lines.push(
            line(
              "API 额度",
              "15m " +
                value(result.data.rate.remaining_points_15min, "?") +
                " / 24h " +
                value(result.data.rate.remaining_points_24h, "?")
            )
          );
        }

        appendOptionalErrors(lines, result.errors);

        finishPanel({
          title: config.title + " / 安全",
          content: lines.join("\n"),
          icon: iconFor("security"),
          color: risk.color || config.color,
        });
      }
    );
  }

  function runMaintenance() {
    getMany(
      [
        { key: "os", call: "getAvailableOS", optional: true },
        { key: "keys", call: "getSshKeys", optional: true },
        { key: "prefs", call: "kiwivm/getNotificationPreferences", optional: true },
      ],
      function (result) {
        if (!result.data.os && !result.data.keys && !result.data.prefs) {
          return finishError("维护信息读取失败", firstError(result.errors) || "无返回");
        }

        var os = result.data.os || {};
        var keys = result.data.keys || {};
        var prefs = result.data.prefs || {};
        var preferences = prefs.email_preferences || {};

        var lines = [
          line("当前系统", value(os.installed, "n/a")),
          line("可装系统", count(os.templates)),
          line("VM SSH keys", keyState(keys.ssh_keys_veid)),
          line("账号 SSH keys", keyState(keys.ssh_keys_user)),
          line("实际使用", keyState(keys.ssh_keys_preferred)),
          line("通知邮箱", value(prefs.notificationEmail, "n/a")),
          line("通知项目", enabledCount(preferences)),
        ];

        appendOptionalErrors(lines, result.errors);

        finishPanel({
          title: config.title + " / 维护",
          content: lines.join("\n"),
          icon: iconFor("maintenance"),
          color: config.color,
        });
      }
    );
  }

  function api(call, params, callback) {
    var requestParams = {};
    var key;
    for (key in params || {}) requestParams[key] = params[key];
    requestParams.veid = config.veid;
    requestParams.api_key = config.apiKey;

    $httpClient.post(
      {
        url: "https://api.64clouds.com/v1/" + sanitizeCall(call),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formEncode(requestParams),
        timeout: 15,
      },
      function (error, response, data) {
        if (error) return callback(new Error(networkError(error)));

        var status = Number((response && (response.status || response.statusCode)) || 200);
        if (status >= 400) return callback(new Error("HTTP " + status));

        var json;
        try {
          json = JSON.parse(data || "{}");
        } catch (parseError) {
          return callback(new Error("JSON 解析失败"));
        }

        if (Number(json.error) !== 0) {
          return callback(new Error("API " + json.error + ": " + value(json.message, "unknown")), json);
        }

        callback(null, json);
      }
    );
  }

  function getMany(calls, callback) {
    var index = 0;
    var data = {};
    var errors = {};

    function next() {
      if (index >= calls.length) return callback({ data: data, errors: errors });

      var item = calls[index++];
      api(item.call, item.params || {}, function (error, json) {
        if (error) {
          errors[item.key] = error.message;
        } else {
          data[item.key] = json;
        }
        next();
      });
    }

    next();
  }

  function trafficSummary(info) {
    var multiplier = Number(info.monthly_data_multiplier || 1) || 1;
    var total = (Number(info.plan_monthly_data) || 0) * multiplier;
    var used = (Number(info.data_counter) || 0) * multiplier;
    var percent = total > 0 ? ((used / total) * 100).toFixed(1) + "%" : "n/a";
    return {
      total: formatBytes(total),
      used: formatBytes(used),
      percent: percent,
    };
  }

  function riskSummary(info) {
    if (isTruthy(info.suspended)) return { text: "已暂停", color: "#D14343" };
    if (isTruthy(info.policy_violation)) return { text: "有待处理违规", color: "#B45309" };
    return { text: "正常", color: "#2E7D32" };
  }

  function ipSummary(info) {
    var ips = asArray(info.ip_addresses);
    var ipv6 = ips.filter(function (item) {
      return String(item).indexOf(":") >= 0 || String(item).indexOf("/") >= 0;
    }).length;
    var ipv4 = Math.max(ips.length - ipv6, 0);
    return "IPv4 " + ipv4 + " / IPv6 " + ipv6;
  }

  function snapshotLabel(item) {
    return compact([item.description, item.os, formatBytes(item.size)]).join(" / ") || value(item.fileName, "unknown");
  }

  function backupLabel(item) {
    return compact([formatUnix(item.timestamp), item.os, formatBytes(item.size)]).join(" / ");
  }

  function newestBackup(backups) {
    if (!backups.length) return null;
    return backups.slice().sort(function (a, b) {
      return Number(b.timestamp || 0) - Number(a.timestamp || 0);
    })[0];
  }

  function keyState(valueToCheck) {
    if (!valueToCheck) return "none";
    if (Array.isArray(valueToCheck)) return valueToCheck.length + " item(s)";
    var text = String(valueToCheck).trim();
    if (!text) return "none";
    return text.split(/\n+/).filter(Boolean).length + " item(s)";
  }

  function enabledCount(preferences) {
    if (!preferences) return "n/a";
    var keys = Object.keys(preferences);
    if (!keys.length) return "0 / 0";
    var enabled = keys.filter(function (key) {
      var item = preferences[key];
      if (typeof item === "object" && item !== null) return isTruthy(item.enabled || item.value || item.state);
      return isTruthy(item);
    }).length;
    return enabled + " / " + keys.length;
  }

  function appendOptionalErrors(lines, errors) {
    var keys = Object.keys(errors || {});
    if (keys.length) lines.push(line("部分失败", keys.join(", ")));
  }

  function finishError(title, message, iconMode) {
    finishPanel({
      title: config.title + " / " + title,
      content: message,
      icon: iconFor(iconMode || mode) || "xmark.octagon.fill",
      color: "#D14343",
    });
  }

  function finishPanel(panel) {
    $done({
      title: panel.title || config.title,
      content: panel.content || "",
      icon: panel.icon || iconFor(mode),
      "icon-color": normalizeColor(panel.color || config.color),
    });
  }

  function iconFor(name) {
    if (config.icon && (name === "overview" || name === mode)) return config.icon;
    return {
      overview: "server.rack",
      live: "waveform.path.ecg",
      network: "network",
      storage: "externaldrive.fill",
      security: "lock.shield.fill",
      maintenance: "wrench.and.screwdriver.fill",
    }[name] || config.icon || "server.rack";
  }

  function parseArguments(input) {
    var out = {};
    String(input || "")
      .split("&")
      .forEach(function (part) {
        if (!part) return;
        var pos = part.indexOf("=");
        var key = pos >= 0 ? part.slice(0, pos) : part;
        var value = pos >= 0 ? part.slice(pos + 1) : "";
        out[decode(key)] = decode(value);
      });
    return out;
  }

  function formEncode(params) {
    return Object.keys(params)
      .map(function (key) {
        return encodeURIComponent(key) + "=" + encodeURIComponent(params[key]);
      })
      .join("&");
  }

  function sanitizeCall(call) {
    return String(call || "")
      .replace(/^\/+/, "")
      .replace(/[^A-Za-z0-9_/-]/g, "");
  }

  function formatBytes(valueToFormat) {
    var bytes = Number(valueToFormat);
    if (!isFinite(bytes) || bytes <= 0) return "0 B";
    var units = ["B", "KB", "MB", "GB", "TB"];
    var index = 0;
    while (bytes >= 1024 && index < units.length - 1) {
      bytes = bytes / 1024;
      index += 1;
    }
    return bytes.toFixed(index === 0 ? 0 : 2) + " " + units[index];
  }

  function normalizeColor(input) {
    var text = String(input || "").trim();
    if (!text) return "#6F4A35";
    text = text.replace(/^%23/i, "#");
    if (text.charAt(0) !== "#") text = "#" + text;
    return text;
  }

  function formatUnix(valueToFormat) {
    var timestamp = Number(valueToFormat);
    if (!timestamp) return "n/a";
    var date = new Date(timestamp * 1000);
    if (String(date) === "Invalid Date") return "n/a";
    return (
      date.getFullYear() +
      "-" +
      pad(date.getMonth() + 1) +
      "-" +
      pad(date.getDate()) +
      " " +
      pad(date.getHours()) +
      ":" +
      pad(date.getMinutes())
    );
  }

  function pad(valueToPad) {
    return String(valueToPad).padStart(2, "0");
  }

  function yesNo(valueToCheck) {
    return isTruthy(valueToCheck) ? "yes" : "no";
  }

  function isTruthy(valueToCheck) {
    if (valueToCheck === true || valueToCheck === 1) return true;
    var text = String(valueToCheck || "").toLowerCase();
    return text === "1" || text === "true" || text === "yes" || text === "enabled";
  }

  function count(valueToCount) {
    if (!valueToCount) return 0;
    if (Array.isArray(valueToCount)) return valueToCount.length;
    if (typeof valueToCount === "object") return Object.keys(valueToCount).length;
    return String(valueToCount).trim() ? 1 : 0;
  }

  function asArray(valueToConvert) {
    if (!valueToConvert) return [];
    if (Array.isArray(valueToConvert)) return valueToConvert;
    if (typeof valueToConvert === "object") {
      return Object.keys(valueToConvert).map(function (key) {
        return valueToConvert[key];
      });
    }
    return [valueToConvert];
  }

  function compact(values) {
    return values
      .map(function (item) {
        return item === undefined || item === null ? "" : String(item);
      })
      .filter(function (item) {
        return item.length > 0 && item !== "0 B";
      });
  }

  function line(label, text) {
    return label + ": " + value(text, "n/a");
  }

  function value(input, fallback) {
    if (input === undefined || input === null || input === "") return fallback;
    return String(input);
  }

  function networkError(error) {
    if (!error) return "network error";
    return error.error || error.message || JSON.stringify(error);
  }

  function firstError(errors) {
    var keys = Object.keys(errors || {});
    return keys.length ? errors[keys[0]] : "";
  }

  function decode(input) {
    try {
      return decodeURIComponent(String(input || "").replace(/\+/g, " "));
    } catch (_) {
      return String(input || "");
    }
  }
})();
