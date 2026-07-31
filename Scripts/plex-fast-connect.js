/*
 * Plex Fast Connect for Surge (public module)
 *
 * Request phase:
 *   Use the exact Plex server Device cached from a previous official response.
 *   Verify explicit URLs, or cached official direct candidates, with the cached
 *   server access token. Return only the first authenticated connection without
 *   contacting plex.tv. A missing or stale cache falls back to discovery.
 *
 * Response phase:
 *   On a cold cache, identify the correct official Device by clientIdentifier
 *   when explicit URLs are provided. With no explicit URLs, authenticate the
 *   official direct candidates and automatically select their Device. Preserve
 *   the complete official Device and persist it for later launches.
 *   With bypass disabled, retain the legacy fastest-candidate response filter.
 */

(function () {
  'use strict';

  var PREFIX = '[PlexFastConnect]';
  var CACHE_KEY = 'plex-fast-connect.device';
  var args = parseArguments(typeof $argument === 'string' ? $argument : '');
  var phase = args.phase || '';
  var debug = parseBoolean(args.debug, false);

  if (phase === 'request') {
    handleRequest();
    return;
  }

  if (phase === 'response') {
    handleResponse();
    return;
  }

  log('Unknown script phase; leaving traffic unchanged');
  $done({});

  function handleRequest() {
    var bypassOfficial = parseBoolean(args.bypass_official, false);
    if (!bypassOfficial) {
      continueWithOfficialDiscovery();
      return;
    }

    var discovery = discoveryOptions(args.lan_url, args.remote_url);
    var cachedDevice = loadCachedDevice(discovery.signature);
    var connections = cachedDevice
      ? discoveryConnections(discovery, cachedDevice)
      : [];
    if (!cachedDevice || !cachedDevice.token || connections.length === 0) {
      log(
        'Bypass unavailable: '
        + (!cachedDevice
          ? 'no cached official Device'
          : !cachedDevice.token
            ? 'cached Device has no server access token'
            : 'no usable explicit or automatically discovered URLs')
        + '; using official discovery'
      );
      continueWithOfficialDiscovery();
      return;
    }

    var timeout = clampNumber(args.bypass_timeout, 3, 0.5, 4);
    probeGroup(
      connections,
      cachedDevice.token,
      timeout,
      'library',
      function (winner, outcome) {
        if (!winner) {
          if (outcome && outcome.unauthorized) {
            clearCachedDevice();
            log('Cached server token was rejected; cleared cache for official refresh');
          }
          log('Configured direct URLs failed; using official discovery');
          continueWithOfficialDiscovery();
          return;
        }

        var body = buildCachedResources(cachedDevice.raw, winner);
        log('Used cached official Device with ' + safeConnectionLabel(winner));
        $done({
          response: {
            status: 200,
            headers: {
              'Content-Type': 'application/xml; charset=utf-8',
              'Cache-Control': 'no-store',
              'X-Surge-Plex-Fast-Connect': 'cache-hit',
            },
            body: body,
          },
        });
      }
    );
  }

  function continueWithOfficialDiscovery() {
    var headers = copyObject($request.headers || {});

    deleteHeader(headers, 'If-None-Match');
    deleteHeader(headers, 'If-Modified-Since');
    deleteHeader(headers, 'Cache-Control');
    deleteHeader(headers, 'Pragma');
    headers['Cache-Control'] = 'no-cache';
    headers.Pragma = 'no-cache';

    debugLog('Removed resources.xml cache validators');
    $done({ headers: headers });
  }

  function handleResponse() {
    var status = Number($response.status);
    var body = $response.body;

    if (status !== 200 || typeof body !== 'string' || body.indexOf('<Connection') < 0) {
      debugLog('Response is not a rewritable resources document; status=' + status);
      $done({});
      return;
    }

    var devices = findServerDevices(body);
    if (devices.length === 0) {
      debugLog('No Plex Media Server devices found');
      $done({});
      return;
    }

    var probeTimeout = clampNumber(args.probe_timeout, 2, 0.5, 3);
    var allowRelay = parseBoolean(args.allow_relay, true);
    if (parseBoolean(args.bypass_official, false)) {
      seedOfficialDevice(body, devices);
      return;
    }

    filterOfficialConnections(body, devices, probeTimeout, allowRelay);
  }

  function seedOfficialDevice(body, devices) {
    var discovery = discoveryOptions(args.lan_url, args.remote_url);
    var timeout = clampNumber(args.bypass_timeout, 3, 0.5, 4);

    if (discovery.explicit) {
      identifyExplicitDevice(body, devices, discovery, timeout);
      return;
    }

    identifyAutomaticDevice(body, devices, discovery, timeout);
  }

  function identifyExplicitDevice(body, devices, discovery, timeout) {
    if (discovery.connections.length === 0) {
      log('Explicit URL parameters are invalid; preserving official discovery');
      $done({});
      return;
    }

    probeGroup(
      discovery.connections,
      '',
      timeout,
      'identity',
      function (identityWinner) {
        var machineIdentifier = identityWinner
          && identityWinner.identity
          && identityWinner.identity.machineIdentifier;
        var device = findDeviceByIdentifier(devices, machineIdentifier);
        if (!device) {
          log('Explicit URL identity did not match an official Device');
          $done({});
          return;
        }
        if (!device.token) {
          log('Matched official Device has no server access token');
          $done({});
          return;
        }

        probeGroup(
          discovery.connections,
          device.token,
          timeout,
          'library',
          function (winner) {
            if (!winner) {
              log('Explicit URLs did not authenticate; preserving official discovery');
              $done({});
              return;
            }
            persistSelectedDevice(body, device, winner, discovery.signature);
          }
        );
      }
    );
  }

  function identifyAutomaticDevice(body, devices, discovery, timeout) {
    var candidates = [];
    devices.forEach(function (device) {
      device.connections.forEach(function (connection) {
        if (connection.relay || !device.token) return;
        var candidate = copyObject(connection);
        candidate.probeToken = device.token;
        candidate.deviceIdentifier = device.clientIdentifier;
        candidates.push(candidate);
      });
    });

    probeGroup(candidates, '', timeout, 'library', function (winner) {
      var device = winner
        ? findDeviceByIdentifier(devices, winner.deviceIdentifier)
        : null;
      if (!winner || !device) {
        log('No official direct candidate authenticated; preserving discovery');
        $done({});
        return;
      }
      persistSelectedDevice(body, device, winner, discovery.signature);
    });
  }

  function persistSelectedDevice(body, device, winner, sourceSignature) {
    if (!saveCachedDevice(device, sourceSignature)) {
      log('Could not persist official Device; returning optimized response only');
    }
    var replacement = replaceConnections(device.raw, winner);
    var optimizedBody = replaceDevice(body, device, replacement);
    finishModifiedResponse(
      optimizedBody,
      'cache-seeded',
      'Seeded ' + labelForDevice(device) + ' with '
        + safeConnectionLabel(winner)
    );
  }

  function filterOfficialConnections(body, devices, probeTimeout, allowRelay) {
    var pending = devices.length;

    devices.forEach(function (device) {
      chooseFastestConnection(
        device,
        probeTimeout,
        allowRelay,
        function (winner) {
          device.winner = winner;
          pending -= 1;
          if (pending === 0) finishResponse(body, devices);
        }
      );
    });
  }

  function chooseFastestConnection(device, timeout, allowRelay, callback) {
    var direct = device.connections.filter(function (connection) {
      return !connection.relay;
    });
    var relay = device.connections.filter(function (connection) {
      return connection.relay;
    });

    probeGroup(direct, device.token, timeout, 'identity', function (winner) {
      if (winner) {
        callback(winner);
        return;
      }

      if (!allowRelay || relay.length === 0) {
        callback(null);
        return;
      }

      debugLog(labelForDevice(device) + ': direct probes failed; trying Relay');
      probeGroup(relay, device.token, timeout, 'identity', callback);
    });
  }

  function probeGroup(connections, token, timeout, probeType, callback) {
    var candidates = uniqueConnections(connections);
    if (candidates.length === 0) {
      callback(null, { unauthorized: false });
      return;
    }

    var settled = false;
    var pending = candidates.length;
    var sawUnauthorized = false;

    setTimeout(function () {
      finish(null);
    }, Math.ceil((timeout + 0.25) * 1000));

    candidates.forEach(function (connection) {
      var headers = { Accept: 'application/xml' };
      var probeToken = connection.probeToken || token;
      if (probeToken) headers['X-Plex-Token'] = probeToken;

      var options = {
        url: probeURL(connection.uri, probeType),
        headers: headers,
        timeout: timeout,
        'auto-cookie': false,
        'auto-redirect': true,
      };

      debugLog('Probing ' + safeConnectionLabel(connection));
      try {
        $httpClient.get(options, function (error, response, data) {
          handleProbeResult(connection, error, response, data);
        });
      } catch (error) {
        handleProbeResult(connection, error, null, '');
      }
    });

    function handleProbeResult(connection, error, response, data) {
      if (settled) return;

      var status = response && Number(
        response.status !== undefined ? response.status : response.statusCode
      );
      if (status === 401 || status === 403) sawUnauthorized = true;
      var identity = probeType === 'identity' ? parseIdentity(data) : {};
      var validBody = probeType === 'identity'
        ? !!identity.machineIdentifier
        : isLibraryResponse(data);
      var reachable = !error
        && status >= 200
        && status < 300
        && validBody;

      if (reachable) {
        connection.identity = identity;
        debugLog('Selected ' + safeConnectionLabel(connection) + '; status=' + status);
        finish(connection);
        return;
      }

      pending -= 1;
      debugLog(
        'Probe failed for ' + safeConnectionLabel(connection)
        + (error ? '; error=' + String(error) : '; status=' + status)
      );
      if (pending === 0) finish(null);
    }

    function finish(result) {
      if (settled) return;
      settled = true;
      callback(result, { unauthorized: sawUnauthorized });
    }
  }

  function finishResponse(originalBody, devices) {
    var selected = devices.filter(function (device) {
      return !!device.winner;
    });

    if (selected.length === 0) {
      log('No reachable candidate verified; preserving the original Plex response');
      $done({});
      return;
    }

    var body = rebuildBody(originalBody, selected);
    if (body === originalBody) {
      $done({});
      return;
    }

    var headers = copyObject($response.headers || {});
    deleteHeader(headers, 'Content-Length');
    deleteHeader(headers, 'ETag');
    deleteHeader(headers, 'Content-MD5');
    headers['X-Surge-Plex-Fast-Connect'] = 'selected-' + selected.length;

    log(
      'Selected reachable connections for '
      + selected.length
      + ' Plex server'
      + (selected.length === 1 ? '' : 's')
    );
    $done({ headers: headers, body: body });
  }

  function finishModifiedResponse(body, marker, message) {
    var headers = copyObject($response.headers || {});
    deleteHeader(headers, 'Content-Length');
    deleteHeader(headers, 'ETag');
    deleteHeader(headers, 'Content-MD5');
    headers['X-Surge-Plex-Fast-Connect'] = marker;
    log(message);
    $done({ headers: headers, body: body });
  }

  function findServerDevices(body) {
    var devices = [];
    var devicePattern = /<Device\b[^>]*>[\s\S]*?<\/Device>/gi;
    var match;

    while ((match = devicePattern.exec(body)) !== null) {
      var raw = match[0];
      var opening = raw.match(/^<Device\b[^>]*>/i);
      if (!opening) continue;

      var provides = xmlAttribute(opening[0], 'provides');
      if (!/(^|,)\s*server\s*(,|$)/i.test(provides)) continue;

      var connections = findConnections(raw);
      if (connections.length === 0) continue;

      devices.push({
        start: match.index,
        end: match.index + raw.length,
        raw: raw,
        connections: connections,
        token: decodeXML(xmlAttribute(opening[0], 'accessToken')),
        name: decodeXML(xmlAttribute(opening[0], 'name')),
        clientIdentifier: decodeXML(xmlAttribute(opening[0], 'clientIdentifier')),
        winner: null,
      });
    }

    return devices;
  }

  function findDeviceByIdentifier(devices, clientIdentifier) {
    var wanted = String(clientIdentifier || '').trim().toLowerCase();
    if (!wanted) return null;

    for (var index = 0; index < devices.length; index += 1) {
      if (
        String(devices[index].clientIdentifier || '').trim().toLowerCase()
        === wanted
      ) {
        return devices[index];
      }
    }
    return null;
  }

  function findConnections(deviceBody) {
    var connections = [];
    var connectionPattern = /<Connection\b[^>]*\/\s*>/gi;
    var match;

    while ((match = connectionPattern.exec(deviceBody)) !== null) {
      var raw = match[0];
      var uri = decodeXML(xmlAttribute(raw, 'uri'));
      if (!/^https?:\/\//i.test(uri)) continue;

      var relayValue = xmlAttribute(raw, 'relay');
      var address = decodeXML(xmlAttribute(raw, 'address'));
      var protocol = decodeXML(xmlAttribute(raw, 'protocol'));
      var port = decodeXML(xmlAttribute(raw, 'port'));
      var resolvedProtocol = protocol
        || ((uri.match(/^https?/i) || ['http'])[0].toLowerCase());
      connections.push({
        index: connections.length,
        start: match.index,
        end: match.index + raw.length,
        raw: raw,
        uri: uri,
        protocol: resolvedProtocol,
        address: address,
        port: port || (resolvedProtocol === 'https' ? '443' : '80'),
        local: parseBoolean(xmlAttribute(raw, 'local'), false),
        relay: parseBoolean(relayValue, false) || /\.plex\.bz$/i.test(address),
      });
    }

    return connections;
  }

  function rebuildBody(body, devices) {
    var output = '';
    var cursor = 0;

    devices.sort(function (a, b) {
      return a.start - b.start;
    }).forEach(function (device) {
      output += body.slice(cursor, device.start);
      output += keepOnlyWinner(device);
      cursor = device.end;
    });

    output += body.slice(cursor);
    return output;
  }

  function keepOnlyWinner(device) {
    var output = '';
    var cursor = 0;

    device.connections.forEach(function (connection) {
      output += device.raw.slice(cursor, connection.start);
      if (connection.index === device.winner.index) output += connection.raw;
      cursor = connection.end;
    });

    output += device.raw.slice(cursor);
    return output;
  }

  function replaceDevice(body, device, replacement) {
    return body.slice(0, device.start) + replacement + body.slice(device.end);
  }

  function replaceConnections(deviceRaw, connection) {
    var withoutConnections = deviceRaw.replace(
      /<Connection\b[^>]*\/\s*>/gi,
      ''
    );
    return withoutConnections.replace(
      /<\/Device>\s*$/i,
      connectionXML(connection) + '</Device>'
    );
  }

  function connectionXML(connection) {
    return [
      '<Connection',
      xmlField('protocol', connection.protocol),
      xmlField('address', connection.address),
      xmlField('port', connection.port),
      xmlField('uri', connection.uri),
      xmlField('local', connection.local ? '1' : '0'),
      xmlField('relay', connection.relay ? '1' : '0'),
      '/>',
    ].join('');
  }

  function buildCachedResources(deviceRaw, connection) {
    return '<?xml version="1.0" encoding="UTF-8"?>'
      + '<MediaContainer size="1">'
      + replaceConnections(deviceRaw, connection)
      + '</MediaContainer>';
  }

  function loadCachedDevice(sourceSignature) {
    if (typeof $persistentStore === 'undefined' || !$persistentStore) return null;
    try {
      var stored = $persistentStore.read(CACHE_KEY);
      if (!stored) return null;
      var payload = JSON.parse(stored);
      if (
        !payload
        || payload.sourceSignature !== sourceSignature
        || typeof payload.raw !== 'string'
      ) {
        return null;
      }
      var devices = findServerDevices(payload.raw);
      var device = findDeviceByIdentifier(devices, payload.clientIdentifier);
      if (!device || !device.token || devices.length !== 1) return null;
      return device;
    } catch (error) {
      debugLog('Ignoring invalid Device cache');
      return null;
    }
  }

  function saveCachedDevice(device, sourceSignature) {
    if (typeof $persistentStore === 'undefined' || !$persistentStore) return false;
    try {
      return $persistentStore.write(
        JSON.stringify({
          sourceSignature: sourceSignature,
          name: device.name,
          clientIdentifier: device.clientIdentifier,
          raw: device.raw,
        }),
        CACHE_KEY
      );
    } catch (error) {
      debugLog('Device cache write failed');
      return false;
    }
  }

  function clearCachedDevice() {
    if (typeof $persistentStore === 'undefined' || !$persistentStore) return false;
    try {
      return $persistentStore.write('', CACHE_KEY);
    } catch (error) {
      debugLog('Device cache clear failed');
      return false;
    }
  }

  function uniqueConnections(connections) {
    var seen = {};
    return connections.filter(function (connection) {
      var key = connection.uri + '\n' + String(connection.probeToken || '');
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    });
  }

  function discoveryOptions(lanURL, remoteURL) {
    var lanValue = normalizeOptionalURL(lanURL);
    var remoteValue = normalizeOptionalURL(remoteURL);
    var explicit = !!lanValue || !!remoteValue;
    var connections = configuredConnections(lanValue, remoteValue);
    return {
      explicit: explicit,
      connections: connections,
      signature: explicit
        ? 'explicit|' + connections.map(function (connection) {
          return connection.uri;
        }).join('|')
        : 'automatic',
    };
  }

  function normalizeOptionalURL(value) {
    var normalized = String(value || '').trim();
    return /^auto$/i.test(normalized) ? '' : normalized;
  }

  function discoveryConnections(discovery, cachedDevice) {
    if (discovery.explicit) return discovery.connections;
    return cachedDevice.connections.filter(function (connection) {
      return !connection.relay;
    });
  }

  function configuredConnections(lanURL, remoteURL) {
    var connections = [];
    var lan = parseConnectionURL(lanURL, true);
    var remote = parseConnectionURL(remoteURL, false);

    if (lan) connections.push(lan);
    if (remote && (!lan || remote.uri !== lan.uri)) connections.push(remote);
    connections.forEach(function (connection, index) {
      connection.index = index;
    });
    return connections;
  }

  function parseConnectionURL(value, local) {
    var uri = String(value || '').trim().replace(/\/+$/, '');
    var match = uri.match(
      /^(https?):\/\/(\[[^\]]+\]|[^/:?#]+)(?::(\d+))?(\/[^?#]*)?$/i
    );
    if (!match) return null;

    var protocol = match[1].toLowerCase();
    var address = match[2].replace(/^\[|\]$/g, '');
    var port = match[3] || (protocol === 'https' ? '443' : '80');
    return {
      index: 0,
      uri: uri,
      protocol: protocol,
      address: address,
      port: port,
      local: !!local,
      relay: false,
      identity: null,
    };
  }

  function probeURL(uri, probeType) {
    var path = probeType === 'library' ? '/library/sections' : '/identity';
    return uri.split(/[?#]/)[0].replace(/\/+$/, '') + path;
  }

  function safeConnectionLabel(connection) {
    var protocol = connection.uri.match(/^https?/i);
    return (protocol ? protocol[0].toLowerCase() : 'http')
      + '://'
      + (connection.address || 'unknown-host')
      + (connection.local ? ' [local]' : connection.relay ? ' [relay]' : ' [remote]');
  }

  function labelForDevice(device) {
    return device.name || device.clientIdentifier || 'Plex server';
  }

  function xmlAttribute(tag, name) {
    var pattern = new RegExp(
      "\\b" + escapeRegExp(name) + "\\s*=\\s*([\"'])([\\s\\S]*?)\\1",
      'i'
    );
    var match = tag.match(pattern);
    return match ? match[2] : '';
  }

  function parseIdentity(body) {
    if (typeof body !== 'string') return {};
    var opening = body.match(/<MediaContainer\b[^>]*\/?\s*>/i);
    if (!opening) return {};
    return {
      machineIdentifier: decodeXML(xmlAttribute(opening[0], 'machineIdentifier')),
      version: decodeXML(xmlAttribute(opening[0], 'version')),
      claimed: decodeXML(xmlAttribute(opening[0], 'claimed')),
    };
  }

  function isLibraryResponse(body) {
    return typeof body === 'string' && /<MediaContainer\b/i.test(body);
  }

  function xmlField(name, value) {
    return ' ' + name + '="' + encodeXML(value) + '"';
  }

  function encodeXML(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function decodeXML(value) {
    return String(value || '')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
  }

  function deleteHeader(headers, target) {
    Object.keys(headers).forEach(function (name) {
      if (name.toLowerCase() === target.toLowerCase()) delete headers[name];
    });
  }

  function copyObject(source) {
    var copy = {};
    Object.keys(source).forEach(function (key) {
      copy[key] = source[key];
    });
    return copy;
  }

  function parseArguments(value) {
    var result = {};
    String(value || '').split('&').forEach(function (part) {
      if (!part) return;
      var separator = part.indexOf('=');
      var key = separator < 0 ? part : part.slice(0, separator);
      var item = separator < 0 ? '' : part.slice(separator + 1);
      try {
        key = decodeURIComponent(key.replace(/\+/g, ' '));
        item = decodeURIComponent(item.replace(/\+/g, ' '));
      } catch (error) {
        // Keep the original strings when a module argument is not URL-encoded.
      }
      result[key] = item;
    });
    return result;
  }

  function parseBoolean(value, fallback) {
    if (value === true || value === '1' || String(value).toLowerCase() === 'true') {
      return true;
    }
    if (value === false || value === '0' || String(value).toLowerCase() === 'false') {
      return false;
    }
    return fallback;
  }

  function clampNumber(value, fallback, minimum, maximum) {
    var number = Number(value);
    if (!isFinite(number)) number = fallback;
    return Math.max(minimum, Math.min(maximum, number));
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function debugLog(message) {
    if (debug) log(message);
  }

  function log(message) {
    console.log(PREFIX + ' ' + message);
  }
})();
