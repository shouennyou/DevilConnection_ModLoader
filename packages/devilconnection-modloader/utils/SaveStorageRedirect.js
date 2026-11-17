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
	let exists = false;
	let writable = false;
	if (configured) {
		try {
			exists = fileSystem.statSync(saveImportDir).isDirectory();
			if (exists) {
				const constants = fileSystem.constants || fs.constants;
				fileSystem.accessSync(saveImportDir, constants.R_OK | constants.W_OK);
				writable = true;
			}
		} catch (error) {
			exists = false;
			writable = false;
		}
	}

	let message;
	if (enabled && !configured) message = '请先选择原版存档文件夹';
	else if (enabled && !exists) message = '原版存档文件夹无法访问, 请重新选择';
	else if (enabled && !writable) message = '原版存档文件夹不可写';

	return {
		enabled,
		active: enabled && writable,
		path: configured ? saveImportDir : null,
		configured,
		exists,
		writable,
		...(message ? { message } : {}),
	};
}

/**
 * 将默认存档根目录内的路径映射至已配置的原版存档目录。
 * 开关已启用但目标目录不可用时返回 path: null，调用方应拒绝操作而不是回退至独立版目录。
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
	if (!status.active || !status.path) return { matched: true, path: null, status };

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
