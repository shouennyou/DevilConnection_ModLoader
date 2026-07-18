const {
	contextBridge,
	ipcRenderer
} = require('electron')
const fs = require('fs')

let apiExtra = {}
try {
	apiExtra = require('dc-modloader/extra/preload')
} catch (e) {
	console.error('[ModLoader] extra-preload 加载失败:', e);
}

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
		return __dirname
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
	existFile: path => fs.existsSync(path),
	makeDir: path => {
		fs.mkdirSync(path)
	},
	writeFile: (path, value) => {
		fs.writeFileSync(path, value)
	},
	writeFileEnc: (path, value) => {
		const encrypted = ipcRenderer.sendSync('encrypt', value)
		fs.writeFileSync(path, encrypted, 'binary')
	},
	readFile: path => fs.readFileSync(path, 'utf-8'),
	readFileDec: path => {
		const buf = fs.readFileSync(path)
		return ipcRenderer.sendSync('decrypt', buf)
	},
	readFileBin: path => fs.readFileSync(path),
	rm: path => {
		fs.rmSync(path, {
			recursive: true,
		})
	},
	saveFile: async param => await ipcRenderer.invoke('saveFile', param),
	unlink: path => {
		fs.unlinkSync(path)
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
	
	...apiExtra,
	launchGame: async () => {
		return await ipcRenderer.invoke('window:launchGame');
	},
	openWebPage: async (url) => {
		await ipcRenderer.invoke('shell:openNewWindow', url);
	}
})
