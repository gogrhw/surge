const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const SOURCE = fs.readFileSync(
  path.join(ROOT, "Scripts/plexamp-qwen.js"),
  "utf8"
);
const MODULE = fs.readFileSync(
  path.join(ROOT, "Modules/plexamp-qwen.sgmodule"),
  "utf8"
);
const README = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
const helpers = require(path.join(ROOT, "Scripts/plexamp-qwen.js"));

(async function () {
  assert.match(MODULE, /^#!name=Plexamp Qwen$/m);
  assert.match(MODULE, /^#!arguments=API_HOST:dashscope\.aliyuncs\.com,/m);
  assert.match(MODULE, /^#!arguments-desc=/m);
  assert.match(MODULE, /^#!requirement=CORE_VERSION>=20$/m);
  assert.equal((MODULE.match(/\btype=http-request\b/g) || []).length, 1);
  assert.equal((MODULE.match(/\btype=http-response\b/g) || []).length, 0);
  assert.match(MODULE, /\brequires-body=true\b/);
  assert.match(MODULE, /\bmax-size=1048576\b/);
  assert.match(MODULE, /\btimeout=300\b/);
  assert.match(MODULE, /\[MITM\][\s\S]*hostname = %APPEND% api\.openai\.com/);
  assert.match(
    MODULE,
    /script-path=https:\/\/raw\.githubusercontent\.com\/gogrhw\/surge\/refs\/heads\/main\/Scripts\/plexamp-qwen\.js/
  );
  assert.match(MODULE, /api_host=\{\{\{API_HOST\}\}\}/);
  assert.match(MODULE, /debug=\{\{\{DEBUG\}\}\}/);
  assert.equal(MODULE.includes("api_key"), false);

  const modulePattern = MODULE.match(/(?:^|,)pattern=([^,\n]+)/m);
  assert.ok(modulePattern, "module pattern missing");
  const pattern = new RegExp(modulePattern[1]);
  [
    "https://api.openai.com/v1/models",
    "https://api.openai.com/v1/models/gpt-4o?x=1",
    "https://api.openai.com/v1/chat/completions",
    "https://api.openai.com/v1/images/generations?x=1",
  ].forEach(function (url) {
    assert.equal(pattern.test(url), true, "pattern should match " + url);
  });
  assert.equal(
    pattern.test("https://api.openai.com/v1/audio/transcriptions"),
    false
  );

  assert.match(
    README,
    /\| Plexamp Qwen \| https:\/\/raw\.githubusercontent\.com\/gogrhw\/surge\/refs\/heads\/main\/Modules\/plexamp-qwen\.sgmodule \|/
  );
  assert.match(README, /### Plexamp Qwen/);

  assert.equal(
    helpers.routeForURL("https://api.openai.com/v1/models/gpt-4o?x=1"),
    "models"
  );
  assert.equal(
    helpers.routeForURL("https://api.openai.com/v1/chat/completions"),
    "chat"
  );
  assert.equal(
    helpers.routeForURL("https://api.openai.com/v1/images/generations"),
    "images"
  );
  assert.equal(
    helpers.routeForURL("https://example.com/v1/chat/completions"),
    ""
  );
  assert.equal(helpers.imageSize("1792x1024", "auto"), "1792*1024");
  assert.equal(helpers.imageSize("256x256", "auto"), "1024*1024");
  assert.equal(helpers.imageSize("1024x1024", "1536*1024"), "1536*1024");

  const parsedConfig = helpers.configFromArguments([
    "api_host=https%3A%2F%2Fexample.com%2Fcompatible-mode",
    "text_model=test-text",
    "image_model=test-image",
    "image_size=1536x1024",
    "prompt_extend=false",
    "watermark=true",
    "image_timeout=999",
    "debug=true",
  ].join("&"));
  assert.equal(parsedConfig.apiHost, "example.com");
  assert.equal(parsedConfig.textModel, "test-text");
  assert.equal(parsedConfig.imageModel, "test-image");
  assert.equal(parsedConfig.imageSize, "1536x1024");
  assert.equal(parsedConfig.promptExtend, false);
  assert.equal(parsedConfig.watermark, true);
  assert.equal(parsedConfig.imageTimeout, 210);
  assert.equal(parsedConfig.debug, true);

  const catalogue = await runScript({
    request: {
      url: "https://api.openai.com/v1/models",
      method: "GET",
      headers: {},
    },
  });
  assert.equal(catalogue.calls.length, 0);
  assert.equal(catalogue.result.response.status, 200);
  assert.equal(
    catalogue.result.response.headers["Content-Type"],
    "application/json; charset=utf-8"
  );
  assert.equal(catalogue.result.response.headers["Content-Length"], undefined);
  const modelList = JSON.parse(catalogue.result.response.body);
  assert.equal(modelList.object, "list");
  assert.equal(modelList.data.some(function (model) {
    return model.id === "gpt-4o";
  }), true);
  assert.equal(modelList.data.some(function (model) {
    return model.id === "gpt-image-1";
  }), true);

  const missingModel = await runScript({
    request: {
      url: "https://api.openai.com/v1/models/not-real",
      method: "GET",
      headers: {},
    },
  });
  assert.equal(missingModel.result.response.status, 404);
  assert.equal(
    JSON.parse(missingModel.result.response.body).error.code,
    "model_not_found"
  );

  const chat = await runScript({
    argument: "text_model=qwen-test&debug=true",
    request: {
      url: "https://api.openai.com/v1/chat/completions",
      method: "POST",
      headers: {
        Authorization: "Bearer fixture-model-studio-key",
        "Content-Type": "application/json",
        "Content-Length": "999",
        "OpenAI-Organization": "org-fixture",
        "User-Agent": "Plexamp/Test",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
        max_completion_tokens: 123,
        reasoning_effort: "high",
        thinking_budget: 1000,
        thinking: { type: "enabled" },
        stream: true,
      }),
    },
    responder: function (method, options) {
      assert.equal(method, "post");
      assert.equal(
        options.url,
        "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
      );
      assert.equal(options.timeout, 300);
      assert.equal(options["auto-cookie"], false);
      assert.equal(options.headers.Authorization, "Bearer fixture-model-studio-key");
      assert.equal(options.headers["Content-Length"], undefined);
      assert.equal(options.headers["OpenAI-Organization"], undefined);
      assert.equal(options.headers["User-Agent"], "Plexamp/Test");

      const body = JSON.parse(options.body);
      assert.equal(body.model, "qwen-test");
      assert.equal(body.enable_thinking, false);
      assert.equal(body.max_tokens, 123);
      assert.equal(body.max_completion_tokens, undefined);
      assert.equal(body.reasoning_effort, undefined);
      assert.equal(body.thinking_budget, undefined);
      assert.equal(body.thinking, undefined);

      return {
        status: 200,
        headers: { "Content-Type": "text/event-stream; charset=utf-8" },
        data: [
          'data: {"choices":[{"delta":{"content":"Hello"}}]}',
          "",
          'data: {"choices":[],"usage":{"total_tokens":4}}',
          "",
          "data: [DONE]",
          "",
        ].join("\n"),
      };
    },
  });
  assert.equal(chat.calls.length, 1);
  assert.equal(chat.result.response.status, 200);
  assert.match(chat.result.response.body, /Hello/);
  assert.match(chat.result.response.body, /\[DONE\]/);
  assert.doesNotMatch(chat.result.response.body, /total_tokens/);

  const missingKey = await runScript({
    request: {
      url: "https://api.openai.com/v1/chat/completions",
      method: "POST",
      headers: {},
      body: "{}",
    },
  });
  assert.equal(missingKey.calls.length, 0);
  assert.equal(missingKey.result.response.status, 401);
  assert.equal(
    JSON.parse(missingKey.result.response.body).error.code,
    "missing_api_key"
  );

  const imageURL = await runScript({
    argument: [
      "image_model=qwen-image-test",
      "image_size=1536x1024",
      "prompt_extend=false",
      "watermark=true",
      "image_timeout=190",
    ].join("&"),
    request: {
      url: "https://api.openai.com/v1/images/generations",
      method: "POST",
      headers: { Authorization: "Bearer fixture-model-studio-key" },
      body: JSON.stringify({
        model: "dall-e-3",
        prompt: "  a record player  ",
        n: 2,
        size: "1024x1024",
        response_format: "url",
      }),
    },
    responder: function (method, options) {
      assert.equal(method, "post");
      assert.equal(
        options.url,
        "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
      );
      assert.equal(options.timeout, 190);
      const body = JSON.parse(options.body);
      assert.equal(body.model, "qwen-image-test");
      assert.equal(body.parameters.n, 2);
      assert.equal(body.parameters.size, "1536*1024");
      assert.equal(body.parameters.prompt_extend, false);
      assert.equal(body.parameters.watermark, true);
      assert.equal(body.input.messages[0].content[0].text, "a record player");
      return {
        status: 200,
        headers: { "Content-Type": "application/json" },
        data: JSON.stringify({
          output: {
            choices: [
              {
                message: {
                  content: [
                    { image: "https://images.example/one.png" },
                    { image: "https://images.example/two.png" },
                  ],
                },
              },
            ],
          },
        }),
      };
    },
  });
  assert.equal(imageURL.calls.length, 1);
  assert.equal(imageURL.result.response.status, 200);
  const imageURLBody = JSON.parse(imageURL.result.response.body);
  assert.equal(imageURLBody.data.length, 2);
  assert.equal(imageURLBody.data[0].url, "https://images.example/one.png");
  assert.equal(imageURLBody.data[0].revised_prompt, "a record player");

  const imageBase64 = await runScript({
    request: {
      url: "https://api.openai.com/v1/images/generations",
      method: "POST",
      headers: { Authorization: "Bearer fixture-model-studio-key" },
      body: JSON.stringify({
        model: "gpt-image-1",
        prompt: "album art",
      }),
    },
    responder: function (method, options) {
      if (method === "post") {
        return {
          status: 200,
          headers: { "Content-Type": "application/json" },
          data: JSON.stringify({
            output: {
              results: [{ url: "https://images.example/generated.png" }],
            },
          }),
        };
      }

      assert.equal(method, "get");
      assert.equal(options.url, "https://images.example/generated.png");
      assert.equal(options["binary-mode"], true);
      assert.equal(options.timeout, 60);
      return {
        status: 200,
        headers: { "Content-Type": "image/png" },
        data: new Uint8Array([0, 1, 2, 253, 254, 255]),
      };
    },
  });
  assert.equal(imageBase64.calls.length, 2);
  assert.equal(
    JSON.parse(imageBase64.result.response.body).data[0].b64_json,
    "AAEC/f7/"
  );

  console.log("plexamp-qwen tests passed");
})().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});

function runScript(options) {
  return new Promise(function (resolve, reject) {
    const calls = [];
    const logs = [];
    let settled = false;
    const timer = setTimeout(function () {
      if (!settled) reject(new Error("script did not call $done"));
    }, 2000);

    function dispatch(method, requestOptions, callback) {
      calls.push({ method: method, options: requestOptions });
      setImmediate(function () {
        try {
          const reply = options.responder
            ? options.responder(method, requestOptions, calls.length - 1)
            : { error: "unexpected HTTP request" };
          callback(
            reply && reply.error ? reply.error : null,
            reply && !reply.error
              ? { status: reply.status, headers: reply.headers || {} }
              : null,
            reply && reply.data
          );
        } catch (error) {
          reject(error);
        }
      });
    }

    const context = {
      $argument: options.argument || "",
      $request: options.request,
      $done: function (result) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ result: result, calls: calls, logs: logs });
      },
      $httpClient: {
        get: function (requestOptions, callback) {
          dispatch("get", requestOptions, callback);
        },
        post: function (requestOptions, callback) {
          dispatch("post", requestOptions, callback);
        },
      },
      console: {
        log: function (message) {
          logs.push(String(message));
        },
      },
      Date: Date,
      JSON: JSON,
      Math: Math,
      Uint8Array: Uint8Array,
      isFinite: isFinite,
      setTimeout: setTimeout,
    };

    try {
      vm.runInNewContext(SOURCE, context, {
        filename: "Scripts/plexamp-qwen.js",
      });
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}
