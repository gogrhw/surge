/**
 * Surge MITM - Emby playback unlock via fake device validation.
 */

if ($request.url.includes("mb3admin.com/admin/service/registration/validateDevice")) {
  if ($response.status !== 200) {
    $done({
      status: "HTTP/1.1 200 OK",
      headers: $response.headers,
      body: JSON.stringify({
        cacheExpirationDays: 999,
        resultCode: "GOOD",
        message: "Device Valid",
      }),
    });
    return;
  }
}
$done({});
