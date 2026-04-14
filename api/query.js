const TYPE_LABELS = {
  single: "单选题",
  multiple: "多选题",
  judgement: "判断题",
  completion: "填空题",
  unknown: "未知题型",
};

const DEFAULT_SEPARATORS = ["#", "===", "---", "###", "|", ";", "；"];
const ANSWER_CACHE = new Map();
const RATE_LIMIT_BUCKETS = new Map();

function getNumberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function getStringEnv(name, fallback) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function getFastMode() {
  return getStringEnv("ANSWER_MODE", "consensus").toLowerCase() === "fast";
}

function getBooleanEnv(name, fallback) {
  const value = process.env[name];
  if (typeof value !== "string") {
    return fallback;
  }
  if (["1", "true", "yes", "on"].includes(value.trim().toLowerCase())) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(value.trim().toLowerCase())) {
    return false;
  }
  return fallback;
}

function buildCacheKey(title, options, type) {
  return JSON.stringify([normalizeType(type), title || "", options || ""]);
}

function getCachedAnswer(key) {
  const ttlMs = getNumberEnv("ANSWER_CACHE_TTL_SECONDS", 3600) * 1000;
  const cached = ANSWER_CACHE.get(key);
  if (!cached) {
    return "";
  }
  if (Date.now() - cached.createdAt > ttlMs) {
    ANSWER_CACHE.delete(key);
    return "";
  }
  return cached.answer || "";
}

function setCachedAnswer(key, answer) {
  if (!answer) {
    return;
  }
  pruneExpiredCache();
  const maxEntries = getNumberEnv("ANSWER_CACHE_MAX_ENTRIES", 500);
  if (!ANSWER_CACHE.has(key) && ANSWER_CACHE.size >= maxEntries) {
    const oldestKey = ANSWER_CACHE.keys().next().value;
    if (oldestKey !== void 0) {
      ANSWER_CACHE.delete(oldestKey);
    }
  }
  ANSWER_CACHE.set(key, {
    answer,
    createdAt: Date.now(),
  });
}

function pruneExpiredCache() {
  const ttlMs = getNumberEnv("ANSWER_CACHE_TTL_SECONDS", 3600) * 1000;
  for (const [key, value] of ANSWER_CACHE.entries()) {
    if (Date.now() - value.createdAt > ttlMs) {
      ANSWER_CACHE.delete(key);
    }
  }
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return String(forwarded[0]).split(",")[0].trim();
  }
  return String(req.socket?.remoteAddress || "unknown");
}

function checkRateLimit(req) {
  const enabled = getBooleanEnv("RATE_LIMIT_ENABLED", true);
  if (!enabled) {
    return { ok: true, retryAfter: 0 };
  }

  const windowMs = getNumberEnv("RATE_LIMIT_WINDOW_SECONDS", 60) * 1000;
  const maxRequests = getNumberEnv("RATE_LIMIT_MAX_REQUESTS", 30);
  const key = getClientIp(req);
  const now = Date.now();

  for (const [bucketKey, bucket] of RATE_LIMIT_BUCKETS.entries()) {
    if (now - bucket.startAt >= windowMs) {
      RATE_LIMIT_BUCKETS.delete(bucketKey);
    }
  }

  const bucket = RATE_LIMIT_BUCKETS.get(key);
  if (!bucket || now - bucket.startAt >= windowMs) {
    RATE_LIMIT_BUCKETS.set(key, { count: 1, startAt: now });
    return { ok: true, retryAfter: 0 };
  }

  if (bucket.count >= maxRequests) {
    return {
      ok: false,
      retryAfter: Math.max(1, Math.ceil((windowMs - (now - bucket.startAt)) / 1000)),
    };
  }

  bucket.count += 1;
  return { ok: true, retryAfter: 0 };
}

function extractBearerToken(req) {
  const auth = req.headers.authorization;
  if (typeof auth !== "string") {
    return "";
  }
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let failed = false;
    req.on("data", (chunk) => {
      if (failed) {
        return;
      }
      raw += chunk;
      if (raw.length > getNumberEnv("MAX_BODY_CHARS", 20000)) {
        failed = true;
        reject(new Error("请求体过大"));
      }
    });
    req.on("end", () => {
      if (failed) {
        return;
      }
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (_) {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function validateInput(title, options) {
  const maxTitleChars = getNumberEnv("MAX_TITLE_CHARS", 500);
  const maxOptionsChars = getNumberEnv("MAX_OPTIONS_CHARS", 4000);
  const maxTotalChars = getNumberEnv("MAX_TOTAL_CHARS", 5000);

  if (title.length > maxTitleChars) {
    return `title 过长，最大 ${maxTitleChars} 个字符`;
  }
  if (options.length > maxOptionsChars) {
    return `options 过长，最大 ${maxOptionsChars} 个字符`;
  }
  if (title.length + options.length > maxTotalChars) {
    return `请求内容过长，最大 ${maxTotalChars} 个字符`;
  }
  return "";
}

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

function parseOptionLines(optionsText) {
  return String(optionsText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^([A-Z])[\.、:：)）\s-]*(.*)$/i);
      if (!match) {
        return { key: "", text: line };
      }
      return {
        key: match[1].toUpperCase(),
        text: cleanAnswer(match[2] || line),
      };
    });
}

function mapLetterAnswerToOption(answer, optionsText) {
  const value = cleanAnswer(answer).replace(/[,，、\s#]/g, "").toUpperCase();
  if (!/^[A-Z]+$/.test(value) || value.length === 0 || value.length > 8) {
    return "";
  }

  const options = parseOptionLines(optionsText);
  if (options.length === 0) {
    return "";
  }

  const mapped = [];
  for (const char of value) {
    const found = options.find((option) => option.key === char);
    if (!found || !found.text) {
      return "";
    }
    mapped.push(found.text);
  }

  return uniqueList(mapped).join("#");
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

function normalizeCandidate(answer, type, optionsText) {
  const mappedFromLetters = mapLetterAnswerToOption(answer, optionsText);
  if (mappedFromLetters) {
    if (type === "single") {
      return splitAnswer(mappedFromLetters)[0] || mappedFromLetters;
    }
    if (type === "multiple" || type === "completion" || type === "unknown") {
      return mappedFromLetters;
    }
  }

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

  let response;
  response = await fetch(`${baseUrl}/chat/completions`, {
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
      max_tokens: 120,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("LLM API error", {
      provider: provider.name,
      status: response.status,
      body: errorText,
    });
    throw new Error("上游模型服务不可用");
  }

  const data = await response.json();
  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : "";

  return cleanAnswer(content);
}

async function firstResolved(tasks) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let pending = tasks.length;
    const errors = [];

    if (pending === 0) {
      reject(new Error("没有可用的答题任务"));
      return;
    }

    for (const task of tasks) {
      task
        .then((result) => {
          if (settled) {
            return;
          }
          if (result && result.answer) {
            settled = true;
            resolve(result);
            return;
          }
          pending -= 1;
          if (!pending && !settled) {
            reject(errors[0] || new Error("所有模型都未返回有效答案"));
          }
        })
        .catch((error) => {
          errors.push(error);
          pending -= 1;
          if (!pending && !settled) {
            reject(errors[0] || new Error("所有模型都未返回有效答案"));
          }
        });
    }
  });
}

function pickMajorityAnswer(candidates, type, optionsText) {
  const counter = new Map();
  for (const candidate of candidates) {
    const normalized = normalizeCandidate(candidate.answer, type, optionsText);
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
  const cacheKey = buildCacheKey(title, options, type);
  const cachedAnswer = getCachedAnswer(cacheKey);
  if (cachedAnswer) {
    return cachedAnswer;
  }

  const providers = parseProviders();
  const answerProviders = providers.filter((provider) => provider.role !== "judge");
  const judgeProvider = providers.find((provider) => provider.role === "judge") || answerProviders[0];

  if (answerProviders.length === 0) {
    throw new Error("至少需要一个可用的答题模型提供方");
  }

  const prompt = buildPrompt(title, options, type);
  const candidateTasks = answerProviders.map(async (provider) => {
    const answer = await callLLM(provider, prompt.system, prompt.user);
    return {
      provider: provider.name,
      answer: normalizeCandidate(answer, type, options),
    };
  });

  if (getFastMode()) {
    const fastest = await firstResolved(candidateTasks);
    setCachedAnswer(cacheKey, fastest.answer);
    return fastest.answer;
  }

  const settledResults = await Promise.allSettled(candidateTasks);
  const candidateResults = settledResults
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value);

  const nonEmptyCandidates = candidateResults.filter((item) => item.answer);
  if (nonEmptyCandidates.length === 0) {
    throw new Error("所有模型都未返回有效答案");
  }

  const majority = pickMajorityAnswer(nonEmptyCandidates, type, options);
  if (!majority.needJudge) {
    setCachedAnswer(cacheKey, majority.answer);
    return majority.answer;
  }

  const judgePrompt = buildJudgePrompt(title, options, type, majority.candidates);
  const judgedAnswer = await callLLM(judgeProvider, judgePrompt.system, judgePrompt.user);
  const normalized = normalizeCandidate(judgedAnswer, type, options);
  const finalAnswer = normalized || majority.answer;
  setCachedAnswer(cacheKey, finalAnswer);
  return finalAnswer;
}

async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ code: -1, message: "Method Not Allowed" });
    return;
  }

  const rateLimit = checkRateLimit(req);
  if (!rateLimit.ok) {
    res.setHeader("Retry-After", String(rateLimit.retryAfter));
    res.status(429).json({ code: -1, message: "请求过于频繁，请稍后再试" });
    return;
  }

  let input;
  try {
    input = req.method === "POST" ? await readJsonBody(req) : (req.query || {});
  } catch (error) {
    res.status(400).json({
      code: -1,
      message: error && error.message ? error.message : "请求格式错误",
    });
    return;
  }

  const queryToken = typeof input.token === "string" ? input.token.trim() : "";
  const headerToken = extractBearerToken(req);
  const token = headerToken || queryToken;
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const options = typeof input.options === "string" ? input.options.trim() : "";
  const type = normalizeType(input.type);

  const validToken = process.env.API_TOKEN || "";
  if (validToken && token !== validToken) {
    res.status(403).json({ code: -1, message: "token 无效" });
    return;
  }

  if (!title) {
    res.status(400).json({ code: -1, message: "缺少 title 参数" });
    return;
  }

  const inputError = validateInput(title, options);
  if (inputError) {
    res.status(400).json({ code: -1, message: inputError });
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
      message: "服务器内部错误",
    });
  }
}

module.exports = handler;
