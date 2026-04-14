function handler(req, res) {
  const providersConfigured = Boolean(process.env.OPENAI_PROVIDERS || process.env.OPENAI_API_KEY);
  const tokenConfigured = Boolean(process.env.API_TOKEN);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  res.status(200).json({
    status: "ok",
    env: {
      providersConfigured,
      tokenConfigured,
    },
    timestamp: new Date().toISOString(),
  });
}

module.exports = handler;
