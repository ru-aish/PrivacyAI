import http from "node:http";

const port = Number(process.env.MOCK_API_PORT || 1234);
let lastRequest = null;

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(404);
    res.end();
    return;
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const bodyText = Buffer.concat(chunks).toString("utf8");
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    body = {};
  }

  lastRequest = { url: req.url, body };

  const userMessages = body.messages?.filter((message) => message.role === "user") || [];
  const userMessage = userMessages.at(-1)?.content || "";
  const emailMatch = userMessage.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
  const originalEmail = emailMatch?.[0] || "secret@example.com";
  const safePrompt = userMessage.replace(originalEmail, "contact1@example.com");

  const payload = {
    choices: [
      {
        message: {
          content: JSON.stringify({
            safe_prompt: safePrompt,
            session_map: {
              "contact1@example.com": originalEmail
            }
          })
        }
      }
    ]
  };

  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Mock AI API listening on http://127.0.0.1:${port}/v1/chat/completions`);
});

export function getLastRequest() {
  return lastRequest;
}

export function closeMockApi() {
  return new Promise((resolve) => server.close(resolve));
}