// preload_extra.js - 管理器预加载 API.
const {
	ipcRenderer
} = require('electron');

// ─── ModManager CRUD ──────────────────────────────────────────────────────────
// 所有相对路径由主进程按写入权限解析至 resourcesPath 或 userData.

const modManagerAPI = {
	/** 列出 subPath 目录下的文件/文件夹/asar,返回数组 [{name, isDir, isAsar}] */
	list: async (subPath) => {
		return await ipcRenderer.invoke('modmanager:list', subPath || '');
	},

	/** 同步读取文件内容;asar 内部路径自动选择对应读取方式,失败返回 null */
	readFileSync: (subPath) => {
		return ipcRenderer.sendSync('modmanager:readFileSync', subPath || '');
	},

	/** 同步读取 .asar 内部文件,subPath 格式为 mods/example.asar/path/in/archive.json */
	readAsarFileSync: (subPath) => {
		return ipcRenderer.sendSync('modmanager:readAsarFileSync', subPath || '');
	},

	/** 异步读取文件内容;asar 内部路径自动选择对应读取方式,失败返回 null */
	readFile: async (subPath) => {
		return await ipcRenderer.invoke('modmanager:readFile', subPath || '');
	},

	/** 异步读取 .asar 内部文件,失败返回 null */
	readAsarFile: async (subPath) => {
		return await ipcRenderer.invoke('modmanager:readAsarFile', subPath || '');
	},

	/** 扫描所有模组的 modloader.mod.json 元信息,返回数组 */
	scanModInfos: async () => {
		return await ipcRenderer.invoke('modmanager:scanModInfos');
	},

	/** 使用主进程原生文件对话框选择外部 ASAR 模组. */
	selectLocalModFile: async () => {
		return await ipcRenderer.invoke('modmanager:selectLocalModFile');
	},

	/** 在主进程将外部 ASAR 复制到模组目录. */
	importLocalModFile: async (sourcePath) => {
		return await ipcRenderer.invoke('modmanager:importLocalModFile', sourcePath || '');
	},

	/** 下载新版本 asar 并原地替换,返回 Promise<{success, message?}> */
	downloadAndReplace: (url, fileName) => {
		// 用 ipcRenderer.send 触发异步下载,不阻塞主线程
		ipcRenderer.send('modmanager:downloadAndReplace', { url, fileName });
		// 实际结果通过 onDownloadProgress 回调中的 result 事件传回
		return new Promise((resolve) => {
			// 注册一次性监听,等主进程推送最终结果
			const key = `modmanager:download-progress:${fileName}`;
			const handler = (event, data) => {
				if (data.fileName !== fileName) return;
				if (data.result !== undefined) {
					ipcRenderer.removeListener('modmanager:download-progress', handler);
					resolve(data.result);
				}
			};
			ipcRenderer.on('modmanager:download-progress', handler);
		});
	},

	/** 注册下载进度回调,签名为 ({fileName, received, total, result}) => void */
	onDownloadProgress: (callback) => {
		ipcRenderer.on('modmanager:download-progress', (event, data) => {
			callback(data);
		});
	},

	/** 更新模组顺序与启用状态, 返回是否写入成功. */
	setModOrder: async (orderedMods) => {
		return await ipcRenderer.invoke('modmanager:setModOrder', orderedMods || []);
	},

	/** 主进程发起 HTTP(S) GET 返回文本(绕过 CORS),返回 {success, status?, text?, message?} */
	fetchText: async (url) => {
		return await ipcRenderer.invoke('modmanager:fetchText', url || '');
	},
	/** 返回程序可写数据目录. */
	getDataDirectory: async () => {
		return await ipcRenderer.invoke('modmanager:getDataDirectory');
	},
	/** 使用系统文件管理器打开程序数据目录. */
	openDataDirectory: async () => {
		return await ipcRenderer.invoke('modmanager:openDataDirectory');
	},

	/** 返回 Promise<{path, configured, exists}>. */
	getGameCoreStatus: async () => {
		return await ipcRenderer.invoke('modmanager:getGameCoreStatus');
	},

	/** 打开主进程文件选择对话框并保存游戏核心路径, 返回 Promise<{success, canceled?, path?, message?}>. */
	selectGameCoreFile: async () => {
		return await ipcRenderer.invoke('modmanager:selectGameCoreFile');
	},

	/** 清除已保存的游戏核心路径, 返回 Promise<{success, message?}>. */
	clearGameCoreFile: async () => {
		return await ipcRenderer.invoke('modmanager:clearGameCoreFile');
	},

	/** 返回外部存档来源目录的配置、可访问状态和可导入存档数. */
	getSaveImportStatus: async () => {
		return await ipcRenderer.invoke('modmanager:getSaveImportStatus');
	},

	/** 打开目录选择对话框并保存原版存档来源目录. */
	selectSaveImportDirectory: async () => {
		return await ipcRenderer.invoke('modmanager:selectSaveImportDirectory');
	},

	/** 清除已保存的存档来源目录, 不删除来源文件. */
	clearSaveImportDirectory: async () => {
		return await ipcRenderer.invoke('modmanager:clearSaveImportDirectory');
	},

	/** 确认后清空独立版现有 .sav, 再导入来源目录顶层的 .sav 文件. */
	importSaves: async (replaceExisting) => {
		return await ipcRenderer.invoke('modmanager:importSaves', replaceExisting === true);
	},

	/** 读取当前 ModLoader 的包名和版本,兼容开发与打包环境 */
	getModLoaderPackageInfo: async () => {
		return await ipcRenderer.invoke('modmanager:getModLoaderPackageInfo');
	},

};

/**
 * 把主进程传来的 stat DTO 重建为带方法的对象,贴合原生 fs.Stats 用法.
 * 进程通信只序列化普通属性, fs.Stats 的 isFile()/isDirectory() 等方法会丢失.
 * 主进程已把类型判定求值成布尔位(见 core.js statToDTO),这里据此还原为方法.
 * @param {object|null} dto
 * @returns {object|null}
 */
function reviveStats(dto) {
	if (!dto) return null;
	return {
		...dto,
		isFile: () => dto.isFile,
		isDirectory: () => dto.isDirectory,
		isSymbolicLink: () => dto.isSymbolicLink,
		isBlockDevice: () => dto.isBlockDevice,
		isCharacterDevice: () => dto.isCharacterDevice,
		isFIFO: () => dto.isFIFO,
		isSocket: () => dto.isSocket,
	};
}

const modLoaderAPI = {
	/** 返回主进程按写入权限判定后的数据根目录. */
	returnModLoaderDataPath: () => {
		return ipcRenderer.sendSync('modloader:getDataPath');
	},
	/** 同步读取 subPath 文件内容,返回字符串,失败返回 null */
	readFileSync: (subPath) => {
		return ipcRenderer.sendSync('modloader:readFileSync', subPath || '');
	},
	/** 异步读取 subPath 文件内容,返回字符串,失败返回 null */
	readFile: async (subPath) => {
		return await ipcRenderer.invoke('modloader:readFile', subPath || '');
	},
	/** 同步写入 subPath 文件内容(自动创建父目录),返回 {success, error?} */
	writeFileSync: (subPath, content) => {
		return ipcRenderer.sendSync('modloader:writeFileSync', { subPath: subPath || '', content: content ?? '' });
	},
	/** 异步写入 subPath 文件内容(自动创建父目录),返回 {success, error?} */
	writeFile: async (subPath, content) => {
		return await ipcRenderer.invoke('modloader:writeFile', { subPath: subPath || '', content: content ?? '' });
	},
	/** 同步读取完整二进制文件,返回 Uint8Array 或 null */
	readBufferSync: (subPath) => {
		return ipcRenderer.sendSync('modloader:readBufferSync', subPath || '');
	},
	/** 异步读取完整二进制文件,返回 Uint8Array 或 null */
	readBuffer: async (subPath) => {
		return await ipcRenderer.invoke('modloader:readBuffer', subPath || '');
	},
	/** 同步写入完整二进制文件(自动创建父目录),buffer 传 ArrayBuffer,返回 {success, error?} */
	writeBufferSync: (subPath, buffer) => {
		return ipcRenderer.sendSync('modloader:writeBufferSync', { subPath: subPath || '', buffer });
	},
	/** 异步写入完整二进制文件(自动创建父目录),buffer 传 ArrayBuffer,返回 {success, error?} */
	writeBuffer: async (subPath, buffer) => {
		return await ipcRenderer.invoke('modloader:writeBuffer', { subPath: subPath || '', buffer });
	},
	/** 创建二进制读流会话,返回 {success, id?, size?, error?}. */
	createReadStream: async (subPath) => {
		return await ipcRenderer.invoke('modloader:createReadStream', subPath || '');
	},
	/** 读取读流会话的下一块数据,size 最大为 1 MiB. */
	readStreamChunk: async (id, size) => {
		return await ipcRenderer.invoke('modloader:readStreamChunk', { id, size });
	},
	/** 创建二进制写流会话;关闭并提交前不会覆盖目标文件. */
	createWriteStream: async (subPath) => {
		return await ipcRenderer.invoke('modloader:createWriteStream', subPath || '');
	},
	/** 向写流会话追加一个 ArrayBuffer / Uint8Array 数据块. */
	writeStreamChunk: async (id, chunk) => {
		return await ipcRenderer.invoke('modloader:writeStreamChunk', { id, chunk });
	},
	/** 关闭流会话;写流仅在 commit=true 时以临时文件替换目标. */
	closeStream: async (id, commit) => {
		return await ipcRenderer.invoke('modloader:closeStream', { id, commit: commit === true });
	},
	/** 同步追加文本(自动创建父目录),返回 {success, error?} */
	appendFileSync: (subPath, content) => {
		return ipcRenderer.sendSync('modloader:appendFileSync', { subPath: subPath || '', content: content ?? '' });
	},
	/** 异步追加文本(自动创建父目录),返回 {success, error?} */
	appendFile: async (subPath, content) => {
		return await ipcRenderer.invoke('modloader:appendFile', { subPath: subPath || '', content: content ?? '' });
	},
	/** 同步删除文件,返回 {success, error?} */
	unlinkSync: (subPath) => {
		return ipcRenderer.sendSync('modloader:unlinkSync', subPath || '');
	},
	/** 异步删除文件,返回 {success, error?} */
	unlink: async (subPath) => {
		return await ipcRenderer.invoke('modloader:unlink', subPath || '');
	},
	/** 同步递归删除文件夹(不存在视为成功),返回 {success, error?} */
	rmdirSync: (subPath) => {
		return ipcRenderer.sendSync('modloader:rmdirSync', subPath || '');
	},
	/** 异步递归删除文件夹(不存在视为成功),返回 {success, error?} */
	rmdir: async (subPath) => {
		return await ipcRenderer.invoke('modloader:rmdir', subPath || '');
	},
	/** 同步获取文件状态,不存在返回 null */
	statSync: (subPath) => {
		return reviveStats(ipcRenderer.sendSync('modloader:statSync', subPath || ''));
	},
	/** 异步获取文件状态,不存在返回 null */
	stat: async (subPath) => {
		return reviveStats(await ipcRenderer.invoke('modloader:stat', subPath || ''));
	},
	/** 同步获取文件或目录大小(目录包含全部子项),失败返回 null */
	getSizeSync: (subPath) => {
		return ipcRenderer.sendSync('modloader:getSizeSync', subPath || '');
	},
	/** 异步获取文件或目录大小(目录包含全部子项),失败返回 null */
	getSize: async (subPath) => {
		return await ipcRenderer.invoke('modloader:getSize', subPath || '');
	},
	/** 同步读取目录项名数组,失败返回 null */
	readdirSync: (subPath) => {
		return ipcRenderer.sendSync('modloader:readdirSync', subPath || '');
	},
	/** 异步读取目录项名数组,失败返回 null */
	readdir: async (subPath) => {
		return await ipcRenderer.invoke('modloader:readdir', subPath || '');
	},
	/** 同步判断文件或目录是否存在,返回 boolean */
	existsSync: (subPath) => {
		return ipcRenderer.sendSync('modloader:existsSync', subPath || '');
	},
	/** 异步判断文件或目录是否存在,返回 boolean */
	exists: async (subPath) => {
		return await ipcRenderer.invoke('modloader:exists', subPath || '');
	},
	/** 同步重命名/移动(自动创建目标父目录),返回 {success, error?} */
	renameSync: (oldPath, newPath) => {
		return ipcRenderer.sendSync('modloader:renameSync', { oldPath: oldPath || '', newPath: newPath || '' });
	},
	/** 异步重命名/移动(自动创建目标父目录),返回 {success, error?} */
	rename: async (oldPath, newPath) => {
		return await ipcRenderer.invoke('modloader:rename', { oldPath: oldPath || '', newPath: newPath || '' });
	},
	/** 同步创建目录(recursive),返回 {success, error?} */
	mkdirSync: (subPath) => {
		return ipcRenderer.sendSync('modloader:mkdirSync', subPath || '');
	},
	/** 异步创建目录(recursive),返回 {success, error?} */
	mkdir: async (subPath) => {
		return await ipcRenderer.invoke('modloader:mkdir', subPath || '');
	},
	/** 同步复制文件(自动创建目标父目录),返回 {success, error?} */
	copyFileSync: (srcPath, destPath) => {
		return ipcRenderer.sendSync('modloader:copyFileSync', { srcPath: srcPath || '', destPath: destPath || '' });
	},
	/** 异步复制文件(自动创建目标父目录),返回 {success, error?} */
	copyFile: async (srcPath, destPath) => {
		return await ipcRenderer.invoke('modloader:copyFile', { srcPath: srcPath || '', destPath: destPath || '' });
	},
};

// ─── 存档备份 ──────────────────────────────────────────────────────────────────
const backupAPI = {
	/** 列出所有备份,返回 [{file, locked, time, size}] */
	list: async () => {
		return await ipcRenderer.invoke('backup:list');
	},
	/** 创建备份(压缩 _storage 的 .sav),返回 {success, file?, count?, message?} */
	create: async (name) => {
		return await ipcRenderer.invoke('backup:create', name || '');
	},
	/** 恢复备份(解压回 _storage),返回 {success, message?} */
	restore: async (file) => {
		return await ipcRenderer.invoke('backup:restore', file || '');
	},
	/** 删除备份(锁定的禁止删除),返回 {success, message?} */
	delete: async (file) => {
		return await ipcRenderer.invoke('backup:delete', file || '');
	},
	/** 重命名备份,返回 {success, file?, message?} */
	rename: async (oldName, newName) => {
		return await ipcRenderer.invoke('backup:rename', { oldName, newName });
	},
	/** 设置锁定状态,返回 {success, message?} */
	setLock: async (file, locked) => {
		return await ipcRenderer.invoke('backup:setLock', { file, locked });
	},
	/** 导出备份(弹保存对话框),返回 {success, path?, canceled?, message?} */
	export: async (file) => {
		return await ipcRenderer.invoke('backup:export', file || '');
	},
	/** 导入外部备份(弹开文件对话框),返回 {success, file?, canceled?, message?} */
	import: async () => {
		return await ipcRenderer.invoke('backup:import');
	},
	/** 按保留策略清理备份(锁定的排除),返回 {success, deleted} */
	cleanup: async (retainDays, retainCount) => {
		return await ipcRenderer.invoke('backup:cleanup', { retainDays, retainCount });
	},
};

const api_extra = {
	modloader: modLoaderAPI,
	modmanager: modManagerAPI,
	backup: backupAPI,
	// ─── Steam 模式开关/状态(顶层暴露,保持 window.api.getSteamXxx 契约) ───────────────
	/** 查询当前配置的 Steam 开关状态 */
	getSteamEnabled: async () => {
		return await ipcRenderer.invoke('steamworks:getEnabled');
	},
	/** 查询 Steam 运行时状态 { configured, active }(configured:模式是否开启;active:是否已连接) */
	getSteamStatus: async () => {
		return await ipcRenderer.invoke('steamworks:getStatus');
	},
	/** 切换 Steam 开关(写配置后退出程序,需用户手动重启生效;调用后进程即退出) */
	setSteamEnabled: async (enabled) => {
		return await ipcRenderer.invoke('steamworks:setEnabled', enabled);
	},
};

module.exports = api_extra;
