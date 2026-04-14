# OCS AI 答题接口

这是一个兼容 OCS 网课助手题库请求格式的 Serverless 接口。

## 路由

- `/`：接口说明首页
- `/query`：答题接口
- `/health`：健康检查

## 接口行为

- 请求方式：`GET`
- 路径：`/query`
- 入参：`token`、`title`、`options`、`type`
- 返回格式：

```json
{
  "code": 1,
  "data": {
    "question": "题目文本",
    "answer": "答案文本"
  },
  "message": "请求成功"
}
```

其中：

- 单选题返回选项内容文本
- 多选题返回多个答案，使用 `#` 连接
- 判断题返回 `正确` 或 `错误`
- 填空题多个空使用 `#` 连接

## 健康检查

请求：

```text
GET /health
```

返回示例：

```json
{
  "status": "ok",
  "env": {
    "providersConfigured": true,
    "tokenConfigured": true
  },
  "timestamp": "2026-04-15T00:00:00.000Z"
}
```

## 环境变量

参考 `.env.example`：

- `OPENAI_API_KEY`：必填
- `OPENAI_BASE_URL`：可选，兼容 OpenAI 格式即可
- `OPENAI_MODEL`：可选
- `API_TOKEN`：可选，配置后会校验请求里的 `token`
- `OPENAI_PROVIDERS`：可选，多模型并行配置，JSON 数组

## 多模型模式

原题库接口通常只返回一个 `data.answer`，但 OCS 的题库框架本身支持一个题库源返回多个候选结果。

当前这个接口采用的是更稳妥的兼容方案：

- 对 OCS 仍然只返回一个最终答案
- 服务端内部可以并行请求 2 到 3 个不同模型
- 如果多个模型答案一致，直接采用多数答案
- 如果多个模型答案冲突，则再交给一个裁决模型选出最终答案

这样不需要改 OCS 侧逻辑，也不会破坏现有 `handler`。

`OPENAI_PROVIDERS` 示例：

```json
[
  {
    "name": "deepseek",
    "baseUrl": "https://api.deepseek.com/v1",
    "apiKey": "sk-xxx",
    "model": "deepseek-chat",
    "role": "answer"
  },
  {
    "name": "openai",
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "sk-xxx",
    "model": "gpt-4o-mini",
    "role": "answer"
  },
  {
    "name": "judge",
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "sk-xxx",
    "model": "gpt-4o-mini",
    "role": "judge"
  }
]
```

建议：

- `2` 个 `answer` 模型 + `1` 个 `judge` 模型
- 或 `3` 个 `answer` 模型，不单独配置 `judge`

注意：

- 多模型会提高正确率，但也会增加响应时间和调用成本
- Serverless 平台上建议优先使用响应较快的模型

## 在 OCS 中的题库配置

```json
[
  {
    "name": "AI答题",
    "homepage": "",
    "url": "https://你的域名.vercel.app/query",
    "method": "get",
    "type": "GM_xmlhttpRequest",
    "contentType": "json",
    "data": {
      "token": "你的token",
      "title": "${title}",
      "options": "${options}",
      "type": "${type}"
    },
    "handler": "return (res)=>res.code === 0 ? [res.data.answer, undefined] : [res.data.question,res.data.answer]"
  }
]
```

## 说明

OCS 实际上传给题库的 `type` 通常是：

- `single`
- `multiple`
- `judgement`
- `completion`
- `unknown`

本项目也兼容数字题型值，但推荐直接按 OCS 默认格式传递字符串题型。
