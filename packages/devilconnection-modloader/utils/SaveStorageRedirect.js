const fs = require('fs');
const path = require('path');

const CONFIG_DIR = 'config';
const APP_CONFIG_FILE = 'mod-manager.json';
const SAVE_IMPORT_DIR_KEY = 'saveImportDir';
const SAVE_STORAGE_REDIRECT_ENABLED_KEY = 'saveStorageRedirectEnabled';

function isPathWithin(root, target) {
	const relative = path.relative(path.resolve(root), path.resolve(target));
	return relative === '' || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function readAppConfig(dataPath, fileSystem) {
	try {
		const configPath = path.join(dataPath, CONFIG_DIR, APP_CONFIG_FILE);
		if (!fileSystem.existsSync(configPath)) return {};
		const config = JSON.parse(fileSystem.readFileSync(configPath, 'utf-8'));
		return config && typeof config === 'object' && !Array.isArray(config) ? config : {};
	} catch (error) {
		return {};
	}
}

function getDirectoryState(directoryPath, fileSystem) {
	if (typeof directoryPath !== 'string' || !path.isAbsolute(directoryPath)) {
		return { exists: false, writable: false, missing: false, issue: 'unavailable' };
	}
	try {
		if (!fileSystem.statSync(directoryPath).isDirectory()) {
			return { exists: false, writable: false, missing: false, issue: 'not-directory' };
		}
	} catch (error) {
		return error?.code === 'ENOENT'
			? { exists: false, writable: false, missing: true, issue: 'missing' }
			: { exists: false, writable: false, missing: false, issue: 'unavailable' };
	}

	try {
		const constants = fileSystem.constants || fs.constants;
		fileSystem.accessSync(directoryPath, constants.R_OK | constants.W_OK);
		return { exists: true, writable: true, missing: false, issue: null };
	} catch (error) {
		return { exists: true, writable: false, missing: false, issue: 'unwritable' };
	}
}

/**
 * 返回原版存档目录重定向的配置与可生效状态。
 * @param {string} dataPath
 * @param {typeof fs} [fileSystem]
 */
function getSaveStorageRedirectStatus(dataPath, fileSystem = fs) {
	const config = readAppConfig(dataPath, fileSystem);
	const enabled = config[SAVE_STORAGE_REDIRECT_ENABLED_KEY] === true;
	const rawPath = config[SAVE_IMPORT_DIR_KEY];
	const saveImportDir = typeof rawPath === 'string' && rawPath.trim()
		? path.normalize(rawPath.trim())
		: null;
	const configured = saveImportDir !== null && path.isAbsolute(saveImportDir);
	const directoryState = configured
		? getDirectoryState(saveImportDir, fileSystem)
		: { exists: false, writable: false, missing: false, issue: null };

	let message;
	if (enabled && !configured) message = '请先选择原版存档文件夹';
	else if (directoryState.missing) message = enabled
		? '原版存档文件夹尚未创建；游戏写入或恢复备份时可自动重建'
		: '原版存档文件夹尚未创建，可在开启时创建';
	else if (directoryState.issue === 'not-directory') message = '原版存档路径不是文件夹';
	else if (directoryState.issue === 'unavailable') message = '原版存档文件夹无法访问';
	else if (directoryState.issue === 'unwritable') message = '原版存档文件夹不可写';

	return {
		enabled,
		active: enabled && directoryState.writable,
		path: configured ? saveImportDir : null,
		configured,
		exists: directoryState.exists,
		writable: directoryState.writable,
		missing: directoryState.missing,
		issue: directoryState.issue,
		...(message ? { message } : {}),
	};
}

/**
 * 将默认存档根目录内的路径映射至已配置的原版存档目录。
 * 开关已启用且路径已配置时，即使目标目录暂缺也返回重定向路径，
 * 由调用方决定是返回原生文件错误，还是在受控的写入操作中重建该目录；绝不回退至独立版目录。
 * @param {string} dataPath
 * @param {string} defaultStoragePath
 * @param {string} targetPath
 * @param {typeof fs} [fileSystem]
 */
function resolveSaveStorageRedirect(dataPath, defaultStoragePath, targetPath, fileSystem = fs) {
	const resolvedDefaultStoragePath = path.resolve(defaultStoragePath);
	const resolvedTargetPath = path.resolve(targetPath);
	if (!isPathWithin(resolvedDefaultStoragePath, resolvedTargetPath)) {
		return { matched: false, path: resolvedTargetPath, status: null };
	}

	const status = getSaveStorageRedirectStatus(dataPath, fileSystem);
	if (!status.enabled) return { matched: true, path: resolvedTargetPath, status };
	// 已启用且已配置时始终映射到原版路径。目录暂缺时让调用方的创建/写入操作重建它，
	// 但绝不回退到独立版存档目录。
	if (!status.configured || !status.path) return { matched: true, path: null, status };

	const redirectedPath = path.resolve(status.path, path.relative(resolvedDefaultStoragePath, resolvedTargetPath));
	return {
		matched: true,
		path: isPathWithin(status.path, redirectedPath) ? redirectedPath : null,
		status,
	};
}

module.exports = {
	getSaveStorageRedirectStatus,
	resolveSaveStorageRedirect,
};
