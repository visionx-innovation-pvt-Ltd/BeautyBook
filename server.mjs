import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(PROJECT_ROOT, "web");
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_JSON_BYTES = Math.ceil(MAX_IMAGE_BYTES * 1.4) + 4096;
const GENERATION_LIMIT = 3;
const GENERATION_WINDOW_MS = 60_000;
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".task": "application/octet-stream",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".webp": "image/webp",
};

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_JSON_BYTES) {
      const error = new Error("REQUEST_TOO_LARGE");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (cause) {
    const error = new Error("INVALID_JSON", { cause });
    error.statusCode = 400;
    throw error;
  }
}

function parseImageDataUrl(value) {
  if (typeof value !== "string") throw new Error("INVALID_IMAGE");
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw new Error("INVALID_IMAGE");
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString("base64") !== match[2]) {
    throw new Error("INVALID_IMAGE");
  }

  const validSignature = match[1] === "image/jpeg"
    ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : match[1] === "image/png"
      ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" &&
        bytes.toString("ascii", 8, 12) === "WEBP";

  if (!validSignature) throw new Error("INVALID_IMAGE");
  return { bytes, mimeType: match[1] };
}

function makePrompt(styleName, hairTexture, hairLength) {
  return [
    "Create a photorealistic hairstyle try-on by editing the supplied portrait.",
    `Apply this haircut or hairstyle: ${JSON.stringify(styleName)}.`,
    hairTexture !== "any" ? `Respect this hair texture preference: ${hairTexture}.` : "",
    hairLength !== "any" ? `Make the requested hairstyle ${hairLength} in length.` : "",
    "Change only the person's hair. Preserve the exact same person and identity, face, facial features, expression, skin tone, age, clothing, pose, camera framing, lighting, and background.",
    "Make the hairstyle look naturally attached to the person's head and consistent with the original hairline and image lighting.",
    "Do not add text, accessories, extra people, or beauty retouching. The person may be any gender; do not change their gender presentation.",
  ].join(" ");
}

function getClientAddress(request) {
  return request.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    request.socket.remoteAddress || "unknown";
}

function isRateLimited(request, generationRequests, now = Date.now()) {
  const client = getClientAddress(request);
  const current = generationRequests.get(client);
  if (!current || now - current.startedAt >= GENERATION_WINDOW_MS) {
    generationRequests.set(client, { startedAt: now, count: 1 });
    if (generationRequests.size > 10_000) {
      for (const [key, entry] of generationRequests) {
        if (now - entry.startedAt >= GENERATION_WINDOW_MS) generationRequests.delete(key);
      }
    }
    return false;
  }
  if (current.count >= GENERATION_LIMIT) return true;
  current.count += 1;
  return false;
}

async function generateHairstyle(request, response, { apiKey, fetchImpl, isRateLimited }) {
  if (isRateLimited(request)) {
    sendJson(response, 429, { error: "RATE_LIMITED" });
    return;
  }
  if (!apiKey) {
    sendJson(response, 503, { error: "AI_NOT_CONFIGURED" });
    return;
  }

  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    sendJson(response, error.statusCode || 400, { error: error.message });
    return;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    sendJson(response, 400, { error: "INVALID_REQUEST" });
    return;
  }

  let image;
  try {
    image = parseImageDataUrl(body.image);
  } catch {
    sendJson(response, 400, { error: "INVALID_IMAGE" });
    return;
  }
  if (typeof body.styleName !== "string" || !body.styleName.trim() || body.styleName.length > 120) {
    sendJson(response, 400, { error: "INVALID_STYLE" });
    return;
  }
  if (!["any", "straight", "wavy", "curly", "coily"].includes(body.hairTexture) ||
      !["any", "short", "medium", "long"].includes(body.hairLength)) {
    sendJson(response, 400, { error: "INVALID_PREFERENCES" });
    return;
  }

  const form = new FormData();
  form.set("model", process.env.OPENAI_IMAGE_MODEL || "gpt-image-1");
  form.set("prompt", makePrompt(body.styleName.trim(), body.hairTexture, body.hairLength));
  if (!["1024x1024", "1536x1024", "1024x1536"].includes(body.imageSize)) {
    sendJson(response, 400, { error: "INVALID_IMAGE_SIZE" });
    return;
  }
  form.set("size", body.imageSize);
  form.set("quality", "medium");
  form.append("image[]", new Blob([image.bytes], { type: image.mimeType }), `portrait.${image.mimeType.split("/")[1]}`);

  let providerResponse;
  try {
    providerResponse = await fetchImpl("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    console.error("Hairstyle image provider request failed.", error.message);
    sendJson(response, 502, { error: "AI_PROVIDER_UNAVAILABLE" });
    return;
  }

  if (!providerResponse.ok) {
    console.error("Hairstyle image provider returned HTTP", providerResponse.status);
    sendJson(response, 502, { error: "AI_PROVIDER_FAILED" });
    return;
  }

  let result;
  try {
    result = await providerResponse.json();
  } catch (error) {
    console.error("Hairstyle image provider returned invalid JSON.", error.message);
    sendJson(response, 502, { error: "AI_PROVIDER_INVALID_RESPONSE" });
    return;
  }
  const encodedImage = result?.data?.[0]?.b64_json;
  if (typeof encodedImage !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(encodedImage)) {
    sendJson(response, 502, { error: "AI_PROVIDER_INVALID_RESPONSE" });
    return;
  }
  sendJson(response, 200, { image: `data:image/png;base64,${encodedImage}` });
}

async function serveStatic(request, response, pathname) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end();
    return;
  }

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    response.writeHead(400);
    response.end();
    return;
  }
  const requestedPath = decodedPath === "/" ? "/index.html" : decodedPath;
  const filePath = path.resolve(WEB_ROOT, `.${requestedPath.replaceAll("/", path.sep)}`);
  const relativePath = path.relative(WEB_ROOT, filePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    response.writeHead(404);
    response.end();
    return;
  }

  let fileInfo;
  try {
    fileInfo = await stat(filePath);
  } catch {
    response.writeHead(404);
    response.end();
    return;
  }
  if (!fileInfo.isFile()) {
    response.writeHead(404);
    response.end();
    return;
  }

  response.writeHead(200, {
    "Cache-Control": path.extname(filePath) === ".html" ? "no-cache" : "public, max-age=3600",
    "Content-Length": fileInfo.size,
    "Content-Type": MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
  });
  if (request.method === "HEAD") response.end();
  else createReadStream(filePath).pipe(response);
}

export function createAppServer({ apiKey = process.env.OPENAI_API_KEY, fetchImpl = fetch } = {}) {
  const generationRequests = new Map();
  const checkRateLimit = (request) => isRateLimited(request, generationRequests);
  return createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/healthz" && request.method === "GET") {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (url.pathname === "/api/generate-hairstyle") {
      if (request.method !== "POST") {
        sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
        return;
      }
      const origin = request.headers.origin;
      if (origin) {
        try {
          if (new URL(origin).host !== request.headers.host) {
            sendJson(response, 403, { error: "ORIGIN_NOT_ALLOWED" });
            return;
          }
        } catch {
          sendJson(response, 403, { error: "ORIGIN_NOT_ALLOWED" });
          return;
        }
      }
      if (!request.headers["content-type"]?.startsWith("application/json")) {
        sendJson(response, 415, { error: "UNSUPPORTED_MEDIA_TYPE" });
        return;
      }
      if (Number(request.headers["content-length"] || 0) > MAX_JSON_BYTES) {
        sendJson(response, 413, { error: "REQUEST_TOO_LARGE" });
        request.resume();
        return;
      }
      await generateHairstyle(request, response, {
        apiKey,
        fetchImpl,
        isRateLimited: checkRateLimit,
      });
      return;
    }
    await serveStatic(request, response, url.pathname);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 8765);
  const host = process.env.HOST || "127.0.0.1";
  const server = createAppServer();
  console.log(`BeautyBook starting at http://${host}:${port}`);
  server.listen(port, host, () => {
    console.log(`BeautyBook listening at http://${host}:${port}`);
    if (!process.env.OPENAI_API_KEY) {
      console.warn("Hairstyle generation is disabled until OPENAI_API_KEY is configured.");
    }
  });
}
