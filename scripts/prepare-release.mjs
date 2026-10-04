#!/usr/bin/env node
// 校验 npm pack --ignore-scripts --json 的产物，再复制为固定资产名 dist/<pkg>.tgz。
// 输入：仓库根的 pack-dsh-audit-rollback.json 与 pack-dsh-auto-review-router.json；
// 输出：dist/dsh-audit-rollback.tgz 与 dist/dsh-auto-review-router.tgz。
// 检查口径见 docs/release-plan.md §6：包内文件集合必须恰好是必需项，
// 多一个 test/、tools/、node_modules/ 即失败。

import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

// 契约 §6：每个包打包后必须恰好包含的文件集合。
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

export function validatePack(name, info) {
	if (!Array.isArray(info) || info.length !== 1) {
		throw new Error(`${name}: pack.json 应恰好包含一个包条目，实际 ${Array.isArray(info) ? info.length : "非数组"}`);
	}
	const pack = info[0];
	if (pack?.name !== name) throw new Error(`${name}: 包名不符，实际 ${pack?.name}`);
	if (typeof pack.version !== "string" || !SEMVER.test(pack.version)) {
		throw new Error(`${name}: version 不是 semver: ${pack.version}`);
	}
	// filename 必须是裸文件名（不得带目录），且等于 <name>-<version>.tgz
	if (typeof pack.filename !== "string" || basename(pack.filename) !== pack.filename) {
		throw new Error(`${name}: filename 不是裸文件名: ${pack.filename}`);
	}
	if (pack.filename !== `${name}-${pack.version}.tgz`) {
		throw new Error(`${name}: filename 应为 ${name}-${pack.version}.tgz，实际 ${pack.filename}`);
	}
	if (!Array.isArray(pack.files)) throw new Error(`${name}: 缺少包内文件清单`);

	const paths = new Set(pack.files.map((file) => file.path));
	const required = new Set(REQUIRED_FILES[name]);
	const missing = [...required].filter((p) => !paths.has(p));
	const extra = [...paths].filter((p) => !required.has(p));
	if (missing.length > 0) throw new Error(`${name}: 包内缺少必需文件: ${missing.join(", ")}`);
	if (extra.length > 0) throw new Error(`${name}: 包内多出非必需文件（不得混入 test/tools/node_modules 等）: ${extra.join(", ")}`);
	return pack;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const dist = resolve(root, "dist");
	// dist 只保留本次校验过的产物，避免旧 tarball 混入 Release 资产
	rmSync(dist, { recursive: true, force: true });
	mkdirSync(dist, { recursive: true });

	for (const name of Object.keys(REQUIRED_FILES)) {
		const manifest = resolve(root, `pack-${name}.json`);
		const pack = validatePack(name, JSON.parse(readFileSync(manifest, "utf8")));
		const asset = join(dist, `${name}.tgz`);
		// npm pack 的 tarball 生成在包目录下（见 CI 的 (cd packages/$pkg && npm pack ...)）
		copyFileSync(join(root, "packages", name, pack.filename), asset);
		console.log(`已校验 ${pack.name}@${pack.version} -> ${asset}（${statSync(asset).size} 字节，${pack.files.length} 个文件）`);
	}
	console.log("\n两个发布产物均已就位。");
}
