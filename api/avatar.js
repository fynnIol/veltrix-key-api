// api/avatar.js
// Vercel serverless function for rendering a temporary Roblox avatar thumbnail.
//
// Required Vercel environment variables:
//   ROBLOX_COOKIE   = only the value of your .ROBLOSECURITY cookie
//   AVATAR_API_KEY  = a private key sent by your Discord bot/executor in x-api-key
//
// Request example:
//   GET /api/avatar?userId=11308770201&accessories=123,456
//   Header: x-api-key: YOUR_PRIVATE_KEY

const ROBLOX_AVATAR_API = "https://avatar.roblox.com";
const MAX_EXTRA_ASSETS = 8;
const RENDER_SIZE = "420x420";
const MAX_RENDER_ATTEMPTS = 25;
const POLL_DELAY_MS = 900;

// Reused while the Vercel function instance stays warm.
let cachedCsrfToken = "";
let cachedRobloxCookie = "";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function firstValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function parsePositiveInteger(value) {
  const text = String(firstValue(value) ?? "").trim();

  if (!/^\d+$/.test(text)) {
    return null;
  }

  const number = Number(text);

  if (!Number.isSafeInteger(number) || number <= 0) {
    return null;
  }

  return number;
}

function parseAccessoryIds(value) {
  const matches = String(firstValue(value) ?? "").match(/\d+/g) ?? [];
  const uniqueIds = [];

  for (const match of matches) {
    const id = Number(match);

    if (!Number.isSafeInteger(id) || id <= 0 || uniqueIds.includes(id)) {
      continue;
    }

    uniqueIds.push(id);

    if (uniqueIds.length >= MAX_EXTRA_ASSETS) {
      break;
    }
  }

  return uniqueIds;
}

function normalizeCookie(rawCookie) {
  let cookie = String(rawCookie ?? "").trim();

  // Allows either the raw value or `.ROBLOSECURITY=value` to be pasted.
  cookie = cookie.replace(/^\.ROBLOSECURITY\s*=\s*/i, "");

  // Removes an accidental Cookie-header suffix.
  const semicolonIndex = cookie.indexOf(";");
  if (semicolonIndex !== -1) {
    cookie = cookie.slice(0, semicolonIndex).trim();
  }

  return cookie;
}

function currentRobloxCookie() {
  const cookie = normalizeCookie(
    cachedRobloxCookie || process.env.ROBLOX_COOKIE
  );

  if (!cookie) {
    throw new Error("ROBLOX_COOKIE is missing from Vercel environment variables");
  }

  return cookie;
}

function robloxCookieHeader() {
  return `.ROBLOSECURITY=${currentRobloxCookie()}`;
}

function captureRotatedRobloxCookie(response) {
  const setCookieHeaders =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);

  for (const header of setCookieHeaders) {
    const match = String(header).match(/\.ROBLOSECURITY=([^;]+)/i);

    if (!match?.[1]) {
      continue;
    }

    const rotatedCookie = normalizeCookie(match[1]);

    if (!rotatedCookie) {
      continue;
    }

    const changed = rotatedCookie !== currentRobloxCookie();
    cachedRobloxCookie = rotatedCookie;
    return changed;
  }

  return false;
}

async function readJson(response) {
  const text = await response.text();

  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `Roblox returned unreadable JSON (HTTP ${response.status}): ${text.slice(0, 250)}`
    );
  }
}

function robloxErrorMessage(data, fallback) {
  return (
    data?.errors?.[0]?.message ||
    data?.message ||
    data?.error ||
    fallback
  );
}

async function getUserAvatar(userId) {
  const response = await fetch(
    `${ROBLOX_AVATAR_API}/v2/avatar/users/${userId}/avatar`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "VeltrixAvatarRenderer/1.1",
      },
      cache: "no-store",
    }
  );

  const data = await readJson(response);

  if (response.status === 404) {
    throw new Error("That Roblox user ID does not exist");
  }

  if (!response.ok) {
    throw new Error(
      robloxErrorMessage(data, `Could not load the avatar (HTTP ${response.status})`)
    );
  }

  return data;
}

function makeBodyColors(avatar) {
  const source = avatar?.bodyColor3s || avatar?.bodyColors || {};

  return {
    headColor: source.headColor3 || source.headColor || "#f5cba7",
    torsoColor: source.torsoColor3 || source.torsoColor || "#f5cba7",
    rightArmColor:
      source.rightArmColor3 || source.rightArmColor || "#f5cba7",
    leftArmColor: source.leftArmColor3 || source.leftArmColor || "#f5cba7",
    rightLegColor:
      source.rightLegColor3 || source.rightLegColor || "#f5cba7",
    leftLegColor: source.leftLegColor3 || source.leftLegColor || "#f5cba7",
  };
}

function safeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function makeScales(avatar) {
  const source = avatar?.scales || {};

  return {
    head: safeNumber(source.head, 1),
    height: safeNumber(source.height, 1),
    bodyType: safeNumber(source.bodyType, 0),
    width: safeNumber(source.width, 1),
    depth: safeNumber(source.depth, 1),
    proportion: safeNumber(source.proportion, 0),
  };
}

function makeAssets(avatar, extraAssetIds) {
  const baseAssets = Array.isArray(avatar?.assets) ? avatar.assets : [];
  const assets = [];
  const seen = new Set();

  for (const asset of baseAssets) {
    const id = Number(asset?.id);

    if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id)) {
      continue;
    }

    const output = { id };

    // Layered clothing can rely on metadata such as order and puffiness.
    if (asset.meta && typeof asset.meta === "object") {
      output.meta = asset.meta;
    }

    assets.push(output);
    seen.add(id);
  }

  for (const id of extraAssetIds) {
    if (!seen.has(id)) {
      assets.push({ id });
      seen.add(id);
    }
  }

  return assets;
}

function getAvatarType(avatar) {
  if (typeof avatar?.playerAvatarType === "string") {
    return avatar.playerAvatarType;
  }

  if (typeof avatar?.playerAvatarType?.playerAvatarType === "string") {
    return avatar.playerAvatarType.playerAvatarType;
  }

  return "R15";
}

function makeRenderPayload(avatar, extraAssetIds) {
  // Keep this stable across polling attempts so Roblox checks the same render job.
  const thumbnailId = Math.floor(Math.random() * 2_000_000_000) + 1;

  return {
    thumbnailConfig: {
      thumbnailId,
      size: RENDER_SIZE,
      thumbnailType: "2d",
    },
    avatarDefinition: {
      scales: makeScales(avatar),
      bodyColors: makeBodyColors(avatar),
      playerAvatarType: {
        playerAvatarType: getAvatarType(avatar),
      },
      assets: makeAssets(avatar, extraAssetIds),
    },
  };
}

async function postRender(
  payload,
  allowCsrfRetry = true,
  allowCookieRetry = true
) {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Cookie: robloxCookieHeader(),
    "User-Agent": "VeltrixAvatarRenderer/1.1",
  };

  if (cachedCsrfToken) {
    headers["x-csrf-token"] = cachedCsrfToken;
  }

  const response = await fetch(`${ROBLOX_AVATAR_API}/v1/avatar/render`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    cache: "no-store",
  });

  const cookieRotated = captureRotatedRobloxCookie(response);

  // Roblox can rotate .ROBLOSECURITY through Set-Cookie.
  if (response.status === 401 && allowCookieRetry && cookieRotated) {
    cachedCsrfToken = "";
    return postRender(payload, allowCsrfRetry, false);
  }

  if (response.status === 403 && allowCsrfRetry) {
    const newToken = response.headers.get("x-csrf-token");

    if (!newToken) {
      const data = await readJson(response);
      throw new Error(
        robloxErrorMessage(data, "Roblox rejected the cookie and gave no CSRF token")
      );
    }

    cachedCsrfToken = newToken;
    return postRender(payload, false, allowCookieRetry);
  }

  const data = await readJson(response);

  if (!response.ok) {
    // The token may have expired while the function instance was warm.
    if (response.status === 403) {
      cachedCsrfToken = "";
    }

    throw new Error(
      robloxErrorMessage(data, `Render request failed (HTTP ${response.status})`)
    );
  }

  return data;
}

async function waitForCompletedRender(payload) {
  let lastResult = null;

  for (let attempt = 1; attempt <= MAX_RENDER_ATTEMPTS; attempt += 1) {
    lastResult = await postRender(payload);

    if (lastResult?.state === "Completed" && lastResult?.imageUrl) {
      return lastResult.imageUrl;
    }

    if (!["Pending", "InReview"].includes(lastResult?.state)) {
      throw new Error(
        `Roblox render failed with state: ${lastResult?.state || "unknown"}`
      );
    }

    await sleep(POLL_DELAY_MS);
  }

  throw new Error(
    `Roblox render timed out after ${MAX_RENDER_ATTEMPTS} attempts`
  );
}

async function downloadRenderedImage(imageUrl) {
  const parsedUrl = new URL(imageUrl);

  // Prevents Roblox from making the backend fetch an arbitrary website.
  if (
    parsedUrl.protocol !== "https:" ||
    !parsedUrl.hostname.toLowerCase().endsWith("rbxcdn.com")
  ) {
    throw new Error("Roblox returned an unexpected image host");
  }

  const response = await fetch(parsedUrl, {
    method: "GET",
    headers: {
      Accept: "image/png,image/webp,image/jpeg,*/*",
      "User-Agent": "VeltrixAvatarRenderer/1.1",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Could not download the rendered image (HTTP ${response.status})`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  if (!buffer.length) {
    throw new Error("Roblox returned an empty image");
  }

  return {
    buffer,
    contentType: response.headers.get("content-type") || "image/png",
  };
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key");
}

function isAuthorized(req) {
  const configuredKey = String(process.env.AVATAR_API_KEY || "");

  // Refuse to run publicly if the owner forgot to configure a key.
  if (!configuredKey) {
    throw new Error("AVATAR_API_KEY is missing from Vercel environment variables");
  }

  const suppliedKey = String(req.headers["x-api-key"] || "");
  return suppliedKey.length > 0 && suppliedKey === configuredKey;
}

export default async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    if (!isAuthorized(req)) {
      return res.status(401).json({ error: "Invalid or missing x-api-key" });
    }

    const userId = parsePositiveInteger(req.query.userId ?? req.query.userid);

    if (!userId) {
      return res.status(400).json({
        error: "A valid userId query parameter is required",
      });
    }

    const accessoryIds = parseAccessoryIds(
      req.query.accessories ?? req.query.assets
    );

    const avatar = await getUserAvatar(userId);
    const payload = makeRenderPayload(avatar, accessoryIds);
    const imageUrl = await waitForCompletedRender(payload);
    const image = await downloadRenderedImage(imageUrl);

    res.setHeader("Content-Type", image.contentType);
    res.setHeader(
      "Content-Disposition",
      `inline; filename="avatar-${userId}.png"`
    );
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Avatar-Accessory-Count", String(accessoryIds.length));

    // The temporary render endpoint does not have a confirmed pose field.
    if (firstValue(req.query.pose)) {
      res.setHeader("X-Avatar-Pose", "ignored");
    }

    return res.status(200).send(image.buffer);
  } catch (error) {
    console.error("avatar render error", error);

    const message = String(error?.message || error || "Unknown error");

    if (message.includes("ROBLOX_COOKIE") || message.includes("AVATAR_API_KEY")) {
      return res.status(500).json({ error: message });
    }

    if (
      message.toLowerCase().includes("cookie") ||
      message.toLowerCase().includes("csrf") ||
      message.toLowerCase().includes("authorization")
    ) {
      return res.status(502).json({
        error: "Roblox authentication failed",
        details: message,
      });
    }

    return res.status(502).json({
      error: "Avatar rendering failed",
      details: message,
    });
  }
}
