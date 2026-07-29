# web2md

**[English →](README.md)**

一个轻量、可自托管的 [r.jina.ai](https://r.jina.ai) 风格 Reader 服务。
在任意 URL 前加上服务前缀,即可返回干净、AI 可直接使用的
Markdown——静态网页和 JS 渲染的 SPA 都支持(包括微信公众号文章)。

| 原始网页 | 转换后的 Markdown |
| --- | --- |
| ![原始网页](docs/images/original-page.jpg) | ![AI-ready Markdown 输出](docs/images/markdown-output.jpg) |

## 功能特性

- **与 r.jina.ai 相同的前缀用法** —— `http://localhost:3000/<url>` → `text/markdown`
- **静态页面亚秒级返回** —— Mozilla Readability 正文提取 + Turndown 转 Markdown
- **SPA / JS 渲染页面** —— 自动降级到真实无头浏览器([Camoufox](https://github.com/daijro/camoufox),反检测 Firefox 定制版)
- **WAF 穿透** —— 在沙箱中求解云盾 `__jsl_clearance` JS 挑战(国内政务网站常见),按域名缓存通关 cookie
- **编码安全** —— jsdom 嗅探字符集,GBK 与 UTF-8 页面都不会乱码
- **Docker Compose 部署** —— 一条命令,全部依赖打包好

## 项目结构

```
├── src/
│   ├── server.ts        # HTTP 服务:抓取、WAF 求解、正文提取、SPA 兜底
│   └── render.py        # Camoufox(无头 Firefox)渲染脚本
├── test/
│   └── smoke-test.ts    # 端到端冒烟测试(npm test)
├── docs/images/         # README 插图
├── Dockerfile           # 一体化镜像:Node 22 + Python + Camoufox 浏览器
├── docker-compose.yml
├── tsconfig.json
├── package.json
└── start.command        # macOS 双击启动器
```

## 本地快速开始

```bash
npm install
npm start          # 先编译 TypeScript,再监听 http://localhost:3000
```

`npm start` 会先自动执行 TypeScript 构建(`prestart` 钩子),保证运行的
始终是你刚改的代码。只构建不启动:`npm run build`。修改监听端口用
`PORT` 环境变量。

**macOS 快捷方式:** 在访达中双击 `start.command` —— 它会打开一个终端
窗口并替你执行 `npm start`(文件已带可执行权限提交,开箱即用)。

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
都打进一个镜像,包括 TypeScript 构建:

```bash
docker compose up -d --build   # 首次构建约下载 500MB(含浏览器)
curl http://localhost:3000/example.com
docker compose logs -f         # 查看请求日志
docker compose down            # 停止
```

修改端口映射请编辑 `docker-compose.yml`(如 `"8080:3000"` 表示对外
8080 端口);容器内 `PORT` 保持 3000 即可。

## 使用方法

**整个 API 只有一条规则:把目标 URL 拼在前缀后面。**

```
http://localhost:3000/https://example.com/article
http://localhost:3000/http://example.com/article
http://localhost:3000/example.com/article        (默认补 https)
```

转换页面并保存为 Markdown 文件:

```bash
curl -o article.md "http://localhost:3000/http://www.scio.gov.cn/xwfb/dfxwfb/gssfbh/gx_13845/202509/t20250923_932502.html"
```

响应为 `text/markdown`,开头是少量元信息,之后是正文:

```
Title: 广西举行第22届中国—东盟博览会闭幕新闻发布会
URL Source: http://www.scio.gov.cn/...

Markdown Content:

中国—东盟博览会、中国—东盟商务与投资峰会指挥中心于2025年9月21日...
```

不同类型页面的表现:

- **静态页面**(新闻、博客、文档、政务公告、微信公众号文章):1 秒
  以内返回。
- **云盾 WAF 后面的网站**(大量 `*.gov.cn`):首次访问需几秒求解 JS
  挑战,通关 cookie 缓存后,后续访问即秒回。
- **JS 渲染的 SPA**(HTML 只是空壳的 React/Vue 应用):自动用无头
  Firefox 重新渲染,每页约 5–15 秒。

替代 r.jina.ai:任何使用 `https://r.jina.ai/<url>` 的地方,换成
`http://localhost:3000/<url>` 即可。

错误以纯文本返回并带 HTTP 状态码:目标格式错误或非 http(s) 协议返回
`400`;目标无法抓取或无法解读(超时、站点故障、无正文)返回 `502`。

## 工作原理

1. **抓取**目标页面,使用浏览器 UA(30 秒超时,20MB 上限)。
2. **穿透 WAF** —— 在 `node:vm` 沙箱中执行 `__jsl_clearance` 挑战脚本,
   带上算出的 cookie 重试;通关 cookie 按域名缓存约 50 分钟。
3. **提取正文** —— Mozilla Readability(Firefox 阅读模式同款引擎),
   jsdom 嗅探字符集。
4. **识别 JS 壳** —— 静态提取失败、正文几乎为空(<100 字符)或文本密度
   过低(<600 字符且占 HTML 不到 5%)时,判定为 JS 渲染的 SPA。
5. **动态兜底** —— 可疑页面交给 `src/render.py`,用无头 Camoufox(真实
   Firefox 内核,执行页面 JS,自然等过 WAF 重载)渲染后,再对渲染出的
   DOM 跑 Readability。只有渲染结果文本更多时才采用;浏览器失败时仍
   返回静态结果。
6. **转换** —— 正文 HTML 经 Turndown 转为 Markdown 返回。

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
