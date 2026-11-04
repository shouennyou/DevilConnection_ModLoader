// ModManager 主进程 IPC 注册.

const { ModManagerApi } = require('../ModManager/api');
const { ModLoaderApi } = require('../ModLoader/api');
const { Env: ModLoaderEnv } = require('../ModLoader/core');

/** 初始化单实例限制, 窗口快捷键和模组管理器目录. */
function initExtra() {
	// 单例锁必须在 app ready 前申请, 避免重复启动.
	const { app } = require('electron');
	if (!app.requestSingleInstanceLock()) {
		// 已有实例会处理 second-instance 事件并唤醒窗口.
		app.quit();
		return;
	}
	app.on('second-instance', () => {
		// 首个实例收到事件后唤醒已有窗口.
		const { BrowserWindow, dialog } = require('electron');
		const wins = BrowserWindow.getAllWindows();
		if (wins.length) {
			const win = wins[0];
			if (win.isMinimized()) win.restore();
			if (!win.isVisible()) win.show();
			win.focus();
			dialog.showMessageBox(win, {
				type: 'info',
				title: '应用程序已在运行',
				message: '无法启动多个实例',
				detail: '程序已在运行中,请使用当前窗口.',
				buttons: ['确定'],
				noLink: true,
			});
		}
	});

	// 在窗口内使用 F12 切换开发者工具.
	app.on('browser-window-created', (event, win) => {
		win.webContents.on('before-input-event', (e, input) => {
			if (input.type === 'keyDown' && input.key === 'F12') {
				win.webContents.toggleDevTools();
				e.preventDefault();
			}
		});
	});

	ModManagerApi.init();
}

/**
 * 注册渲染进程可调用的文件, 模组, 备份和 Steam IPC 接口.
 * @param {Electron.IpcMain} ipcMain Electron 主进程 IPC 对象.
 * @param {object} [deps] 宿主注入的可选依赖, 当前用于 Steam 状态访问.
 */
function registerIPCHandlers(ipcMain, deps = {}) {
	// 宿主 main.js 注入 Steam 状态访问器.
	const steam = deps || {};
	const fileStreams = new Map();
	const trackedStreamOwners = new Set();
	let nextStreamId = 0;

	// 渲染进程与主进程使用同一可写数据目录.
	ipcMain.on('modloader:getDataPath', (event) => {
		event.returnValue = ModLoaderEnv.getDataPath();
	});

	// 渲染进程销毁时关闭其全部流会话, 防止临时文件句柄遗留.
	const cleanupStreamsForOwner = (ownerId) => {
		for (const [id, entry] of fileStreams) {
			if (entry.ownerId !== ownerId) continue;
			fileStreams.delete(id);
			ModLoaderApi.closeStream(entry.stream);
		}
		trackedStreamOwners.delete(ownerId);
	};

	// 将流会话绑定到创建它的渲染进程, 后续请求必须由同一进程发起.
	const registerFileStream = (event, stream) => {
		const ownerId = event.sender.id;
		if (!trackedStreamOwners.has(ownerId)) {
			trackedStreamOwners.add(ownerId);
			event.sender.once('destroyed', () => cleanupStreamsForOwner(ownerId));
		}
		const id = String(++nextStreamId);
		fileStreams.set(id, { ownerId, stream });
		return id;
	};

	// 获取当前渲染进程拥有的流会话, 防止跨窗口访问.
	const takeFileStream = (event, id) => {
		const entry = fileStreams.get(String(id));
		if (!entry || entry.ownerId !== event.sender.id) return null;
		return entry;
	};

	// ReadFileSync: 输入 subPath. 同步读取相对 process.resourcesPath 的文本文件, 返回 string|null.
	ipcMain.on('modloader:readFileSync', (event, subPath) => {
		event.returnValue = ModLoaderApi.readFileSync(subPath || '');
	});

	// ReadFile: 输入 subPath. 异步读取相对 process.resourcesPath 的文本文件, 返回 Promise<string|null>.
	ipcMain.handle('modloader:readFile', async (event, subPath) => {
		return ModLoaderApi.readFile(subPath || '');
	});

	// WriteFileSync: 输入 {subPath, content}. 同步写入文本文件, 返回 {success, error?}.
	ipcMain.on('modloader:writeFileSync', (event, { subPath, content }) => {
		event.returnValue = ModLoaderApi.writeFileSync(subPath || '', content ?? '');
	});

	// WriteFile: 输入 {subPath, content}. 异步写入文本文件, 返回 Promise<{success, error?}>.
	ipcMain.handle('modloader:writeFile', async (event, { subPath, content }) => {
		return ModLoaderApi.writeFile(subPath || '', content ?? '');
	});

	// ReadBufferSync / ReadBuffer: 输入 subPath. 读取完整二进制文件, 分别返回 Buffer|null 和 Promise<Buffer|null>.
	ipcMain.on('modloader:readBufferSync', (event, subPath) => {
		event.returnValue = ModLoaderApi.readBufferSync(subPath || '');
	});
	ipcMain.handle('modloader:readBuffer', async (event, subPath) => {
		return ModLoaderApi.readBuffer(subPath || '');
	});

	// WriteBufferSync / WriteBuffer: 输入 {subPath, buffer}. 写入完整二进制文件, 分别返回 {success, error?} 和 Promise<{success, error?}>.
	ipcMain.on('modloader:writeBufferSync', (event, { subPath, buffer }) => {
		event.returnValue = ModLoaderApi.writeBufferSync(subPath || '', buffer);
	});
	ipcMain.handle('modloader:writeBuffer', async (event, { subPath, buffer }) => {
		return ModLoaderApi.writeBuffer(subPath || '', buffer);
	});

	// FileStream: 流会话仅保存在主进程, 渲染进程通过 id 顺序读写二进制块.
	// CreateReadStream 返回 {success, id?, size?, error?}, ReadStreamChunk 返回 {success, done?, chunk?, error?}.
	// CreateWriteStream 返回 {success, id?, error?}, WriteStreamChunk 和 CloseStream 返回 {success, error?}.
	ipcMain.handle('modloader:createReadStream', async (event, subPath) => {
		const result = ModLoaderApi.createReadStream(subPath || '');
		if (!result.success) return result;
		const { stream, ...info } = result;
		return { ...info, id: registerFileStream(event, stream) };
	});
	ipcMain.handle('modloader:readStreamChunk', async (event, { id, size }) => {
		const entry = takeFileStream(event, id);
		if (!entry || entry.stream.type !== 'read') return { success: false, error: '读流不存在或无权访问' };
		const result = ModLoaderApi.readStreamChunk(entry.stream, size);
		if (!result.success || result.done) fileStreams.delete(String(id));
		return result;
	});
	ipcMain.handle('modloader:createWriteStream', async (event, subPath) => {
		const result = ModLoaderApi.createWriteStream(subPath || '');
		if (!result.success) return result;
		const { stream, ...info } = result;
		return { ...info, id: registerFileStream(event, stream) };
	});
	ipcMain.handle('modloader:writeStreamChunk', async (event, { id, chunk }) => {
		const entry = takeFileStream(event, id);
		if (!entry || entry.stream.type !== 'write') return { success: false, error: '写流不存在或无权访问' };
		const result = ModLoaderApi.writeStreamChunk(entry.stream, chunk);
		if (!result.success) fileStreams.delete(String(id));
		return result;
	});
	ipcMain.handle('modloader:closeStream', async (event, { id, commit }) => {
		const entry = takeFileStream(event, id);
		if (!entry) return { success: false, error: '文件流不存在或无权访问' };
		fileStreams.delete(String(id));
		return ModLoaderApi.closeStream(entry.stream, commit === true);
	});

	// AppendFileSync / AppendFile: 输入 {subPath, content}. 追加文本文件内容, 分别返回 {success, error?} 和 Promise<{success, error?}>.
	ipcMain.on('modloader:appendFileSync', (event, { subPath, content }) => {
		event.returnValue = ModLoaderApi.appendFileSync(subPath || '', content ?? '');
	});
	ipcMain.handle('modloader:appendFile', async (event, { subPath, content }) => {
		return ModLoaderApi.appendFile(subPath || '', content ?? '');
	});

	// UnlinkSync / Unlink: 输入 subPath. 删除单个文件, 分别返回 {success, error?} 和 Promise<{success, error?}>.
	ipcMain.on('modloader:unlinkSync', (event, subPath) => {
		event.returnValue = ModLoaderApi.unlinkSync(subPath || '');
	});
	ipcMain.handle('modloader:unlink', async (event, subPath) => {
		return ModLoaderApi.unlink(subPath || '');
	});

	// RmdirSync / Rmdir: 输入 subPath. 递归删除目录, 分别返回 {success, error?} 和 Promise<{success, error?}>.
	ipcMain.on('modloader:rmdirSync', (event, subPath) => {
		event.returnValue = ModLoaderApi.rmdirSync(subPath || '');
	});
	ipcMain.handle('modloader:rmdir', async (event, subPath) => {
		return ModLoaderApi.rmdir(subPath || '');
	});

	// StatSync / Stat: 输入 subPath. 读取可跨 IPC 序列化的文件状态, 分别返回 FileStat|null 和 Promise<FileStat|null>.
	ipcMain.on('modloader:statSync', (event, subPath) => {
		event.returnValue = ModLoaderApi.statSync(subPath || '');
	});
	ipcMain.handle('modloader:stat', async (event, subPath) => {
		return ModLoaderApi.stat(subPath || '');
	});

	// GetSizeSync / GetSize: 输入 subPath. 获取文件或目录总大小, 单位为字节, 分别返回 number|null 和 Promise<number|null>.
	ipcMain.on('modloader:getSizeSync', (event, subPath) => {
		event.returnValue = ModLoaderApi.getSizeSync(subPath || '');
	});
	ipcMain.handle('modloader:getSize', async (event, subPath) => {
		return ModLoaderApi.getSize(subPath || '');
	});

	// ReaddirSync / Readdir: 输入 subPath. 读取目录项名称数组, 分别返回 string[]|null 和 Promise<string[]|null>.
	ipcMain.on('modloader:readdirSync', (event, subPath) => {
		event.returnValue = ModLoaderApi.readdirSync(subPath || '');
	});
	ipcMain.handle('modloader:readdir', async (event, subPath) => {
		return ModLoaderApi.readdir(subPath || '');
	});

	// ExistsSync / Exists: 输入 subPath. 判断文件或目录是否存在, 分别返回 boolean 和 Promise<boolean>.
	ipcMain.on('modloader:existsSync', (event, subPath) => {
		event.returnValue = ModLoaderApi.existsSync(subPath || '');
	});
	ipcMain.handle('modloader:exists', async (event, subPath) => {
		return ModLoaderApi.exists(subPath || '');
	});

	// RenameSync / Rename: 输入 {oldPath, newPath}. 重命名或移动文件, 分别返回 {success, error?} 和 Promise<{success, error?}>.
	ipcMain.on('modloader:renameSync', (event, { oldPath, newPath }) => {
		event.returnValue = ModLoaderApi.renameSync(oldPath || '', newPath || '');
	});
	ipcMain.handle('modloader:rename', async (event, { oldPath, newPath }) => {
		return ModLoaderApi.rename(oldPath || '', newPath || '');
	});

	// MkdirSync / Mkdir: 输入 subPath. 递归创建目录, 分别返回 {success, error?} 和 Promise<{success, error?}>.
	ipcMain.on('modloader:mkdirSync', (event, subPath) => {
		event.returnValue = ModLoaderApi.mkdirSync(subPath || '');
	});
	ipcMain.handle('modloader:mkdir', async (event, subPath) => {
		return ModLoaderApi.mkdir(subPath || '');
	});

	// CopyFileSync / CopyFile: 输入 {srcPath, destPath}. 复制文件, 分别返回 {success, error?} 和 Promise<{success, error?}>.
	ipcMain.on('modloader:copyFileSync', (event, { srcPath, destPath }) => {
		event.returnValue = ModLoaderApi.copyFileSync(srcPath || '', destPath || '');
	});
	ipcMain.handle('modloader:copyFile', async (event, { srcPath, destPath }) => {
		return ModLoaderApi.copyFile(srcPath || '', destPath || '');
	});

	// List: 输入 subPath. 返回 Promise<Array<{name, isDir, isAsar}>>.
	ipcMain.handle('modmanager:list', async (event, subPath) => {
		return ModManagerApi.list(subPath || '');
	});

	// ReadFileSync: 输入 subPath. 同步读取文件内容, 返回 string|null, ASAR 内部路径会自动选择归档读取方式.
	ipcMain.on('modmanager:readFileSync', (event, subPath) => {
		event.returnValue = ModManagerApi.readFileSync(subPath || '');
	});

	// ReadAsarFileSync: 输入 subPath. 同步读取 ASAR 内部文件, 返回 string|null.
	ipcMain.on('modmanager:readAsarFileSync', (event, subPath) => {
		event.returnValue = ModManagerApi.readAsarFileSync(subPath || '');
	});

	// ReadFile: 输入 subPath. 异步读取文件内容, 返回 Promise<string|null>, ASAR 内部路径会自动选择归档读取方式.
	ipcMain.handle('modmanager:readFile', async (event, subPath) => {
		return ModManagerApi.readFile(subPath || '');
	});

	// ReadAsarFile: 输入 subPath. 异步读取 ASAR 内部文件, 返回 Promise<string|null>.
	ipcMain.handle('modmanager:readAsarFile', async (event, subPath) => {
		return ModManagerApi.readAsarFile(subPath || '');
	});

	// ScanModInfos: 扫描所有模组的 modloader.mod.json 元信息, 返回 Promise<ModMeta[]>.
	ipcMain.handle('modmanager:scanModInfos', async () => {
		return ModManagerApi.scanModInfos();
	});

	// SelectLocalModFile: 使用主进程原生文件对话框选择外部 ASAR 模组.
	ipcMain.handle('modmanager:selectLocalModFile', async () => {
		return ModManagerApi.selectLocalModFile();
	});
	// ImportLocalModFile: 由主进程将已选择的外部 ASAR 复制到模组目录.
	ipcMain.handle('modmanager:importLocalModFile', async (event, sourcePath) => {
		return ModManagerApi.importLocalModFile(sourcePath || '');
	});

	// DownloadAndReplace: 输入 {url, fileName}. 下载新版 ASAR 并原地替换, 最终结果通过 modmanager:download-progress 的 result 字段返回 {success, message?}.
	ipcMain.on('modmanager:downloadAndReplace', async (event, { url, fileName }) => {
		const result = await ModManagerApi.downloadAndReplace(url, fileName, (received, total) => {
			event.sender.send('modmanager:download-progress', { fileName, received, total });
		});
		event.sender.send('modmanager:download-progress', { fileName, received: -1, total: 0, result });
	});

	// SetModOrder: 输入 orderedMods. 更新模组顺序与启用状态, 返回 Promise<boolean>.
	ipcMain.handle('modmanager:setModOrder', async (event, orderedMods) => {
		return ModManagerApi.setModOrder(orderedMods || []);
	});

	// FetchText: 输入 url. 由主进程发起 HTTP(S) GET 请求, 返回 Promise<{success, status?, text?, message?}>.
	ipcMain.handle('modmanager:fetchText', async (event, url) => {
		return ModManagerApi.fetchText(url || '');
	});

	// GetDataDirectory: 返回程序可写数据目录.
	ipcMain.handle('modmanager:getDataDirectory', async () => {
		return ModManagerApi.getDataDirectory();
	});
	// OpenDataDirectory: 使用系统文件管理器打开程序数据目录.
	ipcMain.handle('modmanager:openDataDirectory', async () => {
		return ModManagerApi.openDataDirectory();
	});

	// GetGameCoreStatus: 返回 Promise<{path, configured, exists}>.
	ipcMain.handle('modmanager:getGameCoreStatus', async () => {
		return ModManagerApi.getGameCoreStatus();
	});
	// SelectGameCoreFile: 打开文件选择对话框并保存游戏核心路径, 返回 Promise<{success, canceled?, path?, message?}>.
	ipcMain.handle('modmanager:selectGameCoreFile', async () => {
		return ModManagerApi.selectGameCoreFile();
	});
	// ClearGameCoreFile: 清除已保存的游戏核心路径, 返回 Promise<{success, message?}>.
	ipcMain.handle('modmanager:clearGameCoreFile', async () => {
		return ModManagerApi.clearGameCoreFile();
	});
	// GetSaveImportStatus: 返回外部存档来源目录配置、可访问状态和可导入存档数.
	ipcMain.handle('modmanager:getSaveImportStatus', async () => {
		return ModManagerApi.getSaveImportStatus();
	});
	// SelectSaveImportDirectory: 选择并保存原版存档来源目录, 不复制文件.
	ipcMain.handle('modmanager:selectSaveImportDirectory', async () => {
		return ModManagerApi.selectSaveImportDirectory();
	});
	// ClearSaveImportDirectory: 清除已保存的存档来源目录, 不删除原文件.
	ipcMain.handle('modmanager:clearSaveImportDirectory', async () => {
		return ModManagerApi.clearSaveImportDirectory();
	});
	// ImportSaves: 确认后清空独立版现有 .sav, 再导入来源目录中的 .sav 文件.
	ipcMain.handle('modmanager:importSaves', async (event, replaceExisting) => {
		return ModManagerApi.importSavesFromConfiguredDirectory(replaceExisting === true);
	});

	// GetModLoaderPackageInfo: 通过模块自身路径读取包元数据, 返回 Promise<{name, version}|null>.
	ipcMain.handle('modmanager:getModLoaderPackageInfo', async () => {
		return ModManagerApi.getModLoaderPackageInfo();
	});

	// ─── 存档备份 ────────────────────────────────────────────────────────────────

	// List: 列出所有备份, 返回 Promise<Array<{file, locked, time, size}>>.
	ipcMain.handle('backup:list', async () => {
		return ModManagerApi.listBackups();
	});

	// Create: 输入 name. 将 _storage 中的 .sav 存档压缩为备份, 返回 Promise<{success, file?, count?, noSave?, message?}>.
	ipcMain.handle('backup:create', async (event, name) => {
		return ModManagerApi.createBackup(name || '');
	});

	// Restore: 输入 file. 将备份解压回 _storage 目录, 返回 Promise<{success, count?, message?}>.
	ipcMain.handle('backup:restore', async (event, file) => {
		return ModManagerApi.restoreBackup(file || '');
	});

	// Delete: 输入 file. 删除未锁定的备份, 返回 Promise<{success, message?}>.
	ipcMain.handle('backup:delete', async (event, file) => {
		return ModManagerApi.deleteBackup(file || '');
	});

	// Rename: 输入 {oldName, newName}. 重命名备份, 返回 Promise<{success, file?, message?}>.
	ipcMain.handle('backup:rename', async (event, { oldName, newName }) => {
		return ModManagerApi.renameBackup(oldName || '', newName || '');
	});

	// SetLock: 输入 {file, locked}. 设置备份锁定状态, 返回 Promise<{success, message?}>.
	ipcMain.handle('backup:setLock', async (event, { file, locked }) => {
		return ModManagerApi.setBackupLock(file || '', locked === true);
	});

	// Export: 输入 file. 通过保存对话框导出备份, 返回 Promise<{success, path?, canceled?, message?}>.
	ipcMain.handle('backup:export', async (event, file) => {
		const srcPath = ModManagerApi.getBackupFilePath(file || '');
		const fs = require('fs');
		if (!file || !fs.existsSync(srcPath)) {
			return { success: false, message: '备份不存在' };
		}
		const { dialog, BrowserWindow } = require('electron');
		const win = BrowserWindow.getFocusedWindow();
		const result = await dialog.showSaveDialog(win, {
			title: '导出备份',
			defaultPath: file,
			filters: [{ name: 'Zip 压缩包', extensions: ['zip'] }],
		});
		if (result.canceled || !result.filePath) {
			return { success: false, canceled: true };
		}
		try {
			fs.copyFileSync(srcPath, result.filePath);
			return { success: true, path: result.filePath };
		} catch (error) {
			console.error('[ModManager] 导出备份失败:', error);
			return { success: false, message: error.message };
		}
	});

	// Import: 通过打开对话框选择外部 ZIP 文件并导入 backups 目录, 返回 Promise<{success, file?, canceled?, message?}>.
	ipcMain.handle('backup:import', async () => {
		const { dialog, BrowserWindow } = require('electron');
		const win = BrowserWindow.getFocusedWindow();
		const result = await dialog.showOpenDialog(win, {
			title: '导入备份',
			filters: [{ name: 'Zip 压缩包', extensions: ['zip'] }],
			properties: ['openFile'],
		});
		if (result.canceled || !result.filePaths.length) {
			return { success: false, canceled: true };
		}
		return ModManagerApi.importBackup(result.filePaths[0]);
	});

	// Cleanup: 输入 {retainDays, retainCount}. 按保留策略清理未锁定的备份, 返回 Promise<{success, deleted}>.
	ipcMain.handle('backup:cleanup', async (event, { retainDays, retainCount }) => {
		return ModManagerApi.cleanupBackups(Number(retainDays) || 0, Number(retainCount) || 0);
	});

	// ─── Steam 开关/状态(访问器由宿主壳注入) ────────────────────────────────────────

	// GetEnabled: 查询当前配置的 Steam 开关状态, 返回 Promise<boolean>.
	ipcMain.handle('steamworks:getEnabled', async () => {
		return typeof steam.isSteamConfigured === 'function' ? steam.isSteamConfigured() : true;
	});

	// GetStatus: 查询 Steam 运行时状态, 返回 Promise<{configured, active}>.
	// 配置字段 configured 表示是否启用 Steam 模式, active 表示 Steam 通讯是否已成功连接.
	ipcMain.handle('steamworks:getStatus', async () => {
		return {
			configured: typeof steam.isSteamConfigured === 'function' ? steam.isSteamConfigured() : true,
			active: typeof steam.isSteamActive === 'function' ? steam.isSteamActive() : false,
		};
	});

	// SetEnabled: 输入 enabled. 切换 Steam 开关后退出程序, 返回 Promise<void>.
	ipcMain.handle('steamworks:setEnabled', async (event, enabled) => {
		if (typeof steam.setSteamConfigured === 'function') {
			steam.setSteamConfigured(enabled === true);
		}
		require('electron').app.exit(0);
	});
}

module.exports = { initExtra, registerIPCHandlers };
