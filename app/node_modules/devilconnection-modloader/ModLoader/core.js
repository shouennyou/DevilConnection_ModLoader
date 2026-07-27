/**
 * ============================================================================
 * ModLoader 运行时核心.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const electron = require('electron');
const { version } = require('../package.json');
const { getWritableDataPath } = require('../utils/RuntimePaths');

// 已被 Electron 补丁的 fs 会将 ASAR 路径视为虚拟目录.
// 仅在验证用户选择的归档文件时使用未补丁的文件系统模块.
let originalFs = fs;
try {
	originalFs = require('original-fs');
} catch (error) {
	// 普通 Node 测试环境不提供 original-fs, 此时回退到 fs.
}

const PLUGIN_DIR = 'mods';
const CONFIG_DIR = 'config';
const MOD_ORDER_FILE = 'mod_order.json';
const APP_CONFIG_FILE = 'mod-manager.json';
const GAME_CORE_PATH_KEY = 'gameCorePath';
const VERSION = version.startsWith('v') ? version : `v${version}`;

const electronFs = {
	readFileSync: fs.readFileSync
};

const Logger = {
	info(msg) {
		console.log(`[ModLoader] ${msg}`);
	},
	warn(msg, err) {
		console.warn(`[ModLoader] ${msg}`, err || '');
	},
	error(msg, err) {
		console.error(`[ModLoader] ${msg}${err ? ': ' + err.message : ''}`, err || '');
	}
};

const Env = {
    isMain: process?.type === 'browser',

	getResourcesPath() {
        if (process.resourcesPath) return path.normalize(process.resourcesPath);
        try {
            const app = electron.app;
            return app?.getAppPath() || process.cwd();
	} catch (error) {
		Logger.error('读取 Electron 应用路径失败, 使用默认 resources 路径', error);
		return path.join(process.cwd(), 'resources');
        }
	},

	getDataPath() {
		if (!this.isMain) {
			try {
				const dataPath = electron.ipcRenderer?.sendSync('modloader:getDataPath');
				if (typeof dataPath === 'string' && dataPath.trim()) return path.normalize(dataPath);
			} catch (error) {
				Logger.warn('从主进程读取配置目录失败', error);
			}
		}
		return getWritableDataPath(this.getResourcesPath(), electron, originalFs);
	},

	getConfigDataPath() {
		return this.getDataPath();
	},

	getPluginDir() {
		const resourcesPath = this.getResourcesPath();
		const dataPath = this.getDataPath();
		return path.resolve(dataPath) === path.resolve(resourcesPath)
			? path.join(resourcesPath, PLUGIN_DIR)
			: path.join(dataPath, PLUGIN_DIR);
    }
};

/**
 * 渲染进程通用文件 API 位于同目录 api.js.
 * 此处仅处理模组扫描和路径解析.
 */
const PluginManager = {
	resourcesPath: Env.getResourcesPath(),
	dataPath: Env.getDataPath(),
	pluginDir: '',
	loadedPlugins: [],
	gameCorePath: null,
	_pathCache: new Map(),

	/**
	 * 读取并验证应用配置中的游戏核心路径.
	 * 使用 original-fs 检查归档本体, 避免 Electron 的 ASAR 虚拟文件系统干扰判断.
	 * @returns {string|null} 有效的游戏核心绝对路径.
	 */
	readGameCorePath() {
		const configFile = path.join(this.dataPath, CONFIG_DIR, APP_CONFIG_FILE);
		if (!fs.existsSync(configFile)) return null;
		try {
			const config = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
			const value = config && typeof config === 'object' && !Array.isArray(config)
				? config[GAME_CORE_PATH_KEY]
				: null;
			if (typeof value !== 'string' || !value.trim()) return null;
			const gameCorePath = path.normalize(value.trim());
			if (!path.isAbsolute(gameCorePath) || path.extname(gameCorePath).toLowerCase() !== '.asar') {
				return null;
			}
			return originalFs.statSync(gameCorePath).isFile() ? gameCorePath : null;
		} catch (error) {
			Logger.warn('读取游戏核心路径失败', error);
			return null;
		}
	},

	/**
	 * 扫描模组目录, 应用启用状态与排序, 最后追加已选择的游戏核心归档.
	 */
	init() {
		this.pluginDir = Env.getPluginDir();

		if (!fs.existsSync(this.pluginDir)) {
			fs.mkdirSync(this.pluginDir, {
				recursive: true
			});
		}

		const items = fs.readdirSync(this.pluginDir, {
			withFileTypes: true
		});
		this.loadedPlugins = [];
		this.gameCorePath = this.readGameCorePath();
		this._pathCache.clear();

		for (const item of items) {
			const name = item.name;
			if (name.startsWith('.')) continue;
			if (name === MOD_ORDER_FILE) continue;

			const itemPath = path.join(this.pluginDir, name);
			if (this.gameCorePath && path.resolve(itemPath).toLowerCase() === this.gameCorePath.toLowerCase()) continue;
			const isAsarFile = name.toLowerCase().endsWith('.asar');
			const isValid = isAsarFile ? item.isFile() : item.isDirectory();
			if (isValid) this.loadedPlugins.push(itemPath);
		}

		const configFile = path.join(this.dataPath, CONFIG_DIR, MOD_ORDER_FILE);
		let config = null;
		if (fs.existsSync(configFile)) {
			try {
				config = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
				Logger.info(`已加载配置文件: ${MOD_ORDER_FILE}`);
			} catch (error) {
				Logger.error(`解析 ${MOD_ORDER_FILE} 失败`, error);
			}
		}

		if (Array.isArray(config)) {
			const disabled = new Set(
				config.filter(e => !e.enabled).map(e => e.file)
			);
			const configNames = new Set(config.map(e => e.file));

			this.loadedPlugins = this.loadedPlugins.filter(p => {
				const name = path.basename(p);
				if (!configNames.has(name)) {
					disabled.add(name);
					Logger.info(`未在配置中找到, 已禁用: ${name}`);
				}
				return !disabled.has(name);
			});

			const orderMap = new Map(
				config.filter(e => e.enabled).map(e => [e.file, e.order ?? 9999])
			);
			this.loadedPlugins.sort((a, b) => {
				const nameA = path.basename(a);
				const nameB = path.basename(b);
				const orderA = orderMap.get(nameA) ?? 9999;
				const orderB = orderMap.get(nameB) ?? 9999;
				if (orderA !== orderB) return orderA - orderB;
				return nameA.localeCompare(nameB, undefined, {
					numeric: true,
					sensitivity: 'base'
				});
			});
		} else {
			this.loadedPlugins.sort((a, b) =>
				path.basename(a).localeCompare(path.basename(b), undefined, {
					numeric: true,
					sensitivity: 'base'
				})
			);
		}

		if (this.gameCorePath) {
			this.loadedPlugins.push(this.gameCorePath);
		} else {
			Logger.warn('未选择有效的游戏核心文件');
		}

		Logger.info(`扫描完成, 已加载 ${this.loadedPlugins.length} 个模组.`);
		this.loadedPlugins.forEach((p, i) => Logger.info(`优先级 [${i + 1}]: ${path.basename(p)}`));
	},

	/**
	 * 按已加载顺序解析资源路径. 前面的启用模组可覆盖后面的游戏核心资源.
	 * @param {string} relative 相对于模组或游戏核心根目录的资源路径.
	 * @returns {string|null} 首个存在的实际路径.
	 */
	resolvePath(relative) {
		if (!relative || typeof relative !== 'string') return null;
		const key = relative.replace(/\\/g, '/').toLowerCase();
		if (this._pathCache.has(key)) return this._pathCache.get(key);
		let result = null;
		for (const pluginPath of this.loadedPlugins) {
			const tryPath = path.join(pluginPath, relative.replace(/\//g, path.sep));
			if (fs.existsSync(tryPath)) {
				result = tryPath;
				break;
			}
		}
		if (result) this._pathCache.set(key, result);
		return result;
	}
};

module.exports = {
	Logger,
	Env,
	PluginManager,
	electronFs,
	VERSION,
};
