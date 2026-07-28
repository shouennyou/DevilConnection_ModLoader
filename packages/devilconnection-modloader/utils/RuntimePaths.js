const fs = require('fs');
const path = require('path');

/** 返回当前进程可用的 Electron app 对象. */
function getElectronApp(electron) {
	let electronApi = electron;
	if (!electronApi) {
		try {
			electronApi = require('electron');
		} catch {
			electronApi = null;
		}
	}
	const app = electronApi?.app || electronApi?.remote?.app;
	if (app?.getPath) return app;
	try {
		const remoteApp = require('@electron/remote').app;
		return remoteApp?.getPath ? remoteApp : null;
	} catch {
		return null;
	}
}

/** 判断目录是否具备创建, 修改和删除条目所需的完整目录权限. */
function hasFullWriteAccess(directory, fileSystem = fs) {
	try {
		fileSystem.accessSync(directory, fs.constants.W_OK | fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

const isWritable = hasFullWriteAccess;

/**
 * 返回可写数据根目录.
 * resources 目录没有完整写权限时, 统一改用 Electron 的 userData 目录.
 */
function getWritableDataPath(resourcesPath, electron, fileSystem = fs) {
	const normalizedResourcesPath = path.normalize(resourcesPath);
	if (hasFullWriteAccess(normalizedResourcesPath, fileSystem)) {
		return normalizedResourcesPath;
	}

	try {
		const userDataPath = getElectronApp(electron)?.getPath('userData');
		if (typeof userDataPath === 'string' && userDataPath.trim()) {
			return path.normalize(userDataPath);
		}
	} catch {
		// 无法取得 userData 时保持原路径, 由调用方返回原始错误.
	}
	return normalizedResourcesPath;
}

const getConfigDataPath = getWritableDataPath;

module.exports = {
	getWritableDataPath,
	getConfigDataPath,
	hasFullWriteAccess,
	isWritable,
};
