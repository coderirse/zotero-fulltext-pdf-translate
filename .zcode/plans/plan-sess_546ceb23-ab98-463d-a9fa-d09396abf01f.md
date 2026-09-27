# Zotero 全文翻译插件（复现 doc2x）执行计划

## 一、调研结论（为什么不从零做、复用什么）

**难点不在插件壳，而在"保留版面/公式/表格的 PDF 翻译引擎"**——它依赖本地版面分析 ML 模型，纯 JS 插件无法实现。因此：引擎 100% 复用开源，插件全新开发。

**引擎选型（已核实 2026-09 现状）：pdf2zh_next**（PDFMathTranslate-next，BabelDOC 内核，AGPL-3.0，活跃维护）

- 任意 OpenAI 兼容端点：`--openai --openai-base-url / --openai-api-key / --openai-model`，通用引擎 `--openaicompatible`
- 默认同时输出 **单语 PDF + 双语(dual) PDF**，保留公式/表格/版面
- 支持 `PDF2ZH_*` 环境变量传密钥（不进命令行）、`--watermark-output-mode no_watermark`（⚠ 默认有水印必须显式关）、`--pages`、`--qps`、`--pool-max-workers`、`--custom-system-prompt`、`--glossaries`、翻译缓存（重试成本低）
- Windows 便携版：`pdf2zh-*-with-assets-win64.zip`（发布于 Byaidu/PDFMathTranslate releases，内含 `pdf2zh_next.exe`，自带字体+版面模型，**免 Python**）

**现有插件均不满足需求，故新建：**

- guaguastandup/zotero-pdf2zh（6.9k★）：功能最全，但要手动装 Python 3.12+uv 后端且保持终端开启；项目正在重写、v4 已停止答疑 → 可先装来应急用
- study-233/zotero-pdf2zh-pro（2★/6 周）：带一键安装器但太新、不可托付
- doc2x 官方插件 / 沉浸式翻译 / FanyiPaiban / MagicZotero：闭源或付费云服务
- windingwind/zotero-pdf-translate（11.9k★）：只有划词/批注翻译，无整篇 PDF

**开发范式参考：** UB-Mannheim/zotero-ocr（右键 → Subprocess 调外部程序 → importFromFile 挂回附件的完整单文件实现）、zotero-pdf2zh（配置管理/进度/命名）。

## 二、产品定义

- 技术栈：TypeScript + windingwind/zotero-plugin-template（Node ≥22，热重载开发），目标 Zotero 7（manifest 兼容 8），Windows 优先
- 名称/ID：开发期定，需避开 windingwind/zotero-pdf-translate 重名（建议如 `zotero-fulltext-pdf-translate`）

### 功能清单

1. **服务配置 profiles**（可存多套、随时切换）：预设服务一键填好 base URL——智谱 GLM、DeepSeek、阿里 Qwen/DashScope、Kimi（走 OpenAICompatible）、SiliconFlow、OpenAI、Gemini、Ollama 本地、自定义 OpenAI 兼容；每套含 base URL + API Key + 模型名（可拉取模型列表）+ "测试连接"按钮
2. **预设模式**（一键切换的参数包，开箱即用）：
   - ⚡ 快速预览：快模型 + 高并发（qps 8 / pool 16）+ 双语 PDF
   - 📖 论文精读：强模型 + 自动术语表提取 + 低并发（qps 2 / pool 4）+ 双语
   - 🗂 扫描件兜底：`--auto-enable-ocr-workaround`（仅开关，不重做 OCR 管线）
   - ⚙ 自定义：暴露全部高级参数
3. **高级设置**：目标语言（默认 zh-CN）、输出 mono/dual/both、页码范围、水印默认关、缓存开关、自定义 system prompt、术语表 CSV、字体主族、并发/限速
4. **批量与队列**：条目/分类右键"翻译 PDF"→ 任务队列（Zotero.ProgressQueue，重启可恢复）→ 失败重试
5. **结果处理**：mono/dual PDF 自动 `Zotero.Attachments.importFromFile` 挂回条目（命名如 `标题.zh.bilingual.pdf`）+ ProgressWindow 通知 + 可选自动打开
6. **引擎管理**：首次使用引导——下载便携版 zip 到 `<Zotero 数据目录>\pdf-translate\engine\`（支持镜像加速/手动导入 zip/直接指定已有 exe 路径），缺 VC++ 运行库时给出提示链接

## 三、技术架构

```
src/
  hooks.ts            启动/关闭、菜单注册
  modules/
    engine.ts         引擎检测/下载/解压/版本管理
    queue.ts          任务队列（受控并发、状态持久化）
    runner.ts         Subprocess 调用 pdf2zh_next.exe
    profiles.ts       服务配置 × 预设模式 → 参数合成
    attach.ts         结果挂载/命名/通知
  prefs.xhtml/.js      偏好页（Zotero.PreferencePanes.register）
addon/                manifest.json、prefs.js(默认值)、locale/zh-CN|en-US/*.ftl
```

子进程调用（API 已核实自 Zotero/Gecko 源码）：

- `ChromeUtils.defineESModuleGetters(window, { Subprocess: "resource://gre/modules/Subprocess.sys.mjs" })`
- `Subprocess.call({ command: exe绝对路径, arguments: [数组传参避免引号问题], environment: { PDF2ZH_OPENAI_API_KEY... }, environmentAppend: true, workdir, stderr: "stdout" })`
- 循环 `await proc.stdout.readString()` 解析进度；`await proc.wait()` 后检查 exitCode
- 命令示例：`pdf2zh_next.exe in.pdf --output out --lang-in en --lang-out zh-CN --watermark-output-mode no_watermark --openai --openai-model glm-4.6 --qps 4 --pool-max-workers 4 [--pages 1-5]`
- 挂载：`Zotero.Attachments.importFromFile({ file, parentItemID, title, contentType: "application/pdf" })`
- 菜单：`zotero-itemmenu` / `zotero-collectionmenu` + popupshowing 过滤（选中项含 PDF 附件才显示）
- 分发：XPI 免签名；GitHub Releases + update.json 自动更新（scaffold 自动生成）

## 四、里程碑（每步可独立验证，合计约 2~3 周业余时间）

- **M0（0.5 天）脚手架**：git init → clone 模板 → `npm install` → `npm start` 热重载跑通 Hello World（如本机无 Node 22 先装）
- **M1（2~3 天）偏好页 + 服务 profiles**：预设服务清单、profile 增删改、测试连接按钮
- **M2（3~5 天）核心链路**：引擎下载/管理 + 单条目右键翻译全链路（选 PDF → 子进程 → mono/dual 输出 → 挂回附件 → 通知），用真实 PDF + 你的 GLM key 端到端验证
- **M3（2~3 天）队列与批量**：多选/分类右键、ProgressQueue、并发控制、失败重试、任务历史
- **M4（2~3 天）预设模式 + 高级参数**：四个模式、prompt/术语表/页码范围/字体 UI
- **M5（1~2 天）打磨发布**：中英 i18n、README（中文为主）、打包 XPI、GitHub Release + update.json

**风险与对策**

- AGPL-3.0（引擎）：插件同样以 AGPL 开源即可；不分发引擎二进制，只引导下载官方 zip（自用无任何限制）
- 引擎 zip 较大（含模型约 1~2GB）：支持镜像/手动导入，一次下载长期使用
- `pdf2zh_next.exe` 的发布位置在 v1 仓库 releases（官方文档指路）：M2 时核实最新版本，下载地址做成可配置
- 扫描件弱：v1 仅 OCR workaround 开关（已确认够用）；Word/Markdown 导出 v1 不做，v2 再评估（MinerU 前置解析）

## 五、开工动作

1. 初始化 git 仓库 + 脚手架（M0）
2. 可选并行：先安装 guaguastandup/zotero-pdf2zh 配上自己的 key 应急使用
