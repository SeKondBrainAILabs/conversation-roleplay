import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpConversationAdapter } from '../src/adapters.mjs';

const actor = { id: 'adult', name: 'Synthetic family adult' };
const input = { worldId: 'house', actor, step: { id: 'options', actorId: 'adult', effect: 'read' }, message: 'OPTIONS', messageId: 'message-1', conversationId: 'conversation-1', history: [], shared: {} };
function fixture(response, extra = {}) {
  const calls = [];
  const adapter = new HttpConversationAdapter({
    type: 'http', baseUrl: 'http://fixture.invalid', qaOnly: true,
    bindings: { house: { adult: { qa: true, context: { userId: 3, householdId: 1 }, headersEnv: { Authorization: 'TOKEN' } } } },
    identity: { path: '/identity', assertions: [{ path: 'userId', op: 'eq', expected: '$actor.userId' }] },
    chat: { path: '/internal/ucg/household-channel', body: { message: { text: '$message', external_message_id: '$messageId' } } },
    responseTextBlocksPath: 'blocks', ...extra,
  }, { env: { TOKEN: 'synthetic-only' }, fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify(String(url).endsWith('/identity') ? { userId: 3 } : response));
  } });
  return { adapter, calls };
}

test('explicit native block renderer preserves all ordered family text and raw evidence', async () => {
  const response = { agent: 'basanti-family', blocks: [
    { type: 'text', text: 'Monday: dal, rice' },
    { type: 'text', text: 'Tuesday: chole, roti\nReply OPTIONS 2 for more choices.' },
    { type: 'text', text: 'Preferences are pending adult approval; the menu is unchanged.' },
  ], metadata: { outcome: 'options' } };
  const { adapter, calls } = fixture(response);
  const result = await adapter.send(input);
  assert.equal(result.text, response.blocks.map((block) => block.text).join('\n'));
  assert.equal(result.surface, 'native-text-blocks');
  assert.deepEqual(result.trace, response);
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { message: { text: 'OPTIONS', external_message_id: 'message-1' } });
});

test('native text blocks fail closed on incomplete or unrecognized content instead of silently truncating', async () => {
  for (const blocks of [undefined, [], [{ type: 'text', text: 'ok' }, { type: 'image', url: 'https://fixture.invalid/a' }], [{ type: 'text', text: 3 }]]) {
    const { adapter } = fixture({ blocks });
    await assert.rejects(adapter.send(input), /complete native text-block response/);
  }
  assert.throws(() => fixture({ blocks: [] }, { responsePaths: ['response'] }), /one explicit text-block path/);
  assert.throws(() => fixture({ blocks: [] }, { responseTextBlocksPath: '' }), /one explicit text-block path/);
});
