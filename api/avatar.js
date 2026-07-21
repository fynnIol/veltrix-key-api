// api/avatar.js
// looks up a saved avatar ID, asks Roblox for a temporary render,
// and returns the raw image to the Discord bot

import { timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const ROBLOX_AVATAR_API = "https://avatar.roblox.com";
const MAX_ACCESSORIES = 8;
const RENDER_SIZE = "420x420";
const MAX_RENDER_ATTEMPTS = 22;
const POLL_DELAY_MS = 700;
const HEADLESS_HEAD_ID = 134082579;
const KORBLOX_RIGHT_LEG_ID = 139607718;

let cachedCsrfToken = "";
let cachedRobloxCookie = "";

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing"
    );
  }

  return createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

function constantTimeEquals(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue || ""));
  const right = Buffer.from(String(rightValue || ""));

  if (left.length !== right.length || left.length === 0) {
    return false;
  }

  return timingSafeEqual(left, right);
}

function isAuthorized(req) {
  const configuredKey = String(process.env.AVATAR_API_KEY || "");

  if (!configuredKey) {
    throw new Error(
      "AVATAR_API_KEY is missing from Vercel environment variables"
    );
  }

  return constantTimeEquals(
    req.headers["x-api-key"],
    configuredKey
  );
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, x-api-key"
  );
}

function normalizeCookie(rawCookie) {
  let cookie = String(rawCookie || "").trim();
  cookie = cookie.replace(/^\.ROBLOSECURITY\s*=\s*/i, "");

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
    throw new Error(
      "ROBLOX_COOKIE is missing from Vercel environment variables"
    );
  }

  return cookie;
}

function robloxCookieHeader() {
  return `.ROBLOSECURITY=${currentRobloxCookie()}`;
}

function captureRotatedCookie(response) {
  const headers =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);

  for (const header of headers) {
    const match = String(header).match(/\.ROBLOSECURITY=([^;]+)/i);

    if (match?.[1]) {
      const nextCookie = normalizeCookie(match[1]);

      if (nextCookie) {
        const changed = nextCookie !== currentRobloxCookie();
        cachedRobloxCookie = nextCookie;
        return changed;
      }
    }
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

function parseAvatarId(value) {
  const id = String(value || "").trim().toUpperCase();
  return /^AV-[A-Z0-9]{10}$/.test(id) ? id : null;
}

async function loadSavedAvatar(id) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("saved_avatars")
    .select(
      "id,user_id,accessories,headless,korblox,pose"
    )
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return null;
  }

  const accessories = Array.isArray(data.accessories)
    ? data.accessories
        .map(Number)
        .filter(
          (value, index, array) =>
            Number.isSafeInteger(value) &&
            value > 0 &&
            array.indexOf(value) === index
        )
        .slice(0, MAX_ACCESSORIES)
    : [];

  return {
    id: data.id,
    userId: Number(data.user_id),
    accessories,
    headless: data.headless === true,
    korblox: data.korblox === true,
    pose: typeof data.pose === "string" ? data.pose : "",
  };
}

async function getUserAvatar(userId) {
  const response = await fetch(
    `${ROBLOX_AVATAR_API}/v2/avatar/users/${userId}/avatar`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "VeltrixAvatarRenderer/2.0",
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
      robloxErrorMessage(
        data,
        `Could not load the avatar (HTTP ${response.status})`
      )
    );
  }

  return data;
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

function makeBodyColors(avatar) {
  const source = avatar?.bodyColor3s || avatar?.bodyColors || {};

  return {
    headColor: source.headColor3 || source.headColor || "#F5CBA7",
    torsoColor: source.torsoColor3 || source.torsoColor || "#F5CBA7",
    rightArmColor:
      source.rightArmColor3 || source.rightArmColor || "#F5CBA7",
    leftArmColor:
      source.leftArmColor3 || source.leftArmColor || "#F5CBA7",
    rightLegColor:
      source.rightLegColor3 || source.rightLegColor || "#F5CBA7",
    leftLegColor:
      source.leftLegColor3 || source.leftLegColor || "#F5CBA7",
  };
}

function getAvatarType(avatar) {
  if (typeof avatar?.playerAvatarType === "string") {
    return avatar.playerAvatarType;
  }

  if (
    typeof avatar?.playerAvatarType?.playerAvatarType === "string"
  ) {
    return avatar.playerAvatarType.playerAvatarType;
  }

  return "R15";
}

function normalizedAssetType(asset) {
  return String(
    asset?.assetType?.name || asset?.assetType || ""
  )
    .replace(/[\s_-]/g, "")
    .toLowerCase();
}

function makeAssets(avatar, recipe) {
  const baseAssets = Array.isArray(avatar?.assets)
    ? avatar.assets
    : [];
  const output = [];
  const seen = new Set();

  const addAsset = (id, meta) => {
    const numericId = Number(id);

    if (
      !Number.isSafeInteger(numericId) ||
      numericId <= 0 ||
      seen.has(numericId)
    ) {
      return;
    }

    const item = { id: numericId };

    if (meta && typeof meta === "object") {
      item.meta = meta;
    }

    output.push(item);
    seen.add(numericId);
  };

  for (const asset of baseAssets) {
    const type = normalizedAssetType(asset);

    if (
      recipe.headless &&
      (type === "head" || type === "dynamichead")
    ) {
      continue;
    }

    if (recipe.korblox && type === "rightleg") {
      continue;
    }

    addAsset(asset?.id, asset?.meta);
  }

  for (const id of recipe.accessories) {
    addAsset(id);
  }

  if (recipe.headless) {
    addAsset(HEADLESS_HEAD_ID);
  }

  if (recipe.korblox) {
    addAsset(KORBLOX_RIGHT_LEG_ID);
  }

  return output;
}

function makeRenderPayload(avatar, recipe) {
  return {
    thumbnailConfig: {
      thumbnailId:
        Math.floor(Math.random() * 2_000_000_000) + 1,
      size: RENDER_SIZE,
      thumbnailType: "2d",
    },
    avatarDefinition: {
      scales: makeScales(avatar),
      bodyColors: makeBodyColors(avatar),
      playerAvatarType: {
        playerAvatarType: getAvatarType(avatar),
      },
      assets: makeAssets(avatar, recipe),
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
    "User-Agent": "VeltrixAvatarRenderer/2.0",
  };

  if (cachedCsrfToken) {
    headers["x-csrf-token"] = cachedCsrfToken;
  }

  const response = await fetch(
    `${ROBLOX_AVATAR_API}/v1/avatar/render`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      cache: "no-store",
    }
  );

  const cookieRotated = captureRotatedCookie(response);

  if (
    response.status === 401 &&
    allowCookieRetry &&
    cookieRotated
  ) {
    cachedCsrfToken = "";
    return postRender(payload, allowCsrfRetry, false);
  }

  if (response.status === 403 && allowCsrfRetry) {
    const nextToken = response.headers.get("x-csrf-token");

    if (!nextToken) {
      const data = await readJson(response);
      throw new Error(
        robloxErrorMessage(
          data,
          "Roblox rejected the cookie and gave no CSRF token"
        )
      );
    }

    cachedCsrfToken = nextToken;
    return postRender(payload, false, allowCookieRetry);
  }

  const data = await readJson(response);

  if (!response.ok) {
    if (response.status === 403) {
      cachedCsrfToken = "";
    }

    throw new Error(
      robloxErrorMessage(
        data,
        `Render request failed (HTTP ${response.status})`
      )
    );
  }

  return data;
}

async function waitForCompletedRender(payload) {
  let lastState = "unknown";

  for (
    let attempt = 1;
    attempt <= MAX_RENDER_ATTEMPTS;
    attempt += 1
  ) {
    const result = await postRender(payload);
    const state = String(result?.state || "").toLowerCase();
    lastState = result?.state || "unknown";

    if (state === "completed" && result?.imageUrl) {
      return result.imageUrl;
    }

    if (state !== "pending" && state !== "inreview") {
      throw new Error(
        `Roblox render failed with state: ${lastState}`
      );
    }

    await sleep(POLL_DELAY_MS);
  }

  throw new Error(
    `Roblox render timed out with state: ${lastState}`
  );
}

async function downloadRenderedImage(imageUrl) {
  const parsedUrl = new URL(imageUrl);
  const hostname = parsedUrl.hostname.toLowerCase();

  if (
    parsedUrl.protocol !== "https:" ||
    !(
      hostname === "rbxcdn.com" ||
      hostname.endsWith(".rbxcdn.com")
    )
  ) {
    throw new Error("Roblox returned an unexpected image host");
  }

  const response = await fetch(parsedUrl, {
    method: "GET",
    headers: {
      Accept: "image/png,image/webp,image/jpeg,*/*",
      "User-Agent": "VeltrixAvatarRenderer/2.0",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(
      `Could not download the rendered image (HTTP ${response.status})`
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  if (!buffer.length) {
    throw new Error("Roblox returned an empty image");
  }

  return {
    buffer,
    contentType:
      response.headers.get("content-type") || "image/png",
  };
}

export default async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  try {
    if (!isAuthorized(req)) {
      return res.status(401).json({
        error: "Invalid or missing x-api-key",
      });
    }

    const avatarId = parseAvatarId(req.query.id);

    if (!avatarId) {
      return res.status(400).json({
        error: "A valid avatar ID is required",
      });
    }

    const recipe = await loadSavedAvatar(avatarId);

    if (!recipe) {
      return res.status(404).json({
        error: "Avatar ID not found",
      });
    }

    const avatar = await getUserAvatar(recipe.userId);
    const payload = makeRenderPayload(avatar, recipe);
    const imageUrl = await waitForCompletedRender(payload);
    const image = await downloadRenderedImage(imageUrl);

    res.setHeader("Content-Type", image.contentType);
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${avatarId}.png"`
    );
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Avatar-ID", avatarId);
    res.setHeader(
      "X-Avatar-Accessory-Count",
      String(recipe.accessories.length)
    );

    if (recipe.pose) {
      res.setHeader("X-Avatar-Pose", "stored-but-not-rendered");
    }

    return res.status(200).send(image.buffer);
  } catch (error) {
    console.error("avatar render error", error);

    const message = String(error?.message || error || "Unknown error");

    if (
      message.includes("ROBLOX_COOKIE") ||
      message.includes("AVATAR_API_KEY") ||
      message.includes("SUPABASE_")
    ) {
      return res.status(500).json({
        error: message,
      });
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
