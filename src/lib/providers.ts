export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  suggestedModels: string[];
  consoleUrl: string;
}

export const BUILTIN_PROVIDERS: Provider[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    suggestedModels: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"],
    consoleUrl: "https://console.anthropic.com",
  },
  {
    id: "zhipu",
    name: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/anthropic",
    suggestedModels: ["glm-4.6", "glm-4.5", "glm-4.5-air"],
    consoleUrl: "https://open.bigmodel.cn",
  },
  {
    id: "moonshot",
    name: "月之暗面 Kimi",
    baseUrl: "https://api.moonshot.cn/anthropic",
    suggestedModels: ["kimi-k2-0905-preview", "kimi-k2-turbo-preview"],
    consoleUrl: "https://platform.moonshot.cn",
  },
  {
    id: "qwen",
    name: "通义千问",
    baseUrl: "https://dashscope.aliyuncs.com/api/v2/apps/claude-code-proxy",
    suggestedModels: ["qwen3-coder-plus", "qwen3-coder-flash"],
    consoleUrl: "https://bailian.console.aliyun.com",
  },
  {
    id: "minimax",
    name: "MiniMax",
    baseUrl: "https://api.minimaxi.com/anthropic",
    suggestedModels: ["MiniMax-M2", "MiniMax-M1"],
    consoleUrl: "https://platform.minimaxi.com",
  },
  {
    id: "xiaomi",
    name: "小米 MiMo",
    baseUrl: "https://api.xiaomimimo.com/anthropic",
    suggestedModels: ["MiMo-7B-RL"],
    consoleUrl: "https://platform.xiaomimimo.com/",
  },
  {
    id: "custom",
    name: "自定义",
    baseUrl: "",
    suggestedModels: [],
    consoleUrl: "",
  },
];

export function getProvider(id: string): Provider {
  return BUILTIN_PROVIDERS.find((p) => p.id === id) ?? BUILTIN_PROVIDERS[BUILTIN_PROVIDERS.length - 1];
}

function normalizeUrl(u: string): string {
  return u.trim().toLowerCase().replace(/\/+$/, "");
}

export function detectProviderByBaseUrl(baseUrl: string): string {
  const normalized = normalizeUrl(baseUrl);
  if (!normalized) return "anthropic";
  for (const p of BUILTIN_PROVIDERS) {
    if (p.id === "custom") continue;
    if (normalizeUrl(p.baseUrl) === normalized) return p.id;
  }
  return "custom";
}

export interface ModelConfig {
  id: string;
  providerId: string;
  baseUrl: string;
  apiKey: string;
}

export function resolveModelCreds(
  modelId: string,
  models: ModelConfig[],
  fallbackKey: string,
  fallbackUrl: string,
): { apiKey: string; baseUrl: string } {
  const m = models.find((x) => x.id === modelId);
  if (m) {
    return {
      apiKey: m.apiKey || fallbackKey,
      baseUrl: m.baseUrl || fallbackUrl,
    };
  }
  return { apiKey: fallbackKey, baseUrl: fallbackUrl };
}
