import { env } from "cloudflare:workers";
import { createHash } from "node:crypto";

type ProviderId = "qcc" | "tyc";
type VendorSecrets = { QCC_APP_KEY?: string; QCC_SECRET_KEY?: string; TYC_TOKEN?: string };

const responseHeaders = { "Cache-Control": "no-store" };
const TIMEOUT_MS = 12_000;

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
  let body: { providerId?: unknown; keyword?: unknown };
  try {
    body = await readSmallBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("INVALID_BODY");
  } catch {
    return json({ error: "INVALID_JSON", message: "请提供有效的厂商与企业查询 JSON，内容不超过 8 KB。" }, 400);
  }
  if (body.providerId !== "qcc" && body.providerId !== "tyc") {
    return json({ error: "INVALID_PROVIDER", message: "仅支持企查查（qcc）或天眼查（tyc）。" }, 400);
  }
  const providerId = body.providerId;
  const keyword = typeof body.keyword === "string" ? body.keyword.trim() : "";
  if (!keyword || keyword.length > 200 || /[\u0000-\u001f\u007f]/.test(keyword)) {
    return failure(providerId, "INVALID_KEYWORD", "请输入企业全称或统一社会信用代码，长度不能超过 200 字符。", 400);
  }
  const secrets = serverSecrets();
  if (!configured(secrets, providerId)) {
    return failure(providerId, "CREDENTIALS_NOT_CONFIGURED",
      providerId === "qcc"
        ? "尚未配置企查查服务端凭证 QCC_APP_KEY 与 QCC_SECRET_KEY，本次未调用厂商接口。"
        : "尚未配置天眼查服务端凭证 TYC_TOKEN，本次未调用厂商接口。", 412);
  }

  // Only fixed official, read-only business-information endpoints are callable.
  const url = new URL(providerId === "qcc"
    ? "https://api.qichacha.com/ECIV4/GetBasicDetailsByName"
    : "https://open.api.tianyancha.com/services/v4/open/baseinfoV3");
  url.searchParams.set("keyword", keyword);
  const headers = new Headers({ Accept: "application/json" });
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
    return json({ record, providerId, collectedAt: new Date().toISOString() });
  } catch {
    return failure(providerId, controller.signal.aborted ? "VENDOR_TIMEOUT" : "VENDOR_NETWORK_ERROR",
      controller.signal.aborted ? "厂商接口响应超时，请稍后重试。" : "暂时无法连接厂商接口，请稍后重试。",
      controller.signal.aborted ? 504 : 502);
  } finally {
    clearTimeout(timeout);
  }
}
