import { init } from 'steamworks.js';
import { app } from 'electron';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const { getWritableDataPath } = require('devilconnection-modloader/utils/RuntimePaths');

// 游戏在 Steam 平台的 AppID.
const APP_ID = 3054820;

// 配置文件: <dataPath>/config/mod-manager.json.
const CONFIG_DIR = 'config';
const CONFIG_FILE = 'mod-manager.json';
const LEGACY_CONFIG_FILE = 'modloader.json';

// Steam 通讯仅在启动时初始化一次. null 表示未启用.
let client = null;

function configPath(file = CONFIG_FILE) {
	return path.join(getConfigDataPath(), CONFIG_DIR, file);
}

function getConfigDataPath() {
	return getWritableDataPath(process.resourcesPath, { app }, fs);
}

function readConfigFile(file) {
	try {
		return JSON.parse(fs.readFileSync(configPath(file), 'utf-8')) || {};
	} catch (error) {
		if (error.code !== 'ENOENT') {
			console.error(`[Steam] 读取配置文件失败: ${file}`, error);
		}
		return null;
	}
}

/** 读取配置对象, 首次启动时迁移旧版 modloader.json. */
function readConfig() {
	const current = readConfigFile(CONFIG_FILE);
	if (current) return current;
	const legacy = readConfigFile(LEGACY_CONFIG_FILE);
	if (!legacy) return {};
	writeConfig(legacy);
	return legacy;
}

/** 写入配置对象, 自动创建 config 目录. */
function writeConfig(cfg) {
	const p = configPath();
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, JSON.stringify(cfg || {}, null, 2), 'utf-8');
}

/** Steam 是否启用. 仅明确设置 steam: false 时关闭. */
export function isSteamConfigured() {
	return readConfig().steam !== false;
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
	if (!isSteamConfigured()) return null;
	try {
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
	writeConfig({ ...readConfig(), steam: enabled === true });
}
