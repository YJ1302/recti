// Tiny in-memory rate limiter (no dependencies). Keyed by client IP.
// Used on login endpoints so nobody can walk through student codes or guess the admin password.
function rateLimit({ windowMs, max, message, onLimit }) {
  const hits = new Map(); // ip -> { count, resetAt }

  // drop expired entries now and then so the map can't grow forever
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, Math.max(windowMs, 60000));
  if (sweep.unref) sweep.unref();

  return function limiter(req, res, next) {
    const xff = req.headers["x-forwarded-for"];
    const ip = (xff ? String(xff).split(",")[0].trim() : req.ip) || "unknown";
    const now = Date.now();
    let rec = hits.get(ip);
    if (!rec || rec.resetAt <= now) {
      rec = { count: 0, resetAt: now + windowMs };
      hits.set(ip, rec);
    }
    rec.count += 1;
    if (rec.count > max) {
      const wait = Math.ceil((rec.resetAt - now) / 1000);
      res.set("Retry-After", String(wait));
      if (typeof onLimit === "function") return onLimit(req, res, wait);
      return res.status(429).send(message || "Too many requests");
    }
    return next();
  };
}

module.exports = { rateLimit };
