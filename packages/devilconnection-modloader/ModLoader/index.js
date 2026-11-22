/**
 * ============================================================================
 * ModLoader 入口.
 * ============================================================================
 */

const core = require('./core');
const hooks = require('./hooks');
const injection = require('./injection');
const patchReport = require('./patch-report');

hooks.init(core);
injection.init(core);
patchReport.init(core);

let runtimeInitialized = false;

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
 * 读取当前模组配置并刷新与资源层相关的会话状态。
 * 每次创建游戏窗口都必须调用，以使模组开关、优先级和注入脚本立即生效。
 */
function refreshGameSession() {
	try {
		core.PluginManager.init();
		if (!core.PluginManager.gameCorePath) {
			core.Logger.warn('未选择有效的游戏核心文件，已取消启动');
			return false;
		}

		hooks.invalidateResourceCaches();

		if (core.Env.isMain) {
			injection.scanHooks();
		}
		return true;
	} catch (error) {
		core.Logger.error('刷新游戏会话失败', error);
		return false;
	}
}

/**
 * 初始化仅可注册一次的 fs/protocol Hook。
 * 后续游戏启动只刷新资源层，避免重复拦截 Electron protocol。
 */
function initializeRuntime() {
	if (runtimeInitialized) return refreshGameSession();
	if (!refreshGameSession()) return false;

	try {
		hooks.applyFSHooks();
		if (core.Env.isMain) hooks.setupProtocol();
		runtimeInitialized = true;
		return true;
	} catch (error) {
		core.Logger.error('主程序初始化失败', error);
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
	if (core.Env.isMain) patchReport.startSession();
	if (core.Env.isMain) injectIntoTargetWindow(targetWindow);
	return true;
}

module.exports = {
	start,
	setPatchFailureReporter: patchReport.setFailureReporter
};

// 游戏 preload 初始化渲染进程侧文件 Hook, 管理器 preload 不加载本入口.
if (!core.Env.isMain) start();
