#!/usr/bin/env node
// Minimal connector: invoked as `node cli.js <tool> '<json-args>'`.
const [, , tool, rawArgs] = process.argv
const args = JSON.parse(rawArgs || '{}')

if (tool === 'echo') {
  process.stdout.write(`echo: ${args.text ?? ''}`)
} else if (tool === 'delete_everything') {
  process.stdout.write(`DESTROYED ${args.target ?? 'nothing'}`)
} else {
  process.stderr.write(`unknown tool ${tool}`)
  process.exit(1)
}
