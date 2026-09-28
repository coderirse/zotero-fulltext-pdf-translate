# Zotero Full PDF Translate —— 全面代码审查报告（v0.2.3）

审查对象：`zotero_pdf_translate`（HEAD = `7d2f235`，工作区仅 1 个未跟踪文件
`.zcodeignore`）
代码规模：TS 约 2,200 行（`src/**` 17 个文件）+ `addon/**` 资源 + 1 个 Python 合并脚本
审查方式：全量通读 + 与 `doc/code-review-0.2.1.md` 逐项比对修复状态 + 实际执行
`tsc` / `eslint` / `prettier`

---

## 0. 总体结论

**架构判断维持上轮结论：合理。** 插件壳与外挂引擎解耦干净，v0.2.2/v0.2.3 的两个
关键修复（任务工作目录迁出系统临时目录以规避 v1 引擎删除输入文件；jar: 安装下
运行时提取 side_by_side.py）经核对**实现正确、注释清楚**。仓库卫生明显改善
（XPI 与 `.zcode` 计划移出跟踪，审查文档归档到 `doc/`）。

**工程判断：上轮报告的 2 个 P1 和大部分 P2 问题仍未修复**，v0.2.2→v0.2.3 的
开发重心在功能（双引擎、拼版、诊断），缺陷修复清单基本没有动。本轮另发现
4 个新问题，其中最重要的是**子进程 stdout 无上限内存累积**和**失败路径的
工作目录泄漏只修了一半**。

实测结果（全部通过）：

| 检查     | 命令                 | 结果        |
| -------- | -------------------- | ----------- |
| 类型检查 | `npx tsc --noEmit`   | ✅ exit 0   |
| Lint     | `npx eslint .`       | ✅ exit 0   |
| 格式     | `prettier --check .` | ✅ 全部符合 |

问题计数：**未修复的存量问题 15 项（含 2 个 P1）· 本轮新增 6 项 · 已验证正确若干**

---

## 1. 上轮（0.2.1）问题修复状态核对

| 上轮编号 | 问题                                            | 状态        | 本轮说明                                                                                                                                                                       |
| -------- | ----------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1-1     | 失败时临时目录泄漏                              | 🟡 半修复   | 见新发现 N2：失败路径仍泄漏，只是从"永久"降为"重启前"                                                                                                                          |
| P1-2     | 插件关闭后队列继续跑、新进程无人管              | ❌ 未修复   | 逐行核实 `queue.ts:70-82`、`hooks.ts:192-218`，代码原样                                                                                                                        |
| P1-3     | 引擎下载无完整性校验                            | ❌ 未修复   | `engine.ts` 全文无 digest/sha256 逻辑                                                                                                                                          |
| P2-1     | 任务运行中去重失效（同一 PDF 重复翻译重复计费） | ❌ 未修复   | `queue.ts:76` 仍在 shift 后立即 `queued.delete`                                                                                                                                |
| P2-2     | 队列无取消/暂停出口                             | ❌ 未修复   | 菜单仍只有"翻译"两项                                                                                                                                                           |
| P2-3     | tar 缺失不走 PowerShell 兜底 + 引号注入面       | ❌ 未修复   | `engine.ts:225-241` 原样                                                                                                                                                       |
| P2-4     | 引擎下载无并发保护（双 521MB 下载互相踩踏）     | ❌ 未修复   | `downloadEngine` 仍无单飞                                                                                                                                                      |
| P2-5     | `detectEngine` 每任务全树递归扫描               | ❌ 未修复   | `findManagedEngine` 仍两遍递归扫 site-packages                                                                                                                                 |
| P2-6     | 多窗口菜单清理未实现                            | ❌ 未修复   | `hooks.ts:181-184` 注释原样，前提（单窗口）在 Zotero 不成立                                                                                                                    |
| P2-7     | 服务配置无 URL 校验，Key 可发往 http 明文端点   | ❌ 未修复   | `prefsUI.ts:182-210` 仍只查非空                                                                                                                                                |
| P2-8     | 测试覆盖≈0                                      | ❌ 未修复   | `test/startup.test.ts` 仍 8 行                                                                                                                                                 |
| P3-1     | `pref-engine-browse` 只取 value 得到字面量键名  | ❌ 未修复   | `engine.ts:285`，FTL 里该消息仍只有 `.label`                                                                                                                                   |
| P3-2     | `output=mono` 时白跑一次全量拼版合并            | ❌ 未修复   | `runner.ts:208` 条件仍缺 `output !== "mono"`                                                                                                                                   |
| P3-3     | `getActiveProfile` 静默回退 `profiles[0]`       | ❌ 未修复   | `profiles.ts:98-102`                                                                                                                                                           |
| P3-4     | `engine-exe-not-found` 文案与实际安装的引擎不符 | ❌ 未修复   | 自动下载装的是 v1 `pdf2zh.exe`，中英文案仍说 pdf2zh_next.exe                                                                                                                   |
| P3-5     | 分类右键菜单无显隐控制                          | ❌ 未修复   | `menus.ts:32-43`                                                                                                                                                               |
| P3-6     | 调试日志打印完整参数表（含提示词全文）          | ❌ 未修复   | `runner.ts:148-150`                                                                                                                                                            |
| P3-7     | 每窗口重建 ztoolkit 实例                        | ❌ 未修复   | `hooks.ts:172`                                                                                                                                                                 |
| P3-8     | 模板死代码                                      | ❌ 未修复   | `isWindowAlive`/`clearPref`/`getLocaleID`/`MyToolkit`/`mainWindow-ready`/`zoteroPane.css` 均在，`no-unused-vars` 仍全局关闭                                                    |
| P3-9     | 仓库卫生                                        | 🟡 大半修复 | ✅ XPI、`.zcode` 计划已移出跟踪；❌ `doc/README-frFR.md`、`doc/README-zhCN.md`（上游模板 README）仍在库中；❌ dependabot 与 renovate 仍同时启用；❌ CI 仍引用 `@main` 浮动分支 |

---

## 2. 本轮新发现问题

### N1（P2）子进程 stdout 在内存里无上限累积

- 位置：`src/utils/subprocess.ts:43-52`
- 事实：`stdout += chunk` 把引擎**全部输出**累积在内存里，直到进程结束才一次性
  写盘（`runner.ts:180`）。上轮只指出磁盘上的 `engine.log` 可能巨大，内存侧同源：
  长文档 + 详细输出的翻译跑上几小时，Zotero 主进程内存会持续上涨，极端时
  数百 MB。批量翻译 N 篇则逐篇峰值累加。
- 建议：读循环里直接把 chunk 流式追加写入 `engine.log`（`IOUtils.writeUTF8`
  不支持追加，可换 `IOUtils.open`/OS.File 句柄，或分段 `writeUTF8` 到临时文件
  再拼接），内存里只保留一个 600 字符的滚动 tail 供错误报告。

### N2（P2）失败路径的工作目录泄漏只修了一半

- 位置：`src/modules/runner.ts:117-127`（创建）、`src/modules/queue.ts:110-119`
  与 `174-176`（清理）
- 事实：`runTask` 里 `workDir = outputs.workDir` 仍只在 `runTranslation`
  **成功返回后**才赋值。引擎非 0 退出（`runner.ts:188`）、无输出
  （`runner.ts:200`）、spawn 失败（`runner.ts:164`）这三种失败路径都不把
  `workDir` 交回调用方 → `finally` 里 `cleanupWorkDir` 被跳过。上轮把目录
  迁到 `<数据目录>/fullpdf/tmp` 并加了启动清理，所以泄漏从"永久"降为
  "重启前"——但一个配错 Key 的批量任务仍会在会话内每篇留一份完整 PDF 副本
  - 日志，直到下次重启 Zotero。
- 建议：按上轮方案在 `runTranslation` 内部包 try/catch，失败即回收
  （"谁创建谁负责"），约 10 行。

### N3（P2）应用退出时 `onShutdown` 根本不执行，引擎进程孤儿化

- 位置：`addon/bootstrap.js:45-48`
- 事实：`shutdown()` 在 `reason === APP_SHUTDOWN` 时直接 return（模板默认）。
  这意味着用户**关闭 Zotero**（而非禁用插件）时，`hooks.onShutdown` 不会运行：
  正在翻译的引擎进程不会被 kill。Windows 上父进程退出**不会**连带终止子进程，
  pdf2zh 会继续把这篇翻完（继续消耗 API token），其输出目录则会在下次启动时
  被 `cleanupStaleWorkDirs` 整树删除。与 P1-2（禁用/更新场景队列停不下来）
  是同一生命周期主题的两半。
- 建议：把"停队列 + 杀进程"提前到 `shutdown()` 里、在 APP_SHUTDOWN 早退
  **之前**无条件执行（杀进程是幂等的，多做一次没有代价）。

### N4（P2）手工指定引擎路径时按文件名猜引擎类型，猜错则参数集完全错位

- 位置：`src/modules/engine.ts:56-58`、`86-95`
- 事实：`kindOf()` 只认**文件名以 `pdf2zh_next.exe` 结尾**为 v2，其余一律按
  v1 处理。两条路径会触发误判：
  1. 用户把 v2 引擎改名/拷贝为别的名字（如 `pdf2zh_next2.exe`、放在桌面
     重命名过）→ 插件用 v1 的参数表（`--service openailiked` 等）去调 v2
     引擎，v2 直接 argparse 报错，用户看到的是无从下手的原始输出；
  2. 反过来，v1 引擎若被重命名为 `pdf2zh_next.exe` 则反向错位。
- 建议：不做文件名猜测，改为启动引擎前做一次轻量能力探测（`--help` 输出里
  v2 独有的 `--watermark-output-mode` 等旗标），或至少在手工指定路径时让
  用户显式选择引擎类型（偏好页加一个 v1/v2 选择器，文件选择只负责选路径）。

### N5（P3）`getProfiles` 对畸形数据校验不足

- 位置：`src/modules/profiles.ts:79-92`
- 事实：只校验 `id`/`name` 是字符串；`baseUrl`/`apiKey`/`model` 类型不查。
  偏好存储被手工编辑或半截 JSON 损坏时，`profile.baseUrl.replace(...)` 在
  `runTranslation` 里抛 TypeError，任务失败信息完全不可读。
- 建议：filter 里补齐 4 个字段的 `typeof === "string"` 校验。

### N6（P3）渲染函数里写偏好（副作用）

- 位置：`src/modules/prefsUI.ts:158-165`
- 事实：`renderActiveProfileMenu` 在"渲染"过程中执行
  `setPref("activeProfileId", profiles[0].id)`。打开一次设置页就会把激活
  服务改写为列表第一项——若用户之前选中的 profile 已被删除，这是隐式迁移；
  若只是 UI 重建（Zotero 的 `_refreshPreferences()` 会强制重载已打开的偏好
  窗口），则会**覆盖用户当前选择**。
- 建议：把"激活项失效时的迁移"收敛到 `deleteSelectedProfile` 一处，渲染函数
  保持只读。

---

## 3. 本轮确认"仍然正确/做得好"的点

1. **v0.2.2 两个关键修复实现正确**：
   - `runner.ts:117-127` 工作目录迁到 `<数据目录>/fullpdf/tmp/<taskId>`，注释
     完整记录了 v1 引擎 `high_level.py` 删输入文件的根因，这是排障后写对的
     修复；
   - `mergeSideBySide`（`runner.ts:244-257`）对 jar: 安装用
     `getContentsFromURL` 运行时取脚本，配 `startup` 里的 `scriptRead`
     探针自检，闭环完整。
2. **curl 卡死检测 + 镜像回退链**（`--speed-time 30 --speed-limit 10240`，
   直连 → gh-proxy.com → ghproxy.net）与实测网络数据吻合。
3. **静态检查全绿**：`tsc --noEmit`、`eslint`、`prettier --check` 全部通过
   （上轮末尾提到的 hooks.ts 格式漂移已不存在）。
4. **仓库卫生改善**：XPI、`.zcode` 计划已移出版本库；上轮审查文档归档到
   `doc/`。`.zcodeignore` 目前未跟踪，建议直接加入 `.gitignore`（本地工具
   配置，不属于仓库）。
5. **FTL 键结构完整**：en-US / zh-CN 键仍然对齐；XHTML 里 `data-l10n-id`
   与类型定义一致。

---

## 4. 建议的修复顺序

结合上轮遗留与本轮新增，按"用户损失 × 触发概率 ÷ 工作量"排序：

| 顺序 | 事项                                                                                                                                                                                                                                              | 预计工作量 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1    | 队列生命周期（存量 P1-2 + 新 N3）：`stop()` 接入 shutdown、循环内查 `alive`、bootstrap 在 APP_SHUTDOWN 早退前也执行清理                                                                                                                           | ~20 行     |
| 2    | 失败即回收 workDir（存量 P1-1 剩余一半 + 新 N2）                                                                                                                                                                                                  | ~10 行     |
| 3    | 运行中去重延后到任务结束（存量 P2-1，防重复计费）                                                                                                                                                                                                 | ~5 行      |
| 4    | stdout 流式写盘 + 滚动 tail（新 N1）                                                                                                                                                                                                              | ~30 行     |
| 5    | 下载 sha256 校验（存量 P1-3，GitHub API 已返回 digest）+ 下载单飞（P2-4）                                                                                                                                                                         | ~50 行     |
| 6    | 引擎类型探测替代文件名猜测（新 N4）                                                                                                                                                                                                               | 半天       |
| 7    | 引擎检测缓存（P2-5）；tar/PowerShell 兜底修复（P2-3）                                                                                                                                                                                             | ~40 行     |
| 8    | 服务 URL 校验 + 明文 http 告警（P2-7）；`getProfiles` 字段校验（新 N5）                                                                                                                                                                           | ~25 行     |
| 9    | 文案修正：`getString("pref-engine-browse", "label")`、`engine-exe-not-found` 等引擎相关 FTL 全面对齐实际引擎类型（P3-1/P3-4）                                                                                                                     | 15 分钟    |
| 10   | `output=mono` 时跳过拼版（P3-2）；渲染副作用收敛（新 N6）                                                                                                                                                                                         | ~10 行     |
| 11   | 纯函数单测基线 + CI 无 Zotero 的 unit job（P2-8）                                                                                                                                                                                                 | 半天       |
| 12   | 清理项：取消菜单（P2-2）、多窗口菜单清理（P2-6）、静默回退告警（P3-3）、分类菜单显隐（P3-5）、调试日志截断（P3-6）、ztoolkit 复用（P3-7）、死代码（P3-8）、CI 钉 SHA、dependabot/renovate 二选一、删 doc 模板 README、`.zcodeignore` 入 gitignore | 1-2 小时   |

**一句话总结**：v0.2.2/v0.2.3 的功能修复质量是高的（两处关键修复都对且注释
到位），静态检查全绿；但 0.2.1 审查指出的"失败与退出路径"系统性薄弱问题
一个都没有修，本轮又补了内存累积与引擎误判两个新洞。下个版本建议把功能
开发暂停一个周期，按上表 1-9 把失败/退出/下载这三条路径补齐。
