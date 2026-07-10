import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(200).json({
        ok: true,
        message: "Key API is online. Send POST with { key }."
      });
    }

    const rawKey = req.body?.key;
    const key = typeof rawKey === "string" ? rawKey.trim() : "";

    if (!key) {
      return res.status(400).json({
        valid: false,
        error: "Missing key"
      });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const now = new Date().toISOString();

    const { data, error } = await supabase
      .from("keys")
      .update({
        used: true,
        last_used: now
      })
      .eq("key", key)
      .eq("active", true)
      .eq("used", false)
      .select("id,key")
      .maybeSingle();

    if (error) {
      return res.status(500).json({
        valid: false,
        error: error.message
      });
    }

    if (!data) {
      return res.status(200).json({
        valid: false,
        error: "Invalid, inactive, or already used key."
      });
    }

    return res.status(200).json({
      valid: true
    });
  } catch (err) {
    return res.status(500).json({
      valid: false,
      error: err instanceof Error ? err.message : "Unknown server error"
    });
  }
}
