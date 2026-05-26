/**
 * Surge cron script - BandwagonHost traffic usage notifier.
 *
 * Arguments (passed via module): veid=...&api_key=...
 */

(function () {
  const args = parseArgs(typeof $argument === "string" ? $argument : "");
  const VEID = args.veid || "";
  const API_KEY = args.api_key || "";

  if (!VEID || !API_KEY) {
    $notification.post("搬瓦工流量查询失败", "", "VEID 或 API Key 未配置");
    return $done();
  }

  function notify(title, subtitle, body) {
    $notification.post(title, subtitle || "", body || "");
  }

  const url =
    "https://api.64clouds.com/v1/getServiceInfo?veid=" +
    encodeURIComponent(VEID) +
    "&api_key=" +
    encodeURIComponent(API_KEY);

  $httpClient.get({ url: url, timeout: 10 }, function (error, response, data) {
    if (error) {
      notify("搬瓦工流量查询失败", "", "网络错误：" + (error.error || error.message || JSON.stringify(error)));
      return $done();
    }

    let json;
    try {
      json = JSON.parse(data || "");
    } catch (_) {
      notify("搬瓦工流量查询失败", "", "解析返回数据失败");
      return $done();
    }

    if (Number(json.error) !== 0) {
      notify("搬瓦工流量查询失败", "", "API 返回错误：" + json.error);
      return $done();
    }

    const totalBytes = Number(json.plan_monthly_data) || 0;
    const usedBytes = Number(json.data_counter) || 0;
    const totalGB = totalBytes / 1024 / 1024 / 1024;
    const usedGB = usedBytes / 1024 / 1024 / 1024;
    const remainGB = Math.max(totalGB - usedGB, 0);

    const message =
      "已用：" +
      usedGB.toFixed(2) +
      " GB\n剩余：" +
      remainGB.toFixed(2) +
      " GB";

    notify("Coresite LA2", "", message);
    $done();
  });

  function parseArgs(input) {
    const dict = {};
    String(input || "").split("&").forEach(function (pair) {
      const idx = pair.indexOf("=");
      if (idx === -1) return;
      dict[decodeURIComponent(pair.substring(0, idx))] = decodeURIComponent(pair.substring(idx + 1));
    });
    return dict;
  }
})();
