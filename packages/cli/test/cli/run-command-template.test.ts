import { describe, expect, test } from "bun:test"
import { capture, userText } from "./fixture/command-template-capture"

function projection(result: Awaited<ReturnType<typeof capture>>, expected: string) {
  const before = result.observations.filter((row: { kind: string }) => row.kind === "before")
  const executed = result.observations.filter((row: { kind: string }) => row.kind === "executed")
  expect(before).toHaveLength(1)
  expect(executed).toHaveLength(1)
  expect(before[0].input.arguments).toBe(expected)
  expect(executed[0].event.properties.arguments).toBe(expected)
  expect(typeof before[0].input.arguments).toBe("string")
  expect(typeof executed[0].event.properties.arguments).toBe("string")
}

describe("current command expansion contracts", () => {
  for (const entry of ["index", "headless"] as const) {
    for (const item of [
      {
        name: "repeated-out-of-order",
        template: "X<$3> A<$1> AGAIN<$3> B<$2>",
        expected: "X<c d> A<a> AGAIN<c d> B<b>",
      },
      { name: "sparse-highest", template: "X<$4> A<$1> X2<$4>", expected: "X<d> A<a> X2<d>" },
      { name: "missing-highest", template: "X<$9> A<$1> X2<$9>", expected: "X<> A<a> X2<>" },
    ])
      test(`${entry}: ${item.name}`, async () => {
        const result = await capture({
          entry,
          name: item.name,
          template: item.template,
          operands: ["a", "b", "c", "d"],
        })
        expect(userText(result.requests[0])).toBe(item.expected)
        projection(result, "a b c d")
      }, 15000)
  }
  for (const item of [
    {
      name: "legacy-quoted-UNC",
      arguments: '"\\\\server\\share" tail rest',
      expected: "FIRST<\\\\server\\share>\nSECOND<tail>\nREST<rest>",
      raw: '"\\\\server\\share" tail rest',
    },
    {
      name: "legacy-adjacent-quotes",
      arguments: '"alpha beta""gamma" delta',
      expected: "FIRST<alpha beta>\nSECOND<gamma>\nREST<delta>",
      raw: '"alpha beta""gamma" delta',
    },
    {
      name: "legacy-adjacent-image",
      arguments: "[Image 12]tail end",
      expected: "FIRST<[Image 12]>\nSECOND<tail>\nREST<end>",
      raw: "[Image 12]tail end",
    },
    {
      name: "structured-projection",
      arguments: { argv: ['say "hi"', "", "tail\\path"] },
      expected: 'FIRST<say "hi">\nSECOND<>\nREST<tail\\path>',
      raw: 'say "hi"  tail\\path',
    },
    {
      name: "structured-stdin-projection",
      arguments: { argv: ["alpha", "beta"], stdin: "late λ\nline" },
      expected: "FIRST<alpha>\nSECOND<beta>\nREST<late λ\nline>",
      raw: "alpha beta\nlate λ\nline",
    },
    {
      name: "structured-empty-stdin",
      arguments: { argv: ["alpha", "beta"], stdin: "" },
      expected: "FIRST<alpha>\nSECOND<beta>\nREST<>",
      raw: "alpha beta\n",
    },
    {
      name: "legacy-newline-projection",
      arguments: "alpha beta\nline",
      expected: "FIRST<alpha>\nSECOND<beta>\nREST<line>",
      raw: "alpha beta\nline",
    },
  ])
    test(
      item.name,
      async () => {
        const result = await capture({ name: item.name, arguments: item.arguments })
        expect(userText(result.requests[0])).toBe(item.expected)
        projection(result, item.raw)
      },
      15000,
    )
})

// Every executable in these controls is the explicitly authorized inert absolute printf.
describe("original template shell authority", () => {
  for (const item of [
    {
      name: "argument-cannot-create-span",
      operands: ["!`/usr/bin/printf INERT_ARG`"],
      template: "DATA<$ARGUMENTS>",
      expected: "DATA<!`/usr/bin/printf INERT_ARG`>",
    },
    {
      name: "stdin-cannot-create-span",
      operands: ["-"],
      stdin: "!`/usr/bin/printf INERT_STDIN`",
      template: "DATA<$1>",
      expected: "DATA<!`/usr/bin/printf INERT_STDIN`>",
    },
    {
      name: "fallback-cannot-create-span",
      operands: ["!`/usr/bin/printf INERT_FALLBACK`"],
      template: "HEADER",
      expected: "HEADER\n\n!`/usr/bin/printf INERT_FALLBACK`",
    },
    {
      name: "trusted-static-span",
      operands: ["inert"],
      template: "OUT<!`/usr/bin/printf TRUSTED_STATIC`> $1",
      expected: "OUT<TRUSTED_STATIC> inert",
    },
    {
      name: "trusted-dynamic-vector",
      operands: ["alpha beta", "tail; /usr/bin/printf INERT_SEMI"],
      template: "OUT<!`/usr/bin/printf '<%s>' $ARGUMENTS`>",
      expected: "OUT<<alpha beta><tail; /usr/bin/printf INERT_SEMI>>",
    },
    {
      name: "trusted-output-not-rescanned",
      operands: ["inert"],
      template: "OUT<!`/usr/bin/printf '%b' '!\\x60/usr/bin/printf INERT_OUTPUT\\x60'`> $1",
      expected: "OUT<!`/usr/bin/printf INERT_OUTPUT`> inert",
    },
  ])
    test(
      item.name,
      async () => {
        const result = await capture({ entry: "index", ...item })
        expect(userText(result.requests[0])).toBe(item.expected)
      },
      15000,
    )
})

describe("trusted template binding matrix", () => {
  const items: (import("./fixture/command-template-capture").Input & { expected: string })[] = [
    {
      entry: "headless",
      name: "quoted-vector-data",
      operands: ["alpha beta", "", "$UNSET", "`/usr/bin/printf INERT_BACKTICK`", "semi; /usr/bin/printf INERT_SEMI"],
      template: "OUT<!`/usr/bin/printf '<%s>' \"$ARGUMENTS\"`>",
      expected: "OUT<<alpha beta  $UNSET `/usr/bin/printf INERT_BACKTICK` semi; /usr/bin/printf INERT_SEMI>>",
    },
    {
      entry: "headless",
      name: "unquoted-vector-quotes-slashes",
      operands: ["quote\" and apostrophe'", "\\path\\tail", "line\nbreak"],
      template: "OUT<!`/usr/bin/printf '<%s>' $ARGUMENTS`>",
      expected: "OUT<<quote\" and apostrophe'><\\path\\tail><line\nbreak>>",
    },
    {
      entry: "headless",
      name: "unquoted-scalar-operators",
      operands: ["semi; /usr/bin/printf INERT_SCALAR"],
      template: "OUT<!`/usr/bin/printf '<%s>' $1`>",
      expected: "OUT<<semi; /usr/bin/printf INERT_SCALAR>>",
    },
    {
      entry: "headless",
      name: "quoted-scalar-data",
      operands: ['say "hi" $UNSET'],
      template: "OUT<!`/usr/bin/printf '<%s>' \"$1\"`>",
      expected: 'OUT<<say "hi" $UNSET>>',
    },
    {
      entry: "headless",
      name: "scalar-concat",
      operands: ["a b"],
      template: "OUT<!`/usr/bin/printf '<%s>' pre$1/post`>",
      expected: "OUT<<prea b/post>>",
    },
    {
      entry: "headless",
      name: "vector-concat-native",
      operands: ["a b", "c"],
      template: "OUT<!`/usr/bin/printf '<%s>' pre$ARGUMENTS/post`>",
      expected: "OUT<<prea b><c/post>>",
    },
    {
      entry: "headless",
      name: "quoted-vector-concat-native",
      operands: ["a b", "c"],
      template: "OUT<!`/usr/bin/printf '<%s>' \"pre$ARGUMENTS/post\"`>",
      expected: "OUT<<prea b c/post>>",
    },
    {
      entry: "headless",
      name: "missing-number-scalar",
      operands: ["a"],
      template: "OUT<!`/usr/bin/printf '<%s>' $9`> A<$1>",
      expected: "OUT<<>> A<a>",
    },
    {
      entry: "headless",
      name: "global-highest-across-spans",
      operands: ["a", "b", "c", "d"],
      template: "A<$1> OUT<!`/usr/bin/printf '<%s>' $3`> B<$2>",
      expected: "A<a> OUT<<c d>> B<b>",
    },
    {
      entry: "headless",
      name: "multiple-static-spans",
      operands: ["a b"],
      template: "A<!`/usr/bin/printf FIRST`> DATA<$ARGUMENTS> B<!`/usr/bin/printf '<%s>' $1`>",
      expected: "A<FIRST> DATA<a b> B<<a b>>",
    },
    {
      entry: "headless",
      name: "trusted-static-operators",
      operands: ["inert"],
      template: "OUT<!`/usr/bin/printf A; /usr/bin/printf B`> $1",
      expected: "OUT<AB> inert",
    },
    {
      entry: "headless",
      name: "trusted-static-substitution",
      operands: ["inert"],
      template: "OUT<!`/usr/bin/printf '%s' \"$(/usr/bin/printf TRUSTED_SUB)\"`> $1",
      expected: "OUT<TRUSTED_SUB> inert",
    },
    {
      entry: "headless",
      name: "output-placeholder-not-rescanned",
      operands: ["inert"],
      template: "OUT<!`/usr/bin/printf '%b' '\\x24ARGUMENTS \\x241'`> $1",
      expected: "OUT<$ARGUMENTS $1> inert",
    },
    {
      name: "empty-vector",
      arguments: { argv: [] },
      template: "OUT<!`/usr/bin/printf '<%s>' $ARGUMENTS LAST`>",
      expected: "OUT<<LAST>>",
    },
    {
      name: "empty-stdin-vector-member",
      arguments: { argv: [], stdin: "" },
      template: "OUT<!`/usr/bin/printf '<%s>' $ARGUMENTS LAST`>",
      expected: "OUT<<><LAST>>",
    },
    {
      entry: "headless",
      name: "late-stdin-bound-data",
      operands: ["alpha", "-"],
      stdin: "!`/usr/bin/printf INERT_STDIN`",
      template: "RAW<$ARGUMENTS> OUT<!`/usr/bin/printf '<%s>' $ARGUMENTS`>",
      expected: "RAW<alpha\n!`/usr/bin/printf INERT_STDIN`> OUT<<alpha><!`/usr/bin/printf INERT_STDIN`>>",
    },
    {
      name: "legacy-decoded-vector",
      arguments: '"space here" "\\\\server\\share"',
      template: "RAW<$ARGUMENTS> OUT<!`/usr/bin/printf '<%s>' $ARGUMENTS`>",
      expected: 'RAW<"space here" "\\\\server\\share"> OUT<<space here><\\\\server\\share>>',
    },
    {
      entry: "headless",
      name: "headless-argument-span-literal",
      operands: ["!`/usr/bin/printf INERT_ARG`"],
      template: "DATA<$ARGUMENTS>",
      expected: "DATA<!`/usr/bin/printf INERT_ARG`>",
    },
    {
      entry: "headless",
      name: "headless-fallback-span-literal",
      operands: ["!`/usr/bin/printf INERT_FALLBACK`"],
      template: "HEADER",
      expected: "HEADER\n\n!`/usr/bin/printf INERT_FALLBACK`",
    },
  ]
  for (const item of items)
    test(
      item.name,
      async () => {
        const result = await capture(item)
        expect(userText(result.requests[0])).toBe(item.expected)
        if ("stdin" in item) {
          expect(result.firstBytesAt).toBeGreaterThan(90)
          expect(result.eofAt!).toBeGreaterThan(result.firstBytesAt!)
          expect(result.requestsBeforeEOF).toBe(0)
        }
      },
      15000,
    )
})

describe("legacy highest numbered placeholder controls", () => {
  for (const item of [
    {
      name: "legacy-repeated-out-of-order",
      template: "X<$3> A<$1> AGAIN<$3> B<$2>",
      expected: "X<d e> A<a b> AGAIN<d e> B<c>",
    },
    { name: "legacy-sparse-highest", template: "X<$4> A<$1> AGAIN<$4>", expected: "X<e> A<a b> AGAIN<e>" },
  ])
    test(
      item.name,
      async () => {
        const result = await capture({ name: item.name, arguments: '"a b" c d e', template: item.template })
        expect(userText(result.requests[0])).toBe(item.expected)
        projection(result, '"a b" c d e')
      },
      15000,
    )
})

test("template fixture forced deadline cannot pass as a rejection", async () => {
  await expect(
    capture({ entry: "index", name: "forced-template-deadline", operands: ["inert"], deadlineMs: 1 }),
  ).rejects.toThrow("Command argument fixture deadline fired")
}, 15000)

// These deliberately exercise author-selected programs; binding is not a program sandbox.
describe("original template shell context acceptance", () => {
  for (const item of [
    {
      name: "command-position-absolute-printf",
      operands: ["/usr/bin/printf"],
      template: "OUT<!`$1 '<%s>' COMMAND_DATA`>",
      expected: "OUT<<COMMAND_DATA>>",
    },
    {
      name: "command-position-data-cannot-add-program",
      operands: ["/usr/bin/printf; /usr/bin/printf INERT_PROGRAM"],
      template: "OUT<!`$1 '<%s>' COMMAND_DATA`>",
      expected: "OUT<>",
    },
    {
      name: "unquoted-assignment-data",
      operands: ["data ; /usr/bin/printf INERT_ASSIGN $UNSET"],
      template: "OUT<!`ASSIGN=$1; /usr/bin/printf '<%s>' \"$ASSIGN\"`>",
      expected: "OUT<<data ; /usr/bin/printf INERT_ASSIGN $UNSET>>",
    },
    {
      name: "quoted-assignment-data",
      operands: ['say "hi" ; /usr/bin/printf INERT_ASSIGN'],
      template: 'OUT<!`ASSIGN="$1"; /usr/bin/printf \'<%s>\' "$ASSIGN"`>',
      expected: 'OUT<<say "hi" ; /usr/bin/printf INERT_ASSIGN>>',
    },
    {
      name: "owned-redirection-data",
      operands: ["OWNED_REDIRECT_TARGET"],
      ownedRedirect: true,
      template: "OUT<!`/usr/bin/printf '%s' REDIRECTED > $1`>",
      expected: "OUT<>",
    },
    {
      name: "trusted-static-pipeline",
      operands: ["inert"],
      template: "OUT<!`/usr/bin/printf FIRST | /usr/bin/printf '%s' FINAL`> $1",
      expected: "OUT<FINAL> inert",
    },
    {
      name: "nonzero-stdout-preserved",
      operands: ["inert"],
      template: "OUT<!`/usr/bin/printf '%Z'`> $1",
      expected: "OUT<> inert",
    },
    {
      name: "trusted-interpreter-is-authority",
      operands: ['process.stdout.write("INERT_INTERPRETER")'],
      template: "OUT<!`" + process.execPath + " -e $1`>",
      expected: "OUT<INERT_INTERPRETER>",
    },
  ])
    test(
      item.name,
      async () => {
        const result = await capture({ entry: "headless", ...item })
        expect(userText(result.requests[0])).toBe(item.expected)
        if (item.name === "owned-redirection-data") {
          expect(result.redirected?.text).toBe("REDIRECTED")
          expect(result.redirected?.removed).toBe(true)
          expect(result.redirected?.path.startsWith(result.cwd + "/")).toBe(true)
        }
      },
      15000,
    )
  test("quoted empty vector is one empty argument", async () => {
    const result = await capture({
      name: "quoted-empty-vector",
      arguments: { argv: [] },
      template: "OUT<!`/usr/bin/printf '<%s>' \"$ARGUMENTS\" LAST`>",
    })
    expect(userText(result.requests[0])).toBe("OUT<<><LAST>>")
  }, 15000)
  test("native unclosed quote tolerance is preserved", async () => {
    const result = await capture({
      entry: "headless",
      name: "malformed-trusted-quote",
      operands: ["inert"],
      template: "OUT<!`/usr/bin/printf 'unterminated`> $1",
    })
    expect(userText(result.requests[0])).toBe("OUT<unterminated> inert")
  }, 15000)
})

test("malformed quoted substitution preserves catch error", async () => {
  const result = await capture({
    entry: "headless",
    name: "malformed-quoted-substitution",
    operands: ["inert"],
    template: 'OUT<!`/usr/bin/printf "$(/usr/bin/printf INERT"`> $1',
  })
  expect(userText(result.requests[0])).toBe("OUT<Error executing command: Unclosed command substitution> inert")
}, 15000)
