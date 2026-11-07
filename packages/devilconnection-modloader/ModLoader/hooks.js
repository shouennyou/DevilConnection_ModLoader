/**
 * ============================================================================
 * ModLoader 文件与协议拦截.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { parsePatch, applyPatches } = require('@sanity/diff-match-patch');
const electron = require('electron');

let core;
const MODLOADER_SCHEME = 'modloader';
const MODLOADER_HOST = 'game';
const PATCHABLE_EXTENSIONS = new Set([
	'.js', '.mjs', '.ts', '.html', '.css', '.ks', '.tjs',
	'.json', '.md', '.txt'
]);
const PATCHED_RESOURCE_CACHE = new Map();
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

/** 返回资源对应的同名补丁路径，例如 tyrano/libs/apng.js.patch。 */
function getPatchPath(relative) {
	const name = path.posix.basename(relative);
	const extension = path.posix.extname(name).toLowerCase();
	if (!PATCHABLE_EXTENSIONS.has(extension) && name.toLowerCase() !== '.gitkeep') return null;
	return `${relative}.patch`;
}

function getLayerPath(layerPath, relative) {
	return path.join(layerPath, ...relative.split('/'));
}

/** PatchWeaver 以 UTF-8（无 BOM）和 LF 作为补丁上下文的统一文本表示。 */
function normalizePatchText(text) {
	return text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

function getContentType(relative) {
	switch (path.posix.extname(relative).toLowerCase()) {
		case '.html': return 'text/html; charset=utf-8';
		case '.js':
		case '.mjs': return 'text/javascript; charset=utf-8';
		case '.ts': return 'application/typescript; charset=utf-8';
		case '.css': return 'text/css; charset=utf-8';
		case '.json': return 'application/json; charset=utf-8';
		case '.md': return 'text/markdown; charset=utf-8';
		default: return 'text/plain; charset=utf-8';
	}
}

function clampNumber(value, min, max) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : null;
}

/**
 * PatchWeaver 补丁可选地在首行携带 JSON 配置；旧式纯 DMP 补丁仍可正常读取。
 * 例如：# patch-weaver: {"margin":32,"deleteThreshold":0.2}
 */
function parsePatchDocument(patchText) {
	patchText = normalizePatchText(patchText);
	const header = /^# patch-weaver: ([^\r\n]+)\r?\n/.exec(patchText);
	const options = {};
	let documentText = patchText;
	if (header) {
		documentText = patchText.slice(header[0].length);
		try {
			const config = JSON.parse(header[1]);
			const margin = clampNumber(config?.margin, 1, 15);
			const deleteThreshold = clampNumber(config?.deleteThreshold, 0.01, 1);
			if (margin !== null) options.margin = margin;
			if (deleteThreshold !== null) options.deleteThreshold = deleteThreshold;
		} catch (error) {
			core.Logger.warn('PatchWeaver 补丁配置无效，使用默认应用策略', error);
		}
	}
	return { patches: parsePatch(documentText), options };
}

/**
 * 仅在至少一个模组提供同名 .patch 时，按低到高优先级构建文本资源。
 * 每层的完整文件先覆盖当前文本，再应用该层的同名补丁。
 */
function buildPatchedResource(relative) {
	const patchRelative = getPatchPath(relative);
	if (!patchRelative) return null;

	const layers = core.PluginManager.loadedPlugins;
	if (!layers.some(layer => fs.existsSync(getLayerPath(layer, patchRelative)))) return null;

	let text = null;
	let hasSource = false;
	for (const layer of [...layers].reverse()) {
		const resourcePath = getLayerPath(layer, relative);
		if (fs.existsSync(resourcePath)) {
			try {
				// 使用未被资源映射 Hook 改写的 Electron fs，直接读取当前层。
				text = normalizePatchText(core.electronFs.readFileSync(resourcePath, 'utf-8'));
				hasSource = true;
			} catch (error) {
				core.Logger.warn(`读取补丁资源失败: ${resourcePath}`, error);
				continue;
			}
		}

		const patchPath = getLayerPath(layer, patchRelative);
		if (!fs.existsSync(patchPath)) continue;
		if (!hasSource) {
			core.Logger.warn(`跳过补丁（缺少基础文件）: ${patchPath}`);
			continue;
		}

		try {
			const patchText = core.electronFs.readFileSync(patchPath, 'utf-8');
			const { patches, options } = parsePatchDocument(patchText);
			const [nextText, applied] = applyPatches(patches, text, options);
			if (!applied.every(Boolean)) {
				core.Logger.warn(`跳过补丁（上下文不匹配）: ${patchPath}`);
				continue;
			}
			text = nextText;
		} catch (error) {
			core.Logger.warn(`应用补丁失败: ${patchPath}`, error);
		}
	}

	if (!hasSource) return null;
	return { text, contentType: getContentType(relative) };
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
		PATCHED_RESOURCE_CACHE.clear();

		protocol.handle(MODLOADER_SCHEME, async (request) => {
			const relative = getResourcePath(request.url);
			if (!relative) return new Response('Not Found', { status: 404 });

			let patched = PATCHED_RESOURCE_CACHE.get(relative);
			if (!patched) {
				patched = buildPatchedResource(relative);
				if (patched) PATCHED_RESOURCE_CACHE.set(relative, patched);
			}
			if (patched) {
				return new Response(patched.text, {
					headers: { 'content-type': patched.contentType }
				});
			}

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
