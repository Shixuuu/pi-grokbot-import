// Scripted OpenAI-compatible mock for driving Pi tool calls offline.
// MOCK_SCRIPT (JSON file): [{ "user": "<regex on latest user msg>", "steps": [ {tool, args} | {text} | {toolFromLast: {tool, args, tokenFrom: true}} ] }]
// Step k is used when k tool results follow the latest user message.
// Special arg value "$TOKEN" is replaced by the last confirmToken seen in any tool result.
import http from "node:http";
import fs from "node:fs";
const port = Number(process.env.MOCK_PORT || 18556);
const log = process.env.MOCK_LOG || "/tmp/mock-llm-scripted.jsonl";
const script = JSON.parse(fs.readFileSync(process.env.MOCK_SCRIPT, "utf8"));
const txt = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => x.text || "").join("") : "");
http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ data: [{ id: "mock" }] }));
      }
      let j = {};
      try {
        j = JSON.parse(body);
      } catch {}
      const msgs = j.messages || [];
      let lastUser = -1;
      msgs.forEach((m, i) => m.role === "user" && (lastUser = i));
      const userText = lastUser >= 0 ? txt(msgs[lastUser].content) : "";
      const k = msgs.slice(lastUser + 1).filter((m) => m.role === "tool").length;
      let token = null;
      for (const m of msgs) if (m.role === "tool") { const t = txt(m.content).match(/confirmToken: "([0-9a-f]+)"/); if (t) token = t[1]; }
      const entry = script.find((s) => new RegExp(s.user, "i").test(userText));
      const step = entry?.steps?.[k] || { text: "MOCK_DONE" };
      fs.appendFileSync(log, JSON.stringify({ userText, k, step, tools: (j.tools || []).map((t) => t.function?.name), system: txt(msgs.find((m) => m.role === "system")?.content).slice(0, 20000), lastTool: k ? txt(msgs[msgs.length - 1].content) : null }) + "\n");
      const base = { id: "c1", object: "chat.completion.chunk", created: 0, model: "mock" };
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (step.tool) {
        const args = JSON.parse(JSON.stringify(step.args || {}).replace(/"\$TOKEN"/g, JSON.stringify(token)));
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${k}_${Date.now()}`, type: "function", function: { name: step.tool, arguments: JSON.stringify(args) } }] }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: step.text }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      }
      res.end("data: [DONE]\n\n");
    });
  })
  .listen(port, "127.0.0.1", () => console.log(`scripted mock-llm on ${port}`));
