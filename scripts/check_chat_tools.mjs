#!/usr/bin/env node
/**
 * Check the assistant's tool definitions before they can ship.
 *
 * Every rule here is one that actually broke this feature, and each was caught either by the
 * Anthropic API rejecting a live request or by someone noticing a raw tool name in the UI. None of
 * them could be caught by the type checker: TypeScript cannot see inside a JSON file, and it has no
 * idea what the API will accept.
 *
 * The related check that *is* better done by the compiler stays there — `TOOL_LABEL` is typed
 * `Record<ToolName, string>` in the Assistant, so a tool without a label fails `tsc`. This script
 * covers what tsc structurally cannot.
 *
 * Zero dependencies, like the server, and for the same reason.
 *
 *   node scripts/check_chat_tools.mjs
 */

import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)))
const TOOLS_JSON = join(ROOT, 'src', 'chat', 'tools.json')
const TOOLS_TS = join(ROOT, 'src', 'chat', 'tools.ts')

/** The API accepts at most this many tools marked `strict`. Exceeding it is a hard 400. */
const MAX_STRICT = 20

/**
 * The API compiles the schemas into a grammar, and each union-typed parameter (`["string","null"]`,
 * `anyOf`, `oneOf`) multiplies its cost, so it refuses more than this many across the tools with a
 * 400 on every request. The seventh fault to reach a live request: the tools sat at 17 when the
 * Outlook was added, and every question the reader asked failed.
 */
const MAX_UNIONS = 16

/**
 * JSON Schema keywords the API rejects on a strict tool.
 *
 * They look harmless and are standard JSON Schema, which is exactly why they got written. Bounds
 * belong in the property's `description` instead, where the model still reads them — and the
 * handler should clamp the value regardless, because `strict` guarantees shape, not sanity.
 */
const BANNED_KEYWORDS = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'pattern',
]

const problems = []
const fail = (what, why, fix) => problems.push({ what, why, fix })

// ---- load ---------------------------------------------------------------------------------

let doc
try {
  doc = JSON.parse(readFileSync(TOOLS_JSON, 'utf8'))
} catch (err) {
  console.error(`\n  src/chat/tools.json is not valid JSON: ${err.message}\n`)
  process.exit(1)
}

const tools = Array.isArray(doc.tools) ? doc.tools : []
if (!tools.length) {
  console.error('\n  src/chat/tools.json has no tools in it.\n')
  process.exit(1)
}

// Handler names, read off the object literal in tools.ts. Deliberately textual: importing the
// module would mean compiling TypeScript, and this check has to stay cheap enough to run on
// every build.
const ts = readFileSync(TOOLS_TS, 'utf8')
const open = ts.indexOf('const HANDLERS = {')
const close = ts.indexOf('} satisfies Record<string, Handler>')
if (open < 0 || close < 0) {
  console.error('\n  Could not find the HANDLERS object in src/chat/tools.ts — has it been renamed?\n')
  process.exit(1)
}
const handlers = new Set(
  [...ts.slice(open, close).matchAll(/^ {2}(?:async )?([a-z_][a-z0-9_]*)\(/gm)].map((m) => m[1]),
)

// ---- checks -------------------------------------------------------------------------------

const names = tools.map((t) => t.name)
for (const name of new Set(names)) {
  if (names.filter((n) => n === name).length > 1) {
    fail(`tool "${name}"`, 'is defined more than once', 'remove the duplicate entry')
  }
}

for (const name of names) {
  if (!handlers.has(name)) {
    fail(`tool "${name}"`, 'has a schema but no handler', `add a \`${name}(input, ctx)\` method to HANDLERS in src/chat/tools.ts`)
  }
}
for (const name of handlers) {
  if (!names.includes(name)) {
    fail(`handler "${name}"`, 'has no schema, so the model can never call it', `add a schema for it to src/chat/tools.json`)
  }
}

const strict = tools.filter((t) => t.strict === true)
if (strict.length > MAX_STRICT) {
  fail(
    `${strict.length} strict tools`,
    `exceeds the API limit of ${MAX_STRICT}, which is a 400 on every request`,
    'drop `strict` from tools that take no input — it constrains nothing there and frees a slot',
  )
}

/** Every union-typed parameter, by tool and path, counted across all tools. */
const unions = []

/** Walk a schema, reporting anything the API will not take. */
function inspect(toolName, node, path) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    node.forEach((v) => inspect(toolName, v, path))
    return
  }

  if (path && (Array.isArray(node.type) || node.anyOf || node.oneOf)) unions.push(`${toolName}.${path}`)

  for (const key of BANNED_KEYWORDS) {
    if (key in node) {
      fail(
        `${toolName}.${path || '<root>'}`,
        `uses "${key}", which the API rejects on a strict tool`,
        `delete it and state the bound in the property's description instead; clamp the value in the handler`,
      )
    }
  }

  // A union type that includes null cannot also carry an enum of non-null values.
  if (Array.isArray(node.type) && node.type.includes('null') && Array.isArray(node.enum)) {
    const nonNull = node.enum.filter((v) => v !== null)
    if (nonNull.length) {
      fail(
        `${toolName}.${path || '<root>'}`,
        'is a nullable type with an enum, which the API rejects',
        'make it a plain string enum and add an explicit member such as "all" instead of null',
      )
    }
  }

  if (node.properties && typeof node.properties === 'object') {
    for (const [k, v] of Object.entries(node.properties)) {
      inspect(toolName, v, path ? `${path}.${k}` : k)
    }
  }
  if (node.items) inspect(toolName, node.items, `${path}[]`)
}

for (const t of tools) {
  const where = `tool "${t.name}"`
  if (!t.name) fail('a tool', 'has no name', 'give it one')
  if (!t.description) fail(where, 'has no description, so the model cannot tell when to use it', 'write one')

  const schema = t.input_schema
  if (!schema || schema.type !== 'object') {
    fail(where, 'has no object input_schema', 'give it `{ "type": "object", "additionalProperties": false, "properties": {}, "required": [] }`')
    continue
  }

  inspect(t.name, schema, '')

  if (t.strict === true) {
    if (schema.additionalProperties !== false) {
      fail(where, 'is strict but does not set additionalProperties:false', 'add it')
    }
    const props = Object.keys(schema.properties ?? {})
    const required = new Set(schema.required ?? [])
    const missing = props.filter((p) => !required.has(p))
    if (missing.length) {
      fail(
        where,
        `is strict but leaves ${missing.map((m) => `"${m}"`).join(', ')} out of \`required\``,
        'strict mode expects every property to be required; list them all, and describe any that are optional in practice',
      )
    }
    const stray = [...required].filter((r) => !props.includes(r))
    if (stray.length) {
      fail(where, `requires ${stray.map((s) => `"${s}"`).join(', ')}, which is not among its properties`, 'fix the name or remove it')
    }
  }
}

if (unions.length > MAX_UNIONS) {
  fail(
    `${unions.length} union-typed parameters`,
    `exceeds the API limit of ${MAX_UNIONS}, which is a 400 on every request (${unions.join(', ')})`,
    'replace a nullable parameter with a sentinel the handler already understands — an empty string for "leave it", or an explicit "keep"/"all" member',
  )
}

// ---- report -------------------------------------------------------------------------------

if (problems.length) {
  console.error(`\n  ${problems.length} problem${problems.length === 1 ? '' : 's'} in the assistant's tool definitions:\n`)
  for (const p of problems) {
    console.error(`    ${p.what}`)
    console.error(`      ${p.why}`)
    console.error(`      fix: ${p.fix}\n`)
  }
  console.error('  Every one of these is rejected by the Anthropic API at request time, not at build time,')
  console.error('  so shipping past this check means the assistant fails for the reader instead.\n')
  process.exit(1)
}

console.log(
  `  chat tools ok — ${tools.length} tools, ${strict.length}/${MAX_STRICT} strict, ${unions.length}/${MAX_UNIONS} union-typed, handlers and schemas agree`,
)
