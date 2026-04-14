# AI Tiku

一个兼容常见题库请求格式的 Serverless 答题接口，支持 OpenAI 兼容模型和多模型投票。

## 简介

这个项目提供一个可直接部署到 Vercel 的 HTTP 接口。

接口接收以下参数：

- `token`
- `title`
- `options`
- `type`

接口返回统一的 JSON 结构，适合接入支持自定义题库源的脚本或工具。

## 路由

- `/`：接口说明
- `/query`：答题接口
- `/health`：健康检查

## 返回格式

`/query` 返回示例：

```json
{
  "code": 1,
  "data": {
    "question": "鸦片战争发生在哪一年",
    "answer": "1840年"
  },
  "message": "请求成功"
}
```

说明：

- 单选题返回选项文本
- 多选题使用 `#` 连接多个答案
- 判断题返回 `正确` 或 `错误`
- 填空题多个空使用 `#` 连接

## 请求参数

请求方式：`GET`

参数说明：

- `token`：访问令牌，可选，取决于是否配置 `API_TOKEN`
- `title`：题目文本
- `options`：选项文本，通常按换行分隔
- `type`：题型

支持的题型值：

- `single`
- `multiple`
- `judgement`
- `completion`
- `unknown`

同时兼容数字题型值。

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

含义：

- `providersConfigured`：是否已配置模型调用所需环境变量
- `tokenConfigured`：是否启用了访问令牌校验

## 环境变量

单模型模式：

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENAI_MODEL`
- `API_TOKEN`

多模型模式：

- `OPENAI_PROVIDERS`
- `API_TOKEN`

如果配置了 `OPENAI_PROVIDERS`，接口会优先使用该配置。

## 多模型配置

`OPENAI_PROVIDERS` 是一个 JSON 数组。每个对象支持以下字段：

- `name`
- `baseUrl`
- `apiKey`
- `model`
- `role`

`role` 可选值：

- `answer`：参与生成候选答案
- `judge`：当候选答案冲突时负责裁决

示例：

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

工作方式：

- 多个 `answer` 模型并行返回候选答案
- 如果结果一致，直接返回
- 如果结果冲突，使用 `judge` 模型裁决
- 如果未配置 `judge`，默认使用第一个答题模型参与裁决

## 接入示例

```json
[
  {
    "name": "AI答题",
    "homepage": "https://你的域名.vercel.app/",
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

## 部署到 Vercel

1. 将项目推送到 GitHub
2. 在 Vercel 中导入仓库
3. 设置环境变量
4. 部署项目

部署完成后可访问：

- `https://你的域名.vercel.app/`
- `https://你的域名.vercel.app/health`
- `https://你的域名.vercel.app/query`

## 本地开发

可以使用 `.env.local` 配置本地环境变量。

示例：

```env
OPENAI_API_KEY=sk-xxx
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
API_TOKEN=your-token
```

或：

```env
OPENAI_PROVIDERS=[{"name":"deepseek","baseUrl":"https://api.deepseek.com/v1","apiKey":"sk-xxx","model":"deepseek-chat","role":"answer"},{"name":"openai","baseUrl":"https://api.openai.com/v1","apiKey":"sk-xxx","model":"gpt-4o-mini","role":"judge"}]
API_TOKEN=your-token
```
