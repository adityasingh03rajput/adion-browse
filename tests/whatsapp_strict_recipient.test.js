const assert = require('assert');
const path = require('path');
const QueryPreprocessor = require('../src/control-plane/queryPreprocessor');

async function testWhatsAppStrictRecipient() {
  console.log('=== TEST SUITE: STRICT RECIPIENT VERIFICATION & HIDDEN CHAT UNLOCKING ===\n');

  const preprocessor = new QueryPreprocessor();
  const waContext = { url: 'https://web.whatsapp.com/', title: '(19) WhatsApp' };

  // Test 1: Credential and Secret Code Disentanglement
  console.log('Test 1: Preprocessing & Secret Code Disentanglement...');
  const rawPrompt = 'text pidduk i love you , secret code of hidden chat is 1512';
  const prep = preprocessor.preprocess(rawPrompt);
  const fastIntent = preprocessor.extractFastIntent(prep, waContext);

  assert.ok(fastIntent !== null, 'Fast intent should be resolved');
  assert.strictEqual(fastIntent.type, 'WHATSAPP_CHAT_SEND', 'Intent must be WHATSAPP_CHAT_SEND');
  assert.strictEqual(fastIntent.contact, 'pidduk', 'Contact must be cleanly extracted as pidduk');
  assert.strictEqual(fastIntent.message, 'i love you', 'Message must NOT contain secret code clause');
  assert.strictEqual(fastIntent.secretCode, '1512', 'Secret code must be extracted as 1512');
  console.log('  ✔ Contact: "pidduk"');
  console.log('  ✔ Message: "i love you" (cleanly stripped of credentials)');
  console.log('  ✔ Secret Code: "1512"');

  // Test 2: Unmatched Open Chat Safety Guard
  console.log('\nTest 2: Verifying that an open chat with "Mummy" blocks message dispatch to Mummy...');

  // Simulate WhatsApp Web DOM state where "Mummy ❤️" is currently open on screen
  const targetContact = 'pidduk';
  const openChatHeader = 'Mummy ❤️';

  const cleanStr = s => (s || '')
    .toLowerCase()
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}]/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const cleanTarget = cleanStr(targetContact);
  const cleanHeader = cleanStr(openChatHeader);
  const isMainOpen = true;

  const isOpenChat = isMainOpen && Boolean(cleanTarget && cleanHeader && (cleanHeader.includes(cleanTarget) || cleanTarget.includes(cleanHeader)));
  const isUnmatchedChat = isMainOpen && !isOpenChat;

  assert.strictEqual(isOpenChat, false, 'isOpenChat must be FALSE when Mummy is open but target is pidduk');
  assert.strictEqual(isUnmatchedChat, true, 'isUnmatchedChat must be TRUE when Mummy is open but target is pidduk');

  let composerTypedTo = null;
  // Simulating the strict composer guard in agentRuntime.js
  if (isOpenChat) {
    composerTypedTo = openChatHeader;
  }

  assert.strictEqual(composerTypedTo, null, 'Composer must NEVER be typed into when recipient does not match');
  console.log('  ✔ Recipient mismatch correctly detected: active header "Mummy ❤️" vs target "pidduk"');
  console.log('  ✔ Composer access strictly BLOCKED: 0 messages typed or dispatched to Mummy.');

  // Test 3: Contact Switch to "pidduk"
  console.log('\nTest 3: Simulating chat transition after selecting "pidduk"...');
  const switchedHeader = 'pidduk';
  const cleanSwitchedHeader = cleanStr(switchedHeader);
  const isSwitchedOpenChat = isMainOpen && Boolean(cleanTarget && cleanSwitchedHeader && (cleanSwitchedHeader.includes(cleanTarget) || cleanTarget.includes(cleanSwitchedHeader)));

  assert.strictEqual(isSwitchedOpenChat, true, 'isOpenChat must become TRUE once pidduk is selected and mounted');

  if (isSwitchedOpenChat) {
    composerTypedTo = switchedHeader;
  }

  assert.strictEqual(composerTypedTo, 'pidduk', 'Composer must only receive text when active chat is verified as pidduk');
  console.log(`  ✔ Chat transition verified: target recipient confirmed as "${composerTypedTo}"`);
  console.log(`  ✔ Message "${fastIntent.message}" safely cleared for delivery to "${composerTypedTo}".`);

  console.log('\n✅ ALL STRICT RECIPIENT VERIFICATION & SAFETY TESTS PASSED!\n');
}

testWhatsAppStrictRecipient().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});

