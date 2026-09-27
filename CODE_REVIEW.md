# Zotero Full PDF Translate —— 全面代码审查报告

审查对象：`zotero_pdf_translate`（HEAD = `0408c66`，工作区含 1 个未跟踪文件 `.tmp_decode.py`）
代码规模：TS/JS 约 1,350 行（`src/**` 12 个文件）+ `addon/**` 资源 + 1 个 Python 脚本
审查方式：全量人工通读 + 实际执行构建/静态检查 + 上游引擎源码与 Release API 交叉验证

---

## 0. 总体结论

**架构判断：合理。** 插件壳（Zotero 生命周期 / 右键菜单 / 偏好页 / 队列 / 附件挂回）与"重活"（版面还原的 PDF 翻译引擎）解耦干净，引擎以子进程方式外挂、API Key 走环境变量而非命令行、失败降级路径（镜像 / tar → PowerShell / side-by-side → stacked）都有考虑。安全边界（不打包引擎二进制、AGPL 一致性、Windows 优先）在 README 里交代清楚。

**工程质量判断：能跑通，但"失败路径 + 生命周期"是系统性薄弱环节。** 快乐路径（一次成功翻译）写得比较扎实；一旦出错、被重复点击、或在任务运行中关闭插件，就会出现**临时目录泄漏、重复翻译、进程失控**这三类问题。此外存在 1 个已确认的用户可见缺陷（i18n）、1 处"注释承诺了代码没做的事"（tar 缺失时不会降级）、以及 1 个需要正视的供应链完整性缺口（下载引擎不做校验）。

**实测结果（全部通过，无可挑剔）：**

| 检查     | 命令                       | 结果              |
| -------- | -------------------------- | ----------------- |
| 类型检查 | `npx tsc --noEmit`         | ✅ exit 0         |
| Lint     | `npx eslint .`             | ✅ exit 0         |
| 格式     | `npx prettier --check .`   | ✅ 全部符合       |
| 完整构建 | `npm run build`            | ✅ 0.35s 产出 XPI |
| 文本编码 | 全仓库 UTF-8 / 无 BOM / LF | ✅ 一致           |

问题计数：**P1 高风险 3 项 · P2 中风险 8 项 · P3 低风险/清理 9 项 · 已验证正确 12 项**

---

## 1. P1 —— 高风险问题（建议优先修）

### P1-1 翻译失败时临时工作目录永久泄漏（每个失败的 PDF 都留一份完整副本）

- 位置：`src/modules/runner.ts:113-127`（创建）、`src/modules/queue.ts:110`、`119`、`174-176`（清理）
- 代码事实：

```ts
// queue.ts
let workDir: string | null = null;
try {
  const engine = await ensureEngine(onProgress);
  const outputs = await runTranslation({ ... });   // ← 这里抛错，workDir 永远是 null
  workDir = outputs.workDir;
  ...
} finally {
  if (workDir) void cleanupWorkDir(workDir);       // ← 于是清理被跳过
}
```

`runner.ts` 在**进入翻译流程之前**就已经把原件复制到临时目录并建好 `out/`：

```ts
const workDir = PathUtils.join(
  Zotero.getTempDirectory().path,
  config.addonRef,
  taskId,
);
await IOUtils.makeDirectory(workDir, { createAncestors: true });
const inputFile = PathUtils.join(workDir, "input.pdf");
await IOUtils.copy(filePath, inputFile); // 原件整份复制
```

而 `runTranslation` 的失败路径（引擎非 0 退出 `runner.ts:183`、无输出 `runner.ts:195`、`spawnSubprocess` 抛错 `runner.ts:159`）**都不会把 `workDir` 交回调用方**。

- 触发场景：任意一次失败翻译（欠费、Key 错、网络断、VC++ 缺失、扫描件报错）。用户重试 5 次 → 临时目录里躺着 5 份 input.pdf + engine.log + 半成品 out/。论文 PDF 常见 10–50 MB，扫描件可上百 MB。长期使用会静默吃掉磁盘。
- 附加：`runner.ts:175` 会把**引擎全部 stdout** 写进 `engine.log`（长文档可达成百 MB）。
- 修复（最小改动，放 `runner.ts`，让"谁创建谁负责"）：

```ts
// runTranslation 内部，创建完 workDir 后包一层
try {
  ...  // 原函数体（spawn / 取输出 / side-by-side）
  return outputs;
} catch (e) {
  await cleanupWorkDir(workDir);   // 失败即回收，成功则由 queue 回收
  throw e;
}
```

- 建议再加一道保险：启动时清理 `Zotero.getTempDirectory()/fullpdf/*` 下超过 24h 的历史目录（覆盖 Zotero 崩溃残留）。

### P1-2 插件关闭后队列不会停：继续启动新翻译进程，且这些进程再也不会被 kill

- 位置：`src/modules/queue.ts:70-82`（`pump` 循环）、`src/hooks.ts:64-77`（`onShutdown`）
- 代码事实：

```ts
private async pump(): Promise<void> {
  if (this.running || !addon.data.alive) return;   // ← alive 只在"进入时"检查一次
  this.running = true;
  try {
    while (this.tasks.length) {                    // ← 循环体内不再检查 alive
      const task = this.tasks.shift()!;
      await this.runTask(task);
    }
  } finally { this.running = false; }
}
```

`onShutdown()` 只做三件事：注销偏好面板、`addon.data.currentProc?.kill()`、`ztoolkit.unregisterAll()`。
**没有任何代码把 `alive=false` 传播给队列**：正在跑的 `while` 循环会继续 shift 下一个任务，调用 `ensureEngine`/`runTranslation` 启动**新的引擎进程**；而 `onShutdown` 里的 kill 早已执行完毕，新进程的句柄虽然写进了 `addon.data.currentProc`，却再也没人读它。

- 触发场景：加入 10 篇批量翻译 → 关闭/更新/禁用插件 → 后台仍在逐篇启动引擎进程，不可见、不可停，只能杀 Zotero。
- 附带影响：此时 `ztoolkit.unregisterAll()` 已执行，`queue.ts:85` 再 `new ztoolkit.ProgressWindow(...)`，UI 注册表已清空，属于对已注销工具集的操作。
- 修复：

```ts
// hooks.ts
import { translateQueue } from "./modules/queue";
...
translateQueue.stop();            // 在 onShutdown 最前面

// queue.ts
stop(): void {
  this.tasks = [];
  this.queued.clear();
  addon.data.currentProc?.kill();
}
// pump 循环内同样兜底：
while (this.tasks.length && addon.data.alive) { ... }
```

### P1-3 下载的引擎压缩包无任何完整性校验，且会被直接执行、并注入用户 API Key

- 位置：`src/modules/engine.ts:137-153`（取 URL）、`155-187`（下载）、`203-205`（镜像列表）、`225-241`（解压）、`runner.ts:150-158`（以用户身份执行）
- 代码事实：整条链路**只校验"curl 退出码为 0"**，不校验大小、哈希、签名；`downloadEngine` 会把 `https://gh-proxy.com/`、`https://ghproxy.net/` 两个第三方镜像**自动**加入候选（`MIRROR_PREFIXES`），并且还接受用户自定义任意前缀（`downloadURLPrefix`）。随后：

```ts
extract = await runSubprocess({ command: "...\\tar.exe", arguments: ["-xf", zipPath, "-C", unzipDir] });
...
handle = await spawnSubprocess({
  command: engine.path,                       // 刚解压出来的 exe
  environment: { PDF2ZH_OPENAI_API_KEY: profile.apiKey, ... },   // 用户的 Key
  workdir: engineDir,
});
```

- **重要发现（好消息）**：GitHub Release API 对 `pdf2zh-v1.9.11-with-assets-win64.zip` 已经返回了官方 sha256：
  `sha256:fe513c3b95c9acb2609ce53240962c4a7e073fa13910af0f207956c7b3258c76`。
  也就是说"不校验"是**当前就能补上的**，不需要额外基础设施：
  - `resolveDownloadUrl()` 里顺手把 `asset.digest` 一起取回来；
  - 下载完成后用 `crypto.subtle`（Gecko 内置 `crypto`）算 sha256 比对，不匹配就直接删包报错；
  - 直连 GitHub 时校验官方 digest；**只有走镜像时才必须校验**（这恰好是风险最高的路径）。
- 风险等级判定：需要镜像方作恶或被劫持才能触发，属于"有条件可利用"。但触发条件相当现实——该插件面向中文用户，而"直连 GitHub 失败"（正是镜像存在的理由）在这类网络里是常态，因此镜像在有问题的网络下会成为**主路径**而非兜底路径。一旦命中，攻击者得到的是：以用户权限执行的任意程序 + 用户的大模型 API Key + 可读取该用户全部本地文件。我给 **P1**。
- 修复：按上面的 digest 校验；或（更保守）把镜像改为**用户显式勾选**才启用，并默认只信 GitHub 直连。

---

## 2. P2 —— 中风险问题

### P2-1 运行中的任务没有去重：同一篇 PDF 会被翻译两次

- 位置：`src/modules/queue.ts:47-56`（入队去重）、`75-78`（出队）、`126-151`（挂附件）
- 代码事实：`this.queued` 在任务**被 shift 的瞬间**就被删除：

```ts
while (this.tasks.length) {
  const task = this.tasks.shift()!;
  this.queued.delete(task.sourceId); // ← 任务还在跑，去重标记已经没了
  await this.runTask(task);
}
```

- 触发场景：右键一篇大文件 → 等得不耐烦，又右键一次（或顺手框选多选一起点）→ 同一 `sourceId` 再次入队 → 同一篇被翻译两遍、生成两套附件、白付两遍 token。
- 修复：把 `queued.delete()` 挪到 `runTask` 的 `finally`；或另设 `running: Set<number>`，`enqueue` 同时检查两个集合。

### P2-2 队列无法取消 / 无法暂停

- 位置：全仓库只有 `hooks.ts:74` 一处 `kill()`（即只在关闭插件时杀进程）
- 事实：加错了一整个分类、或发现 Key 配错时，用户只能等它跑完或杀掉 Zotero。README 承诺"批量翻译大分类前建议先用页码范围小规模试跑"，反过来说明确实缺一个"取消"出口。
- 修复：右键菜单加"取消当前翻译/清空队列"；`stop()` 见 P1-2。

### P2-3 引擎解压的 PowerShell 兜底路径有引号注入/健壮性缺陷，且"缺失时不兜底"

- 位置：`src/modules/engine.ts:229-241`
- 两个独立问题：
  1. **单引号未转义**：`Expand-Archive -LiteralPath '${zipPath}' ...`，`zipPath`/`unzipDir` 来自 `Zotero.DataDirectory.dir`。Windows 用户名带单引号（如 `O'Brien`）时命令直接语法错；若路径可被外部影响，则是 `-Command` 注入面。

     顺带一提，同时用了 `-ExecutionPolicy Bypass`，这让注入的实际威力更大。

  2. **注释与代码不符**：注释写 "bsdtar missing/failed: fall back to PowerShell Expanded-Archive"，但 `tar.exe` **不存在**时 `Subprocess.call` 是 reject（不是返回非 0 退出码），`runSubprocess` 直接抛出，`engine.ts:229` 的 `if (extract.exitCode !== 0)` 根本走不到 → 用户拿到一句原始报错，而不是兜底成功。
     ```ts
     let extract = await runSubprocess({ command: "...\\tar.exe", ... });  // ← reject 时下面全被跳过
     if (extract.exitCode !== 0) { /* 兜底 */ }
     ```

- 修复：

```ts
let extract: SubprocessResult | null = null;
try {
  extract = await runSubprocess({
    command: TAR,
    arguments: ["-xf", zipPath, "-C", unzipDir],
  });
} catch (e) {
  Zotero.logError(e);
} // ← 缺失也走兜底
if (!extract || extract.exitCode !== 0) {
  await runSubprocess({
    command: PWSH,
    arguments: [
      "-NoProfile",
      "-Command",
      "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force",
      zipPath,
      unzipDir,
    ],
  });
}
```

    用 `$args[0]`/`$args[1]` 传路径可彻底消除引号问题（去掉 `-ExecutionPolicy Bypass` 与字符串拼接）。`curl.exe` 缺失同理：目前只会抛原始错误，没有可读提示。

### P2-4 引擎下载没有并发保护：两处入口可同时下载同一个 zip

- 位置：`src/modules/engine.ts:189`（`downloadEngine`）、调用方 `prefsUI.ts:381`（点"下载引擎"按钮）与 `queue.ts:112`（每个任务前的 `ensureEngine`）
- 事实：`ensureEngine` 在引擎未就绪时会调 `downloadEngine`。用户在偏好页点了下载、同时右键开始翻译，两条路径会并发 `curl -o <同一个 engine.zip>` → 文件互相踩踏、解压出损坏结果，且白白消耗两个 521 MB 流量。
- 修复：模块内做单飞（single-flight）：

```ts
let inflight: Promise<EngineInfo> | null = null;
export function downloadEngine(p?: DownloadProgress) {
  if (!inflight)
    inflight = doDownload(p).finally(() => {
      inflight = null;
    });
  return inflight;
}
```

### P2-5 `detectEngine()` 每个任务都做一次全目录递归扫描，批量翻译时明显拖慢

- 位置：`src/modules/engine.ts:60-105`（`findExeRecursive`/`findManagedEngine`）、`queue.ts:112`
- 事实：`findManagedEngine()` 会对引擎目录做**两遍**完整递归（先找 `pdf2zh_next.exe`，再找 `pdf2zh.exe`），每个条目一次 `await IOUtils.stat`。而引擎目录里装着 `site-packages/`（PyStand 打包的 venv，成千上万个文件）。批量翻译 N 篇就是 2N 次全树遍历，纯浪费且都在主线程上 await。
- 修复：把检测结果缓存起来（key 用 `enginePath` 偏好 + 引擎目录 mtime），在"下载/指定路径/清除指定"时失效；或至少只在 `ensureEngine` 首次调用时检测。

### P2-6 运行窗口的菜单清理没实现，多窗口场景会残留死引用

- 位置：`src/hooks.ts:43-56`、`src/modules/menus.ts:8-53`
- 事实：`registerMenus(win)` 返回 cleanup 并被塞进 `addon.data.menuCleanups`，但：

```ts
function onMainWindowUnload(_win: Window): void {
  // Menu cleanup happens in onShutdown; the main window going away
  // always coincides with plugin shutdown in practice.
}
```

这个注释在 Zotero 里不成立——Zotero 支持多窗口，关掉第二个窗口并不会关闭插件。该窗口的 menuitem（被 append 到它的 `zotero-itemmenu`）和 listener 会一直留到插件 shutdown，闭包持有已销毁的 window。

- 修复：把清理函数按窗口存 `Map<Window, () => void>`，在 `onMainWindowUnload` 里取出来执行并删除。

### P2-7 服务配置缺少 URL/密钥校验，Key 可能明文发往非 https 端点

- 位置：`src/modules/prefsUI.ts:182-210`（保存校验）、`src/modules/profiles.ts:104-135`（连通性测试）
- 事实：`saveProfileFromEditor` 只校验 `name/baseUrl/model` **非空**，不校验是不是合法 URL、是不是 http(s)。`testProfile` 与后续翻译都会把 `Authorization: Bearer <Key>` 发到用户填的任何地址——包括 `http://` 明文端点（此时 Key 在链路上裸奔）。
- 修复：保存时用 `new URL()` 校验 scheme ∈ {http, https}；对非 `localhost/127.0.0.1` 的 `http:` 给出明确告警（Ollama 本地场景仍允许）。

### P2-8 测试覆盖约等于零，而多数缺陷本可被 10 行单测拦住

- 位置：`test/startup.test.ts`（全文 8 行）
- 事实：唯一的测试是"插件实例存在"的冒烟测试，且依赖真实 Zotero 与 `zotero-plugin test` 下载的二进制（CI 里必须联网）。**纯函数逻辑一行都没测**，而它们恰好是最容易出错的：
  - `buildNextArgs` / `buildV1Args`（`runner.ts:35-99`）：`output × bilingualLayout` 的组合矩阵
  - `getProfiles` / `saveProfiles`（`profiles.ts:79-96`）：JSON 损坏、非数组、缺字段
  - `sanitizeFileBaseName`（`attach.ts:1-9`）：非法字符、超长、全非法字符
  - `applyModePreset` / `MODE_PRESETS`（`presets.ts`）
  - `lastMeaningfulLine`（`runner.ts:24-31`）：ANSI/CRLF/空行
  - FTL 键存在性检查（本次审查正是靠脚本抓到 P3-1 的）
- 修复：把上述纯函数表露出来后加 `mocha` 单测；CI 增加一个不需要 Zotero 的 `test:unit` job。顺带把 i18n 键校验做成 CI 脚本（`getString` 的 key 必须存在且有 value）。

---

## 3. P3 —— 低风险 / 清理项

| #    | 位置                                                                                                                                                             | 问题                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P3-1 | `src/modules/engine.ts:285`                                                                                                                                      | **已确认的用户可见缺陷**：`getString("pref-engine-browse")`，而 `preferences.ftl` 里该消息**只有 `.label` 属性、没有 value**。Fluent 语义下 `pattern.value === null`，`locale.ts:90` 于是回退成 `localStringWithPrefix` → 文件选择框标题显示成字面量 **`fullpdf-pref-engine-browse`**。修复：`getString("pref-engine-browse", "label")`（`locale.ts:44` 的重载正是为此存在）。我用脚本扫了全部 76 条消息 + 全部 `getString` 调用点，**这是唯一一处**属性误用（其余 22 条属性式消息都只用于 XHTML `data-l10n-id`，正确）。                                                                                                                                                                                                                |
| P3-2 | `runner.ts:202-215` + `queue.ts:126`                                                                                                                             | `output === "mono"` 且 `bilingualLayout === "side"`（默认版式）时，`mergeSideBySide` 仍会把整本书合并一遍，产出的 `input-side.pdf` 随后被 `queue.ts:126` 的 `output !== "mono"` 判掉、直接删掉。纯浪费一次全量 PyMuPDF 合并。修复：把 merge 条件改成 `layout === "side" && outputs.monoPath && output !== "mono"`。                                                                                                                                                                                                                                                                                                                                                                                                                      |
| P3-3 | `profiles.ts:98-102`                                                                                                                                             | `getActiveProfile()` 在 `activeProfileId` 失效时**静默**回退到 `profiles[0]`。删了一个配置后，翻译可能悄悄用另一个服务的 Key 计费。建议回退时 `Zotero.debug` 或界面提示。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| P3-4 | `engine.ts:20` vs `addon.ftl:20`                                                                                                                                 | 文案不符：`engine-exe-not-found = pdf2zh_next.exe not found`，但自动下载得到的是 **v1 的 `pdf2zh.exe`**（`findManagedEngine` 两条分支都会走这里）。中英文案都需改。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| P3-5 | `menus.ts:32-43`                                                                                                                                                 | 分类右键菜单项没有 `popupshowing` 显隐控制（条目菜单有），未选中分类时也会出现。点击无反应，属轻微不一致。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| P3-6 | `runner.ts:143-145`                                                                                                                                              | `Zotero.debug` 打印了完整参数表，其中包含 `--custom-system-prompt` 的全文与术语表路径。Key 没进命令行（好），但提示词可能含敏感内容。建议只打印参数个数/截断。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| P3-7 | `hooks.ts:44`                                                                                                                                                    | 每次窗口加载都 `addon.data.ztoolkit = createZToolkit()`，直接丢弃上一个实例，而 `unregisterAll()` 只作用于当前实例。（这是 zotero-plugin-template 的原始写法，不算本次新增问题，但多窗口下会漏注销。）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| P3-8 | `addon/content/zoteroPane.css`、`src/utils/window.ts`、`src/utils/prefs.ts:34`、`src/utils/locale.ts:94`、`src/utils/ztoolkit.ts:37`、`addon.ftl` 的 `startup-*` | 模板遗留死代码：`zoteroPane.css` 只有 `.makeItRed` 且从未被引用；`isWindowAlive` / `clearPref` / `getLocaleID` / `MyToolkit` / `startup-begin`/`startup-finish`/`mainWindow-ready` 全部无人使用。ESLint 因为 `eslint.config.mjs:12` 关掉了 `no-unused-vars`（注释说是为了模板示例），所以一直没暴露。                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| P3-9 | 仓库卫生                                                                                                                                                         | ① `full-pdf-translate.xpi`（51 KB 二进制）**被 git 跟踪**——我把它与重新构建的产物逐条比对过：15 个条目中 14 个字节完全一致，仅 `content/preferences.xhtml` 因构建时间戳不同而不同，即**当前它与 HEAD 是同步的**；但它是手工产物，下次改代码后极易忘记重建而让用户装到旧版。建议 `git rm --cached` 并在 release 时产出。② `doc/README-zhCN.md`、`doc/README-frFR.md` 是上游模板自己的 README（"Zotero Plugin Template"，20/23 KB），与本项目无关，会误导读者。③ `.zcode/plans/plan-sess_*.md`（AI 会话计划）被提交进版本库。④ 工作区有未跟踪的 `.tmp_decode.py`，内含**硬编码的本机 Zotero profile 绝对路径**，建议删除并加进 `.gitignore`。⑤ `.github/dependabot.yml` 与 `.github/renovate.json` 同时启用，会互相重复开 PR，二选一即可。 |

### CI / 供应链（低-中）

`.github/workflows/ci.yml:18,28,43` 与 `release.yml:15`、`issue-bot.yml:20` 全部引用 `zotero-plugin-dev/workflows/*@main` 与 `setup-js@main`（浮动的分支引用），而 `release.yml` 带 `permissions: contents: write` + `secrets: inherit`。上游仓库若被入侵或 force-push，就能在发布流程里执行任意代码并拿到写权限 token。建议钉到 commit SHA。

---

## 4. 已验证"确实正确"的关键假设（这些不必再怀疑）

审查外部依赖时我拉了上游源码逐一核对，以下**全部通过**——这几点是整个插件最容易"写错了就永远跑不通"的地方，值得记一笔：

1. **v2（pdf2zh_next）的 14 个命令行参数全部存在**：`build_args_parser`（上游 `pdf2zh_next/config/main.py:49-136`）会对嵌套 settings 模型递归展开，用 `field_name.replace("_","-").lower()` 生成 flag，因此 `pdf.pages→--pages`、`pdf.no_mono→--no-mono`、`pdf.no_dual→--no-dual`、`pdf.watermark_output_mode→--watermark-output-mode`、`pdf.ocr_workaround→--ocr-workaround`、`pdf.auto_enable_ocr_workaround→--auto-enable-ocr-workaround`、`translation.lang_in/lang_out/output/qps/pool_max_workers/custom_system_prompt/glossaries/no_auto_extract_glossary` 全部对应真实字段；`--openai` 来自引擎 flag 字段 `openai`。`watermark_output_mode` 的两个取值 `watermarked` / `no_watermark` 与上游字段描述一致。
   _注意一个易混淆点（代码写得是对的）_：引擎的 `--output` 是**输出目录**（`translation.output`），而插件偏好里的 `output`（dual/mono/both）是**插件层概念**，映射到 `--no-mono`/`--no-dual` ——`runner.ts:43-47` 的映射经核对无误（dual+stacked→`--no-mono`；mono→`--no-dual`；both→两者都不传）。
2. **v2 的三个密钥环境变量名完全正确**：上游 `parse_dict_vars`（`config/main.py:303-386`）用 `prefix="PDF2ZH_"` 且**递归时前缀不变**，而引擎明细字段名是 `cli_flag_name + "_detail"`（`translate_engine_model.py`），嵌套模型 `OpenAISettings` 的字段就叫 `openai_base_url/openai_api_key/openai_model` → 环境变量正是 `PDF2ZH_OPENAI_BASE_URL` / `PDF2ZH_OPENAI_API_KEY` / `PDF2ZH_OPENAI_MODEL`，加上 `PDF2ZH_OPENAI=1`，与 `runner.ts:132-137` 一字不差。
3. **v1 引擎的 `openailiked` 服务名与环境变量正确**：上游 `pdf2zh/translator.py` 中 `class OpenAIlikedTranslator` 的 `name = "openailiked"`，`envs = {OPENAILIKED_BASE_URL, OPENAILIKED_API_KEY, OPENAILIKED_MODEL}` ——与 `runner.ts:138-142` 完全一致；v1 CLI 的 `--service/--thread/--pages/--prompt/--lang-in/--lang-out/--output` 也都在 `pdf2zh/pdf2zh.py` 的 argparse 里。
4. **引擎自动下载的 URL 解析与兜底地址有效**：Release API 最新版本即 `v1.9.11`，资产 `pdf2zh-v1.9.11-with-assets-win64.zip`（546,221,784 B ≈ 521 MB，与界面文案"约 520 MB"吻合）；`/with-assets-win64\.zip$/i` 能命中；`FALLBACK_DOWNLOAD_URL` 与最新资产**完全同址**，没有过期。
5. **side-by-side 依赖的 Python 运行时布局假设成立**：上游 `exe-build.yml` 的打包产物结构正是 `pdf2zh.exe` + `runtime/`（Python 3.12.9 embeddable）+ `site-packages/`（venv），与 `getBundledRuntime`（`engine.ts:115-124`）推导的 `buildDir/runtime/python.exe`、`buildDir/site-packages` 一致 → `side_by_side.py` 的调用方式可靠。
6. **ztoolkit API 用法正确**：`zotero-plugin-toolkit@5.1.0-beta.13` 的 `ProgressWindowHelper` 确有 `createLine/changeLine/show/startCloseTimer` 与 `closeOnClick/closeTime` 选项（`dist/index.d.ts:1160-1229`）。
7. **偏好面板幂等注册的修法是对的（已对着 Zotero 源码核实，不只是看类型定义）**：类型定义只能证明 API 形状。我进一步从本机 `D:\zotero\app\omni.ja` 中抽出真实实现 `chrome/content/zotero/xpcom/preferencePanes.js`（200 行）逐段核对：
   - `register()`（第 134-165 行）在 id 冲突时抛出的正是 **`Pane with ID ${options.id} already registered`**（第 140 行），与 `hooks.ts:31` 的 `/already registered/i` 精确匹配 → 重复安装不会再叠加条目，**代码与注释的承诺都成立**。
   - 返回值是 `addPaneOptions.id`（第 164 行），`unregister(id)` 按 id 过滤 `pluginPanes`（第 172-175 行）→ `hooks.ts:23-34`、`65-72` 的用法正确。
   - `register()` 会自行挂上插件 shutdown 观察者（`_ensureObserverAdded()`，第 183-199 行），按 `pluginID` 兜底清空面板 → 末尾那次手动 `unregister` 确实是 belt-and-braces；即使 `register` 抛错使 `prefPaneId` 仍为 `null`，面板也不会残留。
   - 一个值得知道的副作用：`register`/`unregister` 都会调用 `_refreshPreferences()`，**强制 reload 所有已打开的偏好窗口**（第 177-181 行）。所以插件启动/关闭时若正开着设置窗口，会看到一次闪动重载——这是 Zotero 的设计，不是插件缺陷。
8. **Zotero API 签名正确**：`Attachments.importFromFile` 确实支持 `title` 与 `fileBaseName`（`attachments.d.ts:42-60`）；`HTTP.request` 支持 `timeout`/`responseType`（`http.d.ts`）。
9. **i18n 结构完整**：en-US / zh-CN 三组 FTL 键数 23/52/1 且**完全对齐**；XHTML 里 45 个 `data-l10n-id` 全部有定义（另有 7 条只在 JS 里用，属正常）。
10. **文件命名与路径安全**：`sanitizeFileBaseName`（`attach.ts:1-9`）清洗了 `\/:*?"<>|` 与控制字符、截断 120 字符、空串兜底，考虑周全；`tar -xf` 与 `Expand-Archive` 默认都有 zip-slip 防护（拒绝绝对路径与 `..`）。
11. **进程 I/O 结构正确**：`subprocess.ts:41` 用 `stderr: "stdout"` 合并流，使 curl 的进度（默认写 stderr）能被 `engine.ts:171-180` 的 `onStdout` 解析到——进度条能正常推进，不是空实现。
12. **模板/脚手架工程配置正常**：`esbuild target: firefox115` 与 Zotero 7 基线匹配；`manifest.json` 的 `strict_min_version 6.999` / `strict_max_version 10.*` 覆盖 Zotero 7–10，与 README"兼容 8"一致。

---

## 5. 建议的修复顺序

| 顺序 | 事项                                                                              | 预计工作量 |
| ---- | --------------------------------------------------------------------------------- | ---------- |
| 1    | P1-1 失败即回收临时目录（+ 启动清理历史目录）                                     | 20 行      |
| 2    | P1-2 `translateQueue.stop()` 接入 `onShutdown` + 循环内检查 `alive`               | 15 行      |
| 3    | P2-1 去重标记延后到任务结束（防重复翻译/重复计费）                                | 5 行       |
| 4    | P3-1 i18n 属性取值（1 行）+ P3-4 文案纠正                                         | 10 分钟    |
| 5    | P1-3 用 Release API 的 `digest` 做 sha256 校验（镜像路径尤其必要）                | 40 行      |
| 6    | P2-3 解压兜底改为"异常也兜底"+ 取消 `-Command` 字符串拼接                         | 20 行      |
| 7    | P2-4 下载单飞；P2-5 引擎检测缓存                                                  | 25 行      |
| 8    | P2-7 配置项 URL 校验 + 明文 http 告警                                             | 20 行      |
| 9    | P2-8 抽出纯函数并补单测 + CI 的 i18n 键校验 job                                   | 半天       |
| 10   | P2-6 多窗口菜单清理；P2-2 取消按钮（可并入 stop）                                 | 半天       |
| 11   | P3-9 仓库卫生（`git rm --cached` XPI、删模板 README/`.tmp_decode.py`、CI 钉 SHA） | 30 分钟    |
| 12   | P3-2 / P3-3 / P3-5 / P3-6 / P3-7 / P3-8 清理                                      | 1 小时     |

**一句话总结**：这份代码的骨架和外部依赖用法（最容易踩坑的引擎参数与密钥注入）经交叉验证**全部正确**，可以放心在此基础上迭代；真正需要补的是"失败与退出"这两条路径——临时目录回收、队列可停、下载校验，以及一个把纯函数纳入 CI 的测试基线。

---

## 6. 审查期间工作区发生了变化（重要说明）

本次审查以 **HEAD = `0408c66`** 为基准。审查过程中（约 21:05–21:22）工作区出现了**我未参与的改动**，为避免误伤你的在途工作，我**没有修改、没有回滚**其中任何文件：

| 文件                            | 状态                       | 内容                                                                                                                                                                    |
| ------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/hooks.ts`                  | 已修改                     | 新增 `runStartupDiagnostics()`：读 `debugProbe` 偏好，15s 后把偏好面板加载诊断（`getContentsFromURL` → `parseXULToFragment`）写成 `<数据目录>/fullpdf-diagnostics.json` |
| `addon/prefs.js`                | 已修改                     | 新增 `pref("debugProbe", false)`                                                                                                                                        |
| `typings/prefs.d.ts`            | 已修改                     | 同步新增 `"debugProbe": boolean`                                                                                                                                        |
| `full-pdf-translate.xpi`        | 已修改                     | 51748 → 52180 B（被重新构建，已含上述诊断代码）                                                                                                                         |
| `.tmp_probe.py`、`.tmp_omni.py` | 新增（未跟踪）             | 调试脚本：拼装 probe XPI、解包 `D:\zotero\app\omni.ja` 查 `preferences.js`                                                                                              |
| `.tmp_decode.py`                | 未跟踪（审查开始前就存在） | 解码 `addonStartup.json.lz4` 排查插件注册                                                                                                                               |

这些改动与"偏好面板为什么加载不出来"的排查高度相关，看起来是**你在并行进行的调试**（也可能来自你的另一个会话），因此我一律不动。

需要提醒两点：

1. **这组改动目前不满足仓库自身的代码规范**：`npx prettier --check .` 现在会 **失败于 `src/hooks.ts`**（此前全仓库通过），也就是说 `npm run lint:check` 与 CI 的 lint job 会红。我用"复制成 `.prettier-probe.ts` → `prettier --write` → diff → 删除探针"的方式定位过，原因**只有一行**：新增的

   ```ts
   if (Zotero.Prefs.get(`${addon.data.config.prefsPrefix}.debugProbe`, true) !== true) {
   ```

   超过 `printWidth: 80`，Prettier 会把它拆成多行。跑一次 `npx prettier --write src/hooks.ts` 即可恢复全绿。_（我自己的 `CODE_REVIEW.md` 也一度触发格式告警，已 `prettier --write` 修好；`src/hooks.ts` 一个字符都没碰，探针文件也已删除。）_

2. 若这个诊断探针最终**不打算保留**，记得连同 `addon/prefs.js` 的 `debugProbe`、`typings/prefs.d.ts` 的对应项一起回滚，并**重新构建 XPI**——当前被跟踪的 `full-pdf-translate.xpi` 已经带上了调试代码，直接发布会把调试脚手架发给用户。

另外，第 4 节第 7 条（偏好面板注册语义）是我**用本机 `omni.ja` 里的 Zotero 真实源码核实过的**，不是只读类型定义——如果你正在查面板不显示的问题，那几条结论（"already registered" 的精确文案与匹配、id 冲突检查、shutdown 自动清理、`_refreshPreferences()` 强制重载）可以直接作为事实依据。
