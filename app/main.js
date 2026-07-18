import {
	createRequire
} from 'module';

const require = createRequire(import.meta.url);

let modLoaderEntry = null;

function loadModLoader(targetWindow) {
	try {
		modLoaderEntry ??= require('dc-modloader/ModLoader/index');
		return modLoaderEntry.start(targetWindow);
	} catch (e) {
		console.error('[ModLoader] 加载失败:', e);
		return false;
	}
}

try {
	const mainExtra = require('dc-modloader/extra/main');
	if (mainExtra && typeof mainExtra.initExtra === 'function') {
		mainExtra.initExtra();
	}
	if (mainExtra && typeof mainExtra.registerIPCHandlers === 'function') {
		mainExtra.registerIPCHandlers(ipcMain, {
			isSteamConfigured,
			isSteamActive,
			setSteamConfigured
		});
	}
} catch (e) {}

import {
	app,
	BrowserWindow,
	dialog,
	globalShortcut,
	ipcMain,
	shell
} from 'electron';
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync
} from 'fs';
import {
	initialize,
	enable
} from '@electron/remote/main/index.js';
import {
	safeStorage
} from 'electron/main';
import {
	EOL
} from 'os';
import path, {
	join,
	relative,
	resolve
} from 'path';
import {
	format
} from 'url';
import {
	initSteam,
	getSteamClient,
	isSteamActive,
	isSteamConfigured,
	setSteamConfigured
} from './steam.js';

try {
	initSteam();
} catch (error) {
	dialog.showErrorBox('Error', error.toString());
}

const MANAGER_PARTITION = 'persist:dc-modmanager';
const MAIN_WINDOW_SIZE = {
	'width': 1280,
	'height': 960,
	'minWidth': 960,
	'minHeight': 720
};
const MANAGER_WINDOW_SIZE = {
	'width': 1280,
	'height': 800,
	'minWidth': 960,
	'minHeight': 640
};

let mainWindow = null;
let managerWindow = null;
let remoteInitialized = false;
app.commandLine.appendSwitch('js-flags', '--expose-gc');

function ensureRemoteInitialized() {
	if (remoteInitialized) return;
	initialize();
	remoteInitialized = true;
}

const scSize = {
	'width': 1280,
	'height': 960
};

async function triggerScreenshot(x, y, width, height) {
	const screenshot = await mainWindow.capturePage({
		'x': x,
		'y': y,
		'width': width,
		'height': height
	});
	const resizeOptions = {
		...scSize
	};
	const tmpPath = resolve('./__screenshot_tmp.png');
	writeFileSync(tmpPath, screenshot.resize(resizeOptions).toPNG(), {
		'encoding': 'binary'
	});
	getSteamClient().screenshots.addScreenshotToLibrary(tmpPath, null, width, height);
	rmSync(tmpPath);
}

function createWindowOptions(preload, windowSize, partition) {
	return {
		...windowSize,
		'useContentSize': true,
		'webPreferences': {
			'nodeIntegration': true,
			'contextIsolation': true,
			'webSecurity': true,
			'preload': join(app.getAppPath(), preload),
			...(partition ? { 'partition': partition } : {})
		},
		'fullscreenable': true
	};
}

function url(protocol, targetPath) {
	return format({
		'pathname': protocol === 'file' ? join(app.getAppPath(), targetPath) : targetPath,
		'protocol': protocol,
		'slashes': true
	});
}

function createMainWindow() {
	if (mainWindow && !mainWindow.isDestroyed()) {
		mainWindow.focus();
		return mainWindow;
	}

	ensureRemoteInitialized();
	mainWindow = new BrowserWindow(createWindowOptions('preload.js', MAIN_WINDOW_SIZE));
	loadModLoader(mainWindow);
	mainWindow.loadURL(url('file', './index.html'));
	mainWindow.removeMenu();
	mainWindow.on('close', function() {
		console.log('close');
		mainWindow.webContents.send('asynchronous-message', 'closeWindow');
	});
	mainWindow.on('closed', () => {
		mainWindow = null;
	});
	return mainWindow;
}

function createManagerWindow() {
	if (managerWindow && !managerWindow.isDestroyed()) {
		managerWindow.show();
		managerWindow.focus();
		return managerWindow;
	}

	ensureRemoteInitialized();
	managerWindow = new BrowserWindow(createWindowOptions('preload-manager.js', MANAGER_WINDOW_SIZE, MANAGER_PARTITION));
	managerWindow.loadURL(url('file', './modmanager/index.html'));
	managerWindow.removeMenu();
	managerWindow.on('closed', () => {
		managerWindow = null;
	});
	return managerWindow;
}

app.on('ready', () => {
	createManagerWindow();
});

app.on('browser-window-created', (_event, window) => {
	ensureRemoteInitialized();
	enable(window.webContents);
	window.webContents.on('before-input-event', (event, input) => {
		if (window !== mainWindow || input.type !== 'keyDown' || input.key !== 'F8') return;
		event.preventDefault();
		createManagerWindow();
	});
	window.webContents.setWindowOpenHandler(({ url }) => {
		shell.openExternal(url);
		return {
			action: 'deny'
		};
	});
});

ipcMain.handle('electron:quit', async () => {
	app.quit();
});

ipcMain.handle('electron:returnSingleInstanceLock', async () => {
	return app.requestSingleInstanceLock();
});

ipcMain.handle('window:launchGame', async (event) => {
	if (!managerWindow || managerWindow.isDestroyed() || event.sender !== managerWindow.webContents) {
		return false;
	}
	createMainWindow();
	managerWindow.close();
	return true;
});

ipcMain.handle('shell:openNewWindow', async (event, url) => {
	shell.openExternal(url);
});

ipcMain.handle('path:returnRelativePath', async (event, from, to) => {
	return relative(from, to);
});

ipcMain.on('getAppPath', async (event, args) => {
	event.returnValue = app.getAppPath();
});

ipcMain.on('encrypt', async (event, text) => {
	event.returnValue = safeStorage.encryptString(text);
});

ipcMain.on('decrypt', async (event, encryptedBuffer) => {
	event.returnValue = safeStorage.decryptString(encryptedBuffer);
});

ipcMain.handle('saveFile', async (event, {
	title: title,
	dataUrl: dataUrl
}) => {
	const result = await dialog.showSaveDialog(mainWindow, {
		'title': title,
		'filters': [{
			'name': 'PNG画像',
			'extensions': 'png'
		}],
		'defaultPath': 'photo.png'
	});
	if (result.canceled) {
		return null;
	}
	const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');
	writeFileSync(result.filePath, base64Data, {
		'encoding': 'base64'
	});
	return result.filePath;
});

ipcMain.handle('setFullScreen', async (event, isFullScreen) => {
	mainWindow.setFullScreen(isFullScreen);
});

ipcMain.handle('patch:apply', async (event, target, gamePath, patchFile) => {
	if (existsSync(patchFile)) {
		var fsExtra = require('fs-extra');
		var targetParam = target;
		if ('asar' != targetParam) {
			const AdmZip = require('adm-zip');
			require('path').resolve('./');
			new AdmZip(patchFile).extractAllTo(targetParam + '/update_tmp', true);
			fsExtra.copySync(targetParam + '/update_tmp/', targetParam + '/');
			fsExtra.removeSync(targetParam + '/update_tmp');
			fsExtra.removeSync(patchFile);
			return true;
		} else {
			const asar = require('asar');
			let baseDir = __dirname;
			readdirSync(baseDir);
			let updatePath = gamePath;
			if ('darwin' == process.platform) {
				alert('パッチを適応するゲーム実行ファイル（.app）の場所を選択してください。');
				let selectedPaths = dialog.showOpenDialogSync(null, {
					'properties': ['openFile'],
					'title': 'パッチを適応するゲームの実行ファイル（app）を選択してください。',
					'filters': [{
						'name': '',
						'extensions': ['app']
					}]
				});
				if (undefined === selectedPaths) {
					alert('パッチの適応を中止します');
					return false;
				}
				baseDir = selectedPaths[0] + '/Contents/Resources/app.asar';
				updatePath += '/';
			} else {
				updatePath += '/';
			}
			fsExtra.mkdirSync(path.resolve(updatePath + '/update_tmp'));
			(async () => {
				await asar.extractAll(path.resolve(baseDir), path.resolve(updatePath + '/update_tmp/'));
			})();
			new(require('adm-zip'))(patchFile).extractAllTo(path.resolve(updatePath + 'update_tmp/'), true);
			const packageSrc = path.resolve(updatePath + 'update_tmp/');
			const packageDest = path.resolve(baseDir);
			(async () => {
				await asar.createPackage(packageSrc, packageDest);
				$.alert($.lang('apply_patch_complete'), function() {
					fsExtra.removeSync(path.resolve(patchFile));
					fsExtra.removeSync(path.resolve(updatePath + 'update_tmp'));
					window.close();
				});
			})();
		}
	} else {
		return false;
	}
});

ipcMain.handle('dialog:showDialog', async (event, options) => {
	return dialog.showMessageBoxSync(mainWindow, {
		'type': options.type,
		'buttons': options.buttons,
		'title': options.title,
		'message': options.message,
		'detail': options.detail,
		'defaultId': options.defaultID,
		'cancelId': options.cancelId
	});
});

ipcMain.handle('debug:readSubDir', async (event, dirPath) => {
	let results = [];
	const walk = (currentPath) => {
		let files = readdirSync(currentPath);
		files = files.map(file => {
			return join(currentPath, file);
		});
		files.forEach(fullPath => {
			results.push(fullPath);
			if (statSync(fullPath).isDirectory()) {
				walk(fullPath);
			}
		});
	};
	walk(dirPath);
	return results;
});

ipcMain.handle('debug:toggleDevTools', async () => {
	mainWindow.toggleDevTools();
});

ipcMain.handle('debug:isMuteAudio', async (event, mute) => {
	if (mute !== undefined) {
		mainWindow.webContents.audioMuted = mute;
	} else {
		return await mainWindow.webContents.audioMuted;
	}
});

ipcMain.handle('debug:captureWindow', async (event, x, y, width, height) => {
	const screenshot = await mainWindow.capturePage({
		'x': x,
		'y': y,
		'width': width,
		'height': height
	});
	const resizeOptions = {
		...scSize
	};
	return screenshot.resize(resizeOptions).toDataURL();
});

ipcMain.handle('debug:registerHotKey', async (event, accelerator) => {
	globalShortcut.unregisterAll();
	globalShortcut.register(accelerator, () => {
		mainWindow.reload();
		mainWindow.focus();
	});
});

ipcMain.handle('steamworks:activateAchievement', async (event, achievementId) => {
	isSteamActive() && getSteamClient().achievement.activate(achievementId);
});

ipcMain.handle('steamworks:triggerScreenshot', async (event, x, y, width, height) => {
	isSteamActive() && await triggerScreenshot(x, y, width, height);
});

ipcMain.on('getSaveKey', async (event, args) => {
	event.returnValue = isSteamActive() ? getSteamClient().localplayer.getSteamId().steamId32 : null;
});

ipcMain.handle('steamworks:isAppActivated', async event => {
	return isSteamActive() ? getSteamClient().apps.isSubscribed() : true;
});

ipcMain.handle('log', async (event, args) => {
	const logContent = args.join(' ') + EOL;
	const logPath = resolve('./log.txt');
	writeFileSync(logPath, logContent, {
		'encoding': 'utf-8',
		'flag': 'a'
	});
});
