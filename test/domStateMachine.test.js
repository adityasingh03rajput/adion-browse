'use strict';

const assert = require('assert');
const {
  waitForDOMCondition,
  waitForNavigationSettled,
  waitForURLChange,
  waitForTabCountChange,
  waitForTabClose,
  waitForScrollChange,
  retryWithBackoff,
  StateMachine
} = require('../src/control-plane/domStateMachine');

async function runTests() {
  console.log('--- Running DOM State Machine Unit Tests ---');

  // Test 1: StateMachine Execution
  {
    const sm = new StateMachine('test-workflow');
    let order = [];
    sm.define('start', (ctx) => {
      order.push('start');
      return sm.to('verifying', { step: 1 });
    });
    sm.define('verifying', (ctx) => {
      order.push(`verify-${ctx.step}`);
      return sm.done({ success: true, processed: true });
    });

    const res = await sm.run('start');
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.processed, true);
    assert.deepStrictEqual(order, ['start', 'verify-1']);
    console.log('✓ Test 1: StateMachine transitions & context pass');
  }

  // Test 2: retryWithBackoff success
  {
    let attempts = 0;
    const res = await retryWithBackoff(async (attempt) => {
      attempts++;
      if (attempt < 3) return { success: false };
      return { success: true, data: 'loaded' };
    }, { initialMs: 10, maxMs: 50 });

    assert.strictEqual(attempts, 3);
    assert.strictEqual(res.result.success, true);
    assert.strictEqual(res.result.data, 'loaded');
    console.log('✓ Test 2: retryWithBackoff handles transient failures and succeeds');
  }

  // Test 3: waitForTabCountChange
  {
    const fakeTabManager = { tabs: new Map() };
    setTimeout(() => {
      fakeTabManager.tabs.set('tab-1', {});
    }, 50);

    const res = await waitForTabCountChange(fakeTabManager, 0, { direction: 'increase', timeoutMs: 500, pollMs: 20 });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.count, 1);
    console.log('✓ Test 3: waitForTabCountChange detects tab addition');
  }

  // Test 4: waitForTabClose
  {
    const fakeTabManager = { tabs: new Map([['tab-1', {}]]) };
    setTimeout(() => {
      fakeTabManager.tabs.delete('tab-1');
    }, 50);

    const res = await waitForTabClose(fakeTabManager, 'tab-1', { timeoutMs: 500, pollMs: 20 });
    assert.strictEqual(res.ok, true);
    console.log('✓ Test 4: waitForTabClose detects tab destruction');
  }

  // Test 5: waitForDOMCondition with fake webContents
  {
    let count = 0;
    const fakeWc = {
      isDestroyed: () => false,
      executeJavaScript: async (expr) => {
        count++;
        return count >= 3;
      }
    };

    const res = await waitForDOMCondition(fakeWc, 'document.querySelector(".ready")', { timeoutMs: 500, pollMs: 20 });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.timedOut, false);
    console.log('✓ Test 5: waitForDOMCondition polls until DOM condition holds');
  }

  // Test 6: waitForNavigationSettled
  {
    const EventEmitter = require('events');
    const fakeWc = new EventEmitter();
    fakeWc.isDestroyed = () => false;
    let loading = true;
    fakeWc.isLoading = () => loading;

    setTimeout(() => {
      loading = false;
      fakeWc.emit('did-stop-loading');
    }, 50);

    const res = await waitForNavigationSettled(fakeWc, { timeoutMs: 500 });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.timedOut, false);
    console.log('✓ Test 6: waitForNavigationSettled listens to did-stop-loading');
  }

  console.log('--- All DOM State Machine Tests Passed Successfully! ---');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
