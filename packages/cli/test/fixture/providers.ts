// An OpenAI-compatible provider outside the built-in catalog, declared the way a user's aictrl.json would.
// Spread it into `provider.alibaba` next to the test's own options.
export const alibabaProvider = {
  npm: "@ai-sdk/openai-compatible",
  api: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  models: {
    "qwen-plus": {
      name: "Qwen Plus",
      family: "qwen",
      attachment: false,
      reasoning: true,
      tool_call: true,
      temperature: true,
      release_date: "2024-01-25",
      modalities: { input: ["text" as const], output: ["text" as const] },
      cost: { input: 0.4, output: 1.2 },
      limit: { context: 1_000_000, output: 32_768 },
    },
  },
}
