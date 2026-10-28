// Zero-dependency HTTP server used by the runverdict demo and tests.
// Listens on process.env.PORT (default 3000) and prints one line on listen,
// which is the startup signal runverdict waits for.
const http = require("node:http");

const port = Number(process.env.PORT ?? 3000);

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === "/json") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "hello", items: [1, 2, 3] }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(port, "127.0.0.1", () => {
  console.log(`sample app listening on port ${port}`);
});
