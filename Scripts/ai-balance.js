/**
 * Surge generic panel script - DeepSeek and Qwen / Alibaba Cloud balance.
 *
 * DeepSeek balance API:
 * https://api-docs.deepseek.com/api/get-user-balance/
 *
 * Qwen is billed through Alibaba Cloud. The combined panel reads the Alibaba
 * Cloud account balance with BSS OpenAPI QueryAccountBalance:
 * https://help.aliyun.com/en/user-center/developer-reference/api-bssopenapi-2017-12-14-queryaccountbalance
 */

(function () {
  "use strict";

  var DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
  var ALIBABA_BSS_ENDPOINT = "https://business.aliyuncs.com";

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      buildAliyunSignedUrl: buildAliyunSignedUrl,
      extractDeepSeekTotal: extractDeepSeekTotal,
      extractQwenAvailable: extractQwenAvailable,
      parseArguments: parseArguments,
    };
  }

  if (typeof $done === "function") main();

  function main() {
    var args = parseArguments(typeof $argument === "string" ? $argument : "");
    var config = {
      title: "AI Balance",
      deepSeekApiKey: args.deepseek_api_key || "",
      qwenAccessKeyId: args.qwen_access_key_id || "",
      qwenAccessKeySecret: args.qwen_access_key_secret || "",
    };

    runCombined(config);
  }

  function runCombined(config) {
    var pending = 2;
    var values = {};

    queryDeepSeek(config.deepSeekApiKey, function (error, total) {
      complete("deepseek", error, total);
    });
    queryQwen(config.qwenAccessKeyId, config.qwenAccessKeySecret, function (error, available) {
      complete("qwen", error, available);
    });

    function complete(provider, error, value) {
      values[provider] = error ? "查询失败" : value;
      pending -= 1;
      if (pending > 0) return;

      finishPanel({
        title: config.title,
        content: [line("DeepSeek 总余额", values.deepseek), line("Qwen 可用余额", values.qwen)].join("\n"),
      });
    }
  }

  function queryDeepSeek(apiKey, callback) {
    if (isMissingCredential(apiKey)) return callback(new Error("未配置 DeepSeek API Key"));
    fetchJson(
      {
        url: DEEPSEEK_BALANCE_URL,
        headers: {
          Accept: "application/json",
          Authorization: "Bearer " + apiKey,
        },
        timeout: 10,
      },
      function (error, status, json) {
        if (error) return callback(error);
        if (status >= 400) return callback(new Error(apiErrorMessage(json) || "HTTP " + status));

        try {
          callback(null, extractDeepSeekTotal(json));
        } catch (formatError) {
          callback(formatError);
        }
      }
    );
  }

  function queryQwen(accessKeyId, accessKeySecret, callback) {
    if (isMissingCredential(accessKeyId) || isMissingCredential(accessKeySecret)) {
      return callback(new Error("未配置阿里云 AccessKey ID 或 AccessKey Secret"));
    }

    var url = buildAliyunSignedUrl(accessKeyId, accessKeySecret);
    fetchJson(
      {
        url: url,
        headers: { Accept: "application/json" },
        timeout: 10,
      },
      function (error, status, json) {
        if (error) return callback(error);
        if (status >= 400 || !isAliyunSuccess(json)) {
          return callback(new Error(apiErrorMessage(json) || "HTTP " + status));
        }

        try {
          callback(null, extractQwenAvailable(json));
        } catch (formatError) {
          callback(formatError);
        }
      }
    );
  }

  function extractDeepSeekTotal(json) {
    if (!json || !Array.isArray(json.balance_infos) || !json.balance_infos.length) {
      throw new Error("返回数据缺少 balance_infos");
    }

    return json.balance_infos
      .map(function (balance) {
        var currency = String((balance && balance.currency) || "").toUpperCase();
        if (!currency || !hasValue(balance && balance.total_balance)) throw new Error("返回数据缺少总余额");
        return formatMoney(balance.total_balance, currency);
      })
      .join(" / ");
  }

  function extractQwenAvailable(json) {
    var data = json && json.Data;
    if (!data || typeof data !== "object") {
      throw new Error("返回数据缺少 Data");
    }

    var currency = String(data.Currency || "CNY").toUpperCase();
    var availableAmount = numberOrNull(data.AvailableAmount);
    if (availableAmount === null) {
      throw new Error("返回数据缺少有效的 AvailableAmount");
    }
    return formatMoney(data.AvailableAmount, currency);
  }

  function buildAliyunSignedUrl(accessKeyId, accessKeySecret, options) {
    var request = options || {};
    var params = {
      AccessKeyId: accessKeyId,
      Action: request.action || "QueryAccountBalance",
      Format: request.format || "JSON",
      SignatureMethod: "HMAC-SHA1",
      SignatureNonce: request.nonce || uuid(),
      SignatureVersion: "1.0",
      Timestamp: request.timestamp || isoTimestamp(new Date()),
      Version: request.version || "2017-12-14",
    };

    var canonicalQuery = Object.keys(params)
      .sort()
      .map(function (key) {
        return percentEncode(key) + "=" + percentEncode(params[key]);
      })
      .join("&");
    var stringToSign = "GET&%2F&" + percentEncode(canonicalQuery);
    var signature = base64Encode(hmacSha1(utf8Bytes(accessKeySecret + "&"), utf8Bytes(stringToSign)));
    var endpoint = String(request.endpoint || ALIBABA_BSS_ENDPOINT).replace(/\/+$/, "");

    return endpoint + "/?Signature=" + percentEncode(signature) + "&" + canonicalQuery;
  }

  function fetchJson(options, callback) {
    $httpClient.get(options, function (error, response, data) {
      if (error) return callback(new Error(networkError(error)), 0, null);

      var status = Number((response && (response.status || response.statusCode)) || 200);
      var json;
      try {
        json = JSON.parse(data || "{}");
      } catch (_) {
        return callback(new Error("JSON 解析失败"), status, null);
      }
      callback(null, status, json);
    });
  }

  function finishPanel(panel) {
    $done({
      title: panel.title,
      content: panel.content || "",
    });
  }

  function isAliyunSuccess(json) {
    if (!json || typeof json !== "object") return false;
    return json.Success === true || String(json.Success).toLowerCase() === "true" || String(json.Code) === "200";
  }

  function apiErrorMessage(json) {
    if (!json || typeof json !== "object") return "";
    var error = json.error;
    if (error && typeof error === "object") return safeMessage(error.message || error.code);
    if (error) return safeMessage(error);
    return safeMessage(json.Message || json.message || json.Code || json.code || "");
  }

  function formatMoney(value, currency) {
    if (!hasValue(value)) return "n/a";
    var amount = numberOrNull(value);
    var text = amount === null ? String(value).trim() : amount.toFixed(2);
    var symbols = { CNY: "¥", USD: "$", JPY: "¥" };
    return (symbols[currency] || "") + text;
  }

  function numberOrNull(value) {
    if (!hasValue(value)) return null;
    var number = Number(String(value).trim());
    return isFinite(number) ? number : null;
  }

  function line(label, value) {
    return label + ": " + (hasValue(value) ? String(value) : "n/a");
  }

  function hasValue(value) {
    return value !== undefined && value !== null && String(value).trim() !== "";
  }

  function isMissingCredential(value) {
    var text = String(value || "").trim();
    return !text || /^YOUR_/i.test(text) || /^<.*>$/.test(text) || /^\{\{\{.*\}\}\}$/.test(text);
  }

  function parseArguments(input) {
    var output = {};
    String(input || "")
      .split("&")
      .forEach(function (part) {
        if (!part) return;
        var position = part.indexOf("=");
        var key = position >= 0 ? part.slice(0, position) : part;
        var value = position >= 0 ? part.slice(position + 1) : "";
        output[decode(key)] = decode(value);
      });
    return output;
  }

  function decode(value) {
    try {
      return decodeURIComponent(String(value || "").replace(/\+/g, " "));
    } catch (_) {
      return String(value || "");
    }
  }

  function safeMessage(value) {
    var message = String(value || "未知错误");
    return message.length > 180 ? message.slice(0, 177) + "..." : message;
  }

  function networkError(error) {
    if (!error) return "网络错误";
    return safeMessage(error.error || error.message || "网络错误");
  }

  function isoTimestamp(date) {
    return date.toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  function uuid() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (character) {
      var random = Math.floor(Math.random() * 16);
      var value = character === "x" ? random : (random & 3) | 8;
      return value.toString(16);
    });
  }

  function percentEncode(value) {
    return encodeURIComponent(String(value)).replace(/[!'()*]/g, function (character) {
      return "%" + character.charCodeAt(0).toString(16).toUpperCase();
    });
  }

  function hmacSha1(key, message) {
    var blockSize = 64;
    var normalizedKey = key.length > blockSize ? sha1(key) : key.slice();
    while (normalizedKey.length < blockSize) normalizedKey.push(0);

    var innerKey = [];
    var outerKey = [];
    for (var index = 0; index < blockSize; index += 1) {
      innerKey[index] = normalizedKey[index] ^ 0x36;
      outerKey[index] = normalizedKey[index] ^ 0x5c;
    }
    return sha1(outerKey.concat(sha1(innerKey.concat(message))));
  }

  function sha1(input) {
    var bytes = input.slice();
    var bitLength = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);

    var high = Math.floor(bitLength / 0x100000000);
    var low = bitLength >>> 0;
    bytes.push((high >>> 24) & 0xff, (high >>> 16) & 0xff, (high >>> 8) & 0xff, high & 0xff);
    bytes.push((low >>> 24) & 0xff, (low >>> 16) & 0xff, (low >>> 8) & 0xff, low & 0xff);

    var h0 = 0x67452301;
    var h1 = 0xefcdab89;
    var h2 = 0x98badcfe;
    var h3 = 0x10325476;
    var h4 = 0xc3d2e1f0;

    for (var offset = 0; offset < bytes.length; offset += 64) {
      var words = [];
      var index;
      for (index = 0; index < 16; index += 1) {
        var position = offset + index * 4;
        words[index] =
          ((bytes[position] << 24) |
            (bytes[position + 1] << 16) |
            (bytes[position + 2] << 8) |
            bytes[position + 3]) >>>
          0;
      }
      for (index = 16; index < 80; index += 1) {
        words[index] = rotateLeft(words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16], 1);
      }

      var a = h0;
      var b = h1;
      var c = h2;
      var d = h3;
      var e = h4;

      for (index = 0; index < 80; index += 1) {
        var f;
        var k;
        if (index < 20) {
          f = (b & c) | (~b & d);
          k = 0x5a827999;
        } else if (index < 40) {
          f = b ^ c ^ d;
          k = 0x6ed9eba1;
        } else if (index < 60) {
          f = (b & c) | (b & d) | (c & d);
          k = 0x8f1bbcdc;
        } else {
          f = b ^ c ^ d;
          k = 0xca62c1d6;
        }

        var temporary = (rotateLeft(a, 5) + f + e + k + words[index]) >>> 0;
        e = d;
        d = c;
        c = rotateLeft(b, 30);
        b = a;
        a = temporary;
      }

      h0 = (h0 + a) >>> 0;
      h1 = (h1 + b) >>> 0;
      h2 = (h2 + c) >>> 0;
      h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0;
    }

    return wordsToBytes([h0, h1, h2, h3, h4]);
  }

  function rotateLeft(value, bits) {
    return ((value << bits) | (value >>> (32 - bits))) >>> 0;
  }

  function wordsToBytes(words) {
    var bytes = [];
    words.forEach(function (word) {
      bytes.push((word >>> 24) & 0xff, (word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff);
    });
    return bytes;
  }

  function utf8Bytes(value) {
    var bytes = [];
    var text = String(value);
    for (var index = 0; index < text.length; index += 1) {
      var code = text.charCodeAt(index);
      if (code < 0x80) {
        bytes.push(code);
      } else if (code < 0x800) {
        bytes.push(0xc0 | (code >>> 6), 0x80 | (code & 0x3f));
      } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
        var next = text.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          var point = 0x10000 + ((code & 0x3ff) << 10) + (next & 0x3ff);
          bytes.push(
            0xf0 | (point >>> 18),
            0x80 | ((point >>> 12) & 0x3f),
            0x80 | ((point >>> 6) & 0x3f),
            0x80 | (point & 0x3f)
          );
          index += 1;
        } else {
          bytes.push(0xe0 | (code >>> 12), 0x80 | ((code >>> 6) & 0x3f), 0x80 | (code & 0x3f));
        }
      } else {
        bytes.push(0xe0 | (code >>> 12), 0x80 | ((code >>> 6) & 0x3f), 0x80 | (code & 0x3f));
      }
    }
    return bytes;
  }

  function base64Encode(bytes) {
    var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    var output = "";
    for (var index = 0; index < bytes.length; index += 3) {
      var first = bytes[index];
      var second = index + 1 < bytes.length ? bytes[index + 1] : 0;
      var third = index + 2 < bytes.length ? bytes[index + 2] : 0;
      var chunk = (first << 16) | (second << 8) | third;
      output += alphabet[(chunk >>> 18) & 63];
      output += alphabet[(chunk >>> 12) & 63];
      output += index + 1 < bytes.length ? alphabet[(chunk >>> 6) & 63] : "=";
      output += index + 2 < bytes.length ? alphabet[chunk & 63] : "=";
    }
    return output;
  }
})();
