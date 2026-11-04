# window.modmanager 管理接口

`window.modmanager` 是 ModLoader 的管理端接口，用于构建模组管理器页面、浏览已安装模组、维护顺序和缓存，以及处理游戏核心与存档迁移。

```js
const manager = window.modmanager

if (!manager) {
  throw new Error('ModManager 接口不可用')
}
```

所有方法均为异步并返回 `Promise`，`readFileSync` 和 `readAsarFileSync` 是唯一的同步例外。该接口也会暴露给游戏窗口，但它包含安装、替换和系统文件对话框等管理能力；普通模组应优先使用 `window.modloader`，不要依赖本接口。

## 接口总览

| 类别 | 方法 | 用途 |
| --- | --- | --- |
| 文件浏览 | `list`、`readFile`、`readFileSync`、`readAsarFile`、`readAsarFileSync` | 浏览 `resources` / `mods`，并读取目录模组或 ASAR 内文件。 |
| 模组信息与缓存 | `scanModInfos`、`refreshModCaches`、`getCachedModInfos`、`getCachedModConfigs` | 扫描元数据、重建和读取管理器缓存。 |
| 工坊目录缓存 | `getCachedWorkshop`、`setCachedWorkshop` | 保存前端已获取和解析的工坊条目。 |
| 本地模组与更新 | `selectLocalModFile`、`importLocalModFile`、`downloadAndReplace`、`onDownloadProgress` | 选择、导入、下载和替换 ASAR 模组。 |
| 加载顺序与网络 | `setModOrder`、`fetchText` | 更新启用状态/优先级，或由主进程发起 HTTP(S) GET。 |
| 数据目录 | `getDataDirectory`、`openDataDirectory` | 获取或在系统文件管理器中打开可写数据目录。 |
| 游戏核心 | `getGameCoreStatus`、`selectGameCoreFile`、`clearGameCoreFile` | 选择、检查或清除作为底层资源的游戏 ASAR。 |
| 存档迁移 | `getSaveImportStatus`、`selectSaveImportDirectory`、`clearSaveImportDirectory`、`importSaves` | 从外部版本复制顶层 `.sav` 存档。 |
| 版本信息 | `getModLoaderPackageInfo` | 读取 ModLoader 包名和版本。 |

## 文件浏览

文件浏览路径使用相对于运行时 `resources` 根目录的路径，通常为 `mods/<模组文件名>/...` 或 `mods/<模组文件名>.asar/...`。路径不存在、格式不正确或读取失败时，读取方法返回 `null`，目录列举返回空数组。

| 方法 | 参数 | 返回值 | 说明 |
| --- | --- | --- | --- |
| `list(path?)` | `path?: string` | `Promise<ModPathEntry[]>` | 列出目录中的直接子项；空路径表示根目录。 |
| `readFileSync(path)` | `path: string` | `string \| null` | 同步读取文本；遇到 ASAR 内部路径时自动读取归档内容。 |
| `readFile(path)` | `path: string` | `Promise<string \| null>` | 异步版本的 `readFileSync`。 |
| `readAsarFileSync(path)` | `path: string` | `string \| null` | 只读取 ASAR 内部文件；普通目录文件返回 `null`。 |
| `readAsarFile(path)` | `path: string` | `Promise<string \| null>` | 异步读取 ASAR 内部文件。 |

```ts
interface ModPathEntry {
  name: string
  isDir: boolean
  isAsar: boolean
}
```

例如，读取目录模组和 ASAR 模组中的元数据：

```js
const folderMeta = await manager.readFile('mods/example/modloader.mod.json')
const archiveMeta = await manager.readAsarFile('mods/example.asar/modloader.mod.json')
```

## 模组信息与缓存

`scanModInfos()` 会实际扫描当前模组目录；缓存方法不会重新扫描。缓存文件位于可写数据目录的 `cache/` 中，适合管理器启动时快速显示数据。

| 方法 | 返回值 | 说明 |
| --- | --- | --- |
| `scanModInfos()` | `Promise<ModMetadata[]>` | 扫描每个目录/ASAR 模组的 `modloader.mod.json`，并附加 `file` 与 `canConfig`。 |
| `refreshModCaches()` | `Promise<{ success: boolean, infoCount: number, configCount: number }>` | 重建 `mod-info.json` 与 `mod-config.json` 缓存。 |
| `getCachedModInfos()` | `Promise<CachedModInfo[]>` | 返回缓存的元数据、启用状态和顺序；无缓存时为 `[]`。 |
| `getCachedModConfigs()` | `Promise<CachedModConfig[]>` | 返回每个模组的 `modloader.config.json` 定义；无缓存时为 `[]`。 |

`ModMetadata` 保留模组 JSON 中的字段（如 `id`、`name`、`version`、`depends`、`breaks`、`injections`），并增加：

```ts
interface ModMetadata {
  file: string
  canConfig: boolean
  // 以及 modloader.mod.json 中的其他字段
}

interface CachedModInfo {
  file: string
  order: number
  enabled: boolean
  metadata: ModMetadata
}

interface CachedModConfig {
  file: string
  config: object | null
}
```

## 工坊目录缓存

此组接口只读写已由前端取得的目录数据，不会自行请求网络。

| 方法 | 参数 | 返回值 |
| --- | --- | --- |
| `getCachedWorkshop()` | 无 | `Promise<{ items: unknown[], unavailableCount: number } \| null>` |
| `setCachedWorkshop(catalog)` | `catalog: { items: unknown[], unavailableCount?: number }` | `Promise<{ success: boolean, message?: string }>` |

## 本地模组、更新与顺序

| 方法 | 参数 | 返回值 | 说明 |
| --- | --- | --- | --- |
| `selectLocalModFile()` | 无 | `Promise<LocalModSelection>` | 显示文件选择框，选择一个外部 `.asar` 模组。 |
| `importLocalModFile(sourcePath)` | `sourcePath: string` | `Promise<ModOperationResult>` | 将已选择的外部 ASAR 复制到模组目录。 |
| `downloadAndReplace(url, fileName)` | `url: string`, `fileName: string` | `Promise<ModOperationResult>` | 下载 ASAR 后以临时文件方式替换同名模组。 |
| `onDownloadProgress(callback)` | `callback: (progress: DownloadProgress) => void` | `void` | 注册下载进度监听；当前没有取消订阅接口，避免重复注册。 |
| `setModOrder(entries)` | `entries: ModOrderEntry[]` | `Promise<boolean>` | 写入顺序和启用状态，并刷新模组缓存。 |

```ts
interface LocalModSelection {
  success: boolean
  canceled?: boolean
  path?: string
  fileName?: string
  size?: number
  message?: string
}

interface ModOperationResult {
  success: boolean
  fileName?: string
  size?: number
  message?: string
}

interface DownloadProgress {
  fileName: string
  received?: number
  total?: number
  result?: ModOperationResult
}

interface ModOrderEntry {
  file: string
  enabled?: boolean
  order?: number // 调用时会按数组位置重新编号
}
```

`downloadAndReplace` 只接受 HTTP(S) 地址并允许重定向；它不验证下载文件的签名或哈希。调用方应只使用可信 HTTPS 发布源，并在产品层提供版本、来源和完整性校验。

## 网络与数据目录

| 方法 | 参数 | 返回值 | 说明 |
| --- | --- | --- | --- |
| `fetchText(url)` | `url: string` | `Promise<FetchTextResult>` | 由主进程执行 HTTP(S) GET，用于跨域更新清单等文本请求。最多重定向 5 次，超时约 15 秒。 |
| `getDataDirectory()` | 无 | `Promise<string>` | 返回当前实际可写的数据目录。 |
| `openDataDirectory()` | 无 | `Promise<{ success: boolean, path: string, message?: string }>` | 用系统文件管理器打开该目录。 |

```ts
interface FetchTextResult {
  success: boolean
  status?: number
  text?: string
  message?: string
}
```

## 游戏核心

游戏核心是用户选择的原版 `.asar`，运行时会将其放在所有启用模组之后，作为资源回退层。选择操作只保存路径，不复制原文件。

| 方法 | 参数 | 返回值 |
| --- | --- | --- |
| `getGameCoreStatus()` | 无 | `Promise<{ path: string \| null, configured: boolean, exists: boolean }>` |
| `selectGameCoreFile()` | 无 | `Promise<{ success: boolean, canceled?: boolean, path?: string, message?: string }>` |
| `clearGameCoreFile()` | 无 | `Promise<{ success: boolean, message?: string }>` |

## 存档迁移

存档来源目录只读取顶层的 `.sav` 文件。`selectSaveImportDirectory()` 只保存来源目录；实际复制发生在 `importSaves()`。若独立版已有存档，首次调用会返回确认请求，调用方必须让用户确认后以 `true` 重试。

| 方法 | 参数 | 返回值 |
| --- | --- | --- |
| `getSaveImportStatus()` | 无 | `Promise<{ path: string \| null, configured: boolean, exists: boolean, count: number }>` |
| `selectSaveImportDirectory()` | 无 | `Promise<{ success: boolean, canceled?: boolean, path?: string, count?: number, message?: string }>` |
| `clearSaveImportDirectory()` | 无 | `Promise<{ success: boolean, message?: string }>` |
| `importSaves(replaceExisting?)` | `replaceExisting?: boolean` | `Promise<SaveImportResult>` |

```ts
interface SaveImportResult {
  success: boolean
  count?: number
  needsConfirmation?: boolean
  existingCount?: number
  noSave?: boolean
  message?: string
}
```

```js
let result = await manager.importSaves(false)
if (!result.success && result.needsConfirmation) {
  // 在真实 UI 中先向用户说明将替换多少个现有存档。
  result = await manager.importSaves(true)
}
```

## 版本信息

| 方法 | 返回值 | 说明 |
| --- | --- | --- |
| `getModLoaderPackageInfo()` | `Promise<{ name: string, version: string } \| null>` | 返回当前安装的 ModLoader 包信息。 |

## 使用边界

- 管理页面应在调用前检查 `window.modmanager` 是否存在，并处理所有 `success: false`、`canceled` 和 `null` 结果。
- `setModOrder`、导入、下载替换、游戏核心切换和存档导入都会改变本地状态；应由明确的用户操作触发。
- 不要把 `fetchText` 或 `downloadAndReplace` 直接暴露给不可信网页内容。它们由主进程发起网络访问，前者可绕过页面 CORS，后者可覆盖已安装模组。
