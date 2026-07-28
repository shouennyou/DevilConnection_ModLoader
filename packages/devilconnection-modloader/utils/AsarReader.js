/**
 * ASAR 归档读取工具.
 * 提供同步和异步的目录,文件,元数据与缓存操作.
 */

const asar = require('@electron/asar');

function wrapPromise(syncFn) {
  return (...args) =>
    new Promise((resolve, reject) => {
      try {
        resolve(syncFn(...args));
      } catch (error) {
        console.error('[ASAR 读取器] 异步操作失败:', error);
        reject(error);
      }
    });
}

function tryDecodeText(buffer) {
  try {
    return buffer.toString('utf-8');
  } catch (error) {
    console.error('[ASAR 读取器] 将文件内容解码为文本失败:', error);
    return buffer;
  }
}

/**
 * 同步列出归档内所有文件路径.
 * @param {string} archivePath
 * @returns {string[]}
 */
function listFilesSync(archivePath) {
  return asar.listPackage(archivePath, { isPack: false });
}

/**
 * 异步列出归档内所有文件路径.
 * @param {string} archivePath
 * @returns {Promise<string[]>}
 */
const listFilesAsync = wrapPromise(listFilesSync);


/**
 * 同步读取归档内单个文件的原始 Buffer.
 * @param {string} archivePath
 * @param {string} filename 归档内相对路径.
 * @returns {Buffer}
 */
function readFileSync(archivePath, filename) {
  return asar.extractFile(archivePath, filename);
}

/**
 * 异步读取归档内单个文件的原始 Buffer.
 * @param {string} archivePath
 * @param {string} filename
 * @returns {Promise<Buffer>}
 */
const readFileAsync = wrapPromise(readFileSync);


/**
 * 同步获取归档内文件的元信息.
 * @param {string} archivePath
 * @param {string} filename
 * @returns {object}
 */
function statFileSync(archivePath, filename) {
  return asar.statFile(archivePath, filename);
}

/**
 * 异步获取归档内文件的元信息.
 * @param {string} archivePath
 * @param {string} filename
 * @returns {Promise<object>}
 */
const statFileAsync = wrapPromise(statFileSync);


/**
 * 同步获取归档原始头部.
 * @param {string} archivePath
 * @returns {{ headerSize: number, headerString: string }}
 */
function getRawHeaderSync(archivePath) {
  return asar.getRawHeader(archivePath);
}

/**
 * 异步获取归档原始头部.
 * @param {string} archivePath
 * @returns {Promise<{ headerSize: number, headerString: string }>}
 */
const getRawHeaderAsync = wrapPromise(getRawHeaderSync);


/**
 * 同步读取归档内文件, 文本返回 string, 二进制内容返回 Buffer.
 *
 * @param {string} archivePath .asar 文件路径.
 * @param {string} filename 归档内相对路径.
 * @returns {string|Buffer}
 */
function readAsarFileSync(archivePath, filename) {
  const buffer = readFileSync(archivePath, filename);
  return tryDecodeText(buffer);
}

/**
 * 异步读取归档内文件, 文本返回 string, 二进制内容返回 Buffer.
 *
 * @param {string} archivePath .asar 文件路径.
 * @param {string} filename 归档内相对路径.
 * @returns {Promise<string|Buffer>}
 */
async function readAsarFile(archivePath, filename) {
  const buffer = await readFileAsync(archivePath, filename);
  return tryDecodeText(buffer);
}


/**
 * 清除指定归档的文件系统缓存.
 * 替换同名归档后必须清除缓存, 否则读取可能继续使用旧目录和偏移.
 * @param {string} archivePath
 */
function uncacheAsar(archivePath) {
  try {
    asar.uncache(archivePath);
  } catch (error) {
    console.error('[ASAR 读取器] 清除归档缓存失败:', error);
  }
}

/** 清除所有归档的文件系统缓存. */
function uncacheAllAsar() {
  try {
    asar.uncacheAll();
  } catch (error) {
    console.error('[ASAR 读取器] 清除全部归档缓存失败:', error);
  }
}

/** 判断异常是否仅表示归档内不存在目标文件. */
function isMissingArchiveEntryError(error) {
  return error instanceof Error && error.message.endsWith('was not found in this archive');
}

/**
 * 判断归档内是否存在指定文件.
 * @param {string} archivePath
 * @param {string} filename
 * @returns {boolean}
 */
function existsInAsar(archivePath, filename) {
  try {
    statFileSync(archivePath, filename);
    return true;
  } catch (error) {
    if (isMissingArchiveEntryError(error)) return false;
    console.error('[ASAR 读取器] 检查归档内文件失败:', error);
    return false;
  }
}

module.exports = {
  listFilesSync,
  listFilesAsync,
  readFileSync,
  readFileAsync,
  statFileSync,
  statFileAsync,
  getRawHeaderSync,
  getRawHeaderAsync,
  readAsarFileSync,
  readAsarFile,
  uncacheAsar,
  uncacheAllAsar,
  existsInAsar,
};
