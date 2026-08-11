# LLM provider adapter configuration

The `llm/` modules provide one portable `LlmAdapter` interface while retaining provider-specific construction at the application-composition boundary. The registry never discovers credentials or imports providers itself: register the factories the application is allowed to use, select one provider, and call `generate()` through the returned adapter.

This guide documents the current adapters:

| Provider ID | Factory export | Required configuration | Model value passed to `generate()` |
| --- | --- | --- | --- |
| `openai` | `openAiAdapterFactory` | `apiKey` option or `OPENAI_API_KEY` | An OpenAI Responses API model ID, for example `gpt-4.1-mini` |
| `bedrock-claude` | `bedrockClaudeAdapterFactory` | `region` option, `AWS_REGION`, or `AWS_DEFAULT_REGION`; AWS credentials | A Claude Sonnet Amazon Bedrock model ID enabled for the selected region |
| `deepseek-v4` | `deepSeekV4AdapterFactory` | `apiKey` option or `DEEPSEEK_API_KEY` | A DeepSeek V4 model ID available to the account, for example `deepseek-v4-flash` |

Model availability, model IDs, and Bedrock model access vary by provider account and region. Treat the values above as examples and configure an ID that the relevant provider has made available.

## Register providers explicitly

Register only the adapter factories your deployment supports. This keeps selection and SDK construction explicit and makes the application fail with a configuration error if an unregistered provider is requested.

```ts
import { LlmAdapterRegistry } from "./llm/adapter-registry.js";
import { openAiAdapterFactory } from "./llm/openai-adapter.js";
import { bedrockClaudeAdapterFactory } from "./llm/bedrock-claude-adapter.js";
import { deepSeekV4AdapterFactory } from "./llm/deepseek-v4-adapter.js";

const adapters = new LlmAdapterRegistry([
  openAiAdapterFactory,
  bedrockClaudeAdapterFactory,
  deepSeekV4AdapterFactory,
]);
```

Provider names are normalized to lowercase and must use lowercase letters, numbers, dots, underscores, or hyphens. The built-in IDs are exactly `openai`, `bedrock-claude`, and `deepseek-v4`.

## Select a provider

Use explicit configuration when composing an application. An explicit `provider` takes precedence over `LLM_PROVIDER`; provider-specific options are passed only to the chosen factory.

```ts
const adapter = await adapters.create({
  provider: "openai",
  options: {
    // Prefer OPENAI_API_KEY in the deployment environment instead of placing it here.
    baseURL: "https://api.openai.com/v1",
    organization: "org_example",
    project: "proj_example",
  },
});
```

For environment-based provider selection, set `LLM_PROVIDER` and call `createFromEnvironment`. The registry uses the supplied environment object only to resolve `LLM_PROVIDER`; each provider factory reads its own documented credential environment variables at construction time.

```ts
// LLM_PROVIDER=deepseek-v4
const adapter = await adapters.createFromEnvironment();
```

Do not log adapter options or environment objects. Keep credentials in the deployment secret manager or process environment, never in source, examples, committed configuration, or request payloads.

## Provider settings and precedence

All factory options must be a plain object. Unknown options and non-string option values are rejected. Factory options have precedence over the matching environment fallback.

### OpenAI (`openai`)

`OpenAiAdapter` uses the OpenAI Responses API and sets `store: false`, so callers supply the complete conversation on every request.

| Option | Environment fallback | Purpose |
| --- | --- | --- |
| `apiKey` | `OPENAI_API_KEY` | OpenAI API credential |
| `baseURL` | none | Optional compatible OpenAI API base URL |
| `organization` | none | Optional OpenAI organization |
| `project` | none | Optional OpenAI project |

```ts
const adapter = await adapters.create({
  provider: "openai",
  options: { apiKey: process.env.OPENAI_API_KEY! },
});

const response = await adapter.generate({
  model: "gpt-4.1-mini",
  messages: [{
    role: "user",
    content: [{ type: "text", text: "Summarize this deployment." }],
  }],
});
```

In production, omit `apiKey` from application configuration and set `OPENAI_API_KEY` through the secret manager instead. The explicit-key line is included only to show the option name and precedence.

### Claude Sonnet on Amazon Bedrock (`bedrock-claude`)

`BedrockClaudeAdapter` uses Amazon Bedrock Converse. It uses an explicit static credential pair when supplied; otherwise the AWS SDK default credential-provider chain applies (environment, shared configuration, web identity, ECS, or instance role).

| Option | Environment fallback | Purpose |
| --- | --- | --- |
| `region` | `AWS_REGION`, then `AWS_DEFAULT_REGION` | Required Bedrock region |
| `accessKeyId` | AWS SDK default chain when omitted | Static AWS access key; requires `secretAccessKey` |
| `secretAccessKey` | AWS SDK default chain when omitted | Static AWS secret key; requires `accessKeyId` |
| `sessionToken` | AWS SDK default chain when static credentials are omitted | Optional token paired with static credentials |

```ts
const adapter = await adapters.create({
  provider: "bedrock-claude",
  options: {
    region: "us-east-1",
    // Omit static credentials to use the AWS SDK default credential chain.
  },
});

const response = await adapter.generate({
  // Use a current Claude Sonnet Bedrock model ID enabled in us-east-1.
  model: "anthropic.claude-sonnet-4-20250514-v1:0",
  messages: [{
    role: "user",
    content: [{ type: "text", text: "Summarize this deployment." }],
  }],
});
```

Prefer workload identity or an instance/task role. If static credentials are unavoidable, provide `accessKeyId` and `secretAccessKey` together through a secret manager; never commit them. `sessionToken` is valid only alongside that static credential pair.

### DeepSeek V4 (`deepseek-v4`)

`DeepSeekV4Adapter` calls the non-streaming OpenAI-compatible Chat Completions endpoint using the global `fetch` implementation.

| Option | Environment fallback | Purpose |
| --- | --- | --- |
| `apiKey` | `DEEPSEEK_API_KEY` | DeepSeek API credential |
| `baseURL` | `https://api.deepseek.com/v1` | Optional compatible API root; include its version segment if required |

```ts
const adapter = await adapters.create({
  provider: "deepseek-v4",
  options: {
    // apiKey is normally read from DEEPSEEK_API_KEY.
    baseURL: "https://api.deepseek.com/v1",
  },
});

const response = await adapter.generate({
  model: "deepseek-v4-flash",
  messages: [{
    role: "user",
    content: [{ type: "text", text: "Summarize this deployment." }],
  }],
});
```

## Portable request example with a tool

Every adapter accepts a complete portable conversation. The tool schema is a JSON Schema object, and tool calls/results use normalized IDs and JSON values. Continue a tool interaction by appending the returned assistant message and a matching `tool` result to the next request.

```ts
const initial = await adapter.generate({
  model: "gpt-4.1-mini", // Replace with a model for the selected provider.
  messages: [{
    role: "system",
    content: [{ type: "text", text: "Use tools when needed." }],
  }, {
    role: "user",
    content: [{ type: "text", text: "What is the deployment status?" }],
  }],
  tools: [{
    type: "function",
    name: "deployment_status",
    description: "Returns the current deployment status.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  }],
  toolChoice: "auto",
  maxOutputTokens: 300,
});

const call = initial.message.toolCalls?.[0];
if (call) {
  const continued = await adapter.generate({
    model: "gpt-4.1-mini", // Keep this aligned with the selected provider.
    messages: [{
      role: "user",
      content: [{ type: "text", text: "What is the deployment status?" }],
    }, initial.message, {
      role: "tool",
      toolCallId: call.id,
      content: { status: "healthy" },
    }],
  });
  console.log(continued.message.content.map((part) => part.text).join(""));
}
```

`developer` messages are supported by the portable contract. OpenAI sends them as developer messages; Bedrock Claude and DeepSeek V4 preserve them as labelled system instructions because their mapped APIs have no separate developer role. Check `adapter.capabilities` before relying on optional behavior in application code.

## Operational behavior

- All adapters are stateless: provide the full relevant conversation on each call. Do not depend on provider response IDs or server-side conversation state.
- Responses normalize assistant text, function calls, finish reason, and any provider-reported token usage. Provider SDK/transport response objects are intentionally not exposed.
- Catch `LlmAdapterError` to distinguish `configuration`, `authentication`, `invalid_request`, `rate_limited`, `unavailable`, and other `provider` errors. Only `rate_limited` and `unavailable` errors are marked retryable.
- Pass an `AbortSignal` through `GenerateRequest.signal` to cancel a provider request.
- Set provider model IDs deliberately per environment. `LLM_PROVIDER` chooses an adapter, not a default model.

## Runtime CLI startup

`main.ts` is the plan-and-execute CLI. Select a provider with `--provider <id>` or set `LLM_PROVIDER`; the command-line option takes precedence. The supported IDs are `openai`, `bedrock-claude`, and `deepseek-v4`. There is no implicit provider default, so a normal launch must provide one of those selection sources.

```sh
npm start -- --help
npm start -- --provider openai "Plan the deployment work."
# Equivalent environment-selected launch:
LLM_PROVIDER=deepseek-v4 npm start -- "Plan the deployment work."
```

The CLI help lists the selected-provider credential and model variables. Pass credentials only through the runtime environment or a deployment secret manager; never put credentials in command-line arguments, `.env` committed to source control, or examples. The launch command asks Node to load an untracked `.env` when present, and application composition repeats that safely for embedded use. Existing process environment values (including secret-manager injection) take precedence.

### Provider runtime settings

| Selected provider | Credential/runtime requirements | Default model | Optional model override |
| --- | --- | --- | --- |
| `openai` | `OPENAI_API_KEY` | `gpt-4.1-mini` | `OPENAI_MODEL` |
| `bedrock-claude` | `AWS_REGION` or `AWS_DEFAULT_REGION`, plus the standard AWS credential-provider chain | `anthropic.claude-sonnet-4-20250514-v1:0` | `BEDROCK_CLAUDE_MODEL` |
| `deepseek-v4` | `DEEPSEEK_API_KEY` | `deepseek-chat` | `DEEPSEEK_MODEL` |

Only the selected provider's credential and model variables are read. A selected-provider model override must be non-blank; otherwise the documented default is used. Model availability and Bedrock access remain account- and region-specific.

For example, configure DeepSeek without persisting a credential in the repository:

```sh
export LLM_PROVIDER=deepseek-v4
export DEEPSEEK_API_KEY="..." # inject from a secret manager in production
export DEEPSEEK_MODEL=deepseek-chat # optional
npm start -- "Plan the deployment work."
```

The multi-turn CLI uses the compatibility runtime to retain its plan/tool-call continuation, in-process response chaining, normalized usage accounting, and provider error propagation while provider adapters remain stateless. `LLM_PROVIDER` and `--provider` select an adapter; the model resolver selects the matching default or provider-specific override.

`.env` and build output are ignored by Git. The Dockerfile declares `LLM_PROVIDER=deepseek-v4` as a non-secret image default; override it with `--provider` or a runtime environment value as needed, and inject the selected provider's credentials at launch.
