"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const scriptPath = path.join(root, "Scripts", "ai-balance.js");
const modulePath = path.join(root, "Modules", "ai-balance.sgmodule");
const kiwiVmScriptPath = path.join(root, "Scripts", "kiwivm-panel.js");
const kiwiVmModulePath = path.join(root, "Modules", "kiwivm-panel.sgmodule");
const source = fs.readFileSync(scriptPath, "utf8");
const helpers = require(scriptPath);

function simulate(argument, responder) {
  return new Promise((resolve, reject) => {
    let requestCount = 0;
    const sandbox = {
      $argument: argument,
      $httpClient: {
        get(options, callback) {
          requestCount += 1;
          try {
            const result = responder(options);
            callback(result.error || null, result.response || { status: 200 }, result.data || "{}");
          } catch (error) {
            reject(error);
          }
        },
      },
      $done(panel) {
        resolve({ panel, requestCount });
      },
    };

    try {
      vm.runInNewContext(source, sandbox, { filename: scriptPath });
    } catch (error) {
      reject(error);
    }
  });
}

async function main() {
  const signedUrl = helpers.buildAliyunSignedUrl("testid", "testsecret", {
    endpoint: "http://cmn.aliyuncs.com",
    action: "DescribeRegions",
    format: "XML",
    version: "2014-05-26",
    timestamp: "2016-02-23T12:46:24Z",
    nonce: "3ee8c1b8-83d3-44af-a94f-4e0ad82fd6cf",
  });
  assert.equal(new URL(signedUrl).searchParams.get("Signature"), "OLeaidS1JvxuMvnyHOwuJ+uX5qY=");

  const argument =
    "deepseek_api_key=sk-test&qwen_access_key_id=testid&qwen_access_key_secret=testsecret";
  const combined = await simulate(argument, (request) => {
    if (request.url === "https://api.deepseek.com/user/balance") {
      assert.doesNotMatch(request.url, /sk-test/);
      assert.equal(request.headers.Authorization, "Bearer sk-test");
      return {
        data: JSON.stringify({
          is_available: true,
          balance_infos: [
            { currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" },
          ],
        }),
      };
    }

    if (request.url.startsWith("https://business.aliyuncs.com/")) {
      const url = new URL(request.url);
      assert.equal(url.hostname, "business.aliyuncs.com");
      assert.equal(url.searchParams.get("Action"), "QueryAccountBalance");
      assert.equal(url.searchParams.get("AccessKeyId"), "testid");
      assert.ok(url.searchParams.get("Signature"));
      assert.doesNotMatch(request.url, /testsecret/);
      return {
        data: JSON.stringify({
          Code: "200",
          Message: "success",
          Success: true,
          Data: {
            AvailableAmount: "88.50",
            AvailableCashAmount: "80.00",
            CreditAmount: "8.50",
            MybankCreditAmount: "0.00",
            Currency: "CNY",
          },
        }),
      };
    }

    throw new Error("unexpected request: " + request.url);
  });
  assert.equal(combined.requestCount, 2);
  assert.equal(combined.panel.title, "AI Balance");
  assert.equal(combined.panel.content, "DeepSeek 总余额: ¥110.00\nQwen 可用余额: ¥88.50");
  assert.equal(combined.panel.content.split("\n").length, 2);
  assert.equal(combined.panel.icon, undefined);
  assert.equal(combined.panel["icon-color"], undefined);

  const partialFailure = await simulate(argument, (request) => {
    if (request.url === "https://api.deepseek.com/user/balance") {
      return { error: { message: "offline" } };
    }
    return {
      data: JSON.stringify({
        Code: "200",
        Success: true,
        Data: { AvailableAmount: "9.25", Currency: "CNY" },
      }),
    };
  });
  assert.equal(partialFailure.requestCount, 2);
  assert.equal(partialFailure.panel.content, "DeepSeek 总余额: 查询失败\nQwen 可用余额: ¥9.25");

  const missingCredential = await simulate(
    "deepseek_api_key=YOUR_DEEPSEEK_API_KEY&qwen_access_key_id=YOUR_ALIBABA_CLOUD_ACCESS_KEY_ID&qwen_access_key_secret=YOUR_ALIBABA_CLOUD_ACCESS_KEY_SECRET",
    () => {
      throw new Error("missing credentials must not trigger an HTTP request");
    }
  );
  assert.equal(missingCredential.requestCount, 0);
  assert.equal(missingCredential.panel.title, "AI Balance");
  assert.equal(missingCredential.panel.content, "DeepSeek 总余额: 查询失败\nQwen 可用余额: 查询失败");

  const moduleSource = fs.readFileSync(modulePath, "utf8");
  assert.match(moduleSource, /^#!name=AI Balance$/m);
  assert.match(
    moduleSource,
    /^AI = title="AI Balance",content="Waiting for refresh",script-name=ai-balance,update-interval=\{\{\{Update Interval\}\}\}$/m
  );
  const panelLines = moduleSource
    .match(/\[Panel\]\n([\s\S]*?)\n\[Script\]/)[1]
    .split("\n")
    .filter(Boolean);
  const scriptLines = moduleSource.split("[Script]\n")[1].split("\n").filter(Boolean);
  assert.equal(panelLines.length, 1);
  assert.equal(scriptLines.length, 1);
  assert.match(panelLines[0], /script-name=ai-balance/);
  assert.match(scriptLines[0], /^ai-balance = type=generic/);
  assert.match(scriptLines[0], /deepseek_api_key=/);
  assert.match(scriptLines[0], /qwen_access_key_id=/);
  assert.match(scriptLines[0], /qwen_access_key_secret=/);
  assert.doesNotMatch(moduleSource, /Panel Title|title=\{\{\{Panel Title\}\}\}/);
  assert.doesNotMatch(moduleSource, /Show DeepSeek|Show Qwen/);
  assert.match(moduleSource, /Scripts\/ai-balance\.js/);
  assert.doesNotMatch(moduleSource, /\bicon(?:-color)?\s*=/);

  const kiwiVmModuleSource = fs.readFileSync(kiwiVmModulePath, "utf8");
  const kiwiVmScriptSource = fs.readFileSync(kiwiVmScriptPath, "utf8");
  assert.doesNotMatch(kiwiVmModuleSource, /\bicon(?:-color)?\s*=/i);
  assert.doesNotMatch(kiwiVmScriptSource, /\bicon(?:-color)?\s*:/i);

  console.log("ai-balance: all tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
