/**
 * GitHub Private Repo Access
 *
 * Surge: [MITM] hostname = %APPEND% raw.githubusercontent.com, gist.githubusercontent.com
 * Loon: [MITM] hostname = raw.githubusercontent.com, gist.githubusercontent.com
 *
 * Only requests to raw/gist.githubusercontent.com under the configured username
 * will have the Authorization header injected.
 *
 * Arguments (passed via module): username=...&token=...
 */

const args = parseArgs($argument);
const username = args.username || "";
const token = args.token || "";

if (!username || !token) {
  console.log("GitHub Private: username or token not configured");
  $done({});
}

const url = $request.url;
const match = url.match(/https:\/\/(?:raw|gist)\.githubusercontent\.com\/([^\/]+)\//);

if (match && match[1] === username) {
  console.log(`GitHub Private: authorized request to ${url}`);
  $done({
    headers: {
      ...$request.headers,
      Authorization: `token ${token}`,
    },
  });
} else {
  $done({});
}

function parseArgs(input) {
  const dict = {};
  String(input || "").split("&").forEach(function (pair) {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    dict[decodeURIComponent(pair.substring(0, idx))] = decodeURIComponent(pair.substring(idx + 1));
  });
  return dict;
}
