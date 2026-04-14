function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  res.status(200).json({
    name: "OCS AI 答题接口",
    status: "ok",
    endpoints: {
      query: "/query",
      health: "/health",
    },
    usage: {
      method: "GET",
      query: ["token", "title", "options", "type"],
    },
  });
}

module.exports = handler;
