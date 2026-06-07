# Surge 模块

个人 [Surge](https://nssurge.com/) 模块合集。

| 模块 |  Raw 链接 |
|--------|----------|
| BandwagonHost 流量 | https://raw.githubusercontent.com/gogrhw/surge/refs/heads/main/Modules/bandwagonhost-traffic.sgmodule |
| Emby 解锁 | https://raw.githubusercontent.com/gogrhw/surge/refs/heads/main/Modules/emby-unlock.sgmodule |
| GitHub 私有仓库 | https://raw.githubusercontent.com/gogrhw/surge/refs/heads/main/Modules/github-private-repo.sgmodule |
| GoodNotes Notability 解锁 | https://raw.githubusercontent.com/gogrhw/surge/refs/heads/main/Modules/goodnotes-notability-unlock.sgmodule |
| KiwiVM 面板 | https://raw.githubusercontent.com/gogrhw/surge/refs/heads/main/Modules/kiwivm-panel.sgmodule |
| Kelee 解锁 | https://raw.githubusercontent.com/gogrhw/surge/refs/heads/main/Modules/unlock-ikelee.sgmodule |
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

### KiwiVM 面板

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `Panel Title` | `KiwiVM` | 面板标题 |
| `Update Interval` | `600` | 面板刷新间隔，单位秒 |
| `Panel Icon` | `server.rack` | 面板图标，SF Symbols 图标名 |
| `Panel Color` | `6F4A35` | 面板颜色，十六进制颜色值（不含 `#`） |
| `VEID` | 必填 | BandwagonHost VPS 的 VEID |
| `API Key` | 必填 | KiwiVM 控制面板的 API Key |

所有面板均为只读模式，不会调用重启、关机、重装、Shell、快照恢复等 VPS 操作接口。

### Kelee 解锁

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `Loon Version` | `962` | Loon 客户端版本号，脚本会自动拼接完整的 User-Agent 字符串 |

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
