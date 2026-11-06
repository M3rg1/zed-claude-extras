/** Stands in for claude-agent-acp: replays a canned ACP message sequence so the
 *  proxy's title rewriting can be tested without an API call. */
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);

let buffer = "";
let turn = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);

    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
      continue;
    }

    // Anything the proxy should have swallowed shows up here, which is how the
    // test asserts that it did not reach the agent.
    if (msg.method === "session/set_config_option") {
      send({ jsonrpc: "2.0", method: "test/leaked", params: { configId: msg.params?.configId } });
      send({ jsonrpc: "2.0", id: msg.id, result: { configOptions: [] } });
      continue;
    }

    // Tool calls shaped like the real Claude adapter's: the shell command is the
    // title, and later reports repeat the title and the kind.
    if (msg.method === "session/prompt") {
      // Never answering is a turn that is still running.
      if (process.env.ZED_AGENT_USAGE_FAKE_HOLD_PROMPT === "1") continue;
      const sessionId = msg.params.sessionId;
      const command = `echo ${"long ".repeat(40)}`;
      const toolUpdate = (update) =>
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
      turn += 1;
      const bash = (n) => ({ toolCallId: `bash_${n}_${turn}`, title: command, kind: "execute" });
      const report = (n) => {
        toolUpdate({ ...bash(n), sessionUpdate: "tool_call", status: "pending", rawInput: { command } });
        toolUpdate({ ...bash(n), sessionUpdate: "tool_call_update", rawInput: { command } });
      };
      const finish = (n, status) =>
        toolUpdate({ sessionUpdate: "tool_call_update", toolCallId: `bash_${n}_${turn}`, status });

      const chunk = (sessionUpdate) =>
        toolUpdate({ sessionUpdate, content: { type: "text", text: "words" } });

      report(1);
      finish(1, "completed");
      report(4);
      chunk("agent_thought_chunk");
      report(5);
      chunk("agent_message_chunk");
      report(2);
      finish(2, "failed");
      toolUpdate({
        sessionUpdate: "tool_call",
        toolCallId: `read_${turn}`,
        title: `Read ${"long/".repeat(40)}`,
        kind: "read",
        status: "pending",
      });
      report(3);
      // No title or kind: Zed can't draw a card it hasn't seen without a title.
      send({
        jsonrpc: "2.0",
        id: 900 + turn,
        method: "session/request_permission",
        params: {
          sessionId,
          toolCall: { toolCallId: `bash_3_${turn}`, rawInput: { command } },
          options: [],
        },
      });
      toolUpdate({ ...bash(3), sessionUpdate: "tool_call_update", status: "completed" });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      continue;
    }

    if (msg.method === "session/load") {
      // Note the absent sessionId: LoadSessionResponse has no such field.
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          configOptions: [
            {
              id: "effort",
              name: "Effort",
              type: "select",
              currentValue: "xhigh",
              options: [{ value: "xhigh", name: "Xhigh" }],
            },
          ],
        },
      });
      continue;
    }

    if (msg.method === "session/new") {
      const sessionId = "sess_test_1";
      // Both real adapters return config options here; "effort" is the one the
      // stub provider nominates, "model" is a control that must stay untouched.
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          sessionId,
          configOptions: [
            {
              id: "model",
              name: "Model",
              type: "select",
              currentValue: "sonnet",
              options: [{ value: "sonnet", name: "Sonnet" }],
            },
            {
              id: "effort",
              name: "Effort",
              type: "select",
              currentValue: "xhigh",
              options: [
                { value: "high", name: "High" },
                { value: "xhigh", name: "Xhigh" },
              ],
            },
          ],
        },
      });

      // A normal turn: some output, a usage_update, then the title at turn end.
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "working" },
          },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: { sessionUpdate: "usage_update", used: 12345, size: 200000 },
        },
      });
      setTimeout(() => {
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: { sessionUpdate: "session_info_update", title: "Fix auth bug" },
          },
        });
      }, 200);
    }
  }
});
