/**
 * 当前游戏会话的持久化补丁应用报告.
 * 报告以文件形式保存, 使管理器和独立错误窗口无需渲染进程事件通道即可读取同一状态.
 */

const fs = require('fs');
const path = require('path');
const { ipcMain, ipcRenderer } = require('electron');

const REPORT_DIRECTORY = 'cache';
const REPORT_FILE = 'patch-report.json';
const REPORT_CHANNEL = 'modloader:patch-report';

let core;
let report = null;
let failureReporter = null;

function now() {
	return new Date().toISOString();
}

function getReportPath() {
	return path.join(core.Env.getDataPath(), REPORT_DIRECTORY, REPORT_FILE);
}

function writeReport() {
	if (!report) return;
	const reportPath = getReportPath();
	const temporaryPath = `${reportPath}.${process.pid}.tmp`;
	try {
		fs.mkdirSync(path.dirname(reportPath), { recursive: true });
		fs.writeFileSync(temporaryPath, JSON.stringify(report, null, '\t'), 'utf-8');
		fs.renameSync(temporaryPath, reportPath);
	} catch (error) {
		try {
			if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
		} catch (_cleanupError) {
			// 清理临时文件失败时无需处理, 原始写入异常更有参考价值.
		}
		console.warn('[ModLoader] 写入补丁状态报告失败:', error);
	}
}

function startSession() {
	const startedAt = now();
	report = {
		version: 1,
		sessionId: `${Date.now()}-${process.pid}`,
		startedAt,
		updatedAt: startedAt,
		gameCore: core?.PluginManager?.gameCorePath ? path.basename(core.PluginManager.gameCorePath) : null,
		summary: { applied: 0, failed: 0, unverified: 0 },
		patches: [],
		rejectedPaths: []
	};
	writeReport();
}

function ensureSession() {
	if (!report) startSession();
}

function getPatchRecord({ layerPath, patchPath, targetPath, format, status, code, message, detail }) {
	ensureSession();
	const modName = path.basename(layerPath);
	const relativePatchPath = path.relative(layerPath, patchPath).replace(/\\/g, '/');
	const id = `${modName}:${relativePatchPath}:${code || status}`;
	let record = report.patches.find(item => item.id === id);
	const occurredAt = now();
	if (!record) {
		record = {
			id,
			modName,
			patchPath: relativePatchPath,
			targetPath,
			format,
			status,
			code: code || null,
			message,
			detail: detail || null,
			firstOccurredAt: occurredAt,
			lastOccurredAt: occurredAt,
			occurrences: 1
		};
		report.patches.push(record);
		return { record, isNew: true };
	}

	if (record.status === 'applied' && status === 'failed') {
		report.summary.applied = Math.max(0, report.summary.applied - 1);
		report.summary.failed++;
		record.status = status;
		record.code = code || null;
	}
	record.message = message;
	record.detail = detail || record.detail;
	record.lastOccurredAt = occurredAt;
	record.occurrences++;
	return { record, isNew: false };
}

function recordApplied(data) {
	if (forwardToMain('applied', data)) return;
	const { isNew } = getPatchRecord({ ...data, status: 'applied', message: '补丁已应用' });
	if (isNew) report.summary.applied++;
	report.updatedAt = now();
	writeReport();
}

function recordFailure(data) {
	if (forwardToMain('failed', data)) return;
	const { record, isNew } = getPatchRecord({ ...data, status: 'failed' });
	if (isNew) report.summary.failed++;
	report.updatedAt = now();
	writeReport();
	if (typeof failureReporter === 'function') {
		try {
			failureReporter({ ...record });
		} catch (error) {
			console.warn('[ModLoader] 显示补丁错误报告失败:', error);
		}
	}
}

function recordPathRejection(data) {
	if (forwardToMain('rejected-path', data)) return;
	ensureSession();
	const timestamp = now();
	let entry = report.rejectedPaths.find(item => item.source === data.source && item.path === data.path && item.reason === data.reason);
	if (entry) {
		entry.occurrences++;
		entry.lastOccurredAt = timestamp;
	} else {
		entry = { ...data, firstOccurredAt: timestamp, lastOccurredAt: timestamp, occurrences: 1 };
		report.rejectedPaths.push(entry);
	}
	report.updatedAt = timestamp;
	writeReport();
}

function forwardToMain(type, data) {
	if (core?.Env?.isMain !== false) return false;
	try {
		if (!ipcRenderer) throw new Error('ipcRenderer 不可用');
		ipcRenderer.sendSync(REPORT_CHANNEL, { type, data });
	} catch (error) {
		core.Logger.warn('无法将补丁报告发送到主进程', error);
	}
	// 渲染进程不独立写报告，避免覆盖主进程或其他渲染进程的数据。
	return true;
}

function setFailureReporter(reporter) {
	failureReporter = typeof reporter === 'function' ? reporter : null;
}

function init(dependencies) {
	core = dependencies;
	if (core.Env.isMain && ipcMain) {
		ipcMain.on(REPORT_CHANNEL, (event, message) => {
			try {
				if (message?.type === 'applied') recordApplied(message.data);
				else if (message?.type === 'failed') recordFailure(message.data);
				else if (message?.type === 'rejected-path') recordPathRejection(message.data);
			} catch (error) {
				console.warn('[ModLoader] 处理补丁报告失败:', error);
			} finally {
				event.returnValue = true;
			}
		});
	}
}

module.exports = {
	init,
	startSession,
	recordApplied,
	recordFailure,
	recordPathRejection,
	setFailureReporter
};
