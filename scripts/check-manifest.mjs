#!/usr/bin/env node
// 发布前机械校验 —— 逐包检查两个插件包的发布元数据。
// 检查口径见 docs/release-plan.md §5；在本地与 GitHub Actions 中都运行，
// 任何一项失败即退出非零，FAIL 行带包名与原因。

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fail = (pkg, msg) => {
	console.error(`FAIL ${pkg} ${msg}`);
	process.exitCode = 1;
};
const ok = (pkg, msg) => console.log(`PASS ${pkg} ${msg}`);

const SEMVER = /^\d+\.\d+\.\d+(-[\w.]+)?$/;
// 契约 §6：每个包打包后必须恰好包含的运行必需文件（package.json 由 npm 自动带上）。
const REQUIRED_FILES = {
	"dsh-audit-rollback": [
		"package.json",
		"README.zh.md",
		"cordis.patch.yml",
		"lib/index.js",
		"lib/ledger.js",
		"scripts/audit-rollback.mjs",
	],
	"dsh-auto-review-router": [
		"package.json",
		"README.zh.md",
		"cordis.patch.yml",
		"lib/index.js",
		"lib/policy.js",
		"lib/context.js",
	],
};

// 契约 §7：package.json 的 files 字段应精确等于的清单（npm 自动包含 package.json，不必列出）。
const FILES_FIELD = Object.fromEntries(
	Object.entries(REQUIRED_FILES).map(([name, files]) => [name, files.filter((f) => f !== "package.json")]),
);

const packagesDir = join(root, "packages");
const names = readdirSync(packagesDir, { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name);

const versions = new Map();

for (const name of names) {
	const dir = join(packagesDir, name);
	const pkgPath = join(dir, "package.json");
	if (!existsSync(pkgPath)) {
		fail(name, "package.json 不存在");
		continue;
	}
	const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

	// 1. name 为目录名；version 符合 semver
	if (pkg.name !== name) fail(name, `package.name 应为 ${name}，实际 ${pkg.name}`);
	else ok(name, `name = ${name}`);
	if (!SEMVER.test(pkg.version || "")) fail(name, `version 不是 semver: ${pkg.version}`);
	else ok(name, `version = ${pkg.version}`);
	versions.set(name, pkg.version);

	// 2. dsh.bundle.patch 存在且指向的文件真实存在
	const patch = pkg.dsh?.bundle?.patch;
	if (!patch) fail(name, "缺少 dsh.bundle.patch");
	else if (!existsSync(join(dir, patch))) fail(name, `dsh.bundle.patch 指向的文件不存在: ${patch}`);
	else ok(name, `dsh.bundle.patch -> ${patch}`);

	// 3. @deepseek-ai/* 只在 peerDependencies，且口径固定为 ">=0.2.0-rc.1 <0.3.0-0"
	const peerRange = pkg.peerDependencies?.["@deepseek-ai/dsh"];
	if (Object.keys(pkg.dependencies || {}).some((key) => key.startsWith("@deepseek-ai/"))) {
		fail(name, "@deepseek-ai/* 出现在 dependencies —— 应只在 peerDependencies");
	} else if (peerRange !== ">=0.2.0-rc.1 <0.3.0-0") {
		fail(name, `peerDependencies["@deepseek-ai/dsh"] 应为 ">=0.2.0-rc.1 <0.3.0-0"，实际 ${peerRange}`);
	} else {
		ok(name, `peerDependencies["@deepseek-ai/dsh"] = "${peerRange}"`);
	}

	// 4. repository.url 指回 KouzakiUmi/dsh-guard，且 directory 指向包目录
	const repo = pkg.repository;
	const url = typeof repo === "string" ? repo : repo?.url || "";
	if (!/github\.com[:/]KouzakiUmi\/dsh-guard/.test(url)) {
		fail(name, `repository.url 未指回 KouzakiUmi/dsh-guard: ${url || "(缺失)"}`);
	} else if (repo?.directory !== `packages/${name}`) {
		fail(name, `repository.directory 应为 packages/${name}，实际 ${repo?.directory}`);
	} else {
		ok(name, `repository.directory = packages/${name}`);
	}

	// 5. files 白名单恰好等于契约 §7 清单，且不得包含 test/tools/node_modules
	const files = [...(pkg.files || [])].sort();
	const expected = [...(FILES_FIELD[name] || [])].sort();
	const missing = expected.filter((f) => !files.includes(f));
	const surplus = files.filter((f) => !expected.includes(f));
	const forbidden = files.filter((f) => /^(test|tools|node_modules)(\/|$)/.test(f));
	if (missing.length > 0 || surplus.length > 0 || forbidden.length > 0) {
		fail(name, `files 应为 [${expected.join(", ")}]；缺少: ${missing.join(", ") || "无"}，多出: ${surplus.join(", ") || "无"}${forbidden.length ? `（含禁区: ${forbidden.join(", ")}）` : ""}`);
	} else {
		ok(name, `files = [${files.join(", ")}]`);
	}

	// 6. exports 里每个字符串目标在磁盘上存在（* 通配只校验其目录）
	for (const [key, target] of Object.entries(pkg.exports || {})) {
		if (typeof target === "string") {
			if (target.endsWith("*")) {
				if (!existsSync(join(dir, dirname(target)))) fail(name, `exports["${key}"] -> ${target} 目录不存在`);
			} else if (!existsSync(join(dir, target))) {
				fail(name, `exports["${key}"] -> ${target} 文件不存在`);
			}
		} else {
			for (const sub of Object.values(target)) {
				if (typeof sub === "string" && !existsSync(join(dir, sub))) {
					fail(name, `exports["${key}"] -> ${sub} 文件不存在`);
				}
			}
		}
	}
	ok(name, "exports 目标均存在");

	// 7. cordis.patch.yml 含 - insert:，且其中 name: 等于本包名
	const patchFile = join(dir, "cordis.patch.yml");
	if (existsSync(patchFile)) {
		const text = readFileSync(patchFile, "utf8");
		if (!text.includes("- insert:")) fail(name, "cordis.patch.yml 缺少 - insert: 结构");
		else if (!new RegExp(`name:\\s*${name}\\b`).test(text)) {
			fail(name, `cordis.patch.yml 未注册 name: ${name}`);
		} else {
			ok(name, `cordis.patch.yml 含 insert 条目（${name}）`);
		}
	}
}

// 8. 两包 version 相等（跨包检查，只在根脚本里做一次）
const distinct = new Set(versions.values());
if (versions.size > 1 && distinct.size === 1) {
	ok("(跨包)", `两包 version 一致: ${[...distinct][0]}`);
} else if (versions.size > 1) {
	fail("(跨包)", `两包 version 不一致: ${[...versions].map(([n, v]) => `${n}=${v}`).join(", ")}`);
}

if (process.exitCode) {
	console.error("\n清单校验未通过 —— 以上 FAIL 项修完再发版。");
} else {
	console.error("\n清单校验全部通过。");
}
