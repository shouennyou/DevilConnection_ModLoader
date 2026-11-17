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
 * 仅映射 ../_storage 及其等价绝对路径；其他文件系统路径保持原样。
 * 重定向已开启但目标不可用时抛出错误，避免静默回退到独立版存档目录。
 */
function resolveSavePath(filePath) {
	if (typeof filePath !== 'string' || !resolveSaveStorageRedirect) return filePath
	const resourcesPath = typeof process.resourcesPath === 'string' && process.resourcesPath
		? path.resolve(process.resourcesPath)
		: null
	if (!resourcesPath) return filePath

	const defaultStoragePath = path.resolve(resourcesPath, '..', '_storage')
	const portablePath = filePath.replace(/\\/g, '/')
	const storagePrefix = '../_storage'
	const candidatePath = portablePath === storagePrefix || portablePath.startsWith(`${storagePrefix}/`)
		? path.resolve(defaultStoragePath, portablePath.slice(storagePrefix.length).replace(/^\/+/, ''))
		: path.resolve(filePath)

	let dataPath = null
	try {
		dataPath = modloader?.returnModLoaderDataPath?.() || null
	} catch (e) {
		console.error('[ModLoader] 读取存档重定向数据目录失败:', e)
	}
	if (typeof dataPath !== 'string' || !dataPath.trim()) return filePath

	const redirected = resolveSaveStorageRedirect(dataPath, defaultStoragePath, candidatePath, fs)
	if (!redirected.matched || !redirected.status?.enabled) return filePath
	if (redirected.path) return redirected.path

	const error = new Error(redirected.status?.message || '原版存档文件夹不可用，无法访问存档')
	error.code = 'EACCES'
	throw error
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
	returnAppPath: () => ipcRenderer.sendSync('getAppPath'),
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
		fs.writeFileSync(resolveSavePath(path), value)
	},
	writeFileEnc: (path, value) => {
		const encrypted = ipcRenderer.sendSync('encrypt', value)
		// fs.writeFileSync(path, encrypted, 'binary')
		fs.writeFileSync(resolveSavePath(path), encrypted, 'binary')
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
