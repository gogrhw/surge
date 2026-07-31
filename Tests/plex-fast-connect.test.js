const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = fs.readFileSync(
  path.join(ROOT, 'Scripts/plex-fast-connect.js'),
  'utf8'
);
const MODULE = fs.readFileSync(
  path.join(ROOT, 'Modules/plex-fast-connect.sgmodule'),
  'utf8'
);
const IDENTITY = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<MediaContainer size="0" claimed="1" ',
  'machineIdentifier="0123456789abcdef0123456789abcdef01234567" ',
  'version="1.43.3.10828-00f62d37d"/>',
].join('');

const XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<MediaContainer size="2">',
  '<Device name="Living Room" product="Plex Media Server" provides="server" ',
  'clientIdentifier="server-1" accessToken="fixture-server-token">',
  '<Connection protocol="http" address="198.51.100.10" port="32400" ',
  'uri="http://198.51.100.10:32400" local="1" relay="0"/>',
  '<Connection protocol="https" address="remote.example.com" port="443" ',
  'uri="https://remote.example.com" local="0" relay="0"/>',
  '<Connection protocol="https" address="relay01.plex.bz" port="443" ',
  'uri="https://relay01.plex.bz:443" local="0" relay="1"/>',
  '</Device>',
  '<Device name="Browser" product="Plex Web" provides="client">',
  '<Connection protocol="https" address="client.example.com" port="443" ',
  'uri="https://client.example.com" local="0" relay="0"/>',
  '</Device>',
  '</MediaContainer>',
].join('');
const SHARED_SERVER_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<MediaContainer size="3">',
  '<Device name="Example Server" product="Plex Media Server" provides="server" ',
  'clientIdentifier="0123456789abcdef0123456789abcdef01234567" ',
  'accessToken="fixture-shared-server-token" owned="0" ownerId="42" ',
  'sourceTitle="Shared by Alice" publicAddress="203.0.113.10">',
  '<Connection protocol="https" address="192-0-2-10.example.plex.direct" ',
  'port="32400" uri="https://192-0-2-10.example.plex.direct:32400" ',
  'local="1" relay="0"/>',
  '<Connection protocol="https" address="old-remote.example.com" port="32400" ',
  'uri="https://old-remote.example.com:32400" local="0" relay="0"/>',
  '</Device>',
  '<Device name="Other Server" product="Plex Media Server" provides="server" ',
  'clientIdentifier="other-server-id" accessToken="fixture-other-server-token" owned="0">',
  '<Connection protocol="https" address="other.example.com" port="443" ',
  'uri="https://other.example.com" local="0" relay="0"/>',
  '</Device>',
  '<Device name="Browser" product="Plex Web" provides="client">',
  '<Connection protocol="https" address="client.example.com" port="443" ',
  'uri="https://client.example.com" local="0" relay="0"/>',
  '</Device>',
  '</MediaContainer>',
].join('');
const LIBRARY_SECTIONS = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<MediaContainer size="1"><Directory key="1" title="Movies"/></MediaContainer>',
].join('');

(async function () {
  assert.match(MODULE, /\[MITM\][\s\S]*hostname = %APPEND% plex\.tv/);
  assert.equal((MODULE.match(/\btype=http-request\b/g) || []).length, 1);
  assert.equal((MODULE.match(/\btype=http-response\b/g) || []).length, 1);
  assert.match(MODULE, /\brequires-body=true\b/);
  assert.match(
    MODULE,
    /^#!arguments=BYPASS_OFFICIAL:true,LAN_URL:auto,REMOTE_URL:auto,/m
  );
  const argumentDeclaration = MODULE.match(/^#!arguments=(.+)$/m);
  assert.ok(argumentDeclaration, 'module argument declaration missing');
  argumentDeclaration[1].split(',').forEach(function (item) {
    assert.match(
      item,
      /^[A-Z_]+:[^,]+$/,
      'every colon-style Surge argument must have a non-empty default value'
    );
  });
  assert.equal(MODULE.includes('SERVER_NAME'), false);
  assert.equal(MODULE.includes('server_name='), false);
  assert.equal(SOURCE.includes('server_name'), false);
  assert.equal(MODULE.includes('plex-fast-connect.js?v='), false);
  assert.match(
    SOURCE,
    /var CACHE_KEY = 'plex-fast-connect\.device';/
  );
  assert.equal(SOURCE.includes('payload.version'), false);
  assert.equal(SOURCE.includes('version: 2'), false);
  assert.match(MODULE, /^#!arguments-desc=/m);
  assert.match(MODULE, /bypass_official=\{\{\{BYPASS_OFFICIAL\}\}\}/);
  assert.equal(MODULE.includes('%SCRIPT_URL%'), false);

  assert.equal(
    (MODULE.match(
      /script-path=https:\/\/raw\.githubusercontent\.com\/gogrhw\/surge\//g
    ) || []).length,
    2,
    'both scripts must use the unauthenticated public raw URL'
  );
  assert.equal(
    /https:\/\/[^/\s]+@raw\.githubusercontent\.com/.test(MODULE),
    false,
    'public module must not embed GitHub credentials'
  );

  const modulePatterns = Array.from(MODULE.matchAll(/(?:^|,)pattern=([^,\n]+)/gm))
    .map(function (match) {
      return new RegExp(match[1]);
    });
  assert.equal(modulePatterns.length, 2);
  modulePatterns.forEach(function (pattern) {
    assert.equal(
      pattern.test('https://plex.tv/api/resources.xml?includeHttps=1&includeRelay=1'),
      true
    );
  });

  const request = await runScript({
    argument: 'phase=request&debug=false',
    request: {
      url: 'https://plex.tv/api/resources.xml?includeHttps=1&includeRelay=1',
      headers: {
        Accept: 'application/xml',
        'if-none-match': 'etag-value',
        'If-Modified-Since': 'yesterday',
        'cache-control': 'max-age=3600',
      },
    },
  });

  assert.equal(request.result.headers.Accept, 'application/xml');
  assert.equal(request.result.headers['if-none-match'], undefined);
  assert.equal(request.result.headers['If-Modified-Since'], undefined);
  assert.equal(request.result.headers['cache-control'], undefined);
  assert.equal(request.result.headers['Cache-Control'], 'no-cache');
  assert.equal(request.result.headers.Pragma, 'no-cache');

  const sharedStore = {};
  const coldRequest = await runScript({
    argument: [
      'phase=request',
      'bypass_official=true',
      'lan_url=http://192.0.2.10:32400',
      'remote_url=https://plex.example.com:8443',
      'bypass_timeout=3',
      'debug=true',
    ].join('&'),
    request: {
      url: 'https://plex.tv/api/resources.xml?includeHttps=1&includeRelay=1',
      headers: {
        Accept: 'application/xml',
        'X-Plex-Token': 'fixture-account-token',
        'If-None-Match': 'stale-etag',
      },
    },
    store: sharedStore,
  });

  assert.equal(coldRequest.result.response, undefined);
  assert.equal(coldRequest.calls.length, 0);
  assert.equal(coldRequest.result.headers['If-None-Match'], undefined);
  assert.equal(coldRequest.result.headers['Cache-Control'], 'no-cache');

  const coldResponse = await runScript({
    argument: [
      'phase=response',
      'bypass_official=true',
      'lan_url=http://192.0.2.10:32400',
      'remote_url=https://plex.example.com:8443',
      'bypass_timeout=3',
      'probe_timeout=2',
      'allow_relay=true',
      'debug=true',
    ].join('&'),
    response: {
      status: 200,
      headers: {
        'Content-Type': 'application/xml',
        'Content-Length': String(SHARED_SERVER_XML.length),
        ETag: 'upstream-etag',
      },
      body: SHARED_SERVER_XML,
    },
    replies: {
      'http://192.0.2.10:32400/identity': {
        status: 200,
        body: IDENTITY,
      },
      'https://plex.example.com:8443/identity': {
        error: 'TLS reset',
      },
      'http://192.0.2.10:32400/library/sections': {
        status: 200,
        body: LIBRARY_SECTIONS,
      },
      'https://plex.example.com:8443/library/sections': {
        error: 'TLS reset',
      },
    },
    store: sharedStore,
  });

  assert.equal(coldResponse.calls.length, 4);
  const identityCalls = coldResponse.calls.filter(function (call) {
    return /\/identity$/.test(call.options.url);
  });
  const authenticatedCalls = coldResponse.calls.filter(function (call) {
    return /\/library\/sections$/.test(call.options.url);
  });
  assert.equal(identityCalls.length, 2);
  identityCalls.forEach(function (call) {
    assert.equal(call.options.headers['X-Plex-Token'], undefined);
  });
  assert.equal(authenticatedCalls.length, 2);
  authenticatedCalls.forEach(function (call) {
    assert.equal(
      call.options.headers['X-Plex-Token'],
      'fixture-shared-server-token',
      'official shared-server token must authenticate direct probes'
    );
  });
  assert.equal(
    coldResponse.calls.some(function (call) {
      return /example\.plex\.direct|old-remote|other\.example/.test(call.options.url);
    }),
    false,
    'explicit mode must never probe automatically discovered official URLs'
  );
  assert.equal(
    coldResponse.result.headers['X-Surge-Plex-Fast-Connect'],
    'cache-seeded'
  );
  assert.deepEqual(
    serverConnectionAddresses(coldResponse.result.body),
    ['192.0.2.10']
  );
  assert.match(coldResponse.result.body, /accessToken="fixture-shared-server-token"/);
  assert.match(coldResponse.result.body, /owned="0"/);
  assert.match(coldResponse.result.body, /ownerId="42"/);
  assert.match(coldResponse.result.body, /sourceTitle="Shared by Alice"/);
  assert.equal(
    allConnectionAddresses(coldResponse.result.body).includes('client.example.com'),
    true,
    'non-server devices must be preserved while seeding the cache'
  );
  assert.ok(
    Object.values(sharedStore).some(function (value) {
      return String(value).includes('fixture-shared-server-token');
    }),
    'official Device must be persisted for the next launch'
  );

  const lanOnlyStore = {};
  const lanOnlyCold = await runScript({
    argument: [
      'phase=response',
      'bypass_official=true',
      'lan_url=http://192.0.2.10:32400',
      'remote_url=',
      'bypass_timeout=3',
      'debug=false',
    ].join('&'),
    response: {
      status: 200,
      headers: { 'Content-Type': 'application/xml' },
      body: SHARED_SERVER_XML,
    },
    replies: {
      'http://192.0.2.10:32400/identity': {
        status: 200,
        body: IDENTITY,
      },
      'http://192.0.2.10:32400/library/sections': {
        status: 200,
        body: LIBRARY_SECTIONS,
      },
    },
    store: lanOnlyStore,
  });

  assert.equal(lanOnlyCold.calls.length, 2);
  lanOnlyCold.calls.forEach(function (call) {
    assert.equal(
      call.options.url.startsWith('http://192.0.2.10:32400/'),
      true,
      'when only LAN_URL is passed, no remote or automatic URL may be used'
    );
  });

  const warmLAN = await runScript({
    argument: [
      'phase=request',
      'bypass_official=true',
      'lan_url=http://192.0.2.10:32400',
      'remote_url=https://plex.example.com:8443',
      'bypass_timeout=3',
      'debug=true',
    ].join('&'),
    request: {
      url: 'https://plex.tv/api/resources.xml?includeHttps=1&includeRelay=1',
      headers: {
        Accept: 'application/xml',
        'X-Plex-Token': 'fixture-account-token',
      },
    },
    replies: {
      'http://192.0.2.10:32400/library/sections': {
        status: 200,
        body: LIBRARY_SECTIONS,
      },
      'https://plex.example.com:8443/library/sections': {
        error: 'TLS reset',
      },
    },
    store: sharedStore,
  });

  assert.equal(warmLAN.result.response.status, 200);
  assert.equal(
    warmLAN.result.response.headers['X-Surge-Plex-Fast-Connect'],
    'cache-hit'
  );
  assert.deepEqual(
    serverConnectionAddresses(warmLAN.result.response.body),
    ['192.0.2.10']
  );
  assert.match(warmLAN.result.response.body, /name="Example Server"/);
  assert.match(warmLAN.result.response.body, /accessToken="fixture-shared-server-token"/);
  assert.match(warmLAN.result.response.body, /owned="0"/);
  assert.match(warmLAN.result.response.body, /ownerId="42"/);
  assert.equal(warmLAN.calls.length, 2);
  warmLAN.calls.forEach(function (call) {
    assert.equal(call.options.headers['X-Plex-Token'], 'fixture-shared-server-token');
    assert.match(call.options.url, /\/library\/sections$/);
  });
  assert.equal(
    warmLAN.logs.some(function (message) {
      return message.includes('fixture-account-token');
    }),
    false,
    'Plex token must not be logged'
  );

  const warmRemote = await runScript({
    argument: [
      'phase=request',
      'bypass_official=true',
      'lan_url=http://192.0.2.10:32400',
      'remote_url=https://plex.example.com:8443',
      'bypass_timeout=3',
      'debug=false',
    ].join('&'),
    request: {
      url: 'https://plex.tv/api/resources.xml?includeHttps=1&includeRelay=1',
      headers: { 'x-plex-token': 'fixture-account-token' },
    },
    replies: {
      'http://192.0.2.10:32400/library/sections': { error: 'timeout' },
      'https://plex.example.com:8443/library/sections': {
        status: 200,
        body: LIBRARY_SECTIONS,
      },
    },
    store: sharedStore,
  });

  assert.deepEqual(
    serverConnectionAddresses(warmRemote.result.response.body),
    ['plex.example.com']
  );
  assert.match(warmRemote.result.response.body, /protocol="https"/);
  assert.match(warmRemote.result.response.body, /port="8443"/);
  assert.match(warmRemote.result.response.body, /local="0"/);

  const automaticStore = {};
  const automaticCold = await runScript({
    argument: [
      'phase=response',
      'bypass_official=true',
      'lan_url=auto',
      'remote_url=auto',
      'bypass_timeout=3',
      'debug=true',
    ].join('&'),
    response: {
      status: 200,
      headers: { 'Content-Type': 'application/xml' },
      body: SHARED_SERVER_XML,
    },
    replies: {
      'https://192-0-2-10.example.plex.direct:32400/library/sections': {
        status: 200,
        body: LIBRARY_SECTIONS,
      },
      'https://old-remote.example.com:32400/library/sections': {
        error: 'timeout',
      },
      'https://other.example.com/library/sections': {
        status: 401,
      },
    },
    store: automaticStore,
  });

  assert.equal(automaticCold.calls.length, 3);
  assert.equal(
    automaticCold.calls.some(function (call) {
      return call.options.url.startsWith('http://192.0.2.10:32400');
    }),
    false,
    'automatic mode must use official Device connections rather than old defaults'
  );
  assert.equal(
    automaticCold.calls.find(function (call) {
      return call.options.url.startsWith('https://other.example.com');
    }).options.headers['X-Plex-Token'],
    'fixture-other-server-token',
    'each automatically discovered Device must use its own server token'
  );
  assert.equal(
    automaticCold.result.headers['X-Surge-Plex-Fast-Connect'],
    'cache-seeded'
  );
  assert.deepEqual(serverConnectionAddresses(automaticCold.result.body), [
    '192-0-2-10.example.plex.direct',
  ]);
  assert.ok(
    Object.values(automaticStore).some(function (value) {
      return String(value).includes(
        '0123456789abcdef0123456789abcdef01234567'
      );
    }),
    'automatic cache must be tied to the matched clientIdentifier'
  );

  const automaticWarm = await runScript({
    argument: [
      'phase=request',
      'bypass_official=true',
      'lan_url=auto',
      'remote_url=auto',
      'bypass_timeout=3',
      'debug=false',
    ].join('&'),
    request: {
      url: 'https://plex.tv/api/resources.xml?includeHttps=1&includeRelay=1',
      headers: { 'X-Plex-Token': 'fixture-account-token' },
    },
    replies: {
      'https://192-0-2-10.example.plex.direct:32400/library/sections': {
        status: 200,
        body: LIBRARY_SECTIONS,
      },
      'https://old-remote.example.com:32400/library/sections': {
        error: 'timeout',
      },
    },
    store: automaticStore,
  });

  assert.equal(automaticWarm.calls.length, 2);
  assert.equal(
    automaticWarm.calls.some(function (call) {
      return call.options.url.startsWith('https://other.example.com');
    }),
    false,
    'warm automatic mode must only use the cached matched Device'
  );
  assert.equal(
    automaticWarm.result.response.headers['X-Surge-Plex-Fast-Connect'],
    'cache-hit'
  );
  assert.deepEqual(
    serverConnectionAddresses(automaticWarm.result.response.body),
    ['192-0-2-10.example.plex.direct']
  );

  const networkFailureStore = Object.assign({}, sharedStore);
  const bypassFailed = await runScript({
    argument: [
      'phase=request',
      'bypass_official=true',
      'lan_url=http://192.0.2.10:32400',
      'remote_url=https://plex.example.com:8443',
      'bypass_timeout=3',
      'debug=false',
    ].join('&'),
    request: {
      url: 'https://plex.tv/api/resources.xml?includeHttps=1&includeRelay=1',
      headers: {
        'X-Plex-Token': 'fixture-account-token',
        'If-None-Match': 'stale-etag',
      },
    },
    replies: {
      'http://192.0.2.10:32400/library/sections': { error: 'timeout' },
      'https://plex.example.com:8443/library/sections': { status: 502 },
    },
    store: networkFailureStore,
  });

  assert.equal(bypassFailed.result.response, undefined);
  assert.equal(bypassFailed.result.headers['If-None-Match'], undefined);
  assert.equal(bypassFailed.result.headers['Cache-Control'], 'no-cache');
  assert.deepEqual(
    networkFailureStore,
    sharedStore,
    'network failures must retain the valid Device cache'
  );

  const unauthorizedStore = Object.assign({}, sharedStore);
  const unauthorized = await runScript({
    argument: [
      'phase=request',
      'bypass_official=true',
      'lan_url=http://192.0.2.10:32400',
      'remote_url=https://plex.example.com:8443',
      'bypass_timeout=3',
      'debug=false',
    ].join('&'),
    request: {
      url: 'https://plex.tv/api/resources.xml?includeHttps=1&includeRelay=1',
      headers: { 'X-Plex-Token': 'fixture-account-token' },
    },
    replies: {
      'http://192.0.2.10:32400/library/sections': { status: 401 },
      'https://plex.example.com:8443/library/sections': { status: 403 },
    },
    store: unauthorizedStore,
  });

  assert.equal(unauthorized.result.response, undefined);
  assert.equal(
    Object.values(unauthorizedStore).some(function (value) {
      return String(value).includes('fixture-shared-server-token');
    }),
    false,
    '401/403 must clear the stale server Device cache'
  );

  const direct = await runScript({
    argument: [
      'phase=response',
      'bypass_official=false',
      'probe_timeout=1',
      'allow_relay=true',
      'debug=true',
    ].join('&'),
    response: {
      status: 200,
      headers: {
        'Content-Type': 'application/xml',
        'Content-Length': String(XML.length),
        ETag: 'upstream-etag',
      },
      body: XML,
    },
    replies: {
      'http://198.51.100.10:32400/identity': { error: 'timeout' },
      'https://remote.example.com/identity': { status: 200, body: IDENTITY },
    },
  });

  assert.equal(direct.calls.length, 2);
  assert.equal(direct.calls[0].options.headers['X-Plex-Token'], 'fixture-server-token');
  assert.deepEqual(serverConnectionAddresses(direct.result.body), [
    'remote.example.com',
  ]);
  assert.equal(
    allConnectionAddresses(direct.result.body).includes('client.example.com'),
    true,
    'non-server devices must be preserved'
  );
  assert.equal(direct.result.headers['Content-Length'], undefined);
  assert.equal(direct.result.headers.ETag, undefined);
  assert.equal(
    direct.result.headers['X-Surge-Plex-Fast-Connect'],
    'selected-1'
  );

  const relay = await runScript({
    argument: [
      'phase=response',
      'bypass_official=false',
      'probe_timeout=1',
      'allow_relay=true',
      'debug=false',
    ].join('&'),
    response: {
      status: 200,
      headers: { 'Content-Type': 'application/xml' },
      body: XML,
    },
    replies: {
      'http://198.51.100.10:32400/identity': { error: 'timeout' },
      'https://remote.example.com/identity': { status: 502 },
      'https://relay01.plex.bz:443/identity': { status: 200, body: IDENTITY },
    },
  });

  assert.equal(relay.calls.length, 3);
  assert.deepEqual(serverConnectionAddresses(relay.result.body), [
    'relay01.plex.bz',
  ]);

  const failed = await runScript({
    argument: [
      'phase=response',
      'bypass_official=false',
      'probe_timeout=1',
      'allow_relay=false',
      'debug=false',
    ].join('&'),
    response: {
      status: 200,
      headers: { 'Content-Type': 'application/xml' },
      body: XML,
    },
    replies: {
      'http://198.51.100.10:32400/identity': { error: 'timeout' },
      'https://remote.example.com/identity': { status: 503 },
    },
  });

  assert.equal(Object.keys(failed.result).length, 0);

  const notModified = await runScript({
    argument: [
      'phase=response',
      'bypass_official=false',
      'probe_timeout=1',
      'allow_relay=true',
      'debug=false',
    ].join('&'),
    response: {
      status: 304,
      headers: { ETag: 'upstream-etag' },
      body: '',
    },
  });

  assert.equal(Object.keys(notModified.result).length, 0);
  assert.equal(notModified.calls.length, 0);

  console.log('Plex Fast Connect public module checks passed');
})().catch(function (error) {
  console.error(error);
  process.exit(1);
});

function runScript(options) {
  return new Promise(function (resolve, reject) {
    const calls = [];
    const logs = [];
    const store = options.store || {};
    let done = false;

    const context = {
      $argument: options.argument,
      $request: options.request || {
        url: 'https://plex.tv/api/resources.xml?includeHttps=1&includeRelay=1',
        headers: {},
      },
      $response: options.response,
      $persistentStore: {
        read(key) {
          return Object.prototype.hasOwnProperty.call(store, key)
            ? store[key]
            : null;
        },
        write(value, key) {
          store[key] = value;
          return true;
        },
      },
      $httpClient: {
        get(requestOptions, callback) {
          calls.push({ options: requestOptions });
          const reply = (options.replies || {})[requestOptions.url];
          setImmediate(function () {
            if (!reply) {
              callback('missing mock reply');
              return;
            }
            callback(
              reply.error || null,
              reply.status === undefined ? null : { status: reply.status },
              reply.body || ''
            );
          });
        },
      },
      $done(result) {
        if (done) {
          reject(new Error('$done called more than once'));
          return;
        }
        done = true;
        resolve({ result: result || {}, calls, logs, store });
      },
      console: {
        log(message) {
          logs.push(String(message));
        },
      },
      setTimeout,
      decodeURIComponent,
      isFinite,
      Math,
      Number,
      Object,
      RegExp,
      String,
    };

    vm.runInNewContext(SOURCE, context);
  });
}

function serverConnectionAddresses(xml) {
  const server = xml.match(
    /<Device\b[^>]*provides="server"[^>]*>[\s\S]*?<\/Device>/
  );
  assert.ok(server, 'server device missing');
  return allConnectionAddresses(server[0]);
}

function allConnectionAddresses(xml) {
  return Array.from(xml.matchAll(/<Connection\b[^>]*address="([^"]+)"/g))
    .map(function (match) {
      return match[1];
    });
}
