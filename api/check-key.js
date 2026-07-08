const { createClient } = require("@supabase/supabase-js");

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(200).json({
        ok: true,
        message: "Key API is online. Send POST with { key }."
      });
    }

    const { key } = req.body || {};

    if (!key) {
      return res.status(400).json({ valid: false, error: "Missing key" });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { data, error } = await supabase
      .from("keys")
      .select("*")
      .eq("key", key)
      .eq("active", true)
      .maybeSingle();

    if (error) {
      return res.status(500).json({ valid: false, error: error.message });
    }

    if (!data) {
      return res.status(200).json({ valid: false });
    }

    await supabase
      .from("keys")
      .update({
        last_used: new Date().toISOString()
      })
      .eq("id", data.id);

    return res.status(200).json({ valid: true });
  } catch (err) {
    return res.status(500).json({
      valid: false,
      error: err.message
    });
  }
};
