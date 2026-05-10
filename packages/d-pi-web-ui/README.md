# D-Pi Web UI (`@sheason/d-pi-web-ui`)

Browser application for D-Pi, served by `d-pi hub serve`.

It is not a standalone server. Build it, then start the hub:

```bash
npm run build --workspace @sheason/d-pi-web-ui
d-pi hub serve
```

Open:

```text
http://127.0.0.1:4317/
http://127.0.0.1:4317/agents/<child-agent-id>
```

The Web UI connects as a hub host UI, not as a peer executor. It can drive the selected session but is not listed in peer/executor discovery and is not counted in `peerCount`. Use `d-pi peer --agent <id>` when peer-local tool execution is required.
