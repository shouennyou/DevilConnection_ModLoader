# window.api.modloader 模组接口

本文件说明游戏窗口中提供给模组调用的 `window.api.modloader` 文件接口. 接口由 ModLoader preload 注入, 可在 `modloader.mod.json` 声明的注入脚本中使用.

```js
const modloader = window.api?.modloader

if (!modloader) {
  throw new Error('ModLoader 文件接口不可用')
}
```

除名称带 `Sync` 的方法外, 所有方法均返回 `Promise`. 模组通常应优先使用异步方法, 避免阻塞游戏渲染线程.

## 路径规则

所有路径应使用相对于 `resources` 的正斜杠路径. 可访问范围仅限以下两个根目录:

| 路径示例 | 实际位置 | 建议用途 |
| --- | --- | --- |
| `config/example-complete-mod.json` | `resources/config/example-complete-mod.json` | 模组持久化配置. |
| `config/example-complete-mod/data.json` | `resources/config/example-complete-mod/data.json` | 模组私有数据目录. |
| `../_storage/save.dat` | `resources` 同级的 `_storage/save.dat` | 游戏存档相关数据. |

- 不要使用绝对路径.
- 路径不能包含 NUL 字符或越出允许根目录的 `..`.
- `stat`、`getSize`、`readdir` 和 `exists` 可以传入空字符串以查询 `resources` 根目录. 其余方法必须传入根目录下的目标路径.
- 接口不按模组隔离文件权限. 请仅读写自己使用的 `config/<模组 ID>.json` 或 `config/<模组 ID>/` 路径, 不要修改 `app.asar`、其他模组文件或 `config/mod_order.json`.

## 通用结果格式

写入、删除、创建和复制操作返回 `FsResult`:

```ts
interface FsResult {
  success: boolean
  error?: string
}
```

`success` 为 `false` 时, `error` 包含失败原因. 调用方应检查该字段:

```js
const result = await window.api.modloader.writeFile(
  'config/example-complete-mod.json',
  JSON.stringify({ enabled: true }, null, 2),
)

if (!result.success) {
  console.error('[完整示例模组] 保存配置失败:', result.error)
}
```

## 文本文件

文本按 UTF-8 读写. 写入和追加会自动创建父目录.

| 方法 | 参数 | 返回值 | 说明 |
| --- | --- | --- | --- |
| `readFileSync(path)` | `path: string` | `string \| null` | 同步读取文本. 路径不存在或读取失败时返回 `null`. |
| `readFile(path)` | `path: string` | `Promise<string \| null>` | 异步读取文本. |
| `writeFileSync(path, content)` | `path: string`, `content: string` | `FsResult` | 同步覆盖写入 UTF-8 文本. |
| `writeFile(path, content)` | `path: string`, `content: string` | `Promise<FsResult>` | 异步覆盖写入 UTF-8 文本. |
| `appendFileSync(path, content)` | `path: string`, `content: string` | `FsResult` | 同步追加 UTF-8 文本. |
| `appendFile(path, content)` | `path: string`, `content: string` | `Promise<FsResult>` | 异步追加 UTF-8 文本. |

读取和保存 JSON 配置示例:

```js
const api = window.api.modloader
const file = 'config/example-complete-mod.json'
const content = await api.readFile(file)

let config = { enabled: true, retryCount: 3 }
if (content) {
  try {
    config = { ...config, ...JSON.parse(content) }
  } catch (error) {
    console.error('[完整示例模组] 配置格式无效:', error)
  }
}

config.retryCount += 1
const result = await api.writeFile(file, JSON.stringify(config, null, 2))
if (!result.success) {
  console.error('[完整示例模组] 配置保存失败:', result.error)
}
```

## 二进制文件

二进制接口适用于图片、音频、压缩包等中小型文件. 大文件应使用下方的流式接口.

| 方法 | 参数 | 返回值 | 说明 |
| --- | --- | --- | --- |
| `readBufferSync(path)` | `path: string` | `Uint8Array \| null` | 同步读取完整二进制文件. |
| `readBuffer(path)` | `path: string` | `Promise<Uint8Array \| null>` | 异步读取完整二进制文件. |
| `writeBufferSync(path, buffer)` | `path: string`, `buffer: ArrayBuffer \| Uint8Array` | `FsResult` | 同步覆盖写入二进制文件. |
| `writeBuffer(path, buffer)` | `path: string`, `buffer: ArrayBuffer \| Uint8Array` | `Promise<FsResult>` | 异步覆盖写入二进制文件. |

```js
const api = window.api.modloader
const response = await fetch('https://example.com/assets/icon.png')
const buffer = await response.arrayBuffer()
const result = await api.writeBuffer('config/example-complete-mod/icon.png', buffer)

if (!result.success) {
  console.error('[完整示例模组] 图片写入失败:', result.error)
}
```

## 流式读写

流式接口用于大文件, 每个会话 ID 只在创建它的游戏窗口中有效. 读取完成、读写失败或调用 `closeStream` 后, 该 ID 立即失效.

| 方法 | 参数 | 返回值 | 说明 |
| --- | --- | --- | --- |
| `createReadStream(path)` | `path: string` | `Promise<FileStreamOpenResult>` | 打开普通文件的二进制读取会话. |
| `readStreamChunk(id, size?)` | `id: string`, `size?: number` | `Promise<FileStreamReadResult>` | 读取下一块数据. 默认 256 KiB, 最大 1 MiB. |
| `createWriteStream(path)` | `path: string` | `Promise<FileStreamOpenResult>` | 创建二进制写入会话. 内容先写入临时文件. |
| `writeStreamChunk(id, chunk)` | `id: string`, `chunk: ArrayBuffer \| Uint8Array` | `Promise<FsResult>` | 向写入会话追加数据块. |
| `closeStream(id, commit?)` | `id: string`, `commit?: boolean` | `Promise<FsResult>` | 关闭会话. 写入会话仅在 `commit: true` 时替换目标文件. |

`FileStreamOpenResult` 的结构如下. 读取会话成功时带有源文件 `size`, 写入会话不带 `size`.

```ts
interface FileStreamOpenResult {
  success: boolean
  id?: string
  size?: number
  error?: string
}
```

`FileStreamReadResult` 的结构如下. `done: true` 代表已到文件末尾, 此时没有 `chunk`.

```ts
interface FileStreamReadResult {
  success: boolean
  done?: boolean
  chunk?: Uint8Array
  error?: string
}
```

流式复制示例:

```js
const api = window.api.modloader
const source = await api.createReadStream('config/example-complete-mod/source.bin')

if (!source.success || !source.id) {
  throw new Error(source.error || '无法打开源文件')
}

const target = await api.createWriteStream('config/example-complete-mod/copy.bin')
if (!target.success || !target.id) {
  await api.closeStream(source.id)
  throw new Error(target.error || '无法创建目标文件')
}

let sourceClosed = false
let targetClosed = false
try {
  while (true) {
    const part = await api.readStreamChunk(source.id)
    if (!part.success) throw new Error(part.error || '读取文件失败')
    if (part.done) {
      sourceClosed = true
      break
    }
    if (!part.chunk) throw new Error('读取结果缺少数据块')

    const result = await api.writeStreamChunk(target.id, part.chunk)
    if (!result.success) throw new Error(result.error || '写入文件失败')
  }

  const result = await api.closeStream(target.id, true)
  if (!result.success) throw new Error(result.error || '提交文件失败')
  targetClosed = true
} finally {
  if (!sourceClosed) await api.closeStream(source.id)
  if (!targetClosed) await api.closeStream(target.id)
}
```

读取流到达末尾时会自动关闭. 写入流无论提交还是放弃, 都必须调用 `closeStream`.

## 文件与目录

| 方法 | 参数 | 返回值 | 说明 |
| --- | --- | --- | --- |
| `statSync(path)` | `path: string` | `FileStat \| null` | 同步读取文件或目录状态. |
| `stat(path)` | `path: string` | `Promise<FileStat \| null>` | 异步读取文件或目录状态. |
| `getSizeSync(path)` | `path: string` | `number \| null` | 同步获取字节大小. 目录会递归计算所有子项. |
| `getSize(path)` | `path: string` | `Promise<number \| null>` | 异步获取字节大小. |
| `readdirSync(path)` | `path: string` | `string[] \| null` | 同步读取目录项名称, 不含完整路径. |
| `readdir(path)` | `path: string` | `Promise<string[] \| null>` | 异步读取目录项名称. |
| `existsSync(path)` | `path: string` | `boolean` | 同步判断文件或目录是否存在. |
| `exists(path)` | `path: string` | `Promise<boolean>` | 异步判断文件或目录是否存在. |
| `mkdirSync(path)` | `path: string` | `FsResult` | 同步递归创建目录. |
| `mkdir(path)` | `path: string` | `Promise<FsResult>` | 异步递归创建目录. |
| `renameSync(oldPath, newPath)` | `oldPath: string`, `newPath: string` | `FsResult` | 同步重命名或移动, 自动创建目标父目录. |
| `rename(oldPath, newPath)` | `oldPath: string`, `newPath: string` | `Promise<FsResult>` | 异步重命名或移动. |
| `copyFileSync(sourcePath, targetPath)` | `sourcePath: string`, `targetPath: string` | `FsResult` | 同步复制文件, 自动创建目标父目录. |
| `copyFile(sourcePath, targetPath)` | `sourcePath: string`, `targetPath: string` | `Promise<FsResult>` | 异步复制文件. |
| `unlinkSync(path)` | `path: string` | `FsResult` | 同步删除单个文件. 文件不存在会返回失败. |
| `unlink(path)` | `path: string` | `Promise<FsResult>` | 异步删除单个文件. |
| `rmdirSync(path)` | `path: string` | `FsResult` | 同步递归删除目录. 目录不存在也视为成功. |
| `rmdir(path)` | `path: string` | `Promise<FsResult>` | 异步递归删除目录. |

`FileStat` 的类型判定方法与常用数据字段如下:

```ts
interface FileStat {
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
  isBlockDevice(): boolean
  isCharacterDevice(): boolean
  isFIFO(): boolean
  isSocket(): boolean
  size: number
  mode: number
  mtimeMs: number
  atimeMs: number
  ctimeMs: number
  birthtimeMs: number
  uid: number
  gid: number
  dev: number
  ino: number
  nlink: number
  blocks: number
  blksize: number
}
```

时间字段均为 Unix 毫秒时间戳. `stat` 结果在路径不存在、路径不合法或读取失败时为 `null`.

## 使用建议

- 文本配置优先放在 `config/<模组 ID>.json`, 结构化数据使用 `JSON.stringify(data, null, 2)` 保存.
- 大于数 MiB 的文件使用流式接口, 避免一次性占用大量渲染进程内存.
- 删除和覆盖写入前先检查路径, `rmdir` 会递归删除整个目录.
- 不要把会话 ID 保存到配置文件. 它只在当前游戏窗口存活期间有效.
- 若 ModLoader 未注入或在非游戏窗口执行脚本, `window.api?.modloader` 可能不存在, 调用前应进行存在性检查.
