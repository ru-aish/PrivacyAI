import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = 3333;

const server = http.createServer((req, res) => {
  const filePath = path.join(__dirname, req.url === "/" ? "mock-chat.html" : req.url);
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath);
    const type = ext === ".html" ? "text/html" : "text/plain";
    res.writeHead(200, { "content-type": type });
    res.end(data);
  });
});

server.listen(port, () => {
  console.log(`Mock chat available at http://127.0.0.1:${port}/mock-chat.html`);
});