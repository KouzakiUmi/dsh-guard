#!/usr/bin/env node
// 本地一键打包：逐包 npm pack --ignore-scripts --json > pack-<pkg>.json，
// 然后调用 prepare-release.mjs 校验并复制为 dist/<pkg>.tgz。
// 命令序列与 ci.yml 中 test job 的「打包与校验」步骤等价。

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = ["dsh-audit-rollback", "dsh-auto-review-router"];

for (const name of PACKAGES) {
	// Windows 上 npm 是 npm.cmd，需要 shell 才能执行（Node ≥20.12 的安全限制）
	const output = execFileSync("npm", ["pack", "--ignore-scripts", "--json"], {
		cwd: join(root, "packages", name),
		shell: process.platform === "win32",
		encoding: "utf8",
	});
	writeFileSync(join(root, `pack-${name}.json`), output);
	console.log(`已生成 pack-${name}.json`);
}

// 与 CI 一致的下一步：node scripts/prepare-release.mjs（子进程调用，继承退出码与输出）
execFileSync(process.execPath, [join(root, "scripts", "prepare-release.mjs")], {
	cwd: root,
	stdio: "inherit",
});
execFileSync(process.execPath, [join(root, "tools", "check-packed.mjs")], {
	cwd: root,
	stdio: "inherit",
});
