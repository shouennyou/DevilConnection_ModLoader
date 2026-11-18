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
 * macOS 的 .app 包会在更新时整体替换，Linux 的安装目录通常也不适合承载用户数据，
 * 因此两个平台无论 Resources 是否可写都必须使用 Electron userData。
 * Windows 保持既有逻辑：resources 没有完整写权限时才改用 Electron userData 目录。
 */
function getWritableDataPath(resourcesPath, electron, fileSystem = fs) {
	const normalizedResourcesPath = path.normalize(resourcesPath);
	if (process.platform === 'darwin' || process.platform === 'linux') {
		const userDataPath = getElectronApp(electron)?.getPath('userData');
		if (typeof userDataPath === 'string' && userDataPath.trim()) {
			return path.normalize(userDataPath);
		}
		throw new Error(`${process.platform} 无法读取 Electron userData 数据目录`);
	}

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
