# Surge 模块

个人 [Surge](https://nssurge.com/) 模块合集。

| 模块 |  Raw 链接 |
|--------|----------|
| BandwagonHost 流量 | https://raw.githubusercontent.com/gogrhw/surge/refs/heads/main/Modules/bandwagonhost-traffic.sgmodule |
| Emby 解锁 | https://raw.githubusercontent.com/gogrhw/surge/refs/heads/main/Modules/emby-unlock.sgmodule |
| GitHub PDF 预览 | https://raw.githubusercontent.com/gogrhw/surge/refs/heads/main/Modules/github-pdf-preview.sgmodule |
| GitHub 私有仓库 | https://raw.githubusercontent.com/gogrhw/surge/refs/heads/main/Modules/github-private-repo.sgmodule |
| GoodNotes Notability 解锁 | https://raw.githubusercontent.com/gogrhw/surge/refs/heads/main/Modules/goodnotes-notability-unlock.sgmodule |
| KiwiVM 面板 | https://raw.githubusercontent.com/gogrhw/surge/refs/heads/main/Modules/kiwivm-panel.sgmodule |
| Kelee 解锁 | https://raw.githubusercontent.com/gogrhw/surge/refs/heads/main/Modules/unlock-ikelee.sgmodule |
| Plex Fast Connect | https://raw.githubusercontent.com/gogrhw/surge/refs/heads/main/Modules/plex-fast-connect.sgmodule |
| Spotify 解锁 | https://raw.githubusercontent.com/gogrhw/surge/refs/heads/main/Modules/Spotify-unlock.sgmodule |
| YouTube Plus | https://raw.githubusercontent.com/gogrhw/surge/refs/heads/main/Modules/youtube-plus.sgmodule |

## 模块参数说明

### BandwagonHost 流量

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `Cron Expression` | `0 0 * * *` | 定时刷新流量的 cron 表达式，默认每天凌晨执行 |
| `VEID` | 必填 | BandwagonHost VPS 的 VEID |
| `API Key` | 必填 | KiwiVM 控制面板的 API Key |

### GitHub 私有仓库

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `Username` | 必填 | GitHub 用户名 |
| `Token` | 必填 | GitHub Personal Access Token，需勾选 repo 权限 |

### GitHub PDF 预览

无需配置参数。将 `raw.githubusercontent.com` 返回的 PDF 响应类型修正为 `application/pdf`，并移除强制下载响应头，使 Safari 等浏览器直接预览文件。需要开启 MITM 并信任 Surge 证书。

### KiwiVM 面板

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `Panel Title` | `KiwiVM` | 面板标题 |
| `Update Interval` | `600` | 面板刷新间隔，单位秒 |
| `Panel Icon` | `server.rack` | 面板图标，SF Symbols 图标名 |
| `Panel Color` | `6F4A35` | 面板颜色，十六进制颜色值（不含 `#`） |
| `Show Overview` | `true` | 是否显示总览面板 |
| `Show Live` | `true` | 是否显示实时状态面板 |
| `Show Network` | `true` | 是否显示网络面板 |
| `Show Storage` | `true` | 是否显示快照与备份面板 |
| `Show Security` | `true` | 是否显示安全面板 |
| `Show Maintenance` | `true` | 是否显示维护面板 |
| `VEID` | 必填 | BandwagonHost VPS 的 VEID |
| `API Key` | 必填 | KiwiVM 控制面板的 API Key |

将某个 `Show ...` 参数设为 `false`，即可隐藏对应面板。所有面板均为只读模式，不会调用重启、关机、重装、Shell、快照恢复等 VPS 操作接口。

### Kelee 解锁

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `Loon Version` | `962` | Loon 客户端版本号，脚本会自动拼接完整的 User-Agent 字符串 |

### Plex Fast Connect

加速 Infuse 的 Plex 服务器发现。首次请求仍访问 Plex 官方
`resources.xml`，脚本自动识别并缓存正确的官方 Device；后续请求会先认证可用
直连并只返回最快的一条，避免客户端逐个等待无效候选地址超时。

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `BYPASS_OFFICIAL` | `true` | 缓存可用时绕过 Plex 官方发现 |
| `LAN_URL` | `auto` | 局域网 Plex 根地址；`auto` 表示使用官方候选 |
| `REMOTE_URL` | `auto` | 远程 Plex 根地址；`auto` 表示使用官方候选 |
| `BYPASS_TIMEOUT` | `3` | 直连认证超时秒数，范围 `0.5–4` |
| `PROBE_TIMEOUT` | `2` | 关闭绕过时筛选官方候选的超时秒数，范围 `0.5–3` |
| `ALLOW_RELAY` | `true` | 关闭绕过后，直连失败时是否尝试 Plex Relay |
| `DEBUG` | `false` | 输出不含 Token 的诊断日志 |

两个 URL 都为 `auto` 时完全自动识别。任意参数填写 HTTP(S) URL 后进入显式
模式，只使用实际填写的 URL；例如只填写 `LAN_URL` 时不会探测远程或自动候选。

模块只 MITM `plex.tv` 的资源发现请求，不会解密实际媒体流。服务器专用 Token
来自 Plex 官方响应，仅保存在 Surge 本机的 `$persistentStore` 中，不会写入
模块、上传到 GitHub 或输出到日志。安装前需在 Surge 中启用 MITM、脚本并信任
Surge CA。

### Spotify 解锁

无需配置参数。通过重写账户属性和客户端 API 请求来解锁 Spotify Premium 功能。需要 MITM 开启并信任证书。

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
