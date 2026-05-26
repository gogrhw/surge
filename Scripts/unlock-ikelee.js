/**
 * Surge MITM - Unlock Kelee.one by rewriting request headers with a custom User-Agent.
 */

const loonVersion = parseArgsToDict($argument).ua;
const userAgent = `Loon/${loonVersion} CFNetwork/3826.500.111.2.2 Darwin/24.4.0`;

$done({
  headers: {
    ...$request.headers,
    "user-agent": userAgent,
  },
});

function parseArgsToDict(args) {
  const dict = {};
  const pairs = args.split("&");
  for (const pair of pairs) {
    const idx = pair.indexOf(":");
    if (idx === -1) continue;
    dict[pair.substring(0, idx)] = pair.substring(idx + 1);
  }
  return dict;
}
