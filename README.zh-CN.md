# web2md

**[English](README.md) | [简体中文](README.zh-CN.md)**

一个轻量、可自托管的 [r.jina.ai](https://r.jina.ai) 风格 Reader 服务。
在任意 URL 前加上服务前缀,即可返回干净、AI 可直接使用的
Markdown——静态网页和 JS 渲染的 SPA 都支持(包括微信公众号文章)。

## 功能特性

- **与 r.jina.ai 相同的前缀用法** —— `http://localhost:3000/<url>` → `text/markdown`
- **静态页面亚秒级返回** —— Mozilla Readability 正文提取 + Turndown 转 Markdown
- **SPA / JS 渲染页面** —— 自动降级到真实无头浏览器([Camoufox](https://github.com/daijro/camoufox),反检测 Firefox 定制版)
- **WAF 穿透** —— 在沙箱中求解云盾 `__jsl_clearance` JS 挑战(国内政务网站常见),按域名缓存通关 cookie
- **编码安全** —— jsdom 嗅探字符集,GBK 与 UTF-8 页面都不会乱码
- **Docker Compose 部署** —— 一条命令,全部依赖打包好

## 本地快速开始

```bash
npm install
npm start          # 监听 http://localhost:3000(可用 PORT 环境变量修改)
```

在 macOS 上也可以双击 `start.command`。

静态页面开箱即用。如需转换 JS 渲染页面(React/Vue SPA),请安装
Camoufox 浏览器兜底:

```bash
python3 -m venv .venv
.venv/bin/pip install camoufox
.venv/bin/python -m camoufox fetch   # 浏览器下载到 ~/Library/Caches/camoufox
```

无需任何配置——当静态提取为空或看起来像 JS 壳时,服务会自动用无头
Firefox 渲染页面。没有 `.venv` 时,静态页面的一切功能不受影响。

## Docker Compose 部署

所有依赖(Node 22 + Python venv + Camoufox 浏览器 + Firefox 系统库)
都打进一个镜像:

```bash
docker compose up -d --build   # 首次构建约下载 500MB(含浏览器)
curl http://localhost:3000/example.com
docker compose logs -f         # 查看请求日志
docker compose down            # 停止
```

修改端口映射请编辑 `docker-compose.yml`(如 `"8080:3000"` 表示对外
8080 端口);容器内 `PORT` 保持 3000 即可。

## 使用方法

```
http://localhost:3000/https://example.com/article
http://localhost:3000/http://example.com/article
http://localhost:3000/example.com/article        (默认补 https)
```

示例:

```bash
curl "http://localhost:3000/http://www.scio.gov.cn/xwfb/dfxwfb/gssfbh/gx_13845/202509/t20250923_932502.html"
```

响应(`text/markdown`):

```
Title: 广西举行第22届中国—东盟博览会闭幕新闻发布会
URL Source: http://www.scio.gov.cn/...

Markdown Content:

中国—东盟博览会、中国—东盟商务与投资峰会指挥中心于2025年9月21日...
```

## 工作原理

1. **抓取**目标页面,使用浏览器 UA(30 秒超时,20MB 上限)。
2. **穿透 WAF** —— 在 `node:vm` 沙箱中执行 `__jsl_clearance` 挑战脚本,
   带上算出的 cookie 重试;通关 cookie 按域名缓存约 50 分钟。
3. **提取正文** —— Mozilla Readability(Firefox 阅读模式同款引擎),
   jsdom 嗅探字符集。
4. **识别 JS 壳** —— 静态提取失败、正文几乎为空(<100 字符)或文本密度
   过低(<600 字符且占 HTML 不到 5%)时,判定为 JS 渲染的 SPA。
5. **动态兜底** —— 可疑页面交给 `render.py`,用无头 Camoufox(真实
   Firefox 内核,执行页面 JS,自然等过 WAF 重载)渲染后,再对渲染出的
   DOM 跑 Readability。只有渲染结果文本更多时才采用;浏览器失败时仍
   返回静态结果。
6. **转换** —— 正文 HTML 经 Turndown 转为 Markdown 返回。

典型延迟:静态页面 1 秒以内;浏览器渲染页面约 5–15 秒。

## 测试

```bash
node smoke-test.js   # 在临时端口启动服务;检查静态路径,
                     # 若已安装 .venv 则一并检查 Camoufox 兜底
```

## 说明

- 仅支持 `http://` 与 `https://` 目标。
- WAF 求解在 `vm` 沙箱中执行远端挑战代码,无法接触宿主机——与
  cloudscraper 类工具同一思路。
- 每次动态渲染都会新起一个浏览器进程(约 200MB 内存),因此只作为
  兜底通道,而非默认路径。

## 致谢

- 本项目由 [Kimi K3](https://www.kimi.com/code/docs/en/) +
  [Kimi Code](https://code.kimi.com) 结对编程完成。
- 感谢 [Mozilla Readability](https://github.com/mozilla/readability)、
  [Turndown](https://github.com/mixmark-io/turndown) 与
  [Camoufox](https://github.com/daijro/camoufox)。
