const TYPE_LABELS = {
  single: "单选题",
  multiple: "多选题",
  judgement: "判断题",
  completion: "填空题",
  unknown: "未知题型",
};

const DEFAULT_SEPARATORS = ["#", "===", "---", "###", "|", ";", "；"];

function normalizeType(type) {
  const value = String(type || "unknown").trim().toLowerCase();
  if (value === "0") return "single";
  if (value === "1") return "multiple";
  if (value === "2") return "judgement";
  if (value === "3" || value === "4") return "completion";
  if (["single", "multiple", "judgement", "completion", "unknown"].includes(value)) {
    return value;
  }
  return "unknown";
}

function cleanAnswer(answer) {
  return String(answer || "")
    .replace(/^答案[:：]\s*/i, "")
    .replace(/[\r\n]+/g, "\n")
    .trim();
}

function splitAnswer(answer) {
  const text = cleanAnswer(answer);
  if (!text) {
    return [];
  }

  try {
    const json = JSON.parse(text);
    if (Array.isArray(json)) {
      return json.map((item) => cleanAnswer(item)).filter(Boolean);
    }
  } catch (_) {
  }

  for (const separator of DEFAULT_SEPARATORS) {
    const parts = text.split(separator).map((item) => cleanAnswer(item)).filter(Boolean);
    if (parts.length > 1) {
      return parts;
    }
  }

  return [text];
}

function uniqueList(items) {
  return Array.from(new Set(items.filter(Boolean)));
}

function normalizeJudgementAnswer(answer) {
  const value = cleanAnswer(answer).toLowerCase();
  const correctWords = ["是", "对", "正确", "确定", "√", "true", "t", "yes", "1"];
  const incorrectWords = ["非", "否", "错", "错误", "×", "x", "false", "f", "no", "0"];

  if (correctWords.includes(value)) {
    return "正确";
  }
  if (incorrectWords.includes(value)) {
    return "错误";
  }
  return cleanAnswer(answer);
}

function normalizeCandidate(answer, type) {
  if (type === "judgement") {
    return normalizeJudgementAnswer(answer);
  }

  if (type === "multiple" || type === "completion") {
    return uniqueList(splitAnswer(answer)).join("#");
  }

  return cleanAnswer(answer);
}

function parseProviders() {
  const rawProviders = process.env.OPENAI_PROVIDERS;
  if (rawProviders) {
    const providers = JSON.parse(rawProviders);
    if (!Array.isArray(providers) || providers.length === 0) {
      throw new Error("OPENAI_PROVIDERS 必须是非空数组");
    }
    return providers.map((provider, index) => ({
      name: provider.name || `provider-${index + 1}`,
      baseUrl: String(provider.baseUrl || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
      apiKey: provider.apiKey || process.env.OPENAI_API_KEY,
      model: provider.model || process.env.OPENAI_MODEL || "gpt-4o-mini",
      role: provider.role || "answer",
    }));
  }

  return [{
    name: "default",
    baseUrl: String(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    role: "answer",
  }];
}

function buildPrompt(title, options, rawType) {
  const type = normalizeType(rawType);
  const label = TYPE_LABELS[type] || TYPE_LABELS.unknown;
  const optionsText = options ? `\n选项：\n${options}` : "";
  const baseRule = "你是题库答题助手。严格遵循以下规则：\n1. 只输出最终答案，不解释、不分析、不输出任何多余文字\n2. 不要输出\"答案是\"\"正确答案\"等前缀\n3. 不要复述题目内容\n4. 若不确定，输出最可能的答案";

  if (type === "single") {
    return {
      system: `${baseRule}\n题型：单选题\n输出要求：仅输出正确选项的完整文字内容，不要输出选项字母（如A/B/C/D）。`,
      user: `题目：${title}${optionsText}`,
    };
  }

  if (type === "multiple") {
    return {
      system: `${baseRule}\n题型：多选题\n输出要求：输出所有正确选项的完整文字内容，多个答案之间用 # 连接，例如：苹果#香蕉#橙子。不要输出选项字母。`,
      user: `题目：${title}${optionsText}`,
    };
  }

  if (type === "judgement") {
    return {
      system: `${baseRule}\n题型：判断题\n输出要求：正确则仅输出\"正确\"二字，错误则仅输出\"错误\"二字。不要输出其他任何内容。`,
      user: `题目：${title}`,
    };
  }

  if (type === "completion") {
    return {
      system: `${baseRule}\n题型：填空题\n输出要求：若有多个空，用 # 连接各答案，例如：北京#2023；若只有一个空，直接输出答案。`,
      user: `题目：${title}${optionsText}`,
    };
  }

  return {
    system: `${baseRule}\n题型：未知题型\n输出要求：根据题目内容给出最可能的答案。若有多个答案，用 # 连接。`,
    user: `题目：${title}${optionsText}`,
  };
}

async function callLLM(provider, systemPrompt, userPrompt) {
  const apiKey = provider.apiKey;
  const baseUrl = provider.baseUrl;
  const model = provider.model;

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY 环境变量未配置");
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.1,
      max_tokens: 300,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM API 请求失败 (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : "";

  return cleanAnswer(content);
}

function pickMajorityAnswer(candidates, type) {
  const counter = new Map();
  for (const candidate of candidates) {
    const normalized = normalizeCandidate(candidate.answer, type);
    if (!normalized) {
      continue;
    }
    const current = counter.get(normalized) || { count: 0, items: [] };
    current.count += 1;
    current.items.push(candidate);
    counter.set(normalized, current);
  }

  const entries = Array.from(counter.entries()).sort((a, b) => b[1].count - a[1].count || a[0].length - b[0].length);
  if (entries.length === 0) {
    return { answer: "", needJudge: false, candidates: [] };
  }

  if (entries.length === 1 || entries[0][1].count > entries[1][1].count) {
    return {
      answer: entries[0][0],
      needJudge: false,
      candidates: entries[0][1].items,
    };
  }

  return {
    answer: entries[0][0],
    needJudge: true,
    candidates: entries.map((entry) => ({ answer: entry[0], votes: entry[1].count })),
  };
}

function buildJudgePrompt(title, options, type, candidates) {
  const label = TYPE_LABELS[type] || TYPE_LABELS.unknown;
  const optionsText = options ? `\n选项：\n${options}` : "";
  const candidateLines = candidates.map((item, index) => `候选${index + 1}：${item.answer}（${item.votes}票）`).join("\n");

  return {
    system: "你是题库答案裁决器。你的任务是从多个候选答案中选出唯一正确的答案。\n严格规则：\n1. 综合分析题目内容和所有候选答案\n2. 只输出最终答案，不解释、不分析\n3. 不要输出\"正确答案是\"等前缀\n4. 若候选答案中有明显错误，忽略它\n5. 输出格式必须与题型匹配",
    user: `题型：${label}\n题目：${title}${optionsText}\n\n各模型给出的候选答案及票数：\n${candidateLines}\n\n请选出唯一正确答案，直接输出答案内容。`,
  };
}

async function resolveAnswer(title, options, type) {
  const providers = parseProviders();
  const answerProviders = providers.filter((provider) => provider.role !== "judge");
  const judgeProvider = providers.find((provider) => provider.role === "judge") || answerProviders[0];

  if (answerProviders.length === 0) {
    throw new Error("至少需要一个可用的答题模型提供方");
  }

  const prompt = buildPrompt(title, options, type);
  const candidateResults = await Promise.all(
    answerProviders.map(async (provider) => {
      const answer = await callLLM(provider, prompt.system, prompt.user);
      return {
        provider: provider.name,
        answer: normalizeCandidate(answer, type),
      };
    })
  );

  const nonEmptyCandidates = candidateResults.filter((item) => item.answer);
  if (nonEmptyCandidates.length === 0) {
    throw new Error("所有模型都未返回有效答案");
  }

  const majority = pickMajorityAnswer(nonEmptyCandidates, type);
  if (!majority.needJudge) {
    return majority.answer;
  }

  const judgePrompt = buildJudgePrompt(title, options, type, majority.candidates);
  const judgedAnswer = await callLLM(judgeProvider, judgePrompt.system, judgePrompt.user);
  const normalized = normalizeCandidate(judgedAnswer, type);
  return normalized || majority.answer;
}

async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "GET") {
    res.status(405).json({ code: -1, message: "Method Not Allowed" });
    return;
  }

  const query = req.query || {};
  const token = query.token;
  const title = typeof query.title === "string" ? query.title.trim() : "";
  const options = typeof query.options === "string" ? query.options.trim() : "";
  const type = normalizeType(query.type);

  const validToken = process.env.API_TOKEN || "";
  if (validToken && token !== validToken) {
    res.status(403).json({ code: -1, message: "token 无效" });
    return;
  }

  if (!title) {
    res.status(400).json({ code: -1, message: "缺少 title 参数" });
    return;
  }

  try {
    const answer = await resolveAnswer(title, options, type);

    res.status(200).json({
      code: 1,
      data: {
        question: title,
        answer,
      },
      message: "请求成功",
    });
  } catch (error) {
    console.error("答题接口错误:", error);
    res.status(500).json({
      code: -1,
      message: error && error.message ? error.message : "服务器内部错误",
    });
  }
}

module.exports = handler;
