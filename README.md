# DevilConnection_ModLoader

## 项目说明

《でびるコネクショん》(恶魔连结) 通用模组加载器. 
本项目基于 [ShiroNeko](https://github.com/nekodakohaku-dev/DevilConnection_Mod_Loader) 原始版本的实现思路重构, 不直接修改游戏原始 `app.asar`, 而是将原版游戏内容作为模组加载. 
这一设计尽可能提升了对游戏更新的兼容性, 无需在游戏每次更新后制作对应的加载器版本.

项目提供 Steam 模式, 用于同时兼容 Steam 版与 DLsite 版游戏.

## 开发文档

- [模组文件 API 文档](MODLOADER_API.md): `window.api.modloader` 的调用方法、返回数据格式和使用示例.

## 主要功能

- 模组管理: 安装 `.asar` 模组, 启用或禁用, 拖拽排序, 重命名, 卸载, 查看大小和元数据.
- 模组校验: 检测已启用模组的重复 ID、缺失或版本不符的依赖、以及版本范围命中的冲突. 启动游戏前会再次校验并阻止存在问题的组合启动.
- 模组更新: 支持 `remote` 和 `github` 更新源, 使用 semver 比较版本. `update.json` 支持单对象旧格式和按 ID 查找的数组格式.
- 模组配置: 读取模组内的 `modloader.config.json`, 提供文本、密码、开关、数字和下拉选择控件, 保存结果到 `config/<模组 ID>.json`.
- 模组工坊: 读取注册表并下载或更新已注册的 GitHub 模组.
- 存档备份: 创建、导入、导出、恢复、锁定、重命名和删除备份, 支持启动前自动备份与保留策略.
- 应用设置: 主题、Steam 模式、自动备份和 ModLoader 更新检查设置.

## 模组包结构

目录模组和 `.asar` 模组的内部结构相同. 将模组放在 `mods` 根目录后, 管理器会读取根目录中的 `modloader.mod.json`.

```text
mods/
  example-complete-mod/
    modloader.mod.json
    modloader.config.json
    assets/
      id/
	    icon.png
        scripts/
          main.js
          ui.js
```

完整可用示例位于 [examples/complete-mod](examples/complete-mod).

## modloader.mod.json

[examples/complete-mod/modloader.mod.json](examples/complete-mod/modloader.mod.json) 是完整元数据示例. JSON 文件必须保持严格格式, 不支持 `//` 或 `/* */` 注释.

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 模组唯一 ID. 用于重复检测、依赖、冲突、更新记录选择和本地配置文件名. 推荐只使用字母、数字、`-` 和 `_`. |
| `name` | string | 管理器中显示的名称. |
| `author` | string[] | 作者名称列表. |
| `description` | string | 模组说明. |
| `icon` | string | 可选的模组内图标相对路径. 图标会显示在管理器的模组卡片上. |
| `version` | string | semver 版本, 例如 `1.2.3`. 依赖、冲突和更新比较使用该字段. |
| `update` | object | 可选的更新源配置. 见下方更新说明. |
| `depends` | object | 可选的前置依赖映射, 键为目标 ID, 值为 semver 范围. |
| `breaks` | object | 可选的冲突映射, 键为目标 ID, 值为命中冲突的 semver 范围. |
| `injections` | object[] | 可选的游戏窗口注入脚本列表. |

### 模组图标

`icon` 指向模组目录内的图片文件, 使用相对路径和正斜杠. 支持 `avif`、`bmp`、`gif`、`jpeg`、`jpg`、`png` 和 `webp`.

```json
{
  "icon": "assets/id/icon.png"
}
```

不支持外部 URL 或绝对路径, 路径中也不能包含 `.` 或 `..` 目录段. 图标文件缺失、路径无效或格式不受支持时, 管理器会忽略该图标而不会影响模组加载.

### 依赖与冲突

`depends` 和 `breaks` 只检查已启用模组.

```json
{
  "depends": {
    "modloader-api": ">=0.1.1",
    "shared-library": "*"
  },
  "breaks": {
    "legacy-overlay": "<2.0.0",
    "old-theme": "<=1.3.0"
  }
}
```

- `"*"` 表示任意版本, 但目标模组仍必须已启用.
- `depends` 的目标不存在、被禁用或版本不满足时, 依赖方显示“依赖异常”.
- `breaks` 的目标存在且版本命中范围时, 冲突双方显示“模组冲突”.
- 同一 ID 被多个已启用模组使用时, 所有对应卡片显示“id 重复”. 依赖和冲突仍会继续计算, 以避免其他状态标签被隐藏.

### 注入脚本

`injections` 的 `path` 相对模组根目录. 每个文件会按模组排序注入游戏窗口.

```json
{
  "injections": [
    { "name": "主逻辑", "path": "assets/id/scripts/main.js" },
    { "name": "界面逻辑", "path": "assets/id/scripts/ui.js" }
  ]
}
```

若模组不存在 `modloader.mod.json`, 运行时会尝试加载根目录的 `hook.js`. 一旦存在 `modloader.mod.json`, 应显式声明 `injections`.

## modloader.config.json

[examples/complete-mod/modloader.config.json](examples/complete-mod/modloader.config.json) 展示了所有可用字段类型. 配置文件位于模组根目录, 存在时管理器会显示“配置”按钮.

顶层字段:

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `title` | string | 可选. 配置弹窗标题, 省略时使用模组名称. |
| `description` | string | 可选. 配置弹窗说明, 省略时为空. |
| `fields` | array | 配置字段列表. 必填. |

每个字段通用属性:

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `key` | string | 配置键. 同一文件内必须唯一, 且不能为 `__proto__`、`constructor` 或 `prototype`. |
| `type` | string | `text`、`password`、`toggle`、`number` 或 `select`. |
| `label` | string | 界面标签. 省略时使用 `key`. |
| `default` | string, number, boolean | 默认值. 应与 `type` 对应. |
| `placeholder` | string | 文本和数字输入框的占位提示. |
| `help` | string | 字段下方的说明文本. |
| `required` | boolean | 文本类字段不能为空. |
| `options` | array | 仅 `select` 使用, 每项含 `label` 与 `value`. |

保存后的配置文件示例为 [examples/complete-mod/config/example-complete-mod.json](examples/complete-mod/config/example-complete-mod.json). 实际保存位置为 `config/<模组 ID>.json`.

## 更新清单 update.json

模组元数据中的更新源支持两种形式:

```json
{ "source": "remote", "url": "https://example.com/update.json" }
```

```json
{ "source": "github", "repo": "owner/repository" }
```

`github` 会请求 `https://github.com/owner/repository/releases/latest/download/update.json`.

更新条目包含 `id`、`name`、`author`、`description`、`version`、`asarUrl` 和 `changelog`. `version` 必须是有效 semver. `asarUrl` 指向可下载的 `.asar` 文件. `changelog` 可以是文本、Markdown 或链接.

- 旧格式: 根节点为单个对象. 若对象声明了 `id`, 必须与当前模组 ID 相同.
- 新格式: 根节点为数组. 管理器按当前模组 ID 精确选择对应条目.

数组格式见 [examples/update.json](examples/update.json). 它演示一个 `update.json` 同时为多个模组提供更新信息.
