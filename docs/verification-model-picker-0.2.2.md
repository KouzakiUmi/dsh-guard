# 0.2.2 已配置审查模型选择 · 验收记录

## 交付范围
- 自动审查仍只有「设置→内置插件」入口。provider/model/effort 改为联动选择，不再提供文本输入。
- 目录来自官方全局 `remote.session.modelCatalog()`；与宿主模型菜单同源，无 sessionId、不改当前会话模型、不查询供应商、不发真实审查请求。
- 仅增加客户端目录读取及信息性 `dsh-api-session-controller` 依赖边；Host 的 index/config/context/policy 与全部审查、安全启停逻辑未修改。
- 两包按既有 monorepo 发包契约联动为 0.2.2；audit 功能无改动。

## 目标官方契约
现场核心 `@deepseek-ai/dsh 0.2.1-alpha.1`。安装根 `C:\Program Files\DSH NEXT\resources\app` 下：
- `dsh-api-session-controller/lib/types/catalog.js:5–59` 聚合活动适配器配置的 provider/models，以及解析后的 `reasoning.efforts[].id/name`、可选 defaultEffort；隔离 provider 失败。
- `dsh-api-session-controller/lib/typert.remote-client.js:1198–1210` 定义无参数 direct `session/modelCatalog` 公共 RPC。
- `dsh-client-ui-model-selection/lib/client.js:752–762` 使用同一目录 RPC；其 ModelSelect 绑定会话且未导出，故本插件不借用其会话修改动作。
- Host-only `llm.listModels` 不是合法客户端 Remote，亦不包含完整 reasoning 元信息，未采用。

## 实测
独立复读实际 lazy factory 与全部新测试，并运行：
```powershell
$env:DSH_APP_ROOT = 'C:\Program Files\DSH NEXT\resources\app'
node tools/verify.mjs --quiet
node scripts/check-manifest.mjs
git diff --check
```
全仓库 60/60 检查、14 套测试通过；既有真实 Loader/Settings/ConfigEditor 与官方 Auto 安全回归保留。

新 `configured-model-picker.mjs` 使用真实交付 factory、hooks 与 apply→slot 派生回调，验证：
- zh/en、加载、刷新、空目录、拒绝/失败、部分 provider 失败及重试；精确且包含斜杠的 ID，不混淆跨 provider 同名模型。
- 模型专属 effort/default，切换只清不兼容 effort，刷新/旧路由失效不静默重写草稿。
- 清空专用路由保留会话回退；完整 pair 与关闭 fallback 的 Config 校验；取消、冲突/拒绝与 revision 保留。
- 目录异常、旧模型/effort 不可用、加载中，都仍允许保留原路由安全保存 enabled=false；无效的新启用/修改被 UI 阻止。
- 过期请求、依赖变化、卸载后的读取/保存响应及 retained callbacks；dispose 后不再发 RPC。

## 验证边界
上述是离线 UI/协议及隔离持久化验收，不是浏览器实机交互。没有调用付费模型、修改真实 approval policy、安装脚本豁免、核心升级或自动重启。CI 发布后还需核验固定网络包与 Git 提交、官方 CLI 安装四验及实际运行态；CI/安装结果由外部安装记录补充，避免在冻结提交中伪填未来结果。
