# 待提交的精选列表条目

这两份 YAML **还没有提交**。本次只把材料放在本仓库，不 fork、不提 PR。

## 目标路径

向上游仓库 `awesome-dsh-plugin/awesome-dsh-plugin` 提 PR 时，各新增一个文件，路径为：

| 本仓库文件 | 上游目标 |
| --- | --- |
| `KouzakiUmi__dsh-guard--packages-dsh-audit-rollback.yml` | `data/plugins/KouzakiUmi__dsh-guard--packages-dsh-audit-rollback.yml` |
| `KouzakiUmi__dsh-guard--packages-dsh-auto-review-router.yml` | `data/plugins/KouzakiUmi__dsh-guard--packages-dsh-auto-review-router.yml` |

`name` 使用 monorepo 子包写法 `KouzakiUmi/dsh-guard#<包名>`。`tarball` 指向 Release 资产名，**不带版本号**，因此可以用 `releases/latest/download/<资产名>.tgz`。不要改成带版本的文件名。

## 提交前再核对

- 仓库创建满 1 天。本仓库若当晚才建，提交前必须确认已满 1 天。
- 仓库已加 `dsh-plugin` topic。
- 一个 PR 最多 3 条。这两条可以放在同一次 PR。
- 描述与代码一致，没有营销词，中英文都以句号结尾。
- `category: security` 按精选列表分类表填写。若上游分类表没有 `security`，提交前改成表内最接近的一项，不要猜一个新分类名硬提。
