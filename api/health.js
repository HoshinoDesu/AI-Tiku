function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  res.status(200).json({
    status: "ok",
    timestamp: new Date().toISOString(),
  });
}

module.exports = handler;
