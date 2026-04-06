/**
 * ============================================================================
 * DevilConnectiond 插件加密工具
 * ----------------------------------------------------------------------------
 * 作用:
 * 1. 生成 RSA 2048 位密钥对 (public.pem / private.pem).
 * 2. 自动化加密指定目录下的插件文件 (JS, CSS, HTML, KS 等).
 * 3. 支持基于 .env 配置的白名单与黑名单过滤.
 * 4. 加密前自动创建 .bak 文件夹备份, 确保原数据安全.
 * 5. 对私钥进行 Base64 字符串反转伪装, 增强在配置文件中的安全性.
 * ============================================================================
 */

const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

// 加密文件唯一特征头，用于识别文件是否已加密
const ENCRYPT_SIG = 'DC_ENC_v1';

// 控制台颜色配置
const colors = {
	reset: "\x1b[0m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	red: "\x1b[31m",
	cyan: "\x1b[36m"
};

/**
 * 显示工具的使用帮助信息
 */
function showHelp() {
	console.log(`
${colors.cyan}==========================================
  DevilConnectiond 插件加密工具 帮助信息
==========================================${colors.reset}

${colors.yellow}使用方法:${colors.reset}
  node encoder.js --gen-keys          ${colors.green}# 生成新的加密密钥对${colors.reset}
  node encoder.js <文件夹路径>         ${colors.green}# 加密指定目录下的插件文件${colors.reset}
  node encoder.js --help              ${colors.green}# 显示此帮助信息${colors.reset}

${colors.yellow}生成文件说明:${colors.reset}
  ${colors.cyan}public.pem${colors.reset}       - 加密公钥. 放置在工具根目录, 用于执行加密操作.
  ${colors.cyan}private.pem${colors.reset}      - 原始私钥. 用于解密的核心凭据, 请${colors.red}务必离线妥善保存${colors.reset}, 不要分发.
  ${colors.cyan}.env.example${colors.reset}     - 配置文件示例. 包含了经过伪装处理的私钥变量, ${colors.yellow}使用前需重命名为 .env 并放置在插件目录.${colors.reset}

${colors.yellow}加密逻辑与安全:${colors.reset}
  1. ${colors.red}重要: 加密操作会直接覆盖原文件!${colors.reset}
  2. 为了安全, 工具在加密前会自动将 <文件夹> 完整备份为 <文件夹.bak>.
  3. 只有匹配 ${colors.cyan}ENCRYPT_WHITELIST${colors.reset} 且不在 ${colors.cyan}ENCRYPT_BLACKLIST${colors.reset} 中的文件才会被加密.
  4. 已加密的文件会自动跳过, 不会重复处理.
`);
}

/**
 * 对私钥进行伪装处理: 反转 Base64 字符串
 * @param {string} pemKey 原始 PEM 格式私钥
 * @returns {string} 伪装后的私钥字符串
 */
function obfuscateKey(pemKey) {
	const pureBase64 = pemKey
		.replace(/-----BEGIN [^-----]+-----/g, '')
		.replace(/-----END [^-----]+-----/g, '')
		.replace(/\s+/g, '');

	const reversed = pureBase64.split('').reverse().join('');

	return `-----BEGIN RSA PRIVATE KEY-----${reversed}-----END RSA PRIVATE KEY-----`;
}

/**
 * 还原伪装后的私钥
 * @param {string} fakeKey 伪装后的字符串
 * @returns {string|null} 还原后的 PEM 私钥
 */
function deobfuscateKey(fakeKey) {
	if (!fakeKey) return null;
	
	let content = fakeKey
		.replace('-----BEGIN RSA PRIVATE KEY-----', '')
		.replace('-----END RSA PRIVATE KEY-----', '')
		.trim();

	const originalBase64 = content.split('').reverse().join('');

	return `-----BEGIN RSA PRIVATE KEY-----\n${originalBase64.match(/.{1,64}/g).join('\n')}\n-----END RSA PRIVATE KEY-----`;
}

/**
 * 生成 RSA 密钥对并创建配置文件示例
 */
async function generateKeys() {
	console.log(`${colors.cyan}正在生成 2048 位 RSA 密钥对...${colors.reset}`);
	const {
		privateKey,
		publicKey
	} = crypto.generateKeyPairSync('rsa', {
		modulusLength: 2048,
		publicKeyEncoding: {
			type: 'pkcs1',
			format: 'pem'
		},
		privateKeyEncoding: {
			type: 'pkcs1',
			format: 'pem'
		}
	});

	const fakePrivateEnv = obfuscateKey(privateKey);

	// 保存原始密钥文件
	await fsPromises.writeFile('private.pem', privateKey);
	await fsPromises.writeFile('public.pem', publicKey);

	// 生成 .env.example 供用户配置
	const envExample = `# 插件配置文件

PRIVATE_KEY_B64=${fakePrivateEnv}

# 白名单
ENCRYPT_WHITELIST=.*\\.html$,.*\\.css$,.*\\.js$,.*\\.ks$

# 黑名单
ENCRYPT_BLACKLIST=.env$
`;
	await fsPromises.writeFile('.env.example', envExample);

	console.log(`${colors.green}成功!${colors.reset}`);
	console.log(`${colors.yellow}已生成:
1. [public.pem]  -> 留在本工具目录用于加密.
2. [private.pem] -> 原始私钥, 请离线妥善保存, 不要分发!
3. [.env.example] -> 已包含伪装后的 PRIVATE_KEY_B64, 请重命名为 .env 使用.${colors.reset}`);
}

/**
 * 解析目标目录下的 .env 配置文件
 * @param {string} pluginPath 插件所在目录路径
 * @returns {Promise<{exists: boolean, whitelist: RegExp[], blacklist: RegExp[], privateKey: string|null}>}
 */
async function parseEnv(pluginPath) {
    // 警告消息模板
    const WARN_INVALID_REGEX = (type, pattern, errMsg) => 
        `${colors.yellow}[警告] 无效的${type}正则表达式: "${pattern}" - ${errMsg}${colors.reset}`;

    const config = {
        exists: false,
        whitelist: [],
        blacklist: [],
        privateKey: null
    };
    const envPath = path.join(pluginPath, '.env');

    if (!fs.existsSync(envPath)) return config;

    config.exists = true;
    const content = await fsPromises.readFile(envPath, 'utf8');
    
    content.split(/\r?\n/).forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;

        const index = trimmed.indexOf('=');
        if (index === -1) return;

        const key = trimmed.substring(0, index).trim();
        const val = trimmed.substring(index + 1).trim();

        // 解析正则列表的辅助函数
        const parseRegexList = (val, type) => {
            const patterns = val.split(',').map(p => p.trim()).filter(p => p !== '');
            const valid = [];
            for (const p of patterns) {
                try {
                    valid.push(new RegExp(p, 'i'));
                } catch (err) {
                    console.warn(WARN_INVALID_REGEX(type, p, err.message));
                }
            }
            return valid;
        };

        if (key === 'ENCRYPT_WHITELIST' && val) {
            config.whitelist = parseRegexList(val, '白名单');
        }
        
        if (key === 'ENCRYPT_BLACKLIST' && val) {
            config.blacklist = parseRegexList(val, '黑名单');
        }
        
        if (key === 'PRIVATE_KEY_B64' && val) {
            config.privateKey = deobfuscateKey(val);
        }
    });
    
    return config;
}

/**
 * 混合加密逻辑: 使用 AES 加密数据，使用 RSA 加密 AES 密钥
 * @param {Buffer} buffer 原始数据
 * @param {string} publicKey RSA 公钥
 * @returns {Buffer} 加密后的二进制流
 */
function encryptBuffer(buffer, publicKey) {
	const aesKey = crypto.randomBytes(32);
	const iv = crypto.randomBytes(16);

	// 使用公钥加密 AES 密钥和 IV
	const keyInfo = Buffer.concat([aesKey, iv]);
	const encryptedKey = crypto.publicEncrypt({
		key: publicKey,
		padding: crypto.constants.RSA_PKCS1_OAEP_PADDING
	}, keyInfo);

	// 使用 AES-256-CBC 加密实际内容
	const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, iv);
	const encryptedContent = Buffer.concat([cipher.update(buffer), cipher.final()]);

	// 构建加密文件结构: [特征头][加密Key长度(4B)][加密Key][加密内容]
	const header = Buffer.alloc(ENCRYPT_SIG.length + 4);
	header.write(ENCRYPT_SIG, 0);
	header.writeUInt32BE(encryptedKey.length, ENCRYPT_SIG.length);

	return Buffer.concat([header, encryptedKey, encryptedContent]);
}

/**
 * 递归复制目录用于备份 (异步版)
 */
async function copyRecursiveAsync(src, dest) {
	const stats = await fsPromises.stat(src);
	if (stats.isDirectory()) {
		await fsPromises.mkdir(dest, { recursive: true });
		const children = await fsPromises.readdir(src);
		for (const child of children) {
			await copyRecursiveAsync(path.join(src, child), path.join(dest, child));
		}
	} else {
		await fsPromises.copyFile(src, dest);
	}
}

/**
 * 程序主入口
 */
async function start() {
	const args = process.argv.slice(2);

	// 无参数或请求帮助
	if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
		showHelp();
		return;
	}

	// 生成密钥对模式
	if (args.includes('--gen-keys')) {
		await generateKeys();
		return;
	}

	const inputPath = args[0];
	const targetDir = path.resolve(inputPath);
	const pubKeyPath = path.join(process.cwd(), 'public.pem');

	// 参数有效性检查
	if (!fs.existsSync(targetDir) || !(await fsPromises.stat(targetDir)).isDirectory()) {
		console.log(`${colors.red}[错误] 目标路径不存在或不是文件夹: ${inputPath}${colors.reset}`);
		return;
	}

	if (!fs.existsSync(pubKeyPath)) {
		console.log(`${colors.red}[错误] 未找到加密公钥 (public.pem)${colors.reset}`);
		console.log(`${colors.yellow}提示: 请先运行 "node encoder.js --gen-keys" 生成密钥.${colors.reset}`);
		return;
	}

	const config = await parseEnv(targetDir);
	if (!config.exists) {
		console.log(`${colors.yellow}[跳过] 目标目录不存在 .env 文件, 请参考 .env.example 进行配置.${colors.reset}`);
		return;
	}

	// 自动备份流程
	const backupDir = targetDir + '.bak';
	console.log(`${colors.cyan}正在创建备份至: ${backupDir}...${colors.reset}`);
	try {
		if (fs.existsSync(backupDir)) {
			console.log(`${colors.yellow}[警告] 备份目录已存在, 正在刷新备份内容...${colors.reset}`);
			await fsPromises.rm(backupDir, { recursive: true, force: true });
		}
		await copyRecursiveAsync(targetDir, backupDir);
		console.log(`${colors.green}备份成功!${colors.reset}`);
	} catch (e) {
		console.log(`${colors.red}[错误] 备份失败 (可能是文件被占用): ${e.message}${colors.reset}`);
		return;
	}

	const publicKey = await fsPromises.readFile(pubKeyPath, 'utf8');

	/**
	 * 递归遍历并加密文件
	 */
	const walk = async (dir) => {
		const files = await fsPromises.readdir(dir);
		for (const file of files) {
			const full = path.join(dir, file);
			const stats = await fsPromises.stat(full);

			if (stats.isDirectory()) {
				await walk(full);
				continue;
			}

			// 跳过配置文件、密钥文件、日志文件和备份文件
			if (file === '.env' || file.endsWith('.pem') || file === 'mod_loader.log' || file.endsWith('.bak')) continue;

			// 匹配黑白名单逻辑
			const isBlack = config.blacklist.some(re => re.test(file));
			const isWhite = config.whitelist.length === 0 || config.whitelist.some(re => re.test(file));

			if (!isBlack && isWhite) {
				const buffer = await fsPromises.readFile(full);
				// 检查是否已经加密过
				if (buffer.length >= ENCRYPT_SIG.length && buffer.slice(0, ENCRYPT_SIG.length).toString() === ENCRYPT_SIG) {
					console.log(`${colors.cyan}[跳过] ${file} (已加密)${colors.reset}`);
					continue;
				}

				try {
					const encrypted = encryptBuffer(buffer, publicKey);
					await fsPromises.writeFile(full, encrypted);
					console.log(`${colors.green}[加密完成] ${file}${colors.reset}`);
				} catch (e) {
					console.log(`${colors.red}[失败] ${file}: ${e.message}${colors.reset}`);
				}
			}
		}
	};

	console.log(`${colors.cyan}开始处理目录: ${targetDir}${colors.reset}`);
	await walk(targetDir);
	console.log(`\n${colors.green}全部处理完毕!${colors.reset}`);
	console.log(`${colors.yellow}注意: 原文件已在原地加密覆盖, 原始未加密版本请保存好备份: ${backupDir}${colors.reset}`);
}

// 捕获异步执行中的致命错误
start().catch(err => {
	console.error(`${colors.red}[致命错误] ${err.message}${colors.reset}`);
});
