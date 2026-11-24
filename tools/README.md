# tools/

诊断脚本，不参与 runtime 启动。

## probe-acp.mjs

模拟 paseo 的 ACP 探测流程（`initialize` → `session/new`），用来验证某个 ACP agent
是否能正常握手并上报模型列表。paseo 的模型列表**完全来自 `session/new` 响应的
`models.availableModels`**（见 `@getpaseo/server` 的 `deriveModelDefinitionsFromACP`），
所以这个脚本能直接判定"为什么 provider 认不出模型"。

用法（在容器里）：

```sh
node tools/probe-acp.mjs vibe-acp
# 或指定绝对路径
node tools/probe-acp.mjs /home/container/.local/bin/vibe-acp
```

关注输出：
- `=== initialize ===` 有 result → ACP 协议基本通
- `=== session/new ===` 里的 `models` → 这就是 paseo 会看到的模型列表；为 `null` 或空数组即"认不出模型"
- `ERROR:` → 认证或权限问题（vibe-acp 需要 Mistral AI Studio 登录时会返回 authMethods）
- 超时 → agent 卡住，paseo 侧会判定探测失败
