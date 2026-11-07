/**
 * ============================================================================
 * ModLoader 文件与协议拦截.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const electron = require('electron');

let core;
const MODLOADER_SCHEME = 'modloader';
const MODLOADER_HOST = 'game';
let schemeRegistered = false;

/**
 * 将 modloader:// 注册为可导航的、安全的标准 URL 协议。
 * 必须在 app ready 前调用；具体请求处理器则在 ready 后注册。
 */
function registerProtocolScheme() {
	const { app, protocol } = electron;
	if (schemeRegistered) return true;
	if (app.isReady()) {
		console.error('[ModLoader] modloader 协议必须在 app ready 前注册');
		return false;
	}

	protocol.registerSchemesAsPrivileged([{
		scheme: MODLOADER_SCHEME,
		privileges: {
			standard: true,
			secure: true,
			supportFetchAPI: true,
			corsEnabled: true,
			stream: true
		}
	}]);
	schemeRegistered = true;
	return true;
}

/**
 * 从 targetPath 提取相对于 app.asar 的路径.
 */
function extractRelative(targetPath) {
	if (typeof targetPath !== 'string') return null;
	const normalized = targetPath.replace(/\\/g, '/');
	if (normalized.includes('app.asar')) {
		return normalized.substring(normalized.indexOf('app.asar') + 8);
	}
	return null;
}

/**
 * 映射 app.asar 路径或相对路径到已加载模组.
 */
function mapPath(targetPath) {
	const rel = extractRelative(targetPath);
	if (rel) {
		const found = core.PluginManager.resolvePath(rel);
		if (found) return found;
	}
	if (!path.isAbsolute(targetPath)) {
		let clean = targetPath.replace(/^(\.[/\\])/, '');
		if (!clean.startsWith('/')) clean = '/' + clean;
		const found = core.PluginManager.resolvePath(clean);
		if (found) return found;
	}
	return targetPath;
}

function applyFSHooks() {
	const orig = core.electronFs;

	fs.readFileSync = (p, o) => orig.readFileSync(mapPath(p), o);

	core.Logger.info('文件系统拦截已启用');
}

function getResourcePath(requestUrl) {
	try {
		const url = new URL(requestUrl);
		if (url.protocol !== `${MODLOADER_SCHEME}:` || url.hostname !== MODLOADER_HOST) return null;

		const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
		const segments = relative.split('/');
		if (!relative || segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\\') || segment.includes('\0'))) {
			return null;
		}
		return segments.join('/');
	} catch (error) {
		return null;
	}
}

function setupProtocol() {
	const {
		app,
		protocol,
		net
	} = electron;
	const register = () => {
		if (!schemeRegistered) {
			throw new Error('modloader 协议未在 app ready 前注册');
		}

		protocol.handle(MODLOADER_SCHEME, async (request) => {
			const relative = getResourcePath(request.url);
			if (!relative) return new Response('Not Found', { status: 404 });

			const resolved = core.PluginManager.resolvePath(relative);
			if (!resolved) return new Response('Not Found', { status: 404 });

			// 仅本协议由 ModLoader 处理。将真实路径交给原生 file: loader，
			// 以保留 Electron 的 ASAR、MIME、Range 与流式资源支持。
			return net.fetch(pathToFileURL(resolved).toString(), {
				method: request.method,
				headers: request.headers
			});
		});
		core.Logger.info('modloader 协议处理器已启用');
	};

	if (app.isReady()) register();
	else app.whenReady().then(register);
}

function init(dependencies) {
	core = dependencies;
}

module.exports = {
	init,
	applyFSHooks,
	setupProtocol,
	registerProtocolScheme
};
