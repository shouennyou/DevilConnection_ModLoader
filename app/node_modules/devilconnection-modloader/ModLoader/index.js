/**
 * ============================================================================
 * ModLoader 入口.
 * ============================================================================
 */

const core = require('./core');
const hooks = require('./hooks');
const injection = require('./injection');

hooks.init(core);
injection.init(core);

let runtimeInitialized = false;
let injectionEnabled = false;

function injectIntoTargetWindow(targetWindow) {
	if (!targetWindow || targetWindow.isDestroyed()) return;

	const inject = () => {
		if (!targetWindow.isDestroyed()) injection.injectIntoWindow(targetWindow);
	};

	// 游戏窗口尚未 loadURL 时等待开始加载, 避免注入 about:blank 后被导航清除.
	if (targetWindow.webContents.isLoading()) inject();
	else targetWindow.webContents.once('did-start-loading', inject);
}

/**
 * 初始化文件拦截与脚本注入运行时.
 * 未配置有效游戏核心时返回 false, 调用方据此阻止游戏窗口启动.
 */
function initializeRuntime() {
	if (runtimeInitialized) return injectionEnabled;

	try {
		core.PluginManager.init();
		if (!core.PluginManager.gameCorePath) {
			core.Logger.warn('未选择有效的游戏核心文件，已取消启动');
			return false;
		}

		hooks.applyFSHooks();

		if (core.Env.isMain) {
			hooks.setupProtocol();
			injection.scanHooks();
			injectionEnabled = true;
		}
		runtimeInitialized = true;
		return injectionEnabled;
	} catch (error) {
		core.Logger.error('主程序启动失败', error);
		return false;
	}
}

/**
 * 初始化 ModLoader 运行时, 并仅向指定游戏窗口注入渲染脚本.
 * 管理器窗口不会注册为注入目标.
 * @param {Electron.BrowserWindow} targetWindow
 * @returns {boolean}
 */
function start(targetWindow) {
	if (!initializeRuntime()) return false;
	if (core.Env.isMain) injectIntoTargetWindow(targetWindow);
	return true;
}

module.exports = {
	start
};

// 游戏 preload 初始化渲染进程侧文件 Hook, 管理器 preload 不加载本入口.
if (!core.Env.isMain) start();
