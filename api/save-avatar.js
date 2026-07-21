// api/save-avatar.js
// saves an avatar recipe and returns a short ID such as AV-A1B2C3D4E5

import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const MAX_ACCESSORIES = 8;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 20;
const rateBuckets = new Map();

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
  const configuredKey = String(process.env.AVATAR_SAVE_KEY || "");

  if (!configuredKey) {
    throw new Error(
      "AVATAR_SAVE_KEY is missing from Vercel environment variables"
    );
  }

  return constantTimeEquals(
    req.headers["x-save-key"],
    configuredKey
  );
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, x-save-key"
  );
  res.setHeader("Cache-Control", "no-store");
}

function getClientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "");
  return forwarded.split(",")[0].trim() || req.socket?.remoteAddress || "unknown";
}

function passRateLimit(req) {
  const key = getClientIp(req);
  const now = Date.now();
  const current = rateBuckets.get(key);

  if (!current || now - current.startedAt >= RATE_WINDOW_MS) {
    rateBuckets.set(key, {
      startedAt: now,
      count: 1,
    });
    return true;
  }

  current.count += 1;
  return current.count <= RATE_LIMIT;
}

function parseBody(req) {
  if (req.body && typeof req.body === "object") {
    return req.body;
  }

  if (typeof req.body === "string" && req.body.trim()) {
    try {
      return JSON.parse(req.body);
    } catch {
      return null;
    }
  }

  return null;
}

function parsePositiveInteger(value) {
  const number = Number(value);

  if (!Number.isSafeInteger(number) || number <= 0) {
    return null;
  }

  return number;
}

function parseAccessories(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const output = [];

  for (const rawValue of value) {
    const id = parsePositiveInteger(rawValue);

    if (id && !output.includes(id)) {
      output.push(id);
    }
  }

  return output;
}

function cleanPose(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().slice(0, 100);
}

function makeRecipe(body) {
  const userId = parsePositiveInteger(body?.userId);
  const accessories = parseAccessories(body?.accessories);

  if (!userId) {
    throw new Error("A valid userId is required");
  }

  if (accessories.length > MAX_ACCESSORIES) {
    throw new Error("You can save up to 8 accessories");
  }

  return {
    userId,
    accessories,
    headless: body?.headless === true,
    korblox: body?.korblox === true,
    pose: cleanPose(body?.pose),
  };
}

function makeRecipeHash(recipe) {
  return createHash("sha256")
    .update(JSON.stringify(recipe))
    .digest("hex");
}

function makeAvatarId() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(10);
  let output = "AV-";

  for (let index = 0; index < 10; index += 1) {
    output += alphabet[bytes[index] % alphabet.length];
  }

  return output;
}

async function findExistingRecipe(supabase, recipeHash) {
  const { data, error } = await supabase
    .from("saved_avatars")
    .select("id")
    .eq("recipe_hash", recipeHash)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data?.id || null;
}

async function touchRecipe(supabase, id) {
  const { error } = await supabase
    .from("saved_avatars")
    .update({
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) {
    throw error;
  }
}

async function insertRecipe(supabase, recipe, recipeHash) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const id = makeAvatarId();

    const { error } = await supabase
      .from("saved_avatars")
      .insert({
        id,
        recipe_hash: recipeHash,
        user_id: recipe.userId,
        accessories: recipe.accessories,
        headless: recipe.headless,
        korblox: recipe.korblox,
        pose: recipe.pose,
      });

    if (!error) {
      return id;
    }

    if (error.code === "23505") {
      const existingId = await findExistingRecipe(
        supabase,
        recipeHash
      );

      if (existingId) {
        return existingId;
      }

      continue;
    }

    throw error;
  }

  throw new Error("Could not generate a unique avatar ID");
}

export default async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  try {
    if (!isAuthorized(req)) {
      return res.status(401).json({
        error: "Invalid or missing x-save-key",
      });
    }

    if (!passRateLimit(req)) {
      return res.status(429).json({
        error: "Too many save requests, wait one minute",
      });
    }

    const body = parseBody(req);

    if (!body) {
      return res.status(400).json({
        error: "The request body must be valid JSON",
      });
    }

    const recipe = makeRecipe(body);
    const recipeHash = makeRecipeHash(recipe);
    const supabase = getSupabase();

    const existingId = await findExistingRecipe(
      supabase,
      recipeHash
    );

    if (existingId) {
      await touchRecipe(supabase, existingId);

      return res.status(200).json({
        success: true,
        id: existingId,
        reused: true,
      });
    }

    const id = await insertRecipe(
      supabase,
      recipe,
      recipeHash
    );

    return res.status(200).json({
      success: true,
      id,
      reused: false,
    });
  } catch (error) {
    console.error("save avatar error", error);

    const message = String(error?.message || error || "Unknown error");
    const isInputError =
      message.includes("valid userId") ||
      message.includes("up to 8 accessories");

    return res.status(isInputError ? 400 : 500).json({
      error: isInputError
        ? message
        : "Could not save the avatar",
      details: isInputError ? undefined : message,
    });
  }
}
