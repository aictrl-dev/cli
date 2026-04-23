/// <reference path="../env.d.ts" />
import { tool } from "@aictrl/plugin"

function getPRNumber(): number {
  const pr = parseInt(process.env.PR_NUMBER ?? "", 10)
  if (!pr) throw new Error("PR_NUMBER env var not set")
  return pr
}

async function githubFetch(endpoint: string, options: RequestInit = {}) {
  const response = await fetch(`https://api.github.com${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      ...options.headers,
    },
  })
  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`GitHub API error: ${response.status} ${response.statusText} - ${errorBody}`)
  }
  return response.json()
}

export default tool({
  description: "Post a comment to a GitHub Pull Request",
  args: {
    body: tool.schema.string().describe("The markdown body of the comment"),
    commit_id: tool.schema.string().optional().describe("The SHA of the commit to comment on (required for line comments)"),
    path: tool.schema.string().optional().describe("The relative path to the file to comment on"),
    line: tool.schema.number().int().optional().describe("The line number to comment on"),
    side: tool.schema.enum(["LEFT", "RIGHT"]).optional().describe("The side of the diff to comment on (LEFT for deleted, RIGHT for added)"),
  },
  async execute(args) {
    const pr = getPRNumber()
    const owner = process.env.GH_OWNER || "aictrl-dev"
    const repo = process.env.GH_REPO || "cli"

    if (args.path && args.line && args.commit_id) {
      // Inline review comment
      await githubFetch(`/repos/${owner}/${repo}/pulls/${pr}/comments`, {
        method: "POST",
        body: JSON.stringify({
          body: args.body,
          commit_id: args.commit_id,
          path: args.path,
          line: args.line,
          side: args.side ?? "RIGHT",
        }),
      })
      return `Posted inline comment to ${args.path}:${args.line}`
    } else {
      // General PR comment
      await githubFetch(`/repos/${owner}/${repo}/issues/${pr}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: args.body }),
      })
      return `Posted general comment to PR #${pr}`
    }
  },
})
