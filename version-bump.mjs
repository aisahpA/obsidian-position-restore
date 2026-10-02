// 版本号写入脚本
// 用法：node version-bump.mjs <major.minor.patch>
//
// 更新 manifest.json / versions.json，并把新版本号打到标准输出。
// 插件的版本号没有第二处存放点：理由见下面的「为什么不用 package.json」。
//
// 这个脚本不会替你算出一个版本号：这里的发版是**手工点名**的 —— 合并到 main、
// 说出这是哪个版本、打 tag、push —— 若改成让软件自己计数，那个决定就落到了没人
// 能复核的地方。
// 脚本干的事只有一件：把那一个数字写进承载它的文件。
import { readFileSync, writeFileSync } from 'node:fs';

const arg = process.argv[2];

// 凡是不是三个点分数字的，都是值得停下来处理的笔误 —— 包括干脆没给参数，
// 那本来也没有别的地方能发现。
if (!arg || !/^\d+\.\d+\.\d+$/.test(arg)) {
	console.error('version-bump: usage — node version-bump.mjs <major.minor.patch>');
	process.exit(1);
}

// 当前版本的唯一真身是 manifest.json。
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));

// 手工点名版本号容易犯一个错：敲成你已经在的那个号 —— 或者更旧的号 —— 于是切出
// 一个自称是别的版本的发布。没有别的地方会核这件事，所以由这个脚本核。
const isAhead = (a, b) => {
	const [x, y, z] = a.split('.').map(Number);
	const [p, q, r] = b.split('.').map(Number);
	return x !== p ? x > p : y !== q ? y > q : z > r;
};

if (!isAhead(arg, manifest.version)) {
	console.error(`version-bump: ${arg} is not ahead of the current ${manifest.version}`);
	process.exit(1);
}

// 为什么不用 package.json / package-lock.json：它们是 npm 的事，而这个包从不发到
// npm —— 没有 `npm publish`，也没有谁来解析版本区间。Obsidian 只读 manifest.json、
// 别的一概不读，发布 workflow 也是拿 tag 跟同一个文件比。多留一份版本号副本，换来的
// 只有「每次发版多碰四个文件」和「一个自己会变的 lock 文件」；不管它的话，npm 每次
// 安装都会高高兴兴地重写那几个字段 —— 而这个项目的版本号根本不住在那儿。
// 所以它们那份版本号钉死一次，之后就不再管。

// manifest.json（tab 缩进）
manifest.version = arg;
writeFileSync('manifest.json', JSON.stringify(manifest, null, '\t') + '\n');

// versions.json：插件版本 -> minAppVersion 的映射（tab 缩进）。这一份 Obsidian
// 是真的会读的 —— 旧版 app 靠它知道自己最后还能装到哪个版本 —— 所以它必须跟
// manifest 保持一致。
const versions = JSON.parse(readFileSync('versions.json', 'utf8'));
versions[arg] = manifest.minAppVersion;
writeFileSync('versions.json', JSON.stringify(versions, null, '\t') + '\n');

// 把新版本号打出来，好让 workflow（或某个 shell）接住它。
console.log(arg);
