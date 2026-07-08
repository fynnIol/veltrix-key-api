import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(200).json({ ok: true, message: "Script API online" });
    }

    const { key } = req.body || {};

    if (!key) {
      return res.status(400).json({ ok: false, error: "Missing key" });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { data: keyData } = await supabase
      .from("keys")
      .select("*")
      .eq("key", key)
      .eq("active", true)
      .maybeSingle();

    if (!keyData) {
      return res.status(200).json({ ok: false, error: "Invalid key" });
    }

    const { data: scriptData, error } = await supabase
      .from("scripts")
      .select("code")
      .eq("name", "main")
      .eq("active", true)
      .maybeSingle();

    if (error || !scriptData) {
      return res.status(500).json({ ok: false, error: "Script not found" });
    }

    return res.status(200).json({
      ok: true,
      code: scriptData.code
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
