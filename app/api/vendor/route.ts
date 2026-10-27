import { env } from "cloudflare:workers";
import { createHash } from "node:crypto";

type ProviderId = "qcc" | "tyc";
type VendorSecrets = { QCC_APP_KEY?: string; QCC_SECRET_KEY?: string; TYC_TOKEN?: string };
type Scalar = string | number | boolean | null;
type ParameterConfig = { query: Record<string, Scalar>; headers: Record<string, Scalar>; body: Record<string, Scalar> };
type RequestConfig = { baseUrl?: unknown; method?: unknown; responsePath?: unknown };

const responseHeaders = { "Cache-Control": "no-store" };
const TIMEOUT_MS = 12_000;
const officialEndpoints: Record<ProviderId, string> = {
  qcc: "https://api.qichacha.com/ECIV4/GetBasicDetailsByName",
  tyc: "https://open.api.tianyancha.com/services/v4/open/baseinfoV3",
};
// Authentication and transport headers belong to the server, never the connector editor.
const reservedNames = new Set([
  "key", "token", "timespan", "authorization", "proxyauthorization", "host", "cookie", "setcookie",
  "appkey", "secretkey", "apikey", "accesstoken", "secret", "password", "xapikey", "xauthtoken",
  "connection", "contentlength", "transferencoding", "forwarded", "xforwardedhost", "xforwardedfor",
  "__proto__", "prototype", "constructor",
]);

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: responseHeaders });
}

function serverSecrets(): VendorSecrets {
  const bindings = env as Cloudflare.Env & VendorSecrets;
  // Wrangler secrets in hosted mode; server process environment in local development.
  return {
    QCC_APP_KEY: bindings.QCC_APP_KEY ?? process.env.QCC_APP_KEY,
    QCC_SECRET_KEY: bindings.QCC_SECRET_KEY ?? process.env.QCC_SECRET_KEY,
    TYC_TOKEN: bindings.TYC_TOKEN ?? process.env.TYC_TOKEN,
  };
}

function configured(secrets: VendorSecrets, providerId: ProviderId) {
  return providerId === "qcc"
    ? Boolean(secrets.QCC_APP_KEY?.trim() && secrets.QCC_SECRET_KEY?.trim())
    : Boolean(secrets.TYC_TOKEN?.trim());
}

function failure(providerId: ProviderId, error: string, message: string, status: number) {
  return json({ error, message, providerId }, status);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validateRequestConfig(value: unknown, providerId: ProviderId) {
  if (value === undefined) return;
  if (!isObject(value)) throw new Error("API 配置须为对象。");
  const config = value as RequestConfig;
  if (config.method !== undefined && (typeof config.method !== "string" || config.method.toUpperCase() !== "GET")) {
    throw new Error("该厂商服务端适配器仅支持 GET 工商基础信息查询，请将请求方法改为 GET。");
  }
  if (config.baseUrl !== undefined && config.baseUrl !== officialEndpoints[providerId]) {
    throw new Error("配置的 API 地址与已实现的官方接口不匹配；当前仅支持 " + officialEndpoints[providerId] + "。其他接口须增加服务端适配器。");
  }
  if (config.responsePath !== undefined) {
    if (typeof config.responsePath !== "string") throw new Error("返回记录根路径须为字符串。");
    const path = config.responsePath.trim().replace(/^\$\./, "");
    if (path !== "" && path !== "$" && path.split(".").some(part => !part || /[\[\]{}*\s]/u.test(part) || ["__proto__", "prototype", "constructor"].includes(part))) {
      throw new Error("返回记录根路径须使用点路径，不支持表达式或通配符。");
    }
  }
}

function readParameters(value: unknown): ParameterConfig {
  const result: ParameterConfig = { query: {}, headers: {}, body: {} };
  if (value === undefined) return result;
  if (!isObject(value)) throw new Error("请求参数须为 query、headers、body 组成的对象。");
  if (Object.keys(value).some(key => !["query", "headers", "body"].includes(key))) throw new Error("请求参数位置仅支持 query、headers、body。");
  let count = 0;
  for (const location of ["query", "headers", "body"] as const) {
    const values = value[location];
    if (values === undefined) continue;
    if (!isObject(values)) throw new Error(location + " 参数须为对象。");
    const names = new Set<string>();
    for (const [name, parameter] of Object.entries(values)) {
      count++;
      if (count > 40) throw new Error("请求参数总数不能超过 40 个。");
      if (!name || name !== name.trim() || name.length > 128 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error("参数名称为空、过长或包含非法字符。");
      if (location === "headers" && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new Error("Header 参数名称须为有效的 HTTP 字段名。");
      const normalized = name.toLowerCase().replace(/[-_]/g, "");
      if (reservedNames.has(normalized) || ["__proto__", "prototype", "constructor"].includes(name.toLowerCase())) {
        throw new Error("参数 " + name + " 为服务端保留鉴权或传输字段，请使用服务端凭证配置，不要在页面传入。");
      }
      const duplicate = location === "headers" ? name.toLowerCase() : name;
      if (names.has(duplicate)) throw new Error("参数名称重复：" + location + "." + name + "。");
      names.add(duplicate);
      if (parameter !== null && !["string", "number", "boolean"].includes(typeof parameter)) throw new Error("参数 " + name + " 仅支持字符串、数值、布尔值或空值。");
      if (typeof parameter === "number" && !Number.isFinite(parameter)) throw new Error("参数 " + name + " 必须为有限数值。");
      if (String(parameter ?? "").length > 2048 || /[\u0000-\u001f\u007f]/.test(String(parameter ?? ""))) throw new Error("参数 " + name + " 取值不能超过 2048 字符或包含控制字符。");
      result[location][name] = parameter as Scalar;
    }
  }
  if (Object.keys(result.body).length) throw new Error("当前官方适配器仅支持 GET，请清空 Body 参数；其他方法须增加服务端适配器。");
  if (Object.prototype.hasOwnProperty.call(result.query, "keyword")) {
    const keyword = result.query.keyword;
    if (typeof keyword !== "string" || !keyword.trim() || keyword.length > 200) throw new Error("Query 参数 keyword 须为企业全称或信用代码，长度为 1 至 200 字符。");
  }
  return result;
}

async function readSmallBody(request: Request) {
  if (!request.body) throw new Error("EMPTY_BODY");
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let value = "";
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 8192) {
        await reader.cancel();
        throw new Error("BODY_TOO_LARGE");
      }
      value += decoder.decode(part.value, { stream: true });
    }
    return JSON.parse(value + decoder.decode());
  } finally {
    reader.releaseLock();
  }
}

export async function GET() {
  const secrets = serverSecrets();
  return json({ providers: {
    qcc: { configured: configured(secrets, "qcc") },
    tyc: { configured: configured(secrets, "tyc") },
  } });
}

export async function POST(request: Request) {
  let body: { providerId?: unknown; keyword?: unknown; parameters?: unknown; config?: unknown };
  try {
    body = await readSmallBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("INVALID_BODY");
  } catch {
    return json({ error: "INVALID_JSON", message: "请提供有效的厂商与企业查询 JSON，内容不超过 8 KB。" }, 400);
  }
  if (body.providerId !== "qcc" && body.providerId !== "tyc") {
    return json({ error: "ADAPTER_NOT_IMPLEMENTED", message: "该信源尚未实现真实 API 服务端适配器，当前可使用演示响应验证入参及字段映射；真实接入需按厂商授权文档增加服务端适配，本次未发送请求。", providerId: body.providerId ?? null }, 501);
  }
  const providerId = body.providerId;
  const keyword = typeof body.keyword === "string" ? body.keyword.trim() : "";
  if (!keyword || keyword.length > 200 || /[\u0000-\u001f\u007f]/.test(keyword)) {
    return failure(providerId, "INVALID_KEYWORD", "请输入企业全称或统一社会信用代码，长度不能超过 200 字符。", 400);
  }
  let parameters: ParameterConfig;
  try {
    validateRequestConfig(body.config, providerId);
    parameters = readParameters(body.parameters);
  } catch (error) {
    return failure(providerId, "INVALID_REQUEST_CONFIG", error instanceof Error ? error.message : "API 配置不正确。", 400);
  }
  const secrets = serverSecrets();
  if (!configured(secrets, providerId)) {
    return failure(providerId, "CREDENTIALS_NOT_CONFIGURED",
      providerId === "qcc"
        ? "尚未配置企查查服务端凭证 QCC_APP_KEY 与 QCC_SECRET_KEY，本次未调用厂商接口。"
        : "尚未配置天眼查服务端凭证 TYC_TOKEN，本次未调用厂商接口。", 412);
  }

  // Only fixed official, read-only business-information endpoints are callable.
  const url = new URL(officialEndpoints[providerId]);
  url.searchParams.set("keyword", keyword);
  for (const [name, value] of Object.entries(parameters.query)) url.searchParams.set(name, String(value ?? ""));
  const headers = new Headers({ Accept: "application/json" });
  for (const [name, value] of Object.entries(parameters.headers)) headers.set(name, String(value ?? ""));
  if (providerId === "qcc") {
    const timespan = String(Math.floor(Date.now() / 1000));
    url.searchParams.set("key", secrets.QCC_APP_KEY!);
    headers.set("Timespan", timespan);
    headers.set("Token", createHash("md5")
      .update(secrets.QCC_APP_KEY! + timespan + secrets.QCC_SECRET_KEY!)
      .digest("hex").toUpperCase());
  } else {
    headers.set("Authorization", secrets.TYC_TOKEN!);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET", headers, signal: controller.signal, redirect: "error", cache: "no-store",
    });
    if (!response.ok) {
      return failure(providerId, response.status === 429 ? "VENDOR_RATE_LIMIT" : "VENDOR_HTTP_ERROR",
        response.status === 429 ? "厂商调用频率受限，请稍后重试。" : "厂商接口请求失败，请检查接口开通状态后重试。", 502);
    }
    let data: Record<string, unknown>;
    try {
      data = await response.json();
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("INVALID_RESPONSE");
    } catch {
      if (controller.signal.aborted) throw new Error("VENDOR_TIMEOUT");
      return failure(providerId, "VENDOR_INVALID_RESPONSE", "厂商未返回有效的 JSON 数据。", 502);
    }
    const success = providerId === "qcc" ? String(data.Status) === "200" : String(data.error_code) === "0";
    const reason = String(providerId === "qcc" ? data.Message ?? "" : data.reason ?? "");
    const record = providerId === "qcc" ? data.Result : data.result;
    if (!success) {
      const noData = (providerId === "qcc" && String(data.Status) === "201")
        || /无结果|无记录|未查询到|查询无|not.?found|no.?data/i.test(reason);
      return failure(providerId, noData ? "VENDOR_NOT_FOUND" : "VENDOR_BUSINESS_ERROR",
        noData ? "厂商未查到该企业，请核对企业全称或统一社会信用代码。" : "厂商返回业务错误，请检查接口权限、余额与查询条件。", noData ? 404 : 502);
    }
    if (!record || typeof record !== "object" || Object.keys(record).length === 0) {
      return failure(providerId, "VENDOR_NOT_FOUND", "厂商未返回企业记录，请核对企业全称或统一社会信用代码。", 404);
    }
    return json({ record, vendorResponse: data, providerId, collectedAt: new Date().toISOString() });
  } catch {
    return failure(providerId, controller.signal.aborted ? "VENDOR_TIMEOUT" : "VENDOR_NETWORK_ERROR",
      controller.signal.aborted ? "厂商接口响应超时，请稍后重试。" : "暂时无法连接厂商接口，请稍后重试。",
      controller.signal.aborted ? 504 : 502);
  } finally {
    clearTimeout(timeout);
  }
}
