# Project context

moonup 的 Magpie 提供商插件，无运行时依赖，无需构建，使用 ESM。

## Entry points and verification

- `index.mjs`：`MoonupPlugin`，API Key 认证、账号身份、模型目录及四种文本协议转发。
- `queries.mjs`：`createQueries`，按站点和完整 Key 隔离的缓存与响应校验。
- `usage.mjs`：`usageOf`，钱包、订阅和密钥额度窗口。
- `npm run check`、`npm test`、`npm pack --dry-run`。测试使用本地 HTTP 或模拟 fetch，不调用收费模型。
- `compat/`：Magpie 原生插件 Key 表单的配套扩展补丁及使用说明；该扩展不是宿主已有的官方接口。

## Account and UI compatibility

- Key 添加应支持获取密钥链接、可选名称、单个/批量粘贴和协议选择；不能仅以宿主限制为由用说明文档代替实现。
- 新 Key 默认 `https://moonup.dev`，不额外提问站点。已存 `auth.metadata.baseURL` 优先于 `options.baseURL` 和默认站点，保留部署路径。
- `accountId` 关联宿主中的账号设置，不随显示调整重命名；保存时保留已有 `uid` 和元数据。不把插件账号转换为普通提供商。
- 名称与协议保存在 `metadata.name`、`metadata.protocol`。缺省协议保留旧行为；指定协议必须同时约束模型发现和请求转发，不得绕过服务端明确的权限。
- `auth.methods[].keyForm` 需配套宿主支持；旧宿主忽略此字段时仍可直接输入单个 Key。批量 Key 分别通过宿主认证接口保存，不放入插件 options 或额外凭据文件。
- [README](README.md) 是用户说明入口；[兼容说明](compat/README.md) 记录宿主变更和验证方法。
