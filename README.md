# Surge 模块

个人 [Surge](https://nssurge.com/) 模块合集。

| 模块 |  Raw 链接 |
|--------|----------|
| AI Balance | https://raw.githubusercontent.com/gogrhw/surge/refs/heads/main/Modules/ai-balance.sgmodule |
| GitHub PDF 预览 | https://raw.githubusercontent.com/gogrhw/surge/refs/heads/main/Modules/github-pdf-preview.sgmodule |
| GitHub 私有仓库 | https://raw.githubusercontent.com/gogrhw/surge/refs/heads/main/Modules/github-private-repo.sgmodule |
| ISVORO 面板 | https://raw.githubusercontent.com/gogrhw/surge/refs/heads/main/Modules/isvoro-panel.sgmodule |
| Kelee 解锁 | https://raw.githubusercontent.com/gogrhw/surge/refs/heads/main/Modules/unlock-ikelee.sgmodule |
| KiwiVM 面板 | https://raw.githubusercontent.com/gogrhw/surge/refs/heads/main/Modules/kiwivm-panel.sgmodule |
| Plexamp Qwen | https://raw.githubusercontent.com/gogrhw/surge/refs/heads/main/Modules/plexamp-qwen.sgmodule |
| Plex Fast Connect | https://raw.githubusercontent.com/gogrhw/surge/refs/heads/main/Modules/plex-fast-connect.sgmodule |
| YouTube Plus | https://raw.githubusercontent.com/gogrhw/surge/refs/heads/main/Modules/youtube-plus.sgmodule |

## 模块参数说明

### AI Balance

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `Update Interval` | `600` | 面板刷新间隔，单位秒 |
| `DeepSeek API Key` | 必填 | DeepSeek 开放平台 API Key |
| `Qwen AccessKey ID` | 必填 | 阿里云 RAM AccessKey ID，不是 DashScope API Key |
| `Qwen AccessKey Secret` | 必填 | 对应的阿里云 RAM AccessKey Secret |

模块使用固定标题 `AI Balance`，将 DeepSeek 和 Qwen 余额合并到一张卡片，只显示 DeepSeek 总余额和 Qwen 可用余额。Qwen/百炼通过阿里云账户结算，因此 Qwen 可用余额来自 BSS OpenAPI `QueryAccountBalance`，代表整个阿里云账号可用于 Qwen/百炼等服务结算的可用额度；它不是单个 Qwen API Key 的用量统计。

建议创建专用 RAM 用户，只授予 BSS 余额只读权限（例如`AliyunBSSReadOnlyAccess`），不要使用具备资源管理权限的主账号 AccessKey。卡片只访问 DeepSeek 与阿里云官方接口；阿里云 AccessKey Secret 仅在 Surge 本机用于生成 HMAC-SHA1 请求签名，不会作为明文参数发送。

### GitHub PDF 预览

无需配置参数。将 `raw.githubusercontent.com` 返回的 PDF 响应类型修正为 `application/pdf`，并移除强制下载响应头，使 Safari 等浏览器直接预览文件。需要开启 MITM 并信任 Surge 证书。

### GitHub 私有仓库

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `Username` | 必填 | GitHub 用户名 |
| `Token` | 必填 | GitHub Personal Access Token，需勾选 repo 权限 |

### ISVORO 面板

按 [ISVORO Open API 文档](https://isvoro.com/docs/api) 的 `read` 权限范围提供七张面板。Key 在控制台的 **Open API** 页面创建，只需选择只读权限。

1. 导入 [isvoro-panel.sgmodule](Modules/isvoro-panel.sgmodule)，填写 `API_KEY`。
2. 刷新服务器面板，查看服务器 ID。
3. 将该 ID 填入 `SERVER_ID`，刷新实时监控、流量、备份与配置面板。

本地使用时，将 `SCRIPT_PATH` 设为 `/Users/guoguanhua/Documents/surge/Scripts/isvoro-panel.js`。在其他设备上，将脚本复制到 Surge 配置目录，再填写该设备上的脚本路径。默认 `SCRIPT_PATH` 和表中的 Raw 链接在这些文件发布到本仓库的 `main` 分支后可用。

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `API_KEY` | 必填 | `isv_` 开头的 Open API Key |
| `SCRIPT_PATH` | 本仓库脚本 Raw URL | 可改为本地脚本路径 |
| `UPDATE_INTERVAL` | `600` | 面板刷新间隔，单位秒 |
| `SERVER_ID` | 空 | 空值显示服务器列表；填写后显示该服务器详情，并用于监控、流量和配置查询 |
| `PRODUCT_ID` | 空 | 空值显示产品列表；填写后查询单个产品 |
| `INVOICE_ID` | 空 | 空值显示账单列表；填写后查询单张账单 |
| `PAGE` | `1` | 产品、服务器、账单列表的页码 |
| `PER_PAGE` | `5` | 列表每页条数，范围 `1–100` |
| `MAX_ROWS` | `5` | 每组最多显示条数，范围 `1–100`；统计仍使用本次返回的全部数据 |
| `SERVER_STATUS` | 空 | 服务器列表的 `status` 筛选值 |
| `SERVER_QUERY` | 空 | 服务器列表的 `q` 搜索值 |
| `INVOICE_STATUS` | 空 | 账单列表的 `status` 筛选值 |
| `TIMEFRAME` | `hour` | 历史指标区间：`hour`、`day`、`week`、`month`、`year` |
| `TRAFFIC_DAYS` | `30` | 每日流量查询天数：`30`、`60`、`90` |
| `SHOW_ACCOUNT` | `true` | 显示账户面板 |
| `SHOW_PRODUCTS` | `true` | 显示产品面板 |
| `SHOW_SERVERS` | `true` | 显示服务器面板 |
| `SHOW_LIVE` | `true` | 显示实时监控面板 |
| `SHOW_TRAFFIC` | `true` | 显示流量面板 |
| `SHOW_STORAGE` | `true` | 显示备份与配置面板 |
| `SHOW_BILLING` | `true` | 显示账单面板 |

将 `SHOW_*` 设为 `false` 可隐藏对应面板。列表会显示本页条数、总数和页码；修改 `PAGE` 查看其他页。填写单条 ID 后，列表筛选不参与详情查询。列表超过 `MAX_ROWS` 时，面板会注明显示条数；增大该参数可查看更多记录。

`SERVER_QUERY` 使用 URL 编码传入。搜索值含 `&`、`+`、`%`、逗号或双引号时，先编码这些字符，例如 `香港 & web` 填为 `%E9%A6%99%E6%B8%AF%20%26%20web`。

| 面板 | 只读接口 | 显示内容 |
|------|----------|----------|
| 账户 | `GET /account` | 账户信息、邮箱验证状态、余额及币种 |
| 产品 | `GET /products`、`GET /products/:productId` | 规格、套餐价格、开通费、库存、限购、实名要求、系统模板 |
| 服务器 | `GET /servers`、`GET /servers/:serviceId` | 状态、规格、IP、流量配额、到期日、自动续费状态、锁定和暂停原因 |
| 实时监控 | `GET /servers/:serviceId/status`、`GET /servers/:serviceId/netrate`、`GET /servers/:serviceId/metrics` | CPU、内存、运行时间、当前网速、累计网络计数、历史 CPU 均值与峰值、最近采样的内存及网络和磁盘速率 |
| 流量 | `GET /servers/:serviceId`、`GET /servers/:serviceId/traffic-daily` | 流量配额及重置时间、每日入站与出站流量、查询期间合计、重置记录 |
| 备份与配置 | `GET /servers/:serviceId/backups`、`GET /servers/:serviceId/port-forwards`、`GET /servers/:serviceId/os-templates` | 备份时间与大小、端口转发及端口范围、可用系统模板 |
| 账单 | `GET /invoices`、`GET /invoices/:invoiceId` | 状态、币种、总额、待付金额、截止日期、支付时间和明细 |

时间按设备时区显示。历史 CPU 均值是返回采样值的算术平均，缺失值不参与计算。网速单位为字节每秒；`sampled=false` 显示“暂无有效采样”。没有返回的指标显示 `—`，真实零值保留为 `0`。

脚本仅通过认证头发送 Key，固定访问 `https://isvoro.com/api/v1/open`，按路径白名单限制到上述 14 个 `read` 接口。模块不需要 MITM。接口失败会显示 HTTP 状态、API 错误码或网络错误；同组其他成功结果继续显示。Key 不写入脚本日志或脚本持久化存储。

验证命令：`node --check Scripts/isvoro-panel.js` 和 `node Tests/isvoro-panel.test.js`。测试使用从官网文档提取的 [14 份响应示例](Tests/Fixtures/isvoro-api.json) 模拟 Surge，覆盖七张面板、列表与详情、分页、筛选、部分失败、超时和只读请求。实际账户查询需要在 Surge 中填写有效 Key。

### Kelee 解锁

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `Loon Version` | `962` | Loon 客户端版本号，脚本会自动拼接完整的 User-Agent 字符串 |

### KiwiVM 面板

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `Panel Title` | `KiwiVM` | 面板标题 |
| `Update Interval` | `600` | 面板刷新间隔，单位秒 |
| `Show Overview` | `true` | 是否显示总览面板 |
| `Show Live` | `true` | 是否显示实时状态面板 |
| `Show Network` | `true` | 是否显示网络面板 |
| `Show Storage` | `true` | 是否显示快照与备份面板 |
| `Show Security` | `true` | 是否显示安全面板 |
| `Show Maintenance` | `true` | 是否显示维护面板 |
| `VEID` | 必填 | BandwagonHost VPS 的 VEID |
| `API Key` | 必填 | KiwiVM 控制面板的 API Key |

将某个 `Show ...` 参数设为 `false`，即可隐藏对应面板。所有面板均为只读模式，不会调用重启、关机、重装、Shell、快照恢复等 VPS 操作接口。

### Plex Fast Connect

加速 Infuse 的 Plex 服务器发现。首次请求仍访问 Plex 官方 `resources.xml`，脚本自动识别并缓存正确的官方 Device；后续请求会先认证可用直连并只返回最快的一条，避免客户端逐个等待无效候选地址超时。

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `BYPASS_OFFICIAL` | `true` | 缓存可用时绕过 Plex 官方发现 |
| `LAN_URL` | `auto` | 局域网 Plex 根地址；`auto` 表示使用官方候选 |
| `REMOTE_URL` | `auto` | 远程 Plex 根地址；`auto` 表示使用官方候选 |
| `BYPASS_TIMEOUT` | `3` | 直连认证超时秒数，范围 `0.5–4` |
| `PROBE_TIMEOUT` | `2` | 关闭绕过时筛选官方候选的超时秒数，范围 `0.5–3` |
| `ALLOW_RELAY` | `true` | 关闭绕过后，直连失败时是否尝试 Plex Relay |
| `DEBUG` | `false` | 输出不含 Token 的诊断日志 |

两个 URL 都为 `auto` 时完全自动识别。任意参数填写 HTTP(S) URL 后进入显式模式，只使用实际填写的 URL；例如只填写 `LAN_URL` 时不会探测远程或自动候选。

模块只 MITM `plex.tv` 的资源发现请求，不会解密实际媒体流。服务器专用 Token 来自 Plex 官方响应，仅保存在 Surge 本机的 `$persistentStore` 中，不会写入模块、上传到 GitHub 或输出到日志。安装前需在 Surge 中启用 MITM、脚本并信任 Surge CA。

### Plexamp Qwen

让固定使用 OpenAI 接口的 Plexamp 接入阿里云百炼 Model Studio：在 Plexamp 的 OpenAI API Key 输入框填写百炼 API Key，模块会在本机返回兼容的模型列表，将聊天请求转发到兼容模式 API，并将 Qwen-Image 的结果转换为 OpenAI Images 格式。

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `API_HOST` | `dashscope.aliyuncs.com` | 百炼 API 主机名 |
| `TEXT_MODEL` | `qwen3.8-max` | 聊天请求使用的模型 |
| `IMAGE_MODEL` | `qwen-image-3.0` | 图像生成使用的模型 |
| `IMAGE_SIZE` | `auto` | `auto` 沿用 Plexamp 请求的尺寸，也可指定如 `1024*1024` |
| `PROMPT_EXTEND` | `true` | 是否启用图像提示词扩写 |
| `WATERMARK` | `false` | 是否为生成图像添加水印 |
| `IMAGE_TIMEOUT` | `180` | 图像生成超时秒数，范围 `30–210` |
| `DEBUG` | `false` | 输出不含 API Key 的诊断日志 |

模块 MITM `api.openai.com`。安装前需在 Surge 中启用 MITM、脚本并信任 Surge CA。API Key 只从 Plexamp 请求头转发到百炼，不会写入模块、脚本、日志或持久化存储。

### YouTube Plus

#### 内容过滤

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `blockUpload` | `true` | 屏蔽上传类型的动态内容 |
| `blockImmersive` | `true` | 屏蔽沉浸式音乐动态内容 |
| `blockShorts` | `true` | 屏蔽 YouTube Shorts |
| `debug` | `false` | 开启调试日志 |

#### 字幕翻译

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `Type` | `Translate` | 字幕类型，`Translate` 翻译字幕 / `Official` 官方字幕 |
| `AutoCC` | `false` | 自动显示翻译字幕 |
| `ShowOnly` | `false` | 仅显示翻译字幕，隐藏原文字幕 |
| `Position` | `Forward` | 原文字幕位置，`Forward` 在上 / `Reverse` 在下 |
