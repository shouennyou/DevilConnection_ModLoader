/**
 * ============================================================================
 * ModLoader 文件与协议拦截.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { applyStandardDiff } = require('apply-multi-diff-patch');
const { parsePatch, applyPatches } = require('@sanity/diff-match-patch');
const electron = require('electron');
const patchReport = require('./patch-report');

let core;
const MODLOADER_SCHEME = 'modloader';
const MODLOADER_HOST = 'game';
const MEMORY_PROTOCOL_MODE = 'memory';
const FILE_CACHE_PROTOCOL_MODE = 'file-cache';
const PATCHABLE_EXTENSIONS = new Set([
	'.js', '.mjs', '.ts', '.html', '.css', '.ks', '.tjs',
	'.json', '.md', '.txt'
]);
const PATCHED_RESOURCE_CACHE = new Map();
const PATCH_CACHE_DIR = 'cache/patches';
const PATCH_CACHE_INDEX = 'cache/patches.json';

let patchCacheIndex = null;
let schemeRegistered = false;

/**
 * 必须在 app ready 前调用；即使当前使用 file-cache 模式也可安全预注册。
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

function getResourceProtocolMode() {
	try {
		const configPath = path.join(core.Env.getDataPath(), 'config', 'mod-manager.json');
		const config = JSON.parse(core.electronFs.readFileSync(configPath, 'utf-8'));
		return config?.resourceProtocolMode === MEMORY_PROTOCOL_MODE
			? MEMORY_PROTOCOL_MODE
			: FILE_CACHE_PROTOCOL_MODE;
	} catch (error) {
		return FILE_CACHE_PROTOCOL_MODE;
	}
}

function normalizeRelative(relative) {
	if (typeof relative !== 'string') return null;
	const normalized = relative.replace(/\\/g, '/').replace(/^\/+/, '');
	const segments = normalized.split('/');
	if (!normalized || segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\0'))) {
		return null;
	}
	return segments.join('/');
}

function getResourcePath(requestUrl) {
	try {
		const url = new URL(requestUrl);
		if (url.protocol !== `${MODLOADER_SCHEME}:` || url.hostname !== MODLOADER_HOST) return null;
		return normalizeRelative(decodeURIComponent(url.pathname));
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

function clampNumber(value, min, max) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : null;
}

/**
 * PatchWeaver 补丁可选地在首行携带 JSON 配置；旧式纯 DMP 补丁仍可正常读取。
 * Sanity DMP 的 Bitap 上下文最多安全支持 15，较大的 margin 可能导致匹配无法结束。
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
			const deleteThreshold = clampNumber(config?.deleteThreshold, 0, 1);
			if (margin !== null) options.margin = margin;
			// Sanity DMP treats 0 as its default threshold; use the smallest positive value for strict matching.
			if (deleteThreshold !== null) options.deleteThreshold = deleteThreshold === 0 ? Number.MIN_VALUE : deleteThreshold;
		} catch (error) {
			core.Logger.warn('PatchWeaver 补丁配置无效，使用默认应用策略', error);
		}
	}
	return { patches: parsePatch(documentText), options };
}

/**
 * 按游戏核心、低优先级模组到高优先级模组的顺序构建文本。
 * 同一层内完整文件覆盖当前内容，随后才应用此层的同名补丁。
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
			patchReport.recordFailure({
				layerPath: layer,
				patchPath,
				targetPath: relative,
				format: 'unknown',
				code: 'missing-base-file',
				message: '找不到补丁所需的基础文件'
			});
			core.Logger.warn(`跳过补丁（缺少基础文件）: ${patchPath}`);
			continue;
		}

		try {
			const document = normalizePatchText(core.electronFs.readFileSync(patchPath, 'utf-8'));
			if (/^(?:Index: .*\n=+\n)?--- [^\n]*\n\+\+\+ /m.test(document)) {
				const files = require('diff').parsePatch(document);
				if (files.length !== 1 || files[0].hunks.length === 0) {
					throw new Error('Unified diff 必须包含单个文件和至少一个修改片段');
				}
				const result = applyStandardDiff(text, document);
				if (!result.success) {
					patchReport.recordFailure({
						layerPath: layer,
						patchPath,
						targetPath: relative,
						format: 'unified',
						code: 'unified-apply-failed',
						message: 'Unified diff 无法应用到当前文件',
						detail: `${result.error.code}: ${result.error.message}`
					});
					core.Logger.warn(`跳过 Unified diff 补丁: ${patchPath} (${result.error.code}: ${result.error.message})`);
					continue;
				}
				text = result.content;
				patchReport.recordApplied({ layerPath: layer, patchPath, targetPath: relative, format: 'unified' });
				continue;
			}
			const { patches, options } = parsePatchDocument(document);
			const [nextText, applied] = applyPatches(patches, text, options);
			if (!applied.every(Boolean)) {
				patchReport.recordFailure({
					layerPath: layer,
					patchPath,
					targetPath: relative,
					format: 'dmp',
					code: 'context-mismatch',
					message: '补丁上下文与当前文件不匹配',
					detail: `${applied.filter(Boolean).length}/${applied.length} 个修改片段匹配成功`
				});
				core.Logger.warn(`跳过补丁（上下文不匹配）: ${patchPath}`);
				continue;
			}
			text = nextText;
			patchReport.recordApplied({ layerPath: layer, patchPath, targetPath: relative, format: 'dmp' });
		} catch (error) {
			patchReport.recordFailure({
				layerPath: layer,
				patchPath,
				targetPath: relative,
				format: 'unknown',
				code: 'apply-error',
				message: '读取、解析或应用补丁时发生错误',
				detail: error?.message || String(error)
			});
			core.Logger.warn(`应用补丁失败: ${patchPath}`, error);
		}
	}

	return hasSource ? text : null;
}

function getPatchCachePaths() {
	const dataPath = core.Env.getDataPath();
	return {
		directory: path.join(dataPath, PATCH_CACHE_DIR),
		index: path.join(dataPath, PATCH_CACHE_INDEX)
	};
}

function loadPatchCacheIndex() {
	if (patchCacheIndex) return patchCacheIndex;
	patchCacheIndex = { version: 1, resources: {} };
	const { index } = getPatchCachePaths();
	try {
		if (fs.existsSync(index)) {
			const parsed = JSON.parse(core.electronFs.readFileSync(index, 'utf-8'));
			if (parsed && typeof parsed === 'object' && parsed.resources && typeof parsed.resources === 'object') {
				patchCacheIndex = { version: 1, resources: parsed.resources };
			}
		}
	} catch (error) {
		core.Logger.warn(`读取补丁缓存索引失败，将重建: ${index}`, error);
	}
	return patchCacheIndex;
}

function writePatchCacheIndex() {
	const { directory, index } = getPatchCachePaths();
	try {
		fs.mkdirSync(directory, { recursive: true });
		fs.writeFileSync(index, JSON.stringify(loadPatchCacheIndex(), null, '\t'), 'utf-8');
	} catch (error) {
		core.Logger.warn(`写入补丁缓存索引失败: ${index}`, error);
	}
}

function getCacheExtension(relative) {
	const name = path.posix.basename(relative);
	return name.toLowerCase() === '.gitkeep' ? '.gitkeep' : (path.posix.extname(name) || '.txt').toLowerCase();
}

/**
 * interceptFileProtocol 只能返回磁盘路径；将最终文本按内容哈希写入缓存后返回该路径。
 */
function cachePatchedResource(relative, text) {
	const hash = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
	const { directory } = getPatchCachePaths();
	const filename = `${hash}${getCacheExtension(relative)}`;
	const cachePath = path.join(directory, filename);

	try {
		fs.mkdirSync(directory, { recursive: true });
		let validCache = false;
		if (fs.existsSync(cachePath)) {
			try {
				const current = core.electronFs.readFileSync(cachePath, 'utf-8');
				validCache = crypto.createHash('sha256').update(current, 'utf8').digest('hex') === hash;
			} catch (error) {
				core.Logger.warn(`验证补丁缓存失败，将重建: ${cachePath}`, error);
			}
		}
		if (!validCache) fs.writeFileSync(cachePath, text, 'utf-8');

		const resources = loadPatchCacheIndex().resources;
		resources[relative] = { hash, file: path.join(PATCH_CACHE_DIR, filename).replace(/\\/g, '/') };
		writePatchCacheIndex();
		return cachePath;
	} catch (error) {
		core.Logger.warn(`写入补丁缓存失败: ${cachePath}`, error);
		return null;
	}
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

function setupFileCacheProtocol(protocol) {
	protocol.interceptFileProtocol('file', (req, callback) => {
			let url = req.url.substr(8);
			url = decodeURIComponent(url);
			const q = url.indexOf('?');
			if (q !== -1) url = url.substring(0, q);

			const rel = normalizeRelative(extractRelative(path.normalize(url)));
			if (rel) {
				let patched = PATCHED_RESOURCE_CACHE.get(rel);
				if (patched === undefined) {
					const text = buildPatchedResource(rel);
					patched = text === null ? null : cachePatchedResource(rel, text);
					PATCHED_RESOURCE_CACHE.set(rel, patched);
				}
				if (patched) {
					callback({ path: patched });
					return;
				}
			}
			const found = rel ? core.PluginManager.resolvePath(rel) : null;
			callback({
				path: found || path.normalize(url)
			});
		});
	core.Logger.info('file 协议拦截已启用（补丁缓存模式）');
}

function setupMemoryProtocol(protocol, net) {
	if (!schemeRegistered) throw new Error('modloader 协议未在 app ready 前注册');

	protocol.handle(MODLOADER_SCHEME, async (request) => {
		const relative = getResourcePath(request.url);
		if (!relative) return new Response('Not Found', { status: 404 });

		let patched = PATCHED_RESOURCE_CACHE.get(relative);
		if (patched === undefined) {
			const text = buildPatchedResource(relative);
			patched = text === null ? null : { text, contentType: getContentType(relative) };
			PATCHED_RESOURCE_CACHE.set(relative, patched);
		}
		if (patched) {
			return new Response(patched.text, {
				headers: { 'content-type': patched.contentType }
			});
		}

		const resolved = core.PluginManager.resolvePath(relative);
		if (!resolved) return new Response('Not Found', { status: 404 });

		// 未修改资源由原生 file: 加载器返回，保留 ASAR、MIME、Range 和媒体流支持。
		return net.fetch(pathToFileURL(resolved).toString(), {
			method: request.method,
			headers: request.headers
		});
	});
	core.Logger.info('modloader 协议处理器已启用（内存补丁模式）');
}

function setupProtocol() {
	const { app, protocol, net } = electron;
	const register = () => {
		PATCHED_RESOURCE_CACHE.clear();
		if (getResourceProtocolMode() === MEMORY_PROTOCOL_MODE) setupMemoryProtocol(protocol, net);
		else setupFileCacheProtocol(protocol);
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
	registerProtocolScheme,
	getResourceProtocolMode
};
