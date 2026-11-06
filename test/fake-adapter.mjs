/** Stands in for claude-agent-acp: replays a canned ACP message sequence so the
 *  proxy's title rewriting can be tested without an API call. */
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);

let buffer = "";
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
      const sessionId = msg.params.sessionId;
      const command = `echo ${"long ".repeat(40)}`;
      const toolUpdate = (update) =>
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
      const bash = { toolCallId: "bash_1", title: command, kind: "execute" };
      toolUpdate({ ...bash, sessionUpdate: "tool_call", status: "pending", rawInput: { command } });
      toolUpdate({ ...bash, sessionUpdate: "tool_call_update", rawInput: { command } });
      toolUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "read_1",
        title: `Read ${"long/".repeat(40)}`,
        kind: "read",
        status: "pending",
      });
      send({
        jsonrpc: "2.0",
        id: 900,
        method: "session/request_permission",
        params: { sessionId, toolCall: { ...bash, rawInput: { command } }, options: [] },
      });
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
