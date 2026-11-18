const {
	contextBridge,
	ipcRenderer
} = require('electron')
const fs = require('fs')
const path = require('path')

let resolveSaveStorageRedirect = null
try {
	({ resolveSaveStorageRedirect } = require('devilconnection-modloader/utils/SaveStorageRedirect'))
} catch (e) {
	console.error('[ModLoader] 存档重定向工具加载失败:', e)
}

let modloader = {}
let modmanager = {}
try {
	({ modloader, modmanager } = require('devilconnection-modloader/extra/preload'))
} catch (e) {
	console.error('[ModLoader] extra-preload 加载失败:', e);
}

try {
	require('devilconnection-modloader/ModLoader/index');
} catch (e) {
	console.error('[ModLoader] 加载失败:', e);
}

/**
 * 解析游戏通过 window.api 访问的默认存档路径。
 * 仅映射默认 _storage 及其等价绝对路径；其他文件系统路径保持原样。
 * 重定向已开启且已配置时始终返回原版路径，目录缺失时由游戏的创建/写入操作重建；
 * 未配置目标时才拒绝操作，避免静默回退到独立版存档目录。
 */
function getSavePathResolution(filePath) {
	if (typeof filePath !== 'string' || !resolveSaveStorageRedirect) {
		return { path: filePath, redirected: false, storagePath: null }
	}
	let dataPath = null
	try {
		dataPath = modloader?.returnModLoaderDataPath?.() || null
	} catch (e) {
		console.error('[ModLoader] 读取存档重定向数据目录失败:', e)
	}
	if (typeof dataPath !== 'string' || !dataPath.trim()) {
		return { path: filePath, redirected: false, storagePath: null }
	}

	let defaultStoragePath = null
	if (process.platform === 'darwin') {
		// 与 returnAppPath() 保持一致：原版会对 userData/app.asar 取 dirname，
		// 因而实际通过 window.api 访问的是 userData/_storage。
		const gameSaveAppPath = ipcRenderer.sendSync('getGameSaveAppPath')
		if (typeof gameSaveAppPath === 'string' && gameSaveAppPath.trim()) {
			defaultStoragePath = path.resolve(path.dirname(gameSaveAppPath), '_storage')
		}
	} else if (process.platform === 'linux') {
		// Linux 的存档路径修复模组以 ModLoader dataPath 作为游戏根目录。
		// RuntimePaths 已保证此处为 Electron userData，因此游戏实际访问 dataPath/_storage。
		defaultStoragePath = path.resolve(dataPath, '_storage')
	} else {
		const resourcesPath = typeof process.resourcesPath === 'string' && process.resourcesPath
			? path.resolve(process.resourcesPath)
			: null
		if (resourcesPath) defaultStoragePath = path.resolve(resourcesPath, '..', '_storage')
	}
	if (!defaultStoragePath) return { path: filePath, redirected: false, storagePath: null }

	const portablePath = filePath.replace(/\\/g, '/')
	const storagePrefix = '../_storage'
	const candidatePath = portablePath === storagePrefix || portablePath.startsWith(`${storagePrefix}/`)
		? path.resolve(defaultStoragePath, portablePath.slice(storagePrefix.length).replace(/^\/+/, ''))
		: path.resolve(filePath)

	const redirected = resolveSaveStorageRedirect(dataPath, defaultStoragePath, candidatePath, fs)
	if (!redirected.matched || !redirected.status?.enabled) {
		return { path: filePath, redirected: false, storagePath: null }
	}
	if (redirected.path) {
		return {
			path: redirected.path,
			redirected: true,
			storagePath: redirected.status?.path || null,
		}
	}

	const error = new Error(redirected.status?.message || '原版存档文件夹不可用，无法访问存档')
	error.code = 'EACCES'
	throw error
}

function resolveSavePath(filePath) {
	return getSavePathResolution(filePath).path
}

/**
 * 游戏首次写入时可重建此前被游戏或用户删除的已配置存档根目录。
 * 仅创建该叶目录，父目录缺失、无权限或目标是普通文件时均保留错误，避免创建未知路径。
 */
function ensureSavePathForWrite(filePath) {
	const resolution = getSavePathResolution(filePath)
	if (!resolution.redirected || !resolution.storagePath) return resolution.path

	try {
		if (!fs.statSync(resolution.storagePath).isDirectory()) {
			const error = new Error('原版存档路径不是文件夹')
			error.code = 'ENOTDIR'
			throw error
		}
		return resolution.path
	} catch (error) {
		if (error?.code !== 'ENOENT') throw error
	}

	const parentPath = path.dirname(resolution.storagePath)
	if (!fs.statSync(parentPath).isDirectory()) {
		const error = new Error('原版存档文件夹的父目录不是文件夹')
		error.code = 'ENOTDIR'
		throw error
	}
	try {
		fs.mkdirSync(resolution.storagePath)
	} catch (error) {
		if (error?.code !== 'EEXIST') throw error
	}
	if (!fs.statSync(resolution.storagePath).isDirectory()) {
		const error = new Error('原版存档路径不是文件夹')
		error.code = 'ENOTDIR'
		throw error
	}
	return resolution.path
}

function savePathExists(filePath) {
	try {
		return fs.existsSync(resolveSavePath(filePath))
	} catch (e) {
		return false
	}
}

// ModLoader 接口只通过顶层入口暴露.
contextBridge.exposeInMainWorld('modloader', modloader)
contextBridge.exposeInMainWorld('modmanager', modmanager)

contextBridge.exposeInMainWorld('api', {
	//process
	returnProcess: () => {
		return {
			platform: process.platform,
			execPath: process.execPath,
		}
	},
	//__dirname
	returnDirName: () => {
		// return __dirname
		return ipcRenderer.sendSync('getAppPath')
	},

	//二重起動確認用
	returnSingleInstanceLock: async () => {
		return await ipcRenderer.invoke('electron:returnSingleInstanceLock')
	},

	quit: async () => {
		await ipcRenderer.invoke('electron:quit')
	},

	//Appパス
	// macOS では原版の存档路径推导需要以 userData 为根目录。
	// returnAppPath: () => ipcRenderer.sendSync('getAppPath'),
	returnAppPath: () => ipcRenderer.sendSync('getGameSaveAppPath'),
	returnRelativePath: async (file_path, item_path) => {
		return await ipcRenderer.invoke(
			'path:returnRelativePath',
			file_path,
			item_path
		)
	},

	//セーブファイル操作
	// existFile: path => fs.existsSync(path),
	existFile: path => savePathExists(path),
	makeDir: path => {
		// fs.mkdirSync(path)
		fs.mkdirSync(resolveSavePath(path))
	},
	writeFile: (path, value) => {
		// fs.writeFileSync(path, value)
		fs.writeFileSync(ensureSavePathForWrite(path), value)
	},
	writeFileEnc: (path, value) => {
		const encrypted = ipcRenderer.sendSync('encrypt', value)
		// fs.writeFileSync(path, encrypted, 'binary')
		fs.writeFileSync(ensureSavePathForWrite(path), encrypted, 'binary')
	},
	// readFile: path => fs.readFileSync(path, 'utf-8'),
	readFile: path => fs.readFileSync(resolveSavePath(path), 'utf-8'),
	readFileDec: path => {
		// const buf = fs.readFileSync(path)
		const buf = fs.readFileSync(resolveSavePath(path))
		return ipcRenderer.sendSync('decrypt', buf)
	},
	// readFileBin: path => fs.readFileSync(path),
	readFileBin: path => fs.readFileSync(resolveSavePath(path)),
	rm: path => {
		// fs.rmSync(path, {
		fs.rmSync(resolveSavePath(path), {
			recursive: true,
		})
	},
	saveFile: async param => await ipcRenderer.invoke('saveFile', param),
	unlink: path => {
		// fs.unlinkSync(path)
		fs.unlinkSync(resolveSavePath(path))
	},
	showDialog: async option => {
		await ipcRenderer.invoke('dialog:showDialog', option)
	},
	setFullScreen: async fullscreen => {
		await ipcRenderer.invoke('setFullScreen', fullscreen)
	},

	//パッチ操作
	applyPatch: async (unzip_path, local_path, patch_path) => {
		return await ipcRenderer.invoke(
			'patch:apply',
			unzip_path,
			local_path,
			patch_path
		)
	},

	//webサイトを開く
	openWebPage: async url => {
		await ipcRenderer.invoke('shell:openNewWindow', url)
	},

	/**
	 * デバッグ支援プラグイン用
	 */
	readSubDir: async path => {
		return await ipcRenderer.invoke('debug:readSubDir', path)
	},
	toggleDevTools: async () => {
		await ipcRenderer.invoke('debug:toggleDevTools')
	},
	isMuteAudio: async enable => {
		await ipcRenderer.invoke('debug:isMuteAudio', enable)
	},
	captureWindow: async (x, y, width, height) => {
		return await ipcRenderer.invoke('debug:captureWindow', x, y, width, height)
	},
	registerHotKey: async key => {
		await ipcRenderer.invoke('debug:registerHotKey', key)
	},
	getSaveKey: () => ipcRenderer.sendSync('getSaveKey'),
	// steamworks
	isAppActivated: async () =>
		await ipcRenderer.invoke('steamworks:isAppActivated'),
	activateAchievement: async name => {
		await ipcRenderer.invoke('steamworks:activateAchievement', name)
	},
	triggerScreenshot: async (x, y, w, h) => {
		await ipcRenderer.invoke('steamworks:triggerScreenshot', x, y, w, h)
	},
	log: async (...args) => {
		await ipcRenderer.invoke('log', args)
	},
})
