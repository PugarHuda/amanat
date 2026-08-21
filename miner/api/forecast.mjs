// Vercel adapter. The miner's logic lives in ../server.mjs; this only maps a
// serverless request onto it, so there is one implementation to keep correct.
import { forecast } from "../server.mjs";

export default async function handler(req, res) {
  try {
    const body = req.method === "POST" ? (req.body ?? {}) : {};
    const q = req.query ?? {};
    const out = await forecast({
      lat: Number(body.lat ?? q.lat),
      lon: Number(body.lon ?? q.lon),
      hours: Number(body.hours ?? q.hours ?? 0),
    });
    res.status(200).json(out);
  } catch (e) {
    const client = e instanceof RangeError || e instanceof SyntaxError;
    res.status(client ? 400 : 502).json({ error: e.message });
  }
}
