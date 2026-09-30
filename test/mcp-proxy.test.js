import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('MCP server lists the Flow tools over stdio without corrupting the stream', async (t) => {
  const transport = new StdioClientTransport({ command: process.execPath, args: ['src/index.js'] });
  const client = new Client({ name: 'proxy-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(() => client.close());
  const { tools } = await client.listTools();
  assert.ok(tools.some((tool) => tool.name === 'flow_generate_video'));
  assert.equal(tools.length, 17);
});
