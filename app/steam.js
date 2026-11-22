import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { getConfigDataPath } = require('devilconnection-modloader/utils/RuntimePaths');

// 游戏在 Steam 平台的 AppID.
const APP_ID = 3054820;

// 配置文件: <可写数据目录>/config/mod-manager.json.
const CONFIG_DIR = 'config';
const CONFIG_FILE = 'mod-manager.json';

// Steam 通讯仅在启动时初始化一次. null 表示未启用.
let client = null;

/**
 * steamworks.js 0.4.0 当前随包提供的原生模块平台矩阵。
 * 不支持的平台绝不能在顶层加载 steamworks.js，否则 ESM 初始化阶段会直接终止主进程。
 */
export function isSteamSupported() {
	return (process.platform === 'win32' && process.arch === 'x64')
		|| (process.platform === 'linux' && process.arch === 'x64')
		|| (process.platform === 'darwin' && (process.arch === 'x64' || process.arch === 'arm64'));
}

/** 返回当前运行时无法使用 Steam 功能的用户可见原因；支持时返回 null。 */
export function getSteamUnsupportedReason() {
	if (isSteamSupported()) return null;
	if (process.platform === 'linux' && process.arch === 'arm64') {
		return 'Linux ARM64 发行版暂不支持 Steam 功能，已自动关闭。';
	}
	return `当前平台（${process.platform}/${process.arch}）暂不支持 Steam 功能，已自动关闭。`;
}

function getResourcesPath() {
	return path.normalize(process.resourcesPath || process.cwd());
}

/** 返回与 ModManager 相同的可写配置数据目录. */
function getDataPath() {
	return getConfigDataPath(getResourcesPath());
}

function configPath(file = CONFIG_FILE) {
	return path.join(getDataPath(), CONFIG_DIR, file);
}

function readConfigFile(file = CONFIG_FILE) {
	try {
		return JSON.parse(fs.readFileSync(configPath(file), 'utf-8')) || {};
	} catch (error) {
		if (error.code !== 'ENOENT') {
			console.error(`[Steam] 读取配置文件失败: ${file}`, error);
		}
		return null;
	}
}

/** 读取 Steam 配置对象. */
function readConfig() {
	return readConfigFile() || {};
}

/** 写入配置对象, 自动创建 config 目录. */
function writeConfig(cfg) {
	const p = configPath();
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, JSON.stringify(cfg || {}, null, 2), 'utf-8');
}

/**
 * 在不受支持的平台将旧配置或默认配置持久化修正为 steam: false。
 * 写入失败不能妨碍程序作为非 Steam 版本启动。
 */
function forceDisableUnsupportedSteam() {
	if (isSteamSupported()) return;
	const config = readConfig();
	if (config.steam === false) return;
	try {
		writeConfig({ ...config, steam: false });
	} catch (error) {
		console.error('[Steam] 写入不受支持平台的禁用配置失败:', error);
	}
}

/** Steam 是否启用. 不受支持的平台始终视为关闭。 */
export function isSteamConfigured() {
	return isSteamSupported() && readConfig().steam !== false;
}

/** Steam 通讯是否处于活动状态. */
export function isSteamActive() {
	return client != null;
}

/** 获取当前 Steam 客户端, 未启用时返回 null. */
export function getSteamClient() {
	return client;
}

/**
 * 按配置初始化 Steam. 整个进程生命周期仅调用一次.
 * @returns 已启用且成功时返回客户端, 否则返回 null.
 */
export function initSteam() {
	if (!isSteamSupported()) {
		forceDisableUnsupportedSteam();
		client = null;
		return null;
	}
	if (!isSteamConfigured()) return null;
	try {
		// 仅在已确认平台支持时加载原生模块，避免 Linux ARM64 在启动阶段崩溃。
		const { init } = require('steamworks.js');
		client = init(APP_ID);
		return client;
	} catch (error) {
		// Steam 客户端不可用时降级为非 Steam 模式.
		console.error('[Steam] 初始化失败:', error);
		client = null;
		return null;
	}
}

/**
 * 写入 Steam 开关配置.
 * 实际启用或停止 Steam 通讯需要重启程序.
 * @param {boolean} enabled
 */
export function setSteamConfigured(enabled) {
	const configured = isSteamSupported() && enabled === true;
	writeConfig({ ...readConfig(), steam: configured });
	return configured;
}
