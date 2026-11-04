#!/usr/bin/env node
// Mock Messages-compatible endpoint (what dsh's DeepSeek adapter speaks), so
// end-to-end tests exercise a real agent turn without a real API key.
// Every reply states where it ran, which proves the agent ran on the device.
import http from 'node:http'
import os from 'node:os'

const port = Number(process.argv[2] || 4599)
const label = process.argv[3] || 'VPS'
let count = 0

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

http
  .createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const url = new URL(req.url, 'http://x')
      if (req.method === 'GET' && url.pathname.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'deepseek-flash', type: 'model', display_name: 'mock flash' }], has_more: false }))
        return
      }
      if (req.method !== 'POST' || !url.pathname.endsWith('/messages')) {
        res.writeHead(404)
        res.end()
        return
      }
      let json = {}
      try {
        json = JSON.parse(body)
      } catch {}
      count += 1
      const last = [...(json.messages ?? [])].reverse().find((m) => m.role === 'user')
      const prompt = typeof last?.content === 'string' ? last.content : (last?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(' ')
      const text = `[${label}] MOCK-REPLY #${count} — agent running on ${label} (${os.hostname()}). You said: ${String(prompt).slice(-80)}`
      console.log(`[mock-llm] request #${count} model=${json.model} stream=${json.stream} prompt=${JSON.stringify(String(prompt).slice(-80))}`)
      const usage = { input_tokens: 12, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
      // Scripted tool calls, so tests can make a remote agent wait for the user:
      //   "NEED-APPROVAL"     → a write asking for a wider sandbox mode (needs approval)
      //   "ASK-QUESTION"      → ask_user_question
      //   "START-SERVER <n>"  → bash runs http.server on port n until it becomes a DSH job
      // Only when the last user turn is that prompt (not a tool result).
      const tools = Array.isArray(json.tools) ? json.tools : []
      if (count === 1 || process.env.MOCK_DUMP_TOOLS) console.log(`[mock-llm] tools: ${tools.map((x) => x.name).join(', ')}`)
      const lastIsText = typeof last?.content === 'string' || (Array.isArray(last?.content) && !last.content.some((b) => b.type === 'tool_result'))
      let toolUse = null
      if (lastIsText && /NEED-APPROVAL/.test(prompt)) {
        // A write that asks for a wider sandbox mode: the agent must get the user's approval first.
        const tool = tools.find((x) => x.name === 'write')
        const props = tool?.input_schema?.properties ?? {}
        if (tool && props.sandbox_permissions) {
          const pathKey = Object.keys(props).find((k) => /path|file/i.test(k)) || 'path'
          const contentKey = Object.keys(props).find((k) => /content|text/i.test(k)) || 'content'
          const modes = props.sandbox_permissions.enum ?? ['danger-full-access']
          toolUse = { name: 'write', input: { [pathKey]: `/tmp/dshdev-approval-${count}.txt`, [contentKey]: 'approved\n', sandbox_permissions: modes[modes.length - 1], justification: 'e2e: needs your approval' } }
          console.log(`[mock-llm] tool write schema=${JSON.stringify(tool.input_schema).slice(0, 300)}`)
        }
      }
      if (lastIsText && /START-SERVER \d+/.test(prompt)) {
        // A dev server started the way agents often do it: detached, in the session's folder.
        const port = Number(String(prompt).match(/START-SERVER (\d+)/)[1])
        const tool = tools.find((x) => x.name === 'bash')
        // DSH ends every process a command leaves behind; a long-running server is a
        // foreground command that outlives its timeout and keeps running as a DSH job.
        if (tool) toolUse = { name: 'bash', input: { description: 'Start a preview server', command: `python3 -m http.server ${port} --bind 127.0.0.1`, timeoutMs: 2000 } }
      }
      if (lastIsText && /ASK-QUESTION/.test(prompt)) {
        const tool = tools.find((x) => x.name === 'ask_user_question')
        if (tool) {
          console.log(`[mock-llm] tool ask_user_question schema=${JSON.stringify(tool.input_schema).slice(0, 600)}`)
          toolUse = { name: 'ask_user_question', input: { questions: [{ id: 'color', question: 'Which color should the button be?', header: 'Color', options: [{ label: 'Blue', description: 'Calm' }, { label: 'Green', description: 'Fresh' }], multi_select: false }] } }
        }
      }
      if (toolUse) {
        const id = `toolu_mock_${count}`
        if (!json.stream) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ id: `msg_mock_${count}`, type: 'message', role: 'assistant', model: json.model, content: [{ type: 'tool_use', id, name: toolUse.name, input: toolUse.input }], stop_reason: 'tool_use', stop_sequence: null, usage }))
          return
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        sse(res, 'message_start', { type: 'message_start', message: { id: `msg_mock_${count}`, type: 'message', role: 'assistant', model: json.model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } })
        sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name: toolUse.name, input: {} } })
        sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolUse.input) } })
        sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
        sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } })
        sse(res, 'message_stop', { type: 'message_stop' })
        res.end()
        return
      }
      if (!json.stream) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: `msg_mock_${count}`, type: 'message', role: 'assistant', model: json.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      sse(res, 'message_start', { type: 'message_start', message: { id: `msg_mock_${count}`, type: 'message', role: 'assistant', model: json.model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } })
      sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      const words = text.split(/(?<= )/)
      let i = 0
      const timer = setInterval(() => {
        if (i < words.length) {
          sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: words[i++] } })
          return
        }
        clearInterval(timer)
        sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
        sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } })
        sse(res, 'message_stop', { type: 'message_stop' })
        res.end()
      }, 15)
    })
  })
  .listen(port, '127.0.0.1', () => console.log(`[mock-llm] listening on 127.0.0.1:${port}`))
