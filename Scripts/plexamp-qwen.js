/**
 * Plexamp Qwen for Surge.
 *
 * Plexamp has a fixed OpenAI endpoint and expects OpenAI model identifiers.
 * This script returns a compatible model catalogue, proxies Chat Completions
 * through Model Studio's compatible API, and converts Qwen-Image responses to
 * the OpenAI Images shape Plexamp expects.
 *
 * The Model Studio API key remains in Plexamp's OpenAI key field. It is never
 * stored in this script or in the module.
 */

(function () {
  "use strict";

  var PREFIX = "[PlexampQwen]";
  var DEFAULT_API_HOST = "dashscope.aliyuncs.com";
  var DEFAULT_TEXT_MODEL = "qwen3.8-max";
  var DEFAULT_IMAGE_MODEL = "qwen-image-3.0";
  var config = configFromArguments(
    typeof $argument === "string" ? $argument : ""
  );

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      configFromArguments: configFromArguments,
      extractImages: extractImages,
      imageSize: imageSize,
      normalizeChatStream: normalizeChatStream,
      parseArguments: parseArguments,
      routeForURL: routeForURL,
    };
  }

  if (typeof $done === "function" && typeof $request !== "undefined") {
    try {
      main();
    } catch (error) {
      finishError(500, safeMessage(error), "script_error");
    }
  }

  function main() {
    var requestURL = String(($request && $request.url) || "");
    var route = routeForURL(requestURL);

    if (route === "models") return returnModels(requestURL);
    if (route === "chat") return proxyChatRequest();
    if (route === "images") return proxyImageRequest();

    debugLog("No matching route");
    $done({});
  }

  function returnModels(url) {
    var models = [
      modelRecord("gpt-4o"),
      modelRecord("gpt-4-turbo"),
      modelRecord("gpt-3.5-turbo"),
      modelRecord("gpt-3.5-turbo-0125"),
      modelRecord("gpt-image-1"),
      modelRecord("dall-e-3"),
    ];
    var detail = urlPath(url).match(/^\/v1\/models\/(.+)$/);

    if (detail) {
      var requestedID = safeDecodeURIComponent(detail[1]);
      var selected = null;
      for (var i = 0; i < models.length; i++) {
        if (models[i].id === requestedID) {
          selected = models[i];
          break;
        }
      }
      if (!selected) {
        return finishError(
          404,
          "The requested compatibility model was not found.",
          "model_not_found"
        );
      }
      return finishJSON(200, selected);
    }

    debugLog("Returned synthetic OpenAI model catalogue");
    finishJSON(200, { object: "list", data: models });
  }

  function proxyChatRequest() {
    var authorization = getHeader($request.headers, "Authorization");
    if (!validAuthorization(authorization)) {
      return finishError(
        401,
        "Enter a valid Model Studio API key in Plexamp's OpenAI API key field.",
        "missing_api_key"
      );
    }

    var body = parseRequestBody();
    if (!body) return;

    body.model = config.textModel;
    body.enable_thinking = false;
    delete body.reasoning_effort;
    delete body.thinking_budget;
    delete body.thinking;

    if (body.max_tokens == null && body.max_completion_tokens != null) {
      body.max_tokens = body.max_completion_tokens;
    }
    delete body.max_completion_tokens;

    var url = "https://" + config.apiHost
      + "/compatible-mode/v1/chat/completions";
    var headers = outboundHeaders(
      $request.headers,
      authorization,
      config.apiHost
    );

    debugLog("Proxying chat request to model " + config.textModel);
    $httpClient.post({
      url: url,
      headers: headers,
      body: JSON.stringify(body),
      timeout: 300,
      "auto-cookie": false,
    }, function (error, response, data) {
      if (error) {
        return finishError(
          502,
          "Qwen chat request failed: " + safeMessage(error),
          "upstream_error"
        );
      }

      var status = responseStatus(response);
      var responseHeaders = response && response.headers;
      var responseBody = normalizeChatStream(status, responseHeaders, data);
      finishRaw(status || 502, responseHeaders, responseBody);
    });
  }

  function proxyImageRequest() {
    var authorization = getHeader($request.headers, "Authorization");
    if (!validAuthorization(authorization)) {
      return finishError(
        401,
        "Enter a valid Model Studio API key in Plexamp's OpenAI API key field.",
        "missing_api_key"
      );
    }

    var openAIRequest = parseRequestBody();
    if (!openAIRequest) return;

    var prompt = typeof openAIRequest.prompt === "string"
      ? openAIRequest.prompt.trim()
      : "";
    if (!prompt) {
      return finishError(400, "The image prompt is empty.", "invalid_prompt");
    }

    var requestedCount = Math.floor(
      clampNumber(openAIRequest.n, 1, 1, 6)
    );
    var qwenRequest = {
      model: config.imageModel,
      input: {
        messages: [
          {
            role: "user",
            content: [{ text: prompt }],
          },
        ],
      },
      parameters: {
        n: requestedCount,
        size: imageSize(openAIRequest.size, config.imageSize),
        prompt_extend: config.promptExtend,
        watermark: config.watermark,
      },
    };
    var url = "https://" + config.apiHost
      + "/api/v1/services/aigc/multimodal-generation/generation";

    debugLog(
      "Generating image with model " + config.imageModel
      + ", size=" + qwenRequest.parameters.size
      + ", n=" + requestedCount
    );

    $httpClient.post({
      url: url,
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(qwenRequest),
      timeout: config.imageTimeout,
      "auto-cookie": false,
    }, function (error, response, data) {
      if (error) {
        return finishError(
          502,
          "Qwen-Image request failed: " + safeMessage(error),
          "upstream_error"
        );
      }

      var status = responseStatus(response);
      var payload = parseJSON(data);
      if (status < 200 || status >= 300) {
        return finishError(
          status || 502,
          qwenErrorMessage(payload, data, "Qwen-Image returned an error."),
          qwenErrorCode(payload, "upstream_error")
        );
      }
      if (!payload) {
        return finishError(
          502,
          "Qwen-Image returned invalid JSON.",
          "invalid_upstream_response"
        );
      }

      var images = extractImages(payload);
      if (images.length === 0) {
        return finishError(
          502,
          qwenErrorMessage(payload, data, "Qwen-Image returned no image."),
          qwenErrorCode(payload, "empty_image_response")
        );
      }

      var responseFormat = String(
        openAIRequest.response_format || ""
      ).toLowerCase();
      var originalModel = String(openAIRequest.model || "");
      var wantsBase64 = responseFormat === "b64_json"
        || (!responseFormat && /^gpt-image/i.test(originalModel));

      if (wantsBase64) return returnImagesAsBase64(images, prompt);

      var results = [];
      for (var i = 0; i < images.length; i++) {
        if (isDataURL(images[i])) {
          results.push({
            b64_json: dataURLBase64(images[i]),
            revised_prompt: prompt,
          });
        } else {
          results.push({ url: images[i], revised_prompt: prompt });
        }
      }
      finishImageResponse(results);
    });
  }

  function returnImagesAsBase64(images, prompt) {
    var results = new Array(images.length);
    var pending = images.length;
    var finished = false;

    for (var i = 0; i < images.length; i++) downloadOne(i, images[i]);

    function downloadOne(index, image) {
      if (isDataURL(image)) {
        results[index] = {
          b64_json: dataURLBase64(image),
          revised_prompt: prompt,
        };
        completeOne();
        return;
      }

      $httpClient.get({
        url: image,
        headers: { Accept: "image/*" },
        timeout: Math.min(config.imageTimeout, 60),
        "auto-cookie": false,
        "binary-mode": true,
      }, function (error, response, data) {
        if (finished) return;
        if (error) {
          finished = true;
          return finishError(
            502,
            "Generated image download failed: " + safeMessage(error),
            "image_download_failed"
          );
        }

        var status = responseStatus(response);
        var bytes = byteView(data);
        if (status < 200 || status >= 300 || !bytes) {
          finished = true;
          return finishError(
            502,
            "Generated image download failed: HTTP " + status,
            "image_download_failed"
          );
        }

        results[index] = {
          b64_json: base64Encode(bytes),
          revised_prompt: prompt,
        };
        completeOne();
      });
    }

    function completeOne() {
      pending -= 1;
      if (pending === 0 && !finished) {
        finished = true;
        finishImageResponse(results);
      }
    }
  }

  function finishImageResponse(results) {
    debugLog("Returned " + results.length + " converted image result(s)");
    finishJSON(200, {
      created: Math.floor(Date.now() / 1000),
      data: results,
    });
  }

  function parseRequestBody() {
    var body = parseJSON($request.body);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      finishError(
        400,
        "The intercepted request body is not valid JSON.",
        "invalid_request_body"
      );
      return null;
    }
    return body;
  }

  function extractImages(payload) {
    var images = [];
    var output = payload && payload.output;
    var choices = output && Array.isArray(output.choices)
      ? output.choices
      : [];

    for (var i = 0; i < choices.length; i++) {
      var message = choices[i] && choices[i].message;
      var content = message && Array.isArray(message.content)
        ? message.content
        : [];
      for (var j = 0; j < content.length; j++) {
        addImage(images, content[j] && (content[j].image || content[j].url));
      }
    }

    var outputResults = output && Array.isArray(output.results)
      ? output.results
      : [];
    for (var k = 0; k < outputResults.length; k++) {
      addImage(
        images,
        outputResults[k] && (outputResults[k].url || outputResults[k].image)
      );
    }

    var data = payload && Array.isArray(payload.data) ? payload.data : [];
    for (var n = 0; n < data.length; n++) {
      addImage(images, data[n] && (data[n].url || data[n].image));
    }

    return images;
  }

  function addImage(images, value) {
    if (typeof value === "string" && value.trim()) {
      images.push(value.trim());
    }
  }

  function imageSize(requested, configured) {
    var candidate = String(configured || "").trim();
    if (!candidate || /^auto$/i.test(candidate)) {
      candidate = String(requested || "");
    }

    var match = candidate.match(/^(\d{3,4})\s*[xX*]\s*(\d{3,4})$/);
    if (!match) return "1024*1024";

    var width = Number(match[1]);
    var height = Number(match[2]);
    var pixels = width * height;
    if (
      width < 512 || height < 512 || width > 2048 || height > 2048
      || pixels < 512 * 512 || pixels > 2048 * 2048
    ) {
      return "1024*1024";
    }
    return width + "*" + height;
  }

  function outboundHeaders(source, authorization, host) {
    var headers = {};
    var input = source || {};

    for (var key in input) {
      if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
      if (
        /^(?:host|content-length|transfer-encoding|connection|proxy-connection|keep-alive|te|trailer|upgrade|openai-organization|openai-project)$/i.test(key)
      ) {
        continue;
      }
      headers[key] = input[key];
    }

    deleteHeader(headers, "Authorization");
    deleteHeader(headers, "Content-Type");
    headers.Authorization = authorization;
    headers["Content-Type"] = "application/json";
    headers.Host = host;
    return headers;
  }

  function modelRecord(id) {
    return {
      id: id,
      object: "model",
      created: 1715367049,
      owned_by: "openai",
    };
  }

  function routeForURL(url) {
    if (!/^https:\/\/api\.openai\.com(?:\/|$)/i.test(url)) return "";
    var path = urlPath(url);
    if (/^\/v1\/models(?:\/|$)/.test(path)) return "models";
    if (path === "/v1/chat/completions") return "chat";
    if (path === "/v1/images/generations") return "images";
    return "";
  }

  function urlPath(url) {
    return String(url || "")
      .replace(/^https?:\/\/[^/]+/i, "")
      .split("?")[0];
  }

  function finishJSON(status, payload) {
    finishRaw(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    }, JSON.stringify(payload));
  }

  function normalizeChatStream(status, headers, body) {
    if (
      status < 200 || status >= 300
      || typeof body !== "string"
      || !/text\/event-stream/i.test(String(getHeader(headers, "Content-Type")))
    ) {
      return body;
    }

    var usesCRLF = body.indexOf("\r\n") >= 0;
    var normalized = usesCRLF ? body.replace(/\r\n/g, "\n") : body;
    var events = normalized.split("\n\n");
    var kept = [];
    var removed = 0;

    for (var i = 0; i < events.length; i++) {
      if (isUsageOnlyChatEvent(events[i])) {
        removed += 1;
      } else {
        kept.push(events[i]);
      }
    }

    if (removed === 0) return body;

    debugLog("Removed " + removed + " incompatible chat usage event(s)");
    var result = kept.join("\n\n");
    return usesCRLF ? result.replace(/\n/g, "\r\n") : result;
  }

  function isUsageOnlyChatEvent(event) {
    var lines = String(event || "").split("\n");
    var data = [];

    for (var i = 0; i < lines.length; i++) {
      if (lines[i].indexOf("data:") !== 0) continue;
      var value = lines[i].slice(5);
      if (value.charAt(0) === " ") value = value.slice(1);
      data.push(value);
    }

    if (data.length === 0) return false;

    var payload = parseJSON(data.join("\n").trim());
    return payload
      && Array.isArray(payload.choices)
      && payload.choices.length === 0
      && payload.usage
      && typeof payload.usage === "object";
  }

  function finishRaw(status, sourceHeaders, body) {
    var headers = {};
    var contentType = getHeader(sourceHeaders, "Content-Type");
    var cacheControl = getHeader(sourceHeaders, "Cache-Control");
    if (contentType) headers["Content-Type"] = contentType;
    if (cacheControl) headers["Cache-Control"] = cacheControl;
    if (!headers["Content-Type"]) {
      headers["Content-Type"] = "application/json; charset=utf-8";
    }

    $done({
      response: {
        status: Number(status) || 500,
        headers: headers,
        body: typeof body === "string" ? body : "",
      },
    });
  }

  function finishError(status, message, code) {
    var safe = safeMessage(message);
    log("HTTP " + status + ": " + safe);
    finishJSON(status, {
      error: {
        message: safe,
        type: "qwen_proxy_error",
        param: null,
        code: code || "proxy_error",
      },
    });
  }

  function qwenErrorMessage(payload, raw, fallback) {
    if (payload) {
      if (typeof payload.message === "string" && payload.message) {
        return payload.message;
      }
      if (payload.error && typeof payload.error.message === "string") {
        return payload.error.message;
      }
      if (payload.output && typeof payload.output.message === "string") {
        return payload.output.message;
      }
    }
    if (typeof raw === "string" && raw.trim() && raw.trim().charAt(0) !== "{") {
      return raw.trim();
    }
    return fallback;
  }

  function qwenErrorCode(payload, fallback) {
    if (payload) {
      if (payload.code) return String(payload.code);
      if (payload.error && payload.error.code) {
        return String(payload.error.code);
      }
      if (payload.output && payload.output.code) {
        return String(payload.output.code);
      }
    }
    return fallback;
  }

  function responseStatus(response) {
    return Number(response && (response.status || response.statusCode)) || 0;
  }

  function validAuthorization(value) {
    return typeof value === "string"
      && /^Bearer\s+\S+/i.test(value)
      && !/^Bearer\s+(?:undefined|null)$/i.test(value.trim());
  }

  function getHeader(headers, name) {
    var source = headers || {};
    for (var key in source) {
      if (
        Object.prototype.hasOwnProperty.call(source, key)
        && key.toLowerCase() === name.toLowerCase()
      ) {
        return source[key];
      }
    }
    return "";
  }

  function deleteHeader(headers, name) {
    for (var key in headers) {
      if (
        Object.prototype.hasOwnProperty.call(headers, key)
        && key.toLowerCase() === name.toLowerCase()
      ) {
        delete headers[key];
      }
    }
  }

  function configFromArguments(argument) {
    var args = parseArguments(argument);
    return {
      apiHost: normalizeHost(args.api_host) || DEFAULT_API_HOST,
      textModel: cleanValue(args.text_model, DEFAULT_TEXT_MODEL),
      imageModel: cleanValue(args.image_model, DEFAULT_IMAGE_MODEL),
      imageSize: cleanValue(args.image_size, "auto"),
      promptExtend: parseBoolean(args.prompt_extend, true),
      watermark: parseBoolean(args.watermark, false),
      imageTimeout: clampNumber(args.image_timeout, 180, 30, 210),
      debug: parseBoolean(args.debug, false),
    };
  }

  function normalizeHost(value) {
    var host = String(value || "").trim();
    var absolute = host.match(/^https?:\/\/([^/]+)/i);
    if (absolute) host = absolute[1];
    host = host.replace(/^\/\//, "").replace(/\/.*$/, "").replace(/\.+$/, "");
    if (!/^[A-Za-z0-9.-]+(?::\d+)?$/.test(host)) return "";
    return host;
  }

  function cleanValue(value, fallback) {
    var normalized = String(value || "").trim();
    return normalized || fallback;
  }

  function parseArguments(argument) {
    var parsed = {};
    String(argument || "").split("&").forEach(function (item) {
      if (!item) return;
      var separator = item.indexOf("=");
      var key = separator >= 0 ? item.slice(0, separator) : item;
      var value = separator >= 0 ? item.slice(separator + 1) : "";
      parsed[safeDecodeURIComponent(key)] = safeDecodeURIComponent(
        value.replace(/\+/g, " ")
      );
    });
    return parsed;
  }

  function safeDecodeURIComponent(value) {
    try {
      return decodeURIComponent(value);
    } catch (_) {
      return value;
    }
  }

  function parseBoolean(value, fallback) {
    if (/^(?:1|true|yes|on)$/i.test(String(value))) return true;
    if (/^(?:0|false|no|off)$/i.test(String(value))) return false;
    return fallback;
  }

  function clampNumber(value, fallback, min, max) {
    var number = Number(value);
    if (!isFinite(number)) number = fallback;
    return Math.max(min, Math.min(max, number));
  }

  function parseJSON(value) {
    if (value && typeof value === "object" && !isBinary(value)) return value;
    if (typeof value !== "string" || !value.trim()) return null;
    try {
      return JSON.parse(value);
    } catch (_) {
      return null;
    }
  }

  function isBinary(value) {
    return value
      && typeof value === "object"
      && typeof value.byteLength === "number";
  }

  function byteView(value) {
    if (!value || typeof value.byteLength !== "number") return null;
    if (typeof value.length === "number") return value;
    try {
      return new Uint8Array(value);
    } catch (_) {
      return null;
    }
  }

  function isDataURL(value) {
    return /^data:image\/[A-Za-z0-9.+-]+;base64,/i.test(String(value || ""));
  }

  function dataURLBase64(value) {
    var separator = String(value || "").indexOf(",");
    return separator >= 0 ? String(value).slice(separator + 1) : "";
  }

  function base64Encode(bytes) {
    var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    var chunks = [];
    var chunk = "";
    var chunkLimit = 16384;

    for (var i = 0; i < bytes.length; i += 3) {
      var a = bytes[i];
      var hasB = i + 1 < bytes.length;
      var hasC = i + 2 < bytes.length;
      var b = hasB ? bytes[i + 1] : 0;
      var c = hasC ? bytes[i + 2] : 0;

      chunk += alphabet.charAt(a >> 2);
      chunk += alphabet.charAt(((a & 3) << 4) | (b >> 4));
      chunk += hasB
        ? alphabet.charAt(((b & 15) << 2) | (c >> 6))
        : "=";
      chunk += hasC ? alphabet.charAt(c & 63) : "=";

      if (chunk.length >= chunkLimit) {
        chunks.push(chunk);
        chunk = "";
      }
    }
    if (chunk) chunks.push(chunk);
    return chunks.join("");
  }

  function safeMessage(value) {
    var message = value && value.message ? value.message : value;
    message = String(message == null ? "Unknown error" : message)
      .replace(/\s+/g, " ")
      .trim();
    return message.slice(0, 500) || "Unknown error";
  }

  function debugLog(message) {
    if (config.debug) log(message);
  }

  function log(message) {
    console.log(PREFIX + " " + message);
  }
})();
