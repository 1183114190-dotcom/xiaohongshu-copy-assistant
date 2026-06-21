import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

loadEnv(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 8787);
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml; charset=utf-8"
};

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "POST" && request.url === "/api/generate-copy") {
      await handleGenerate(request, response);
      return;
    }

    if (request.method === "POST" && request.url === "/api/analyze-copy") {
      await handleAnalyze(request, response);
      return;
    }

    if (request.method === "GET") {
      await serveStatic(request, response);
      return;
    }

    sendJson(response, 405, { error: "只支持 GET 和 POST 请求。" });
  } catch (error) {
    console.error(error);
    sendJson(response, error.statusCode || 500, {
      error: error.message || "服务端处理失败，请稍后再试。"
    });
  }
});

server.listen(PORT, () => {
  console.log(`小红书文案助手已启动：http://localhost:${PORT}`);
  if (!DEEPSEEK_API_KEY) {
    console.log("提示：还没有检测到 DEEPSEEK_API_KEY，请复制 .env.example 为 .env 后填写。");
  }
});

function loadEnv(envPath) {
  if (!existsSync(envPath)) return;

  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const equalIndex = trimmed.indexOf("=");
    if (equalIndex === -1) continue;

    const key = trimmed.slice(0, equalIndex).trim();
    const value = trimmed.slice(equalIndex + 1).trim().replace(/^["']|["']$/g, "");
    if (key && !process.env[key]) {
      process.env[key] = value;
    }
  }
}

async function readJsonBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 80_000) {
      throw new Error("请求内容太长。");
    }
  }
  return JSON.parse(body || "{}");
}

async function handleGenerate(request, response) {
  const data = await readJsonBody(request);
  const requiredFields = ["productName", "sellingPoints", "audience", "scene", "tone", "length"];
  const missing = requiredFields.filter((field) => !String(data[field] || "").trim());

  if (missing.length) {
    sendJson(response, 400, { error: "请先填写完整的产品信息。" });
    return;
  }

  const systemPrompt = `你是专业的小红书营销文案助手。请使用中文输出，适合普通用户直接复制发布。必须输出严格 json，不要输出 markdown。JSON 格式示例：
{
  "titles": ["标题1", "标题2", "标题3"],
  "body": "正文",
  "coverKeywords": ["关键词1", "关键词2", "关键词3", "关键词4", "关键词5"],
  "tags": ["#标签1", "#标签2"]
}`;

  const userPrompt = `请根据以下信息生成小红书文案：
产品名称：${data.productName}
产品卖点：${data.sellingPoints}
目标人群：${data.audience}
使用场景：${data.scene}
语气风格：${data.tone}
文案长度：${data.length}

要求：
1. 给 3 个标题。
2. 给 1 篇小红书正文，口语化、真诚、有场景感。
3. 给 5 个封面关键词，每个尽量短。
4. 给 10 个话题标签，标签必须以 # 开头。
5. 只输出 json。`;

  const result = await callDeepSeek([
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt }
  ]);

  sendJson(response, 200, normalizeGenerateResult(result));
}

async function handleAnalyze(request, response) {
  const data = await readJsonBody(request);
  const text = String(data.text || "").trim();

  if (!text) {
    sendJson(response, 400, { error: "请先粘贴需要分析的小红书文案。" });
    return;
  }

  const systemPrompt = `你是专业的小红书文案分析师。请使用中文，给普通用户能看懂的建议。必须输出严格 json，不要输出 markdown。JSON 格式示例：
{
  "scores": {
    "标题吸引力": 80,
    "开头抓人程度": 75,
    "卖点清晰度": 82,
    "情绪价值": 78,
    "转化引导": 70
  },
  "advice": "修改建议",
  "optimized": "优化后的完整文案"
}`;

  const userPrompt = `请分析这篇小红书文案：
${text}

要求：
1. 从标题吸引力、开头抓人程度、卖点清晰度、情绪价值、转化引导五个方面评分，每项 0 到 100 分。
2. 给出清晰、具体、可执行的修改建议。
3. 给出一版优化后的完整文案。
4. 只输出 json。`;

  const result = await callDeepSeek([
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt }
  ]);

  sendJson(response, 200, normalizeAnalyzeResult(result));
}

async function callDeepSeek(messages) {
  if (!DEEPSEEK_API_KEY || DEEPSEEK_API_KEY.includes("在这里填写")) {
    const error = new Error("请先在 .env 文件里填写 DEEPSEEK_API_KEY。");
    error.statusCode = 400;
    throw error;
  }

  const apiResponse = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages,
      response_format: { type: "json_object" },
      max_tokens: 2200,
      temperature: 0.7,
      stream: false
    })
  });

  const payload = await apiResponse.json().catch(() => ({}));
  if (!apiResponse.ok) {
    const detail = payload.error?.message || `DeepSeek 请求失败，状态码 ${apiResponse.status}`;
    const error = new Error(detail);
    error.statusCode = apiResponse.status;
    throw error;
  }

  const content = payload.choices?.[0]?.message?.content || "";
  if (!content.trim()) {
    throw new Error("DeepSeek 返回为空，请重试。");
  }

  try {
    return JSON.parse(content);
  } catch {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    throw new Error("DeepSeek 返回内容不是有效 JSON。");
  }
}

async function serveStatic(request, response) {
  const url = new URL(request.url, `http://localhost:${PORT}`);
  const safePath = path
    .normalize(decodeURIComponent(url.pathname))
    .replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(__dirname, safePath === "/" ? "index.html" : safePath);

  if (!filePath.startsWith(__dirname)) {
    sendText(response, 403, "禁止访问。");
    return;
  }

  try {
    const content = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream"
    });
    response.end(content);
  } catch {
    sendText(response, 404, "文件不存在。");
  }
}

function normalizeGenerateResult(result) {
  return {
    titles: ensureArray(result.titles).slice(0, 3),
    body: String(result.body || ""),
    coverKeywords: ensureArray(result.coverKeywords).slice(0, 5),
    tags: ensureArray(result.tags).slice(0, 10).map((tag) => {
      const clean = String(tag || "").trim();
      return clean.startsWith("#") ? clean : `#${clean}`;
    })
  };
}

function normalizeAnalyzeResult(result) {
  const scoreNames = ["标题吸引力", "开头抓人程度", "卖点清晰度", "情绪价值", "转化引导"];
  const scores = {};
  for (const name of scoreNames) {
    const value = Number(result.scores?.[name] ?? 0);
    scores[name] = Math.max(0, Math.min(100, Math.round(value)));
  }

  return {
    scores,
    advice: String(result.advice || ""),
    optimized: String(result.optimized || "")
  };
}

function ensureArray(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string") {
    return value
      .split(/[,，、\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

function sendText(response, statusCode, text) {
  response.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(text);
}
