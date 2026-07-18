/**
 * ============================================================================
 * ModLoader 文件与协议拦截.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const electron = require('electron');

let core;

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

function setupProtocol() {
	const {
		app,
		protocol
	} = electron;
	const register = () => {
		protocol.interceptFileProtocol('file', (req, callback) => {
			let url = req.url.substr(8);
			url = decodeURIComponent(url);
			const q = url.indexOf('?');
			if (q !== -1) url = url.substring(0, q);

			const rel = extractRelative(path.normalize(url));
			const found = rel ? core.PluginManager.resolvePath(rel) : null;
			callback({
				path: found || path.normalize(url)
			});
		});
		core.Logger.info('协议拦截已启用');
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
	setupProtocol
};
