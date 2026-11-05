/**
 * ============================================================================
 * ModLoader 文件 API.
 * ============================================================================
 * 实现 window.modloader 的主进程文件操作.
 * 逻辑路径位于 resourcesPath 或同级 _storage. 安装目录不可写时自动映射到 userData.
 */

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { Env, Logger, PluginManager, electronFs } = require('./core');

let originalFs = fs;
try {
	originalFs = require('original-fs');
} catch (error) {
	Logger.error('original-fs 不可用, 使用 Node fs 回退', error);
}

const INVALID_PATH_ERROR = '路径必须位于 resources 或 ../_storage 目录内';
const READ_ONLY_GAME_RESOURCE_ERROR = '游戏资源虚拟目录为只读';
const GAME_RESOURCES_ROOT = 'game-resources';
const ORIGINAL_GAME_RESOURCES_ROOT = 'original-game-resources';
const DEFAULT_STREAM_CHUNK_SIZE = 256 * 1024;
const MAX_STREAM_CHUNK_SIZE = 1024 * 1024;

/**
 * 将渲染进程路径限制在 resourcesPath, userData 或同级 _storage.
 * 无法写入 resourcesPath 时, 写操作映射至 userData. 读操作优先读取 userData 副本.
 * @param {string} resourcesPath
 * @param {unknown} inputPath
 * @param {{ allowRoot?: boolean, allowStorage?: boolean, access?: 'read'|'write' }} [options]
 * @returns {string|null}
 */
function resolveResourcePath(resourcesPath, inputPath, options = {}) {
	if (typeof inputPath !== 'string' || inputPath.includes('\0')) return null;
	const portablePath = inputPath.replace(/\\/g, '/');
	const isConfigPath = portablePath === 'config' || portablePath.startsWith('config/');
	const isPluginPath = portablePath === 'mods' || portablePath.startsWith('mods/');
	const resourcesBase = path.resolve(resourcesPath);
	const dataBase = path.resolve(Env.getDataPath());
	const allowStorage = options.allowStorage !== false;
	const isStorageRelative = allowStorage && (portablePath === '../_storage'
		|| portablePath.startsWith('../_storage/'));
	const segments = portablePath.split('/');
	if (segments.some((segment, index) => segment === '..' && !(isStorageRelative && index === 0))) {
		return null;
	}

	const absolutePath = path.isAbsolute(inputPath) ? path.resolve(inputPath) : null;
	if (absolutePath && isPathWithin(dataBase, absolutePath)) {
		if (!options.allowRoot && path.relative(dataBase, absolutePath) === '') return null;
		return absolutePath;
	}

	const basePath = isConfigPath
		? dataBase
		: isPluginPath
			? path.dirname(Env.getPluginDir())
			: resourcesPath;
	const base = path.resolve(basePath);
	const storageBase = path.resolve(base, '..', '_storage');
	const resourcesStorageBase = path.resolve(resourcesBase, '..', '_storage');
	const fullPath = path.resolve(base, inputPath);
	const roots = allowStorage ? [base, storageBase] : [base];
	const matchedRoot = roots.find(root => isPathWithin(root, fullPath));
	if (!matchedRoot) return null;
	if (!options.allowRoot && path.relative(matchedRoot, fullPath) === '') return null;

	const usesResourceDataPath = dataBase !== resourcesBase;
	if (!usesResourceDataPath || isConfigPath || isPluginPath) return fullPath;

	const isStoragePath = isStorageRelative || isPathWithin(resourcesStorageBase, fullPath);
	if (isStoragePath) {
		const userStoragePath = path.resolve(
			dataBase,
			'_storage',
			path.relative(resourcesStorageBase, fullPath)
		);
		if (!isPathWithin(path.join(dataBase, '_storage'), userStoragePath)) return fullPath;
		if (options.access === 'write' || fs.existsSync(userStoragePath)) return userStoragePath;
		return fullPath;
	}

	if (!isPathWithin(resourcesBase, fullPath)) return fullPath;

	const userDataPath = path.resolve(dataBase, path.relative(resourcesBase, fullPath));
	if (!isPathWithin(dataBase, userDataPath)) return fullPath;
	if (options.access === 'write' || fs.existsSync(userDataPath)) return userDataPath;
	return fullPath;
}

function isPathWithin(root, target) {
	const relative = path.relative(path.resolve(root), path.resolve(target));
	return relative === '' || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function invalidPathResult() {
	return { success: false, error: INVALID_PATH_ERROR };
}

function readOnlyGameResourceResult() {
	return { success: false, error: READ_ONLY_GAME_RESOURCE_ERROR };
}

/**
 * 解析保留的游戏资源虚拟目录. 返回 null 表示普通资源路径.
 * 虚拟目录仅用于读取:
 * - game-resources: 已启用模组按优先级覆盖, 最后回退游戏核心
 * - original-game-resources: 仅当前选定的游戏核心
 */
function parseGameResourcePath(inputPath) {
	if (typeof inputPath !== 'string' || inputPath.includes('\0')) return null;
	const portablePath = inputPath.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
	const segments = portablePath.split('/');
	const root = segments.shift();
	const rootKey = root?.toLowerCase();
	const scope = rootKey === GAME_RESOURCES_ROOT
		? 'overlay'
		: rootKey === ORIGINAL_GAME_RESOURCES_ROOT
			? 'original'
			: null;
	if (!scope) return null;

	// 根目录本身允许用于 readdir; 其余路径必须是干净的相对路径.
	if (segments.length === 1 && segments[0] === '') segments.pop();
	if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
		return { scope, relative: null, invalid: true };
	}
	return { scope, relative: segments.join('/'), invalid: false };
}

function resolveGameResourcePath(resource) {
	if (!resource || resource.invalid || !resource.relative) return null;
	if (resource.scope === 'overlay') return PluginManager.resolvePath(resource.relative);
	const gameCorePath = PluginManager.gameCorePath;
	if (!gameCorePath) return null;
	return path.join(gameCorePath, ...resource.relative.split('/'));
}

/**
 * 解析普通资源路径或游戏资源虚拟路径. 虚拟路径强制使用 Electron fs,
 * 以保留 .asar/内部路径 的虚拟文件系统支持.
 */
function resolveReadablePath(resourcesPath, inputPath, options = {}) {
	const gameResource = parseGameResourcePath(inputPath);
	if (gameResource) {
		if (gameResource.invalid || (!options.allowRoot && !gameResource.relative)) return null;
		const fullPath = resolveGameResourcePath(gameResource);
		return fullPath ? { fullPath, fileSystem: fs, gameResource } : null;
	}
	const fullPath = resolveResourcePath(resourcesPath, inputPath, options);
	return fullPath ? { fullPath, fileSystem: getFileSystem(resourcesPath, fullPath), gameResource: null } : null;
}

function gameResourceSourcePaths(gameResource) {
	if (!gameResource || gameResource.invalid) return [];
	if (gameResource.scope === 'original') {
		return PluginManager.gameCorePath ? [PluginManager.gameCorePath] : [];
	}
	return Array.isArray(PluginManager.loadedPlugins) ? PluginManager.loadedPlugins : [];
}

function hasGameResourceMount(gameResource) {
	return gameResourceSourcePaths(gameResource).length > 0;
}

/** 为虚拟根目录构造可跨 IPC 传输的目录状态 DTO. */
function virtualDirectoryStat() {
	const now = Date.now();
	return {
		isFile: false,
		isDirectory: true,
		isSymbolicLink: false,
		isBlockDevice: false,
		isCharacterDevice: false,
		isFIFO: false,
		isSocket: false,
		size: 0,
		mode: 0o555,
		mtimeMs: now,
		atimeMs: now,
		ctimeMs: now,
		birthtimeMs: now,
		uid: 0,
		gid: 0,
		dev: 0,
		ino: 0,
		nlink: 1,
		blocks: 0,
		blksize: 0,
	};
}

function statGameResourceRoot(gameResource) {
	if (!gameResource || gameResource.invalid || gameResource.relative) return null;
	return hasGameResourceMount(gameResource) ? virtualDirectoryStat() : null;
}

/**
 * 将可用虚拟根注入 resources 根目录的列表. 两个名称为保留名称,
 * 因而同名真实条目不会暴露为普通资源目录.
 */
function withGameResourceMounts(entries) {
	const reserved = new Set([GAME_RESOURCES_ROOT, ORIGINAL_GAME_RESOURCES_ROOT]);
	const result = entries.filter(name => !reserved.has(name.toLowerCase()));
	const overlayRoot = parseGameResourcePath(GAME_RESOURCES_ROOT);
	const originalRoot = parseGameResourcePath(ORIGINAL_GAME_RESOURCES_ROOT);
	if (hasGameResourceMount(overlayRoot)) result.push(GAME_RESOURCES_ROOT);
	if (hasGameResourceMount(originalRoot)) result.push(ORIGINAL_GAME_RESOURCES_ROOT);
	return result;
}

function isResourcesRootRequest(inputPath) {
	if (typeof inputPath !== 'string') return false;
	const portablePath = inputPath.replace(/\\/g, '/');
	return portablePath === '' || portablePath === '.' || portablePath === './';
}

/** 合并游戏资源覆盖视图中的目录项; 同名项保留高优先级来源的名称. */
function readdirGameResourceSync(gameResource) {
	if (!gameResource || gameResource.invalid) return null;
	if (gameResource.relative) {
		const resolvedPath = resolveGameResourcePath(gameResource);
		if (!resolvedPath) return null;
		try {
			// 先验证优先级最高的目标确实是可读取目录.
			fs.readdirSync(resolvedPath);
		} catch (error) {
			if (isPathNotFoundError(error) || error.code === 'ENOTDIR') return null;
			Logger.error(`读取游戏资源目录失败: ${resolvedPath}`, error);
			return null;
		}
	}

	const entries = new Map();
	for (const sourceRoot of gameResourceSourcePaths(gameResource)) {
		const sourcePath = gameResource.relative
			? path.join(sourceRoot, ...gameResource.relative.split('/'))
			: sourceRoot;
		try {
			for (const name of fs.readdirSync(sourcePath)) {
				const key = name.toLocaleLowerCase();
				if (!entries.has(key)) entries.set(key, name);
			}
		} catch (error) {
			if (!isPathNotFoundError(error) && error.code !== 'ENOTDIR') {
				Logger.error(`读取游戏资源目录失败: ${sourcePath}`, error);
			}
		}
	}
	return entries.size > 0 ? [...entries.values()] : null;
}

function normalizeRmOptions(options) {
	const value = options && typeof options === 'object' ? options : {};
	return {
		recursive: value.recursive === true,
		force: value.force === true,
	};
}

function normalizeReadOptions(options) {
	const value = options && typeof options === 'object' ? options : {};
	return { encoding: value.encoding === null ? null : 'utf8' };
}

function normalizeWriteOptions(options) {
	const value = options && typeof options === 'object' ? options : {};
	return {
		encoding: value.encoding === null ? null : 'utf8',
		append: value.append === true,
	};
}

function toWriteData(content) {
	if (content == null) return '';
	if (typeof content === 'string' || Buffer.isBuffer(content)) return content;
	if (content instanceof ArrayBuffer) return Buffer.from(content);
	if (ArrayBuffer.isView(content)) return Buffer.from(content.buffer, content.byteOffset, content.byteLength);
	return Buffer.from(content);
}

/** 判断异常是否仅表示目标路径不存在. */
function isPathNotFoundError(error) {
	return error && typeof error === 'object' && error.code === 'ENOENT';
}

function getFileSystem(resourcesPath, fullPath) {
	const modsPath = path.resolve(Env.getPluginDir());
	const relativeToMods = path.relative(modsPath, fullPath);
	const isModPath = relativeToMods === ''
		|| (!relativeToMods.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeToMods));
	return isModPath ? originalFs : fs;
}

function getPromises(fileSystem) {
	return fileSystem.promises || fs.promises;
}

function uncacheAsar(fullPath) {
	if (!fullPath.toLowerCase().endsWith('.asar')) return;
	try {
		require('../utils/AsarReader').uncacheAsar(fullPath);
	} catch (error) {
		Logger.warn(`清除 ASAR 缓存失败: ${fullPath}`, error);
	}
}

function closeFileStream(stream, commit = false) {
	if (!stream || stream.closed) return { success: false, error: '文件流已关闭' };
	stream.closed = true;
	let succeeded = false;
	try {
		stream.fileSystem.closeSync(stream.fd);
		if (stream.type === 'write') {
			if (commit) {
				stream.fileSystem.renameSync(stream.tempPath, stream.targetPath);
				uncacheAsar(stream.targetPath);
			} else {
				stream.fileSystem.unlinkSync(stream.tempPath);
			}
		}
		succeeded = true;
		return { success: true };
	} catch (error) {
		Logger.error(`关闭${stream.type === 'write' ? '写入' : '读取'}流失败`, error);
		return { success: false, error: error.message };
	} finally {
		if (!succeeded && stream.type === 'write') {
			try {
				stream.fileSystem.unlinkSync(stream.tempPath);
			} catch (error) {
				Logger.error(`清理临时文件失败: ${stream.tempPath}`, error);
			}
		}
	}
}

/**
 * 将 fs.Stats 转换为可跨 IPC 序列化的数据对象.
 * 类型判定方法在主进程求值, 由 preload 在渲染端重建.
 */
function statToDTO(s) {
	return {
		isFile: s.isFile(),
		isDirectory: s.isDirectory(),
		isSymbolicLink: s.isSymbolicLink(),
		isBlockDevice: s.isBlockDevice(),
		isCharacterDevice: s.isCharacterDevice(),
		isFIFO: s.isFIFO(),
		isSocket: s.isSocket(),
		size: s.size,
		mode: s.mode,
		mtimeMs: s.mtimeMs,
		atimeMs: s.atimeMs,
		ctimeMs: s.ctimeMs,
		birthtimeMs: s.birthtimeMs,
		uid: s.uid,
		gid: s.gid,
		dev: s.dev,
		ino: s.ino,
		nlink: s.nlink,
		blocks: s.blocks,
		blksize: s.blksize
	};
}

const ModLoaderApi = {
	resourcesPath: Env.getResourcesPath(),

	readFileSync(relative, options) {
		const target = resolveReadablePath(this.resourcesPath, relative);
		if (!target) return null;
		try {
			// fs.readFileSync 会被 hooks.js 替换为按模组优先级重新路由的版本。
			// 路径已在 resolveReadablePath 中决定；此处必须使用 Hook 前保存的
			// Electron fs，避免 original-game-resources 被再次解析为模组覆盖资源。
			return electronFs.readFileSync(target.fullPath, normalizeReadOptions(options));
		} catch (error) {
			if (isPathNotFoundError(error)) return null;
			Logger.error(`同步读取文件失败: ${target.fullPath}`, error);
			return null;
		}
	},

	/**
	 * 异步读取文件内容, 路径不存在时返回 null.
	 * @param {string} relative
	 * @returns {Promise<string|null>}
	 */
	async readFile(relative, options) {
		const target = resolveReadablePath(this.resourcesPath, relative);
		if (!target) return null;
		try {
			return await fs.promises.readFile(target.fullPath, normalizeReadOptions(options));
		} catch (error) {
			if (isPathNotFoundError(error)) return null;
			Logger.error(`异步读取文件失败: ${target.fullPath}`, error);
			return null;
		}
	},

	/**
 * 同步写入文件并自动创建父目录.
	 * @param {string} relative
	 * @param {string} content
	 * @returns {{ success: boolean, error?: string }}
	 */
	writeFileSync(relative, content, options) {
		if (parseGameResourcePath(relative)) return readOnlyGameResourceResult();
		const fullPath = resolveResourcePath(this.resourcesPath, relative, { access: 'write' });
		if (!fullPath) return invalidPathResult();
		try {
			const fileSystem = getFileSystem(this.resourcesPath, fullPath);
			const writeOptions = normalizeWriteOptions(options);
			fileSystem.mkdirSync(path.dirname(fullPath), { recursive: true });
			const data = toWriteData(content);
			if (writeOptions.append) fileSystem.appendFileSync(fullPath, data, writeOptions.encoding ?? undefined);
			else fileSystem.writeFileSync(fullPath, data, writeOptions.encoding ?? undefined);
			uncacheAsar(fullPath);
			return { success: true };
		} catch (error) {
			Logger.error(`同步写入文件失败: ${fullPath}`, error);
			return { success: false, error: error.message };
		}
	},

	/**
 * 异步写入文件并自动创建父目录.
	 * @param {string} relative
	 * @param {string} content
	 * @returns {Promise<{ success: boolean, error?: string }>}
	 */
	async writeFile(relative, content, options) {
		if (parseGameResourcePath(relative)) return readOnlyGameResourceResult();
		const fullPath = resolveResourcePath(this.resourcesPath, relative, { access: 'write' });
		if (!fullPath) return invalidPathResult();
		try {
			const fileSystem = getFileSystem(this.resourcesPath, fullPath);
			const promises = getPromises(fileSystem);
			const writeOptions = normalizeWriteOptions(options);
			await promises.mkdir(path.dirname(fullPath), { recursive: true });
			const data = toWriteData(content);
			if (writeOptions.append) await promises.appendFile(fullPath, data, writeOptions.encoding ?? undefined);
			else await promises.writeFile(fullPath, data, writeOptions.encoding ?? undefined);
			uncacheAsar(fullPath);
			return { success: true };
		} catch (error) {
			Logger.error(`异步写入文件失败: ${fullPath}`, error);
			return { success: false, error: error.message };
		}
	},

	/**
 * 创建二进制读取流会话, 渲染端通过返回的 ID 拉取数据块.
	 * @param {string} relative
	 * @returns {{ success: boolean, stream?: object, size?: number, error?: string }}
	 */
	createReadStream(relative) {
		const target = resolveReadablePath(this.resourcesPath, relative);
		if (!target) return invalidPathResult();
		try {
			const { fullPath, fileSystem } = target;
			const stats = fileSystem.statSync(fullPath);
			if (!stats.isFile()) return { success: false, error: '只能读取普通文件' };
			return {
				success: true,
				size: stats.size,
				stream: {
					type: 'read',
					fileSystem,
					fd: fileSystem.openSync(fullPath, 'r'),
					position: 0,
					closed: false,
				},
			};
		} catch (error) {
			Logger.error(`创建读取流失败: ${fullPath}`, error);
			return { success: false, error: error.message };
		}
	},

	/** 读取读取流会话的下一块数据. */
	readStreamChunk(stream, requestedSize = DEFAULT_STREAM_CHUNK_SIZE) {
		if (!stream || stream.type !== 'read' || stream.closed) {
			return { success: false, error: '无效或已关闭的读流' };
		}
		const chunkSize = Number.isInteger(requestedSize)
			? Math.min(Math.max(requestedSize, 1), MAX_STREAM_CHUNK_SIZE)
			: DEFAULT_STREAM_CHUNK_SIZE;
		try {
			const buffer = Buffer.allocUnsafe(chunkSize);
			const bytesRead = stream.fileSystem.readSync(stream.fd, buffer, 0, chunkSize, stream.position);
			if (bytesRead === 0) {
				closeFileStream(stream);
				return { success: true, done: true };
			}
			stream.position += bytesRead;
			return { success: true, done: false, chunk: buffer.subarray(0, bytesRead) };
		} catch (error) {
			closeFileStream(stream);
			Logger.error('读取流数据块失败', error);
			return { success: false, error: error.message };
		}
	},

	/**
	 * 创建二进制写入流会话.
	 * 数据先写入同目录临时文件, 仅在提交时替换目标文件.
	 * @param {string} relative
	 * @returns {{ success: boolean, stream?: object, error?: string }}
	 */
	createWriteStream(relative) {
		if (parseGameResourcePath(relative)) return readOnlyGameResourceResult();
		const targetPath = resolveResourcePath(this.resourcesPath, relative, { access: 'write' });
		if (!targetPath) return invalidPathResult();
		try {
			const fileSystem = getFileSystem(this.resourcesPath, targetPath);
			fileSystem.mkdirSync(path.dirname(targetPath), { recursive: true });
			const tempPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${randomUUID()}.upload`);
			return {
				success: true,
				stream: {
					type: 'write',
					fileSystem,
					fd: fileSystem.openSync(tempPath, 'wx'),
					targetPath,
					tempPath,
					closed: false,
				},
			};
		} catch (error) {
			Logger.error(`创建写入流失败: ${targetPath}`, error);
			return { success: false, error: error.message };
		}
	},

	/** 向写入流会话写入一个二进制数据块. */
	writeStreamChunk(stream, chunk) {
		if (!stream || stream.type !== 'write' || stream.closed) {
			return { success: false, error: '无效或已关闭的写流' };
		}
		try {
			const buffer = Buffer.from(chunk || []);
			let offset = 0;
			while (offset < buffer.length) {
				const written = stream.fileSystem.writeSync(stream.fd, buffer, offset, buffer.length - offset);
				if (written <= 0) throw new Error('写入文件时未写入任何数据');
				offset += written;
			}
			return { success: true };
		} catch (error) {
			closeFileStream(stream);
			Logger.error('写入流数据块失败', error);
			return { success: false, error: error.message };
		}
	},

	/** 关闭流会话, 写入流仅在 commit 为 true 时替换目标文件. */
	closeStream(stream, commit = false) {
		return closeFileStream(stream, commit);
	},

	/** 同步删除文件或目录. 默认不递归且目标不存在时报错. */
	rmSync(relative, options) {
		if (parseGameResourcePath(relative)) return readOnlyGameResourceResult();
		const fullPath = resolveResourcePath(this.resourcesPath, relative, { access: 'write' });
		if (!fullPath) return invalidPathResult();
		try {
			getFileSystem(this.resourcesPath, fullPath).rmSync(fullPath, normalizeRmOptions(options));
			return { success: true };
		} catch (error) {
			Logger.error(`同步删除路径失败: ${fullPath}`, error);
			return { success: false, error: error.message };
		}
	},

	/** 异步删除文件或目录. 默认不递归且目标不存在时报错. */
	async rm(relative, options) {
		if (parseGameResourcePath(relative)) return readOnlyGameResourceResult();
		const fullPath = resolveResourcePath(this.resourcesPath, relative, { access: 'write' });
		if (!fullPath) return invalidPathResult();
		try {
			const promises = getPromises(getFileSystem(this.resourcesPath, fullPath));
			await promises.rm(fullPath, normalizeRmOptions(options));
			return { success: true };
		} catch (error) {
			Logger.error(`异步删除路径失败: ${fullPath}`, error);
			return { success: false, error: error.message };
		}
	},

	/** 同步获取文件状态 DTO, 路径不存在时返回 null. */
	statSync(relative) {
		const gameResource = parseGameResourcePath(relative);
		if (gameResource && !gameResource.relative) return statGameResourceRoot(gameResource);
		const target = resolveReadablePath(this.resourcesPath, relative, { allowRoot: true });
		if (!target) return null;
		try {
			return statToDTO(target.fileSystem.statSync(target.fullPath));
		} catch (error) {
			if (isPathNotFoundError(error)) return null;
			Logger.error(`同步获取文件状态失败: ${target.fullPath}`, error);
			return null;
		}
	},

	/** 异步获取文件状态 DTO, 路径不存在时返回 null. */
	async stat(relative) {
		const gameResource = parseGameResourcePath(relative);
		if (gameResource && !gameResource.relative) return statGameResourceRoot(gameResource);
		const target = resolveReadablePath(this.resourcesPath, relative, { allowRoot: true });
		if (!target) return null;
		try {
			return statToDTO(await getPromises(target.fileSystem).stat(target.fullPath));
		} catch (error) {
			if (isPathNotFoundError(error)) return null;
			Logger.error(`异步获取文件状态失败: ${target.fullPath}`, error);
			return null;
		}
	},

	/** 同步读取目录项名称数组, 失败时返回 null. */
	readdirSync(relative) {
		const gameResource = parseGameResourcePath(relative);
		if (gameResource) return readdirGameResourceSync(gameResource);
		const fullPath = resolveResourcePath(this.resourcesPath, relative, { allowRoot: true });
		if (!fullPath) return null;
		try {
			const entries = fs.readdirSync(fullPath);
			return isResourcesRootRequest(relative) ? withGameResourceMounts(entries) : entries;
		} catch (error) {
			if (isPathNotFoundError(error)) return null;
			Logger.error(`同步读取目录失败: ${fullPath}`, error);
			return null;
		}
	},

	/** 异步读取目录项名称数组, 失败时返回 null. */
	async readdir(relative) {
		const gameResource = parseGameResourcePath(relative);
		if (gameResource) return readdirGameResourceSync(gameResource);
		const fullPath = resolveResourcePath(this.resourcesPath, relative, { allowRoot: true });
		if (!fullPath) return null;
		try {
			const entries = await fs.promises.readdir(fullPath);
			return isResourcesRootRequest(relative) ? withGameResourceMounts(entries) : entries;
		} catch (error) {
			if (isPathNotFoundError(error)) return null;
			Logger.error(`异步读取目录失败: ${fullPath}`, error);
			return null;
		}
	},

	/** 同步重命名或移动文件并自动创建目标父目录. */
	renameSync(oldRelative, newRelative) {
		if (parseGameResourcePath(oldRelative) || parseGameResourcePath(newRelative)) return readOnlyGameResourceResult();
		const from = resolveResourcePath(this.resourcesPath, oldRelative);
		const to = resolveResourcePath(this.resourcesPath, newRelative, { access: 'write' });
		if (!from || !to) return invalidPathResult();
		try {
			const fileSystem = getFileSystem(this.resourcesPath, from) === originalFs
				|| getFileSystem(this.resourcesPath, to) === originalFs
				? originalFs
				: fs;
			fileSystem.mkdirSync(path.dirname(to), { recursive: true });
			fileSystem.renameSync(from, to);
			return { success: true };
		} catch (error) {
			Logger.error(`同步重命名或移动文件失败: ${from} -> ${to}`, error);
			return { success: false, error: error.message };
		}
	},

	/** 异步重命名或移动文件并自动创建目标父目录. */
	async rename(oldRelative, newRelative) {
		if (parseGameResourcePath(oldRelative) || parseGameResourcePath(newRelative)) return readOnlyGameResourceResult();
		const from = resolveResourcePath(this.resourcesPath, oldRelative);
		const to = resolveResourcePath(this.resourcesPath, newRelative, { access: 'write' });
		if (!from || !to) return invalidPathResult();
		try {
			const fileSystem = getFileSystem(this.resourcesPath, from) === originalFs
				|| getFileSystem(this.resourcesPath, to) === originalFs
				? originalFs
				: fs;
			const promises = getPromises(fileSystem);
			await promises.mkdir(path.dirname(to), { recursive: true });
			await promises.rename(from, to);
			return { success: true };
		} catch (error) {
			Logger.error(`异步重命名或移动文件失败: ${from} -> ${to}`, error);
			return { success: false, error: error.message };
		}
	},

	/** 同步复制文件并自动创建目标父目录. */
	copyFileSync(srcRelative, destRelative) {
		if (parseGameResourcePath(destRelative)) return readOnlyGameResourceResult();
		const source = resolveReadablePath(this.resourcesPath, srcRelative);
		const src = source?.fullPath;
		const dest = resolveResourcePath(this.resourcesPath, destRelative, { access: 'write' });
		if (!src || !dest) return invalidPathResult();
		try {
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			fs.copyFileSync(src, dest);
			return { success: true };
		} catch (error) {
			Logger.error(`同步复制文件失败: ${src} -> ${dest}`, error);
			return { success: false, error: error.message };
		}
	},

	/** 异步复制文件并自动创建目标父目录. */
	async copyFile(srcRelative, destRelative) {
		if (parseGameResourcePath(destRelative)) return readOnlyGameResourceResult();
		const source = resolveReadablePath(this.resourcesPath, srcRelative);
		const src = source?.fullPath;
		const dest = resolveResourcePath(this.resourcesPath, destRelative, { access: 'write' });
		if (!src || !dest) return invalidPathResult();
		try {
			await fs.promises.mkdir(path.dirname(dest), { recursive: true });
			await fs.promises.copyFile(src, dest);
			return { success: true };
		} catch (error) {
			Logger.error(`异步复制文件失败: ${src} -> ${dest}`, error);
			return { success: false, error: error.message };
		}
	}
};

module.exports = { INVALID_PATH_ERROR, ModLoaderApi, statToDTO, resolveResourcePath };
