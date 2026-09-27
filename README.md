# Full PDF Translate（PDF 全文翻译）

[![zotero target version](https://img.shields.io/badge/Zotero-7-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)

在 Zotero 内一键把整篇 PDF 翻译成**保留排版/公式/表格的双语对照 PDF**，使用**你自己的大模型 API Key**（OpenAI 兼容接口），本地运行翻译引擎，不依赖任何付费云服务。

定位：复现并开源替代 doc2x / 沉浸式翻译 Pro 等"整篇 PDF 翻译"能力。

## 功能

- **右键翻译**：选中条目（或直接选中 PDF 附件）→ 右键 →「翻译整篇 PDF」；也可以对整个分类右键批量翻译
- **双语 + 译文 PDF**：由 [pdf2zh_next](https://github.com/PDFMathTranslate/PDFMathTranslate-next)（BabelDOC 内核）本地生成，版面、公式、表格保留
- **自带 Key、多套服务配置**：内置智谱 GLM / DeepSeek / 阿里 Qwen / Kimi / SiliconFlow / OpenAI / Gemini / Ollama 预设，也可填任意 OpenAI 兼容端点；多套配置随时切换，支持"测试连接"
- **预设模式（开箱即用）**：
  - ⚡ 快速预览：高并发、省 token
  - 📖 论文精读：自动术语表、低并发
  - 🗂 扫描件：自动 OCR 兼容
  - ⚙ 自定义：完全自己调
- **高度自定义**：源/目标语言、页码范围、输出（双语/译文/两者）、QPS 与并发、自定义 System Prompt、术语表 CSV、水印开关、完成后自动打开等
- **自动挂回**：翻译完成后自动作为附件挂到原条目下，可自动打开

## 安装（自用版）

1. 安装 [Zotero 7](https://www.zotero.org/)（兼容 8）
2. 工具 → 插件 → 齿轮 → Install Plugin From File…，选择 `full-pdf-translate.xpi`（构建产物在 `.scaffold/build/`）
3. 打开插件设置：
   - **服务配置**：新建一个服务（如智谱 GLM），填 API Key 和模型，点「测试连接」，然后保存
   - **翻译引擎**：点「下载引擎」自动下载 pdf2zh_next 便携版（约 1~2 GB，仅首次；Windows 10/11 自带 curl/tar，无需 Python）
4. 选中条目右键 →「翻译整篇 PDF（双语）」

> 提示：如果引擎无法启动，多半缺 VC++ 运行库：https://aka.ms/vs/17/release/vc_redist.x64.exe
> 国内下载慢可在设置里填镜像前缀（如 `https://ghproxy.net/`）。

## 开发

```bash
npm install
npm run build     # 构建 XPI 到 .scaffold/build/
npm start         # 开发模式（需先复制 .env.example 为 .env 指定 Zotero 路径）
```

架构一句话：Zotero 7 插件（TypeScript）通过 `Subprocess` 启动 `pdf2zh_next.exe` 子进程（API Key 走 `PDF2ZH_*` 环境变量，不进命令行），产出 mono/dual PDF 后用 `Zotero.Attachments.importFromFile` 挂回条目。

```
src/
  hooks.ts               生命周期
  modules/
    engine.ts            引擎检测 / 下载(curl+tar) / 解压 / 手动指定
    runner.ts            组装 pdf2zh_next 命令行并执行、收集输出
    queue.ts             翻译任务队列（顺序执行、进度通知、失败提示）
    profiles.ts          服务配置与预设服务商、连通性测试
    presets.ts           预设模式参数包
    items.ts             从条目/分类收集 PDF 附件
    attach.ts            结果 PDF 挂载与命名
    menus.ts             右键菜单注册
    prefsUI.ts           偏好页交互
addon/                   manifest / prefs.js / 偏好页 / 中英文案
```

## 已知限制

- Windows 上开箱即用（便携 exe）；macOS/Linux 需自行 `uv tool install pdf2zh-next` 后在设置中指定可执行文件
- 扫描版 PDF 仅有 OCR 兼容模式兜底，复杂扫描件效果不如 doc2x 的云端 OCR
- 暂不导出 Word/Markdown（pdf2zh_next 仅输出 PDF）；后续可评估接 MinerU 做解析导出
- 每页约消耗数千 token，批量翻译大分类前建议先用「页码范围」小规模试跑

## 许可

AGPL-3.0-or-later（与依赖的 pdf2zh_next / BabelDOC 一致）。本插件不分发引擎二进制，仅引导从官方 Release 下载。

致谢：[PDFMathTranslate-next](https://github.com/PDFMathTranslate/PDFMathTranslate-next) · [BabelDOC](https://github.com/funstory-ai/BabelDOC) · [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template)（本插件基于该模板开发）· 参考实现 [UB-Mannheim/zotero-ocr](https://github.com/UB-Mannheim/zotero-ocr) 与 [guaguastandup/zotero-pdf2zh](https://github.com/guaguastandup/zotero-pdf2zh)。
