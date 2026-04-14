# AI Tiku

一个可部署到 Vercel 的答题接口，兼容常见题库请求格式，支持 OpenAI 兼容模型、缓存和多模型投票。

## 特性

- 兼容 `token`、`title`、`options`、`type` 请求格式
- 支持单模型和多模型配置
- 支持两种答题策略：`consensus` 和 `fast`
- 内置答案缓存，重复题目响应更快
- 提供首页说明和健康检查接口

## 路由

| 路径 | 说明 |
| --- | --- |
| `/` | 接口说明 |
| `/query` | 答题接口 |
| `/health` | 健康检查 |

## 请求格式

请求方式：`GET`

请求参数：

- `token`：访问令牌，可选，配置 `API_TOKEN` 后生效
- `title`：题目文本
- `options`：选项文本，通常按换行分隔
- `type`：题型

支持的 `type`：

- `single`
- `multiple`
- `judgement`
- `completion`
- `unknown`

同时兼容数字题型值。

## 返回格式

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

答案规则：

- 单选题返回选项文本
- 多选题使用 `#` 连接多个答案
- 判断题返回 `正确` 或 `错误`
- 填空题多个空使用 `#` 连接

## 快速开始

### 1. 配置环境变量

单模型模式：

```env
OPENAI_API_KEY=sk-xxx
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
API_TOKEN=your-token
ANSWER_MODE=consensus
ANSWER_CACHE_TTL_SECONDS=3600
```

多模型模式：

```env
OPENAI_PROVIDERS=[{"name":"deepseek","baseUrl":"https://api.deepseek.com/v1","apiKey":"sk-xxx","model":"deepseek-chat","role":"answer"},{"name":"openai","baseUrl":"https://api.openai.com/v1","apiKey":"sk-xxx","model":"gpt-4o-mini","role":"answer"},{"name":"judge","baseUrl":"https://api.openai.com/v1","apiKey":"sk-xxx","model":"gpt-4o-mini","role":"judge"}]
API_TOKEN=your-token
ANSWER_MODE=consensus
ANSWER_CACHE_TTL_SECONDS=3600
```

### 2. 部署到 Vercel

1. 将项目推送到 GitHub
2. 在 Vercel 中导入仓库
3. 配置环境变量
4. 部署项目

部署后可访问：

- `https://你的域名.vercel.app/`
- `https://你的域名.vercel.app/health`
- `https://你的域名.vercel.app/query`

## 答题模式

### `consensus`

默认模式。

- 多个 `answer` 模型并行返回候选答案
- 如果结果一致，直接返回
- 如果结果冲突，使用 `judge` 模型裁决
- 如果未配置 `judge`，默认使用第一个答题模型参与裁决

适合更看重稳定性的场景。

### `fast`

- 多个 `answer` 模型并行请求
- 第一个返回有效答案的模型会被直接采用
- 不会调用 `judge` 模型

适合更看重响应速度的场景。

推荐配置：

```env
ANSWER_MODE=fast
ANSWER_CACHE_TTL_SECONDS=3600
```

## 缓存

接口会基于 `title`、`options`、`type` 做内存缓存。

- 命中缓存时可直接返回结果
- 适合同一题目短时间重复请求的场景
- 缓存受实例生命周期影响，不是持久化存储

缓存时间通过 `ANSWER_CACHE_TTL_SECONDS` 控制。

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

字段说明：

- `providersConfigured`：模型调用配置是否存在
- `tokenConfigured`：是否启用了访问令牌校验

## 接入示例

下面是一份可直接用于自定义题库源的配置：

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
    "handler": "return (res)=>res.code === 0 ? [res.data.answer, undefined] : [res.data.question, res.data.answer]"
  }
]
```

## 调试示例

```text
https://你的域名.vercel.app/query?token=your-token&title=鸦片战争发生在哪一年&options=A.1840年%0AB.1842年%0AC.1856年%0AD.1860年&type=single
```

## 环境变量

| 变量名 | 说明 |
| --- | --- |
| `OPENAI_API_KEY` | 单模型模式下的 API Key |
| `OPENAI_BASE_URL` | 单模型模式下的接口地址 |
| `OPENAI_MODEL` | 单模型模式下的模型名 |
| `OPENAI_PROVIDERS` | 多模型配置，JSON 数组 |
| `API_TOKEN` | 接口访问令牌 |
| `ANSWER_MODE` | `consensus` 或 `fast` |
| `ANSWER_CACHE_TTL_SECONDS` | 缓存存活时间，单位秒 |

如果配置了 `OPENAI_PROVIDERS`，接口会优先使用它。
