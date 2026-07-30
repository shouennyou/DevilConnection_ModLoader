/**
 * ============================================================================
 * ModManager 文件管理和存档备份 API.
 * ============================================================================
 * 实现 window.api.modmanager 和 window.api.backup 的主进程操作.
 * 常量,环境,日志和压缩工具位于同目录 core.js.
 */

const path = require('path');
const { randomUUID } = require('crypto');
const AsarReader = require('../utils/AsarReader');
const { ModLoaderApi, resolveResourcePath } = require('../ModLoader/api');
const {
	originalFs,
	CONFIG_DIR,
	MOD_ORDER_FILE,
	APP_CONFIG_FILE,
	GAME_CORE_PATH_KEY,
	SAVE_IMPORT_DIR_KEY,
	BACKUP_DIR,
	BACKUP_LOCK_FILE,
	STORAGE_DIR,
	SAV_EXT,
	Env,
	Logger,
	zipFiles,
	extractSavesFlat,
} = require('./core');

/**
 * 规范化备份文件名. 备份仅允许位于 backups 根目录中的单层 ZIP 文件.
 * @param {unknown} value
 * @param {{ appendExtension?: boolean }} [options]
 * @returns {string|null}
 */
function normalizeBackupFileName(value, options = {}) {
	if (typeof value !== 'string') return null;
	let fileName = value.trim();
	if (!fileName || fileName.includes('\0')) return null;
	if (path.isAbsolute(fileName)
		|| fileName !== path.basename(fileName)
		|| fileName.includes('/')
		|| fileName.includes('\\')
		|| fileName.includes(':')
		|| fileName === '.'
		|| fileName === '..') {
		return null;
	}
	if (options.appendExtension && !fileName.toLowerCase().endsWith('.zip')) {
		fileName += '.zip';
	}
	return fileName.toLowerCase().endsWith('.zip') ? fileName : null;
}

const ModManagerApi = {
	resourcesPath: Env.getResourcesPath(),
	dataPath: Env.getDataPath(),
	pluginDir: '',

	init() {
		this.pluginDir = Env.getPluginDir();
		const configDir = path.join(this.dataPath, CONFIG_DIR);
		if (!originalFs.existsSync(this.pluginDir)) {
			originalFs.mkdirSync(this.pluginDir, { recursive: true });
		}
		if (!originalFs.existsSync(configDir)) {
			originalFs.mkdirSync(configDir, { recursive: true });
		}
		this.ensureModOrder();
	},

	/** 返回程序可写数据目录. */
	getDataDirectory() {
		return this.dataPath;
	},

	/** 使用系统文件管理器打开程序数据目录. */
	async openDataDirectory() {
		try {
			if (!originalFs.existsSync(this.dataPath)) {
				originalFs.mkdirSync(this.dataPath, { recursive: true });
			}
			const { shell } = require('electron');
			const openResult = shell.openPath(this.dataPath);
			if (process.platform === 'linux') {
				// 部分 Linux 桌面环境会打开目录但不结束 openPath 的 Promise, 不能阻塞 IPC 回复.
				void Promise.resolve(openResult).then(message => {
					if (message) Logger.error(`打开程序数据目录失败: ${message}`);
				}).catch(error => {
					Logger.error('打开程序数据目录失败', error);
				});
				return { success: true, path: this.dataPath };
			}
			const message = await openResult;
			return message
				? { success: false, path: this.dataPath, message }
				: { success: true, path: this.dataPath };
		} catch (error) {
			Logger.error('打开程序数据目录失败', error);
			return { success: false, path: this.dataPath, message: error.message || String(error) };
		}
	},

	/** 返回模组顺序配置路径. */
	getModOrderPath() {
		return path.join(this.dataPath, CONFIG_DIR, MOD_ORDER_FILE);
	},

	/** 返回包含界面设置及游戏核心路径的应用配置文件路径. */
	getAppConfigPath() {
		return path.join(this.dataPath, CONFIG_DIR, APP_CONFIG_FILE);
	},

	/** 读取应用配置. 配置缺失, 格式错误或根节点不是对象时返回空对象. */
	readAppConfig() {
		const configFile = this.getAppConfigPath();
		if (!originalFs.existsSync(configFile)) return {};
		try {
			const config = JSON.parse(originalFs.readFileSync(configFile, 'utf-8'));
			return config && typeof config === 'object' && !Array.isArray(config) ? config : {};
		} catch (error) {
			Logger.error(`解析 ${APP_CONFIG_FILE} 失败`, error);
			return {};
		}
	},

	/** 写入应用配置, 保持调用方传入的未知设置字段. */
	writeAppConfig(config) {
		const configFile = this.getAppConfigPath();
		try {
			if (!originalFs.existsSync(path.dirname(configFile))) {
				originalFs.mkdirSync(path.dirname(configFile), { recursive: true });
			}
			originalFs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf-8');
			return true;
		} catch (error) {
			Logger.error(`写入 ${APP_CONFIG_FILE} 失败`, error);
			return false;
		}
	},

	/** 从应用配置中读取经过规范化的游戏核心绝对路径. */
	getConfiguredGameCorePath() {
		const value = this.readAppConfig()[GAME_CORE_PATH_KEY];
		if (typeof value !== 'string' || !value.trim()) return null;
		const gameCorePath = path.normalize(value.trim());
		return path.isAbsolute(gameCorePath) ? gameCorePath : null;
	},

	/** 判断 mods 根目录中的条目是否就是当前选择的游戏核心文件. */
	isSelectedGameCoreEntry(name) {
		const gameCorePath = this.getConfiguredGameCorePath();
		if (!gameCorePath || !this.isPluginEntryName(name)) return false;
		return path.resolve(this.pluginDir, name).toLowerCase() === gameCorePath.toLowerCase();
	},

	/** 使用 original-fs 验证游戏核心是实际存在的 ASAR 普通文件. */
	isGameCoreFile(gameCorePath) {
		if (typeof gameCorePath !== 'string'
			|| !path.isAbsolute(gameCorePath)
			|| path.extname(gameCorePath).toLowerCase() !== '.asar') {
			return false;
		}
		try {
			return originalFs.statSync(gameCorePath).isFile();
		} catch (error) {
			return false;
		}
	},

	/** 返回游戏核心路径是否已配置以及源文件是否仍可访问. */
	getGameCoreStatus() {
		const gameCorePath = this.getConfiguredGameCorePath();
		return {
			path: gameCorePath,
			configured: gameCorePath !== null,
			exists: gameCorePath !== null && this.isGameCoreFile(gameCorePath),
		};
	},

	/** 由主进程显示文件选择对话框, 保存用户选择的路径而不复制文件. */
	async selectGameCoreFile() {
		const { BrowserWindow, dialog } = require('electron');
		const options = {
			title: '选择游戏核心文件',
			properties: ['openFile'],
			filters: [{ name: 'Electron ASAR', extensions: ['asar'] }],
		};
		const parent = BrowserWindow.getFocusedWindow();
		const result = parent
			? await dialog.showOpenDialog(parent, options)
			: await dialog.showOpenDialog(options);
		if (result.canceled || result.filePaths.length === 0) {
			return { success: false, canceled: true };
		}

		const gameCorePath = path.resolve(result.filePaths[0]);
		if (!this.isGameCoreFile(gameCorePath)) {
			return { success: false, message: '请选择存在的 .asar 文件' };
		}

		const success = this.writeAppConfig({
			...this.readAppConfig(),
			[GAME_CORE_PATH_KEY]: gameCorePath,
		});
		return success
			? { success: true, path: gameCorePath }
			: { success: false, message: '保存游戏核心路径失败' };
	},

	/** 返回可安全导入的外部 ASAR 模组文件信息. */
	getLocalModFileInfo(sourcePath) {
		if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) return null;
		const fullPath = path.normalize(sourcePath);
		const fileName = path.basename(fullPath);
		if (!this.isPluginEntryName(fileName) || path.extname(fileName).toLowerCase() !== '.asar') return null;
		try {
			const stat = originalFs.statSync(fullPath);
			return stat.isFile() ? { path: fullPath, fileName, size: stat.size } : null;
		} catch (error) {
			return null;
		}
	},

	/** 由主进程选择要导入的本地 ASAR 模组, 避开 Chromium File API. */
	async selectLocalModFile() {
		const { BrowserWindow, dialog } = require('electron');
		const options = {
			title: '选择本地模组',
			properties: ['openFile'],
			filters: [{ name: 'ModLoader ASAR', extensions: ['asar'] }],
		};
		const parent = BrowserWindow.getFocusedWindow();
		const result = parent
			? await dialog.showOpenDialog(parent, options)
			: await dialog.showOpenDialog(options);
		if (result.canceled || result.filePaths.length === 0) {
			return { success: false, canceled: true };
		}

		const info = this.getLocalModFileInfo(result.filePaths[0]);
		return info
			? { success: true, ...info }
			: { success: false, message: '请选择存在的 .asar 模组文件' };
	},

	/**
	 * 在主进程复制外部 ASAR 到模组目录.
	 * 先写入同目录临时文件, 成功后再替换目标文件.
	 */
	async importLocalModFile(sourcePath) {
		const source = this.getLocalModFileInfo(sourcePath);
		if (!source) return { success: false, message: '所选模组文件无法访问' };

		const targetPath = path.join(this.pluginDir || Env.getPluginDir(), source.fileName);
		let tempPath = '';
		try {
			originalFs.mkdirSync(path.dirname(targetPath), { recursive: true });
			tempPath = path.join(path.dirname(targetPath), `.${source.fileName}.${randomUUID()}.upload`);
			await new Promise((resolve, reject) => {
				originalFs.copyFile(source.path, tempPath, error => error ? reject(error) : resolve());
			});
			originalFs.renameSync(tempPath, targetPath);
			tempPath = '';
			AsarReader.uncacheAsar(targetPath);
			Logger.info(`导入本地模组成功: ${source.fileName}`);
			return { success: true, fileName: source.fileName, size: source.size };
		} catch (error) {
			if (tempPath) {
				try {
					originalFs.unlinkSync(tempPath);
				} catch (cleanupError) {
					Logger.error(`清理模组导入临时文件失败: ${tempPath}`, cleanupError);
				}
			}
			Logger.error(`导入本地模组失败: ${source.fileName}`, error);
			return { success: false, message: error.message || String(error) };
		}
	},

	/** 清除已保存的游戏核心路径, 不删除用户选择的源文件. */
	clearGameCoreFile() {
		const config = this.readAppConfig();
		delete config[GAME_CORE_PATH_KEY];
		return this.writeAppConfig(config)
			? { success: true }
			: { success: false, message: '清除游戏核心路径失败' };
	},

	/** 从应用配置中读取经过规范化的外部存档目录绝对路径. */
	getConfiguredSaveImportDir() {
		const value = this.readAppConfig()[SAVE_IMPORT_DIR_KEY];
		if (typeof value !== 'string' || !value.trim()) return null;
		const saveImportDir = path.normalize(value.trim());
		return path.isAbsolute(saveImportDir) ? saveImportDir : null;
	},

	/** 使用 original-fs 验证路径是否为可访问的目录. */
	isSaveDirectory(dirPath) {
		if (typeof dirPath !== 'string' || !path.isAbsolute(dirPath)) return false;
		try {
			return originalFs.statSync(dirPath).isDirectory();
		} catch (error) {
			return false;
		}
	},

	/** 返回目录顶层的 .sav 普通文件名, 读取失败时返回空数组. */
	listSaveFiles(dirPath) {
		if (!this.isSaveDirectory(dirPath)) return [];
		try {
			return originalFs.readdirSync(dirPath).filter(name => {
				if (!name.toLowerCase().endsWith(SAV_EXT)) return false;
				try {
					return originalFs.statSync(path.join(dirPath, name)).isFile();
				} catch (error) {
					Logger.error(`读取存档文件状态失败: ${name}`, error);
					return false;
				}
			});
		} catch (error) {
			Logger.error(`读取存档目录失败: ${dirPath}`, error);
			return [];
		}
	},

	/** 返回外部存档来源目录的配置和可用状态. */
	getSaveImportStatus() {
		const saveImportDir = this.getConfiguredSaveImportDir();
		const exists = saveImportDir !== null && this.isSaveDirectory(saveImportDir);
		return {
			path: saveImportDir,
			configured: saveImportDir !== null,
			exists,
			count: exists ? this.listSaveFiles(saveImportDir).length : 0,
		};
	},

	/** 由主进程选择并保存外部存档来源目录, 不会移动或复制任何文件. */
	async selectSaveImportDirectory() {
		const { BrowserWindow, dialog } = require('electron');
		const configuredPath = this.getConfiguredSaveImportDir();
		const options = {
			title: '选择原版存档文件夹',
			properties: ['openDirectory'],
			...(configuredPath && this.isSaveDirectory(configuredPath) ? { defaultPath: configuredPath } : {}),
		};
		const parent = BrowserWindow.getFocusedWindow();
		const result = parent
			? await dialog.showOpenDialog(parent, options)
			: await dialog.showOpenDialog(options);
		if (result.canceled || result.filePaths.length === 0) {
			return { success: false, canceled: true };
		}

		const saveImportDir = path.resolve(result.filePaths[0]);
		if (!this.isSaveDirectory(saveImportDir)) {
			return { success: false, message: '请选择存在的文件夹' };
		}

		const success = this.writeAppConfig({
			...this.readAppConfig(),
			[SAVE_IMPORT_DIR_KEY]: saveImportDir,
		});
		return success
			? { success: true, path: saveImportDir, count: this.listSaveFiles(saveImportDir).length }
			: { success: false, message: '保存存档文件夹路径失败' };
	},

	/** 清除外部存档来源目录配置, 不删除用户选择的文件夹或其中的文件. */
	clearSaveImportDirectory() {
		const config = this.readAppConfig();
		delete config[SAVE_IMPORT_DIR_KEY];
		return this.writeAppConfig(config)
			? { success: true }
			: { success: false, message: '清除存档文件夹路径失败' };
	},

	/**
	 * 将外部来源目录顶层的 .sav 文件复制到独立版 _storage.
	 * 先复制至临时目录并校验, 再替换独立版现有存档.
	 * @param {boolean} [replaceExisting=false] 是否已确认清空独立版当前存档.
	 */
	importSavesFromConfiguredDirectory(replaceExisting = false) {
		const sourceDir = this.getConfiguredSaveImportDir();
		if (!sourceDir) return { success: false, message: '请先选择原版存档文件夹' };
		if (!this.isSaveDirectory(sourceDir)) {
			return { success: false, message: '所选存档文件夹无法访问, 请重新选择' };
		}

		const saveFiles = this.listSaveFiles(sourceDir);
		if (saveFiles.length === 0) {
			return { success: false, noSave: true, message: '所选文件夹中没有可导入的存档(.sav)' };
		}

		const storageDir = this.getStorageDir();
		if (path.resolve(sourceDir).toLowerCase() === path.resolve(storageDir).toLowerCase()) {
			return { success: false, message: '所选文件夹已经是独立版存档目录, 无需导入' };
		}
		const existingSaveFiles = this.listSaveFiles(storageDir);
		if (existingSaveFiles.length > 0 && !replaceExisting) {
			return { success: false, needsConfirmation: true, existingCount: existingSaveFiles.length };
		}

		const stagingDir = path.join(this.getBackupDir(), `.import-staging-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		const stagedSourceDir = path.join(stagingDir, 'source');
		const stagedExistingDir = path.join(stagingDir, 'existing');
		let targetCleared = false;
		try {
			// 所有来源文件成功写入临时目录前, 不会触碰独立版存档.
			originalFs.mkdirSync(stagedSourceDir, { recursive: true });
			for (const name of saveFiles) {
				originalFs.copyFileSync(path.join(sourceDir, name), path.join(stagedSourceDir, name));
			}
			const stagedSaveFiles = this.listSaveFiles(stagedSourceDir);
			if (stagedSaveFiles.length !== saveFiles.length || saveFiles.some(name => !stagedSaveFiles.includes(name))) {
				throw new Error('存档临时复制校验失败');
			}

			// 先保留独立版当前存档, 以便写入阶段失败时恢复.
			if (existingSaveFiles.length > 0) {
				originalFs.mkdirSync(stagedExistingDir, { recursive: true });
				for (const name of existingSaveFiles) {
					originalFs.copyFileSync(path.join(storageDir, name), path.join(stagedExistingDir, name));
				}
			}
			if (!originalFs.existsSync(storageDir)) {
				originalFs.mkdirSync(storageDir, { recursive: true });
			}
			for (const name of existingSaveFiles) {
				originalFs.unlinkSync(path.join(storageDir, name));
			}
			targetCleared = true;
			for (const name of stagedSaveFiles) {
				originalFs.copyFileSync(path.join(stagedSourceDir, name), path.join(storageDir, name));
			}
			Logger.info(`导入存档成功: ${sourceDir} -> ${storageDir} (${stagedSaveFiles.length} 个文件)`);
			return { success: true, count: stagedSaveFiles.length };
		} catch (error) {
			Logger.error('导入存档失败', error);
			if (targetCleared) {
				try {
					for (const name of this.listSaveFiles(storageDir)) {
						originalFs.unlinkSync(path.join(storageDir, name));
					}
					for (const name of this.listSaveFiles(stagedExistingDir)) {
						originalFs.copyFileSync(path.join(stagedExistingDir, name), path.join(storageDir, name));
					}
					Logger.info('导入失败, 已恢复独立版原有存档');
				} catch (restoreError) {
					Logger.error('导入失败后恢复原有存档失败', restoreError);
				}
			}
			return { success: false, message: error.message };
		} finally {
			if (originalFs.existsSync(stagingDir)) {
				originalFs.rmSync(stagingDir, { recursive: true, force: true });
			}
		}
	},

	/** 返回通用资源文件 API, 用于处理非 mods 路径. */
	getFileApi() {
		ModLoaderApi.resourcesPath = this.resourcesPath;
		return ModLoaderApi;
	},

	/** 解析受限 resources 路径. */
	resolvePath(subPath, options = {}) {
		return resolveResourcePath(this.resourcesPath, subPath, { ...options, allowStorage: false });
	},

	/** 判断已解析路径是否位于 mods 目录, 包含 ASAR 内部路径. */
	isPluginPath(fullPath) {
		const pluginRoot = path.resolve(this.pluginDir || path.join(this.resourcesPath, 'mods'));
		const relative = path.relative(pluginRoot, fullPath);
		return relative === '' || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
	},

	/** 模组文件名仅允许 mods 根目录中的单层条目. */
	isPluginEntryName(name) {
		return typeof name === 'string'
			&& name.length > 0
			&& name !== '.'
			&& name !== '..'
			&& name === path.basename(name)
			&& !name.includes('/')
			&& !name.includes('\\');
	},

	/**
	 * 判断条目是否为有效模组.
	 * @param {string} name - 条目名称
	 * @param {string} fullPath - 条目完整路径
	 * @returns {'asar'|'folder'|null} asar 表示归档, folder 表示目录.
	 */
	isModKind(name, fullPath) {
		if (name.toLowerCase().endsWith('.asar')) {
			try {
				if (originalFs.statSync(fullPath).isFile()) return 'asar';
			} catch (error) {
				Logger.error(`读取 ASAR 模组状态失败: ${fullPath}`, error);
			}
		}
		try {
			if (originalFs.statSync(fullPath).isDirectory()) return 'folder';
		} catch (error) {
			Logger.error(`读取目录模组状态失败: ${fullPath}`, error);
		}
		return null;
	},

	/**
	 * 扫描模组目录并返回文件夹和 ASAR 形式的模组条目.
	 */
	scanPlugins() {
		if (!originalFs.existsSync(this.pluginDir)) return [];
		const items = originalFs.readdirSync(this.pluginDir);
		const mods = [];
		const modOrder = this.readModOrder();

		for (const name of items) {
			if (name.startsWith('.')) continue;
			if (name === MOD_ORDER_FILE) continue;
			if (this.isSelectedGameCoreEntry(name)) continue;

			const fullPath = path.join(this.pluginDir, name);
			const kind = this.isModKind(name, fullPath);
			if (!kind) continue;

			const orderEntry = modOrder.find(e => e.file === name);
			mods.push({
				file: name,
				path: fullPath,
				order: orderEntry?.order ?? 9999,
				enabled: orderEntry ? orderEntry.enabled !== false : true,
			});
		}

		mods.sort((a, b) => {
			if (a.order !== b.order) return a.order - b.order;
			return a.file.localeCompare(b.file, undefined, {
				numeric: true,
				sensitivity: 'base'
			});
		});

		return mods;
	},

	/** 读取 config 目录中的 mod_order.json. */
	readModOrder() {
		const configFile = this.getModOrderPath();
		if (!originalFs.existsSync(configFile)) return [];
		try {
			return JSON.parse(originalFs.readFileSync(configFile, 'utf-8'));
		} catch (error) {
			Logger.error(`解析 ${MOD_ORDER_FILE} 失败`, error);
			return [];
		}
	},

	/** 整体写入 config 目录中的 mod_order.json. */
	writeModOrder(entries) {
		const configFile = this.getModOrderPath();
		try {
			if (!originalFs.existsSync(path.dirname(configFile))) {
				originalFs.mkdirSync(path.dirname(configFile), { recursive: true });
			}
			originalFs.writeFileSync(configFile, JSON.stringify(entries, null, 2), 'utf-8');
			Logger.info(`已写入 ${MOD_ORDER_FILE}`);
			return true;
		} catch (error) {
			Logger.error(`写入 ${MOD_ORDER_FILE} 失败`, error);
			return false;
		}
	},

	/**
	 * 同步模组配置, 新增条目追加到末尾, 已删除条目移除并重新编号.
	 */
	ensureModOrder() {
		const existingOrder = this.readModOrder();
		const existingMap = new Map(existingOrder.map(e => [e.file, e]));

		const scanned = this.scanPlugins();
		const entries = [];
		let maxOrder = 0;

		for (const mod of scanned) {
			const prev = existingMap.get(mod.file);
			if (prev) {
				// 保留已有启用状态, 并标记为仍存在.
				existingMap.delete(mod.file);
				entries.push({ file: mod.file, order: prev.order, enabled: prev.enabled });
				if (prev.order > maxOrder) maxOrder = prev.order;
			} else {
				// 新增模组后统一重新编号.
				entries.push({ file: mod.file, order: 0, enabled: true });
			}
		}

		// 现有最大 order 作为新增模组的起始编号.
		if (maxOrder === 0) maxOrder = entries.length;
		entries.forEach(e => {
			if (e.order === 0) e.order = ++maxOrder;
		});

		// 重新连续编号.
		entries.sort((a, b) => {
			if (a.order !== b.order) return a.order - b.order;
			return a.file.localeCompare(b.file, undefined, { numeric: true, sensitivity: 'base' });
		});
		entries.forEach((e, i) => { e.order = i + 1; });

		// 剩余配置项对应已删除的模组.
		const removed = [...existingMap.keys()];

		this.writeModOrder(entries);
		if (removed.length > 0) {
			Logger.info(`已移除已删除的模组: ${removed.join(', ')}`);
		}
		Logger.info(`同步完成, 当前共 ${entries.length} 个模组`);
	},

	/**
	 * 扫描模组元信息, 透传 modloader.mod.json 字段并附加 file 和 canConfig.
	 */
	async scanModInfos() {
		const scanned = this.scanPlugins();
		const results = [];

		for (const mod of scanned) {
			let info = { file: mod.file };

			try {
				const raw = await this.readFile(path.join('mods', mod.file, 'modloader.mod.json'));
				if (raw) {
					const json = JSON.parse(raw);
					if (!json || typeof json !== 'object' || Array.isArray(json)) {
						throw new Error('modloader.mod.json 必须是对象');
					}
					const metadata = Object.fromEntries(Object.entries(json).filter(([key]) =>
						key !== '__proto__' && key !== 'constructor' && key !== 'prototype' && key !== 'file'
					));
					info = { ...metadata, file: mod.file };
				}
			} catch (error) {
				Logger.error(`解析模组元信息失败: ${mod.file}/modloader.mod.json`, error);
			}

			info.canConfig = this.hasModConfig(mod.file);
			results.push(info);
		}

		return results;
	},

	/** 判断模组是否包含 modloader.config.json. */
	hasModConfig(file) {
		const full = this.resolvePath(path.join('mods', file, 'modloader.config.json'));
		if (!full) return false;
		const [asarPath, innerPath] = this._parseAsarPath(full);
		if (asarPath && innerPath) return AsarReader.existsInAsar(asarPath, innerPath);
		return originalFs.existsSync(full);
	},

	/** 读取 ModLoader 自身包元数据, 兼容开发和打包运行环境. */
	getModLoaderPackageInfo() {
		try {
			const pkg = require('../package.json');
			const name = typeof pkg.name === 'string' ? pkg.name.trim() : '';
			const version = typeof pkg.version === 'string' ? pkg.version.trim() : '';
			if (!name || !version) {
				throw new Error('package.json 缺少有效的 name 或 version');
			}
			return { name, version };
		} catch (error) {
			Logger.error('读取 ModLoader 包元数据失败', error);
			return null;
		}
	},

	/**
	 * 列出 subPath 目录下的条目.
	 * @param {string} subPath - 相对于 resourcesPath 的路径
	 * @returns {Array<{name: string, isDir: boolean, isAsar: boolean}>}
	 */
	list(subPath) {
		const base = this.resolvePath(subPath, { allowRoot: true });
		if (!base) return [];

		if (!this.isPluginPath(base)) {
			const fileApi = this.getFileApi();
			const names = fileApi.readdirSync(base);
			if (!names) return [];
			return names.map(name => {
				const stat = fileApi.statSync(path.join(base, name));
				return {
					name,
					isDir: stat?.isDirectory() === true,
					isAsar: name.toLowerCase().endsWith('.asar'),
				};
			});
		}

		if (!originalFs.existsSync(base)) return [];
		try {
			return originalFs.readdirSync(base).map(name => {
				const full = path.join(base, name);
				let stat;
				try {
					stat = originalFs.statSync(full);
				} catch (error) {
					Logger.error(`读取目录项状态失败: ${full}`, error);
					return { name, isDir: false, isAsar: false };
				}
				return {
					name,
					isDir: stat.isDirectory(),
					isAsar: name.toLowerCase().endsWith('.asar')
				};
			});
		} catch (error) {
			Logger.error(`列出目录失败: ${subPath}`, error);
			return [];
		}
	},

	/**
	 * 将可能的 ASAR 内部路径拆分为归档路径和内部路径.
	 */
	_parseAsarPath(full) {
		const asarIdx = full.toLowerCase().indexOf('.asar');
		if (asarIdx === -1) return [null, full];
		const asarPath = full.slice(0, asarIdx + 5);
		const suffix = full.slice(asarIdx + 5);
		if (!suffix.startsWith(path.sep)) return [null, full];
		const innerPath = suffix.slice(1);
		if (!innerPath || !originalFs.existsSync(asarPath)) return [null, full];
		return [asarPath, innerPath];
	},

	/**
	 * 同步读取 ASAR 内部文件并返回 UTF-8 文本.
	 * @param {string} subPath - 相对于 resourcesPath 的路径
	 * @returns {string | null}
	 */
	readAsarFileSync(subPath) {
		const full = this.resolvePath(subPath);
		if (!full || !this.isPluginPath(full)) return null;
		const [asarPath, innerPath] = this._parseAsarPath(full);
		if (!asarPath || !innerPath) return null;
		if (!AsarReader.existsInAsar(asarPath, innerPath)) return null;
		try {
			return AsarReader.readAsarFileSync(asarPath, innerPath);
		} catch (error) {
			Logger.error(`同步读取 ASAR 内部文件失败: ${subPath}`, error);
			return null;
		}
 	},

	/**
	 * 同步读取文件内容, ASAR 内部路径自动使用对应读取器.
	 * @param {string} subPath - 相对于 resourcesPath 的路径
	 * @returns {string | null}
	 */
	readFileSync(subPath) {
		const full = this.resolvePath(subPath);
		if (!full) return null;
		if (!this.isPluginPath(full)) return this.getFileApi().readFileSync(full);
		const [asarPath, innerPath] = this._parseAsarPath(full);
		if (asarPath && innerPath) return this.readAsarFileSync(subPath);
		if (!originalFs.existsSync(full)) return null;
		try {
			return originalFs.readFileSync(full, 'utf-8');
		} catch (error) {
			Logger.error(`同步读取文件失败: ${subPath}`, error);
			return null;
		}
	},

	/** 异步读取 ASAR 内部文件. */
	async readAsarFile(subPath) {
		const full = this.resolvePath(subPath);
		if (!full || !this.isPluginPath(full)) return null;
		const [asarPath, innerPath] = this._parseAsarPath(full);
		if (!asarPath || !innerPath) return null;
		if (!AsarReader.existsInAsar(asarPath, innerPath)) return null;
		try {
			return await AsarReader.readAsarFile(asarPath, innerPath);
		} catch (error) {
			Logger.error(`异步读取 ASAR 内部文件失败: ${subPath}`, error);
			return null;
		}
	},

	/**
	 * 异步读取文件内容, ASAR 内部路径自动使用对应读取器.
	 * @param {string} subPath - 相对于 resourcesPath 的路径
	 * @returns {Promise<string | null>}
	 */
	async readFile(subPath) {
		const full = this.resolvePath(subPath);
		if (!full) return null;
		if (!this.isPluginPath(full)) return this.getFileApi().readFile(full);
		const [asarPath, innerPath] = this._parseAsarPath(full);
		if (asarPath && innerPath) return this.readAsarFile(subPath);
		if (!originalFs.existsSync(full)) return null;
		try {
			return await new Promise((resolve, reject) => {
				originalFs.readFile(full, 'utf-8', (err, data) => err ? reject(err) : resolve(data));
			});
		} catch (error) {
			Logger.error(`异步读取文件失败: ${subPath}`, error);
			return null;
		}
	},

	/**
 * 通过 Electron 会话下载 ASAR 并原地替换旧文件, 使用系统和会话代理.
	 * @param {string} url ASAR 下载地址.
	 * @param {string} fileName mods 下的文件名.
	 * @param {Function|null} onProgress 下载进度回调.
	 * @param {number} [redirectCount] 已跟随的重定向次数.
	 * @returns {Promise<{success: boolean, message?: string}>}
	 */
	async downloadAndReplace(url, fileName, onProgress, redirectCount = 0) {
		const { net } = require('electron');
		if (!this.isPluginEntryName(fileName)) {
			return { success: false, message: '无效的目标文件名' };
		}
		const targetPath = path.join(Env.getPluginDir(), fileName);

		return new Promise((resolve) => {
			let target;
			try {
				target = new URL(url);
			} catch (error) {
				Logger.error(`解析下载地址失败: ${url}`, error);
				resolve({ success: false, message: '无效的 URL' });
				return;
			}
			if (target.protocol !== 'https:' && target.protocol !== 'http:') {
				resolve({ success: false, message: '仅支持 HTTP(S) URL' });
				return;
			}

			let settled = false;
			let req;
			let writeStream = null;
			let tmpPath = '';
			const removeTemp = () => {
				if (!tmpPath) return;
				originalFs.unlink(tmpPath, (error) => {
					if (error) Logger.error(`删除下载临时文件失败: ${tmpPath}`, error);
				});
			};
			const done = (result) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(result);
			};
			const fail = (message) => {
				try {
					writeStream?.destroy();
				} catch (error) {
					Logger.error('关闭下载写入流失败', error);
				}
				removeTemp();
				done({ success: false, message });
			};

			try {
				req = net.request({ method: 'GET', url: target.toString() });
				req.setHeader('User-Agent', 'Mozilla/5.0');
				req.setHeader('Cache-Control', 'no-cache');
				req.setHeader('Pragma', 'no-cache');
			} catch (error) {
				Logger.error(`创建下载请求失败: ${url}`, error);
				resolve({ success: false, message: `请求创建失败: ${error.message}` });
				return;
			}

			const timer = setTimeout(() => {
				try {
					req.abort();
				} catch (error) {
					Logger.error('中止超时下载请求失败', error);
				}
				fail('下载超时');
			}, 30000);

			req.on('redirect', (_statusCode, _method, redirectUrl) => {
				if (redirectCount >= 5) {
					fail('重定向次数过多');
					return;
				}
				try {
					const next = new URL(redirectUrl, target).toString();
					done(this.downloadAndReplace(next, fileName, onProgress, redirectCount + 1));
				} catch (error) {
					Logger.error(`解析下载重定向地址失败: ${redirectUrl}`, error);
					fail('无效的重定向 URL');
				}
			});

			req.on('response', (res) => {
				const status = res.statusCode || 0;
				if (status !== 200) {
					res.resume();
					fail(`HTTP ${status}`);
					return;
				}

				const total = parseInt(res.headers['content-length'], 10) || 0;
				let received = 0;
				tmpPath = targetPath + `.tmp.${Date.now()}.asar`;
				writeStream = originalFs.createWriteStream(tmpPath);

				res.on('data', (chunk) => {
					received += chunk.length;
					if (onProgress && total > 0) onProgress(received, total);
				});
				res.on('error', (err) => {
					Logger.error('下载响应失败', err);
					fail(err.message);
				});

				writeStream.on('finish', () => {
					if (settled) {
						removeTemp();
						return;
					}
					try {
						originalFs.renameSync(tmpPath, targetPath);
						if (targetPath.toLowerCase().endsWith('.asar')) {
							AsarReader.uncacheAsar(targetPath);
						}
						Logger.info(`下载替换成功: ${fileName}`);
						if (onProgress) onProgress(total, total);
						done({ success: true });
					} catch (error) {
						Logger.error('替换下载文件失败', error);
						fail(error.message);
					}
				});

				writeStream.on('error', (err) => {
					Logger.error('下载文件写入失败', err);
					fail(err.message);
				});

				res.pipe(writeStream);
			});

			req.on('error', (err) => {
				Logger.error('下载请求失败', err);
				fail(err.message);
			});
			req.end();
		});
	},

	/**
 * 更新模组顺序与启用状态.
	 * @param {Array<{file: string, order?: number, enabled?: boolean}>} orderedMods
	 * @returns {boolean} 是否写入成功
	 */
	setModOrder(orderedMods) {
		if (!Array.isArray(orderedMods)) {
			Logger.error('更新模组顺序失败, 参数必须为数组');
			return false;
		}

		const entries = orderedMods
			.filter(e => e && this.isPluginEntryName(e.file) && !this.isSelectedGameCoreEntry(e.file))
			.map((e, i) => ({ file: e.file, order: i + 1, enabled: e.enabled !== false }));

		return this.writeModOrder(entries);
	},

	/**
 * 通过 Electron 会话发起 HTTP(S) GET 并返回响应文本.
 * 使用 Electron net 以应用系统和会话代理, 最多跟随 5 次重定向.
	 * @param {string} url
	 * @param {number} [redirectCount]
	 * @returns {Promise<{ success: boolean, status?: number, text?: string, message?: string }>}
	 */
	fetchText(url, redirectCount = 0) {
		const { net } = require('electron');

		return new Promise((resolve) => {
			let target;
			try {
				target = new URL(url);
			} catch (error) {
				Logger.error(`解析文本请求地址失败: ${url}`, error);
				resolve({ success: false, message: '无效的 URL' });
				return;
			}
			if (target.protocol !== 'https:' && target.protocol !== 'http:') {
				resolve({ success: false, message: '仅支持 HTTP(S) URL' });
				return;
			}

			let settled = false;
			let req;
			const done = (result) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(result);
			};

			try {
				req = net.request({ method: 'GET', url: target.toString() });
				req.setHeader('User-Agent', 'Mozilla/5.0');
				req.setHeader('Cache-Control', 'no-cache');
				req.setHeader('Pragma', 'no-cache');
			} catch (error) {
				Logger.error(`创建文本请求失败: ${url}`, error);
				resolve({ success: false, message: `请求创建失败: ${error.message}` });
				return;
			}

			const timer = setTimeout(() => {
				try {
					req.abort();
				} catch (error) {
					Logger.error('中止超时文本请求失败', error);
				}
				done({ success: false, message: '请求超时' });
			}, 15000);

			req.on('redirect', (_statusCode, _method, redirectUrl) => {
				if (redirectCount >= 5) {
					done({ success: false, message: '重定向次数过多' });
					return;
				}
				try {
					const next = new URL(redirectUrl, target).toString();
					done(this.fetchText(next, redirectCount + 1));
				} catch (error) {
					Logger.error(`解析文本请求重定向地址失败: ${redirectUrl}`, error);
					done({ success: false, message: '无效的重定向 URL' });
				}
			});

			req.on('response', (res) => {
				const status = res.statusCode || 0;

				if (status < 200 || status >= 300) {
					res.resume();
					done({ success: false, status, message: `HTTP ${status}` });
					return;
				}

				const chunks = [];
				res.on('data', (chunk) => chunks.push(chunk));
				res.on('end', () => {
					done({ success: true, status, text: Buffer.concat(chunks).toString('utf-8') });
				});
				res.on('error', (error) => {
					Logger.error('文本响应读取失败', error);
					done({ success: false, message: error.message });
				});
			});

			req.on('error', (error) => {
				Logger.error('文本请求失败', error);
				done({ success: false, message: error.message });
			});
			req.end();
		});
	},

	/** 游戏存档目录. 安装目录不可写时使用 userData/_storage. */
	getStorageDir() {
		return path.resolve(this.dataPath) === path.resolve(this.resourcesPath)
			? path.normalize(path.join(this.resourcesPath, '..', STORAGE_DIR))
			: path.join(this.dataPath, STORAGE_DIR);
	},

	/** 备份目录. */
	getBackupDir() {
		return path.join(this.dataPath, BACKUP_DIR);
	},

	/** 返回经校验的 backups 根目录内 ZIP 文件路径. */
	getBackupFilePath(file) {
		const fileName = normalizeBackupFileName(file);
		if (!fileName) return null;
		const backupDir = path.resolve(this.getBackupDir());
		const backupPath = path.resolve(backupDir, fileName);
		return path.dirname(backupPath) === backupDir ? backupPath : null;
	},

	/** 读取备份锁定状态表. */
	readBackupLocks() {
		const lockFile = path.join(this.getBackupDir(), BACKUP_LOCK_FILE);
		if (!originalFs.existsSync(lockFile)) return {};
		try {
			return JSON.parse(originalFs.readFileSync(lockFile, 'utf-8'));
		} catch (error) {
			Logger.error('读取备份锁定状态失败', error);
			return {};
		}
	},

	/** 写入备份锁定状态表. */
	writeBackupLocks(locks) {
		const backupDir = this.getBackupDir();
		if (!originalFs.existsSync(backupDir)) {
			originalFs.mkdirSync(backupDir, { recursive: true });
		}
		originalFs.writeFileSync(
			path.join(backupDir, BACKUP_LOCK_FILE),
			JSON.stringify(locks, null, 2),
			'utf-8'
		);
	},

	/**
 * 列出所有备份及其锁定状态,时间和大小.
	 * @returns {Array<{ file: string, locked: boolean, time: number, size: number }>}
	 */
	listBackups() {
		const backupDir = this.getBackupDir();
		if (!originalFs.existsSync(backupDir)) return [];
		const locks = this.readBackupLocks();
		return originalFs.readdirSync(backupDir)
			.filter(n => normalizeBackupFileName(n) === n)
			.map(n => {
				let time = 0;
				let size = 0;
				try {
					const st = originalFs.statSync(path.join(backupDir, n));
					time = st.mtimeMs;
					size = st.size;
				} catch (error) {
					Logger.error(`读取备份文件状态失败: ${n}`, error);
				}
				return { file: n, locked: locks[n] === true, time, size };
			})
			.sort((a, b) => b.time - a.time);
	},

	/**
 * 将 _storage 下的 .sav 存档压缩为备份.
	 * @param {string} [name] 备份文件名, 可不含 .zip.
	 * @returns {{ success: boolean, file?: string, count?: number, message?: string }}
	 */
	createBackup(name) {
		const storageDir = this.getStorageDir();
		if (!originalFs.existsSync(storageDir)) {
			return { success: false, noSave: true, message: '存档目录不存在' };
		}

		try {
			const hasSave = originalFs.readdirSync(storageDir).some(n => {
				if (!n.toLowerCase().endsWith(SAV_EXT)) return false;
				try {
					return originalFs.statSync(path.join(storageDir, n)).isFile();
				} catch (error) {
					Logger.error(`读取待备份文件状态失败: ${n}`, error);
					return false;
				}
			});
			if (!hasSave) {
				return { success: false, noSave: true, message: '没有可备份的存档(.sav)' };
			}

			const backupDir = this.getBackupDir();
			if (!originalFs.existsSync(backupDir)) {
				originalFs.mkdirSync(backupDir, { recursive: true });
			}

			const requestedName = (name && String(name).trim()) || `backup_${Date.now()}`;
			const fileName = normalizeBackupFileName(requestedName, { appendExtension: true });
			const zipPath = this.getBackupFilePath(fileName);
			if (!zipPath) return { success: false, message: '无效的备份文件名' };
			if (originalFs.existsSync(zipPath)) {
				return { success: false, message: '同名备份已存在' };
			}

			const count = zipFiles(storageDir, zipPath, n => n.toLowerCase().endsWith(SAV_EXT));
			if (count === 0) {
				return { success: false, noSave: true, message: '没有可备份的存档(.sav)' };
			}
			Logger.info(`创建备份成功: ${fileName} (${count} 个存档)`);
			return { success: true, file: fileName, count };
		} catch (error) {
			Logger.error('创建备份失败', error);
			return { success: false, message: error.message };
		}
	},

	/**
	 * 恢复备份.
	 * 先将新存档完整写入临时目录并验证, 成功后通过目录切换提交.
	 * 切换后任一步失败都会恢复原 _storage.
	 * 自动跳过 steam_autocloud.vdf, 防止与 Steam 云存档冲突.
	 * @param {string} file
	 * @returns {{ success: boolean, count?: number, message?: string }}
	 */
	restoreBackup(file) {
		const zipPath = this.getBackupFilePath(file);
		if (!zipPath || !originalFs.existsSync(zipPath)) {
			return { success: false, message: '备份不存在' };
		}
		const storageDir = this.getStorageDir();
		const stagingDir = path.join(this.getBackupDir(), `.restore-staging-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		const restoredSavesDir = path.join(stagingDir, 'restored');
		const nextStorageDir = path.join(stagingDir, 'next');
		const previousStorageDir = path.join(stagingDir, 'previous');
		let storageWasMoved = false;
		let newStorageActivated = false;
		try {
			// 先解压并验证备份, 此阶段不会修改当前存档.
			extractSavesFlat(zipPath, restoredSavesDir);
			const stagedFiles = originalFs.readdirSync(restoredSavesDir).filter(name => {
				const fullPath = path.join(restoredSavesDir, name);
				return name.toLowerCase().endsWith(SAV_EXT) && originalFs.statSync(fullPath).isFile();
			});
			if (stagedFiles.length === 0) {
				throw new Error('备份中没有可恢复的存档(.sav)');
			}

			// 先将新存档完整写入并校验到独立临时目录, 当前存档仍保持原状.
			originalFs.mkdirSync(nextStorageDir, { recursive: true });
			for (const name of stagedFiles) {
				const sourcePath = path.join(restoredSavesDir, name);
				const targetPath = path.join(nextStorageDir, name);
				originalFs.copyFileSync(sourcePath, targetPath);
				if (originalFs.statSync(sourcePath).size !== originalFs.statSync(targetPath).size) {
					throw new Error(`存档临时复制校验失败: ${name}`);
				}
			}

			// 新数据已就绪, 通过同卷目录重命名切换. 失败时将 previous 原样移回.
			if (originalFs.existsSync(storageDir)) {
				if (!originalFs.statSync(storageDir).isDirectory()) {
					throw new Error('存档路径不是文件夹');
				}
				originalFs.renameSync(storageDir, previousStorageDir);
				storageWasMoved = true;
			}
			originalFs.renameSync(nextStorageDir, storageDir);
			newStorageActivated = true;
			const count = stagedFiles.length;
			Logger.info(`恢复备份成功: ${file} (${count} 个文件)`);
			return { success: true, count };
		} catch (error) {
			let rollbackError = null;
			if (newStorageActivated && originalFs.existsSync(storageDir)) {
				try {
					originalFs.rmSync(storageDir, { recursive: true, force: true });
				} catch (cleanupError) {
					rollbackError = cleanupError;
					Logger.error('清理未完成的恢复目录失败', cleanupError);
				}
			}
			if (!rollbackError && storageWasMoved && originalFs.existsSync(previousStorageDir)) {
				try {
					originalFs.renameSync(previousStorageDir, storageDir);
					storageWasMoved = false;
				} catch (restoreError) {
					rollbackError = restoreError;
					Logger.error('恢复原存档目录失败', restoreError);
				}
			}
			Logger.error('恢复备份失败', error);
			return {
				success: false,
				message: rollbackError
					? `${error.message}; 原存档回滚失败: ${rollbackError.message}`
					: error.message
			};
		} finally {
			if (originalFs.existsSync(stagingDir)) {
				try {
					originalFs.rmSync(stagingDir, { recursive: true, force: true });
				} catch (cleanupError) {
					Logger.error(`清理恢复临时目录失败: ${stagingDir}`, cleanupError);
				}
			}
		}
	},

	/**
	 * 删除备份, 锁定的备份禁止删除.
	 * @param {string} file
	 * @returns {{ success: boolean, message?: string }}
	 */
	deleteBackup(file) {
		const fileName = normalizeBackupFileName(file);
		if (!fileName) return { success: false, message: '无效的备份文件名' };
		const locks = this.readBackupLocks();
		if (locks[fileName]) return { success: false, message: '备份已锁定,请先解锁' };
		const zipPath = this.getBackupFilePath(fileName);
		if (!zipPath || !originalFs.existsSync(zipPath)) {
			return { success: false, message: '备份不存在' };
		}
		try {
			originalFs.unlinkSync(zipPath);
			Logger.info(`删除备份成功: ${file}`);
			return { success: true };
		} catch (error) {
			Logger.error('删除备份失败', error);
			return { success: false, message: error.message };
		}
	},

	/**
	 * 重命名备份, 同步迁移锁定状态.
	 * @param {string} oldName
	 * @param {string} newName
	 * @returns {{ success: boolean, file?: string, message?: string }}
	 */
	renameBackup(oldName, newName) {
		const oldFileName = normalizeBackupFileName(oldName);
		const finalName = normalizeBackupFileName(newName, { appendExtension: true });
		if (!oldFileName || !finalName) return { success: false, message: '无效的备份文件名' };
		if (oldFileName === finalName) return { success: true, file: finalName };

		const oldPath = this.getBackupFilePath(oldFileName);
		const newPath = this.getBackupFilePath(finalName);
		if (!oldPath || !newPath || !originalFs.existsSync(oldPath)) return { success: false, message: '备份不存在' };
		if (originalFs.existsSync(newPath)) return { success: false, message: '目标名已存在' };

		try {
			originalFs.renameSync(oldPath, newPath);
			const locks = this.readBackupLocks();
			if (locks[oldFileName]) {
				locks[finalName] = true;
				delete locks[oldFileName];
				this.writeBackupLocks(locks);
			}
			Logger.info(`重命名备份成功: ${oldName} -> ${finalName}`);
			return { success: true, file: finalName };
		} catch (error) {
			Logger.error('重命名备份失败', error);
			return { success: false, message: error.message };
		}
	},

	/**
	 * 设置备份锁定状态.
	 * @param {string} file
	 * @param {boolean} locked
	 * @returns {{ success: boolean, message?: string }}
	 */
	setBackupLock(file, locked) {
		const fileName = normalizeBackupFileName(file);
		const backupPath = this.getBackupFilePath(fileName);
		if (!backupPath || !originalFs.existsSync(backupPath)) {
			return { success: false, message: '备份不存在' };
		}
		const locks = this.readBackupLocks();
		if (locked) locks[fileName] = true;
		else delete locks[fileName];
		try {
			this.writeBackupLocks(locks);
			return { success: true };
		} catch (error) {
			Logger.error('设置备份锁定状态失败', error);
			return { success: false, message: error.message };
		}
	},

	/**
	 * 导入外部备份 ZIP 文件到 backups 目录.
	 * @param {string} srcPath 外部 ZIP 文件绝对路径.
	 * @returns {{ success: boolean, file?: string, message?: string }}
	 */
	importBackup(srcPath) {
		if (typeof srcPath !== 'string'
			|| !srcPath
			|| path.extname(srcPath).toLowerCase() !== '.zip'
			|| !originalFs.existsSync(srcPath)) {
			return { success: false, message: '文件不存在' };
		}
		try {
			if (!originalFs.statSync(srcPath).isFile()) {
				return { success: false, message: '请选择 ZIP 备份文件' };
			}
		} catch (error) {
			return { success: false, message: '文件无法访问' };
		}
		const backupDir = this.getBackupDir();
		if (!originalFs.existsSync(backupDir)) {
			originalFs.mkdirSync(backupDir, { recursive: true });
		}
		let baseName = normalizeBackupFileName(path.basename(srcPath));
		if (!baseName) return { success: false, message: '无效的备份文件名' };
		let destPath = this.getBackupFilePath(baseName);
		if (!destPath) return { success: false, message: '无效的备份文件名' };
		// 同名文件追加时间戳.
		if (originalFs.existsSync(destPath)) {
			baseName = normalizeBackupFileName(`${baseName.replace(/\.zip$/i, '')}_${Date.now()}.zip`);
			destPath = this.getBackupFilePath(baseName);
			if (!baseName || !destPath) return { success: false, message: '无效的备份文件名' };
		}
		try {
			originalFs.copyFileSync(srcPath, destPath);
			Logger.info(`导入备份成功: ${baseName}`);
			return { success: true, file: baseName };
		} catch (error) {
			Logger.error('导入备份失败', error);
			return { success: false, message: error.message };
		}
	},

	/**
	 * 清理备份.
	 * 保留 retainDays 天内且最新 retainCount 份的未锁定备份, 其余删除.
	 * 锁定备份不计数也不删除. retainDays 或 retainCount 小于等于 0 时不限制对应维度.
	 * @param {number} retainDays
	 * @param {number} retainCount
	 * @returns {{ success: boolean, deleted: number }}
	 */
	cleanupBackups(retainDays, retainCount) {
		const now = Date.now();
		const dayMs = 86400000;
		const all = this.listBackups();
		let kept = 0;
		let deleted = 0;
		for (const b of all) {
			if (b.locked) continue;
			const withinDays = !(retainDays > 0) || (now - b.time) <= retainDays * dayMs;
			const withinCount = !(retainCount > 0) || kept < retainCount;
			if (withinDays && withinCount) {
				kept++;
			} else {
				try {
					originalFs.unlinkSync(this.getBackupFilePath(b.file));
					deleted++;
				} catch (error) {
					Logger.error(`清理备份失败: ${b.file}`, error);
				}
			}
		}
		if (deleted > 0) Logger.info(`清理备份完成,删除 ${deleted} 份`);
		return { success: true, deleted };
	}
};

module.exports = { ModManagerApi };
