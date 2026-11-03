Use the signed-in website UI through Ego Browser and its separate web plan pool.

Use `status` first to inspect login, visible model or plan, and limit notices without sending a prompt. Use `ask` to send only the explicit `prompt` once and return a new completed answer plus its conversation URL. Supply the returned `conversationUrl` to continue that conversation; omit it for a new chat. `timeout` is in seconds and includes browser queue wait.

No session or repository context is added automatically. Remaining quota is reported only when the website exposes it; never infer numeric quota. If submission times out or user control is lost, inspect the conversation before sending again. Never retry an uncertain submission automatically.
