/**
 * ============================================================================
 * ModLoader 渲染脚本注入.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const electron = require('electron');

let Logger;
let PluginManager;
let VERSION;
const MANAGER_PARTITION = 'persist:dc-modmanager';

function isManagerWindow(win) {
	try {
		return win.webContents.session === electron.session.fromPartition(MANAGER_PARTITION);
	} catch (error) {
		if (Logger) Logger.error('读取管理器窗口分区失败', error);
		return false;
	}
}

const BUILTIN_HOOK_TITLE = `
	const _s = " - DCModLoader __VERSION__ By 逍婉瑶";
	function _t() {
		try {
			if (document.title !== undefined && !document.title.includes(_s)) document.title += _s;
		} catch (error) {
			console.error('[ModLoader] 更新页面标题失败:', error);
		}
	}
	const _o = new MutationObserver(_t);
	_t();
	document.addEventListener("DOMContentLoaded", () => {
		_t();
		const n = document.querySelector("title");
		if (n) _o.observe(n, {
			childList: true,
			characterData: true
		});
		else {
			const h = document.querySelector("head");
			if (h) {
				const ho = new MutationObserver(() => {
					if (document.querySelector("title")) {
						_t();
						ho.disconnect();
						_o.observe(document.querySelector("title"), {
							childList: true,
							characterData: true
						});
					}
				});
				ho.observe(h, {
					childList: true
				});
			}
		}
	});
	`;

const BUILTIN_HOOK_WORKER = `
	const OrigWorker = window.Worker;
	if (!OrigWorker || !window.api?.modloader?.readFileSync) {
		console.warn('[ModLoader] Worker 拦截功能初始化失败');
		return;
	}

	function shouldIntercept(url) {
		if (/^(blob:|data:|https?:)/i.test(url)) return false;
		const abs = new URL(url, location.href);
		return abs.protocol === 'file:';
	}

	function resolveFilePath(abs) {
		let p = decodeURIComponent(abs.pathname);
		if (/^\\/[A-Za-z]:/.test(p)) p = p.slice(1);
		return p;
	}

	window.Worker = function(url, options) {
		const rawUrl = String(url);

		if (!shouldIntercept(rawUrl)) return new OrigWorker(url, options);

		try {
			const filePath = resolveFilePath(new URL(rawUrl, location.href));
			const code = window.api.modloader.readFileSync(filePath);
			if (code == null) return new OrigWorker(url, options);
			return new OrigWorker(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })), options);
		} catch (error) {
			console.warn('[ModLoader] Worker 钩子回退原生加载:', error);
			return new OrigWorker(url, options);
		}
	};

	try {
		window.Worker.prototype = OrigWorker.prototype;
	} catch (error) {
		console.error('[ModLoader] 设置 Worker 原型失败:', error);
	}
`;

const Injection = {
	_scripts: [],
	_pendingWindowContents: new WeakSet(),
	_injectingWindowContents: new WeakSet(),

	scanHooks() {
		this._scripts = [];

		// 内置标题栏钩子.
		this._scripts.push({
			name: 'DCModLoader - 标题栏',
			code: `
				(function() {
					console.log("[ModLoader] 正在运行内置钩子: DCModLoader - 标题栏");
					try {
						${BUILTIN_HOOK_TITLE.replace('__VERSION__', VERSION)}
					} catch (error) {
						console.error("[ModLoader] 内置标题栏钩子运行失败:", error);
					}
				})();
				`
		});

		// 内置 Worker 钩子.
		this._scripts.push({
			name: 'DCModLoader - Worker',
			code: `
				(function() {
					console.log("[ModLoader] 正在运行内置钩子: DCModLoader - Worker");
					try {
						${BUILTIN_HOOK_WORKER}
					} catch (error) {
						console.error("[ModLoader] 内置 Worker 钩子运行失败:", error);
					}
				})();
				`
		});

		// 遍历已加载模组并读取 modloader.mod.json 中的 injections.
		for (const pluginPath of PluginManager.loadedPlugins) {
			const modJsonPath = path.join(pluginPath, 'modloader.mod.json');

			/** @type {null | { injections?: Array<{ name?: string, path: string }> }} */
			let modInfo = null;
			try {
				if (fs.existsSync(modJsonPath)) {
					modInfo = JSON.parse(fs.readFileSync(modJsonPath, 'utf8'));
				}
			} catch (error) {
				Logger.error(`读取模组注入配置失败: ${modJsonPath}`, error);
			}

			if (!modInfo) {
				// 缺少注入配置时回退查找 hook.js.
				const hookPath = path.join(pluginPath, 'hook.js');
				if (!fs.existsSync(hookPath)) continue;
				const pluginName = path.basename(pluginPath);
				try {
					const content = fs.readFileSync(hookPath, 'utf8');
					this._scripts.push({
						name: pluginName,
						code: `
							(function() {
								console.log("[ModLoader] 正在运行模组钩子: ${pluginName}");
								try {
									${content}
								} catch (error) {
									console.error("[ModLoader] 模组钩子运行失败: ${pluginName}", error);
								}
							})();
							`
					});
					Logger.info(`模组钩子已就绪: ${pluginName}`);
				} catch (error) {
					Logger.error(`读取模组钩子文件失败: ${hookPath}`, error);
				}
				continue;
			}

			const injections = modInfo.injections;
			if (!Array.isArray(injections) || injections.length === 0) {
				// 未配置注入脚本时跳过该模组.
				continue;
			}

			for (const injection of injections) {
				if (!injection || typeof injection.path !== 'string') continue;

				// 注入路径相对模组目录, 兼容 "./hook.js" 和 "hook.js".
				const injectionPath = path.resolve(pluginPath, injection.path);
				const injectionName = injection.name || path.basename(injection.path);

				if (!fs.existsSync(injectionPath)) {
					Logger.info(`注入文件不存在, 已跳过: ${injectionPath}`);
					continue;
				}

				let content;
				try {
					content = fs.readFileSync(injectionPath, 'utf8');
				} catch (error) {
					Logger.error(`读取注入文件失败: ${injectionPath}`, error);
					continue;
				}

				const pluginName = path.basename(pluginPath);

				this._scripts.push({
					name: `${pluginName} - ${injectionName}`,
					code: `
						(function() {
							console.log("[ModLoader] 正在运行模组钩子: ${pluginName} - ${injectionName}");
							try {
								${content}
							} catch (error) {
								console.error("[ModLoader] 模组钩子运行失败: ${pluginName} - ${injectionName}", error);
							}
						})();
						`
				});

				Logger.info(`插件注入已就绪: ${pluginName} - ${injectionName} (${injectionPath})`);
			}
		}
	},

	injectIntoWindow(win) {
		if (isManagerWindow(win) || !this._scripts.length) return;
		const contents = win.webContents;
		if (contents.isDestroyed()) return;
		const doInject = () => {
			this._pendingWindowContents.delete(contents);
			if (win.isDestroyed() || contents.isDestroyed()) return;
			if (this._injectingWindowContents.has(contents)) return;
			this._injectingWindowContents.add(contents);

			void (async () => {
				for (const script of this._scripts) {
					try {
						await contents.executeJavaScript(script.code);
						Logger.info(`注入: ${script.name}`);
					} catch (error) {
						Logger.error(`注入失败: ${script.name}`, error);
					}
				}
				this._injectingWindowContents.delete(contents);
			})();
		};
		if (contents.isLoading()) {
			if (this._pendingWindowContents.has(contents)) return;
			this._pendingWindowContents.add(contents);
			contents.once('did-finish-load', doInject);
		} else {
			doInject();
		}
	},

	injectToAllExistingWindows() {
		const wins = electron.BrowserWindow.getAllWindows();
		if (wins.length) Logger.info(`发现 ${wins.length} 个窗口, 正在注入`);
		wins.forEach(win => this.injectIntoWindow(win));
	}
};

function init({
	Logger: L,
	PluginManager: PM,
	VERSION: V
}) {
	Logger = L;
	PluginManager = PM;
	VERSION = V;
}

module.exports = {
	init,
	scanHooks: () => Injection.scanHooks(),
	injectIntoWindow: win => Injection.injectIntoWindow(win),
	injectToAllExistingWindows: () => Injection.injectToAllExistingWindows()
};
