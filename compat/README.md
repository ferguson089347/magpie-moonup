# Magpie 原生插件 Key 表单

`magpie-key-form.patch` 为 Magpie 插件账号补齐截图中的获取密钥、名称、单个/批量粘贴、协议、添加与取消。它复用宿主的输入框、样式、协议菜单和批量解析器，所有 Key 仍分别通过原来的 `plugin-signin` 接口存入 `plugin-auth.json`。

这是配套扩展，不是官方已有的插件接口；只更新 moonup 插件不会自动修改已安装的 Magpie 二进制文件。补丁基于 Magpie 提交 `e21ea07e` 验证，先检查能否干净应用，再按 Magpie 自身的构建说明构建和使用。不得覆盖运行中的账号配置。

![中文 Key 表单预览](key-form-preview.png)

在 Magpie 源码根目录运行（替换补丁绝对路径）：

```powershell
git apply --check D:/llm/magpie-moonup/compat/magpie-key-form.patch
git apply D:/llm/magpie-moonup/compat/magpie-key-form.patch
```

## 接口

API 认证方法可声明：

```js
{
  type: "api",
  label: "moonup API key",
  prompts: [],
  keyForm: {
    keysURL: "https://moonup.dev/keys",
    protocols: [
      { label: "Any protocol", value: "" },
      { label: "Anthropic", value: "anthropic_messages" },
    ],
  },
  // authorize 显式校验并保存 inputs.name / inputs.protocol。
}
```

宿主检查链接仅为无嵌入账号密码的 HTTP(S) URL，并限制协议选项数量和字符串长度。表单只向认证方法传入非机密的 `inputs.name`、`inputs.protocol`，Key 仍使用独立的 `key` 参数。插件必须校验这些字段、显式保留元数据，并在模型发现与生成请求中执行协议限制。

同一批中的重复 Key 只提交一次。失败后保留未处理的 Key；已保存的 Key 不会撤销或在重试时再次提交。现有账号不转换、不改名、不重建，旧 Key 缺省名称和协议时仍按原逻辑加载。未声明 `keyForm` 的插件保持原界面；旧宿主继续使用普通 API Key 输入框。

## 验证

补丁自带宿主 Go 测试及 Playwright 回归测试：

```powershell
go test ./internal/plugin -run 'TestPluginKeyForm|TestPluginOwnIconAndKeyHint'
# Playwright 可通过 NODE_PATH 指向仓库外已安装的包。
node --test internal/gui/tests/plugin-key-form.test.cjs internal/gui/tests/plugin-signin.test.cjs internal/gui/tests/plugin-key-hint.test.cjs internal/gui/tests/key-import.test.cjs
```

新表单测试在 Chromium 和 WebKit 下覆盖中、英、繁中、日、德语，以及 420 和 1100 像素窗口；检查链接、名称和协议提交、自动批量粘贴、去重、部分失败重试、取消和旧账号保留。设置 `ARTIFACT_DIR` 可保存截图。测试拦截所有浏览器请求，不读取真实凭据、不访问收费接口。
