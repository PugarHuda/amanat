export default function handler(_req, res) {
  res.status(200).json({ status: "ok", miner: "amanat", time: new Date().toISOString() });
}
