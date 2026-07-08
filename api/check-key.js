import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseServiceKey);

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ valid: false, error: "Method not allowed" });
  }

  try {
    const { key, used_by } = req.body || {};
    const cleanKey = String(key || "").trim().toUpperCase();
    const cleanUsedBy = String(used_by || "unknown").trim().slice(0, 120);

    if (!cleanKey) {
      return res.status(400).json({ valid: false, error: "Missing key" });
    }

    const { data, error } = await supabase
      .from("keys")
      .select("id, key, active, used, used_by, expires_at")
      .eq("key", cleanKey)
      .maybeSingle();

    if (error) {
      return res.status(500).json({ valid: false, error: "Database error" });
    }

    if (!data) {
      return res.status(200).json({ valid: false, error: "Invalid key" });
    }

    if (!data.active) {
      return res.status(200).json({ valid: false, error: "Key disabled" });
    }

    if (data.expires_at && new Date(data.expires_at).getTime() < Date.now()) {
      return res.status(200).json({ valid: false, error: "Key expired" });
    }

    // One-user lock: first successful use stores used_by.
    // After that, only the same used_by can use it again.
    if (data.used && data.used_by && data.used_by !== cleanUsedBy) {
      return res.status(200).json({ valid: false, error: "Key already used" });
    }

    const { error: updateError } = await supabase
      .from("keys")
      .update({
        used: true,
        used_by: data.used_by || cleanUsedBy,
        last_used: new Date().toISOString()
      })
      .eq("id", data.id);

    if (updateError) {
      return res.status(500).json({ valid: false, error: "Could not update key" });
    }

    return res.status(200).json({ valid: true });
  } catch (err) {
    return res.status(500).json({ valid: false, error: "Server error" });
  }
}
