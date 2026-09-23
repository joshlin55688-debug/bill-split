const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

// 1. Read split.html and extract script
const html = fs.readFileSync('split.html', 'utf8');
const scriptMatch = html.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/i);
assert(scriptMatch, 'Inline script should exist in split.html');
const scriptCode = scriptMatch[1];

// 2. Set up DOM and environment mocks
class MockElement {
  constructor(id = '', tagName = 'div') {
    this.id = id;
    this.tagName = tagName.toUpperCase();
    this.value = '';
    this.textContent = '';
    this.innerHTML = '';
    this.style = {};
    this.classList = {
      classes: new Set(),
      add: (c) => this.classList.classes.add(c),
      remove: (c) => this.classList.classes.delete(c),
      toggle: (c, force) => {
        if (force === undefined) {
          if (this.classList.classes.has(c)) this.classList.classes.delete(c);
          else this.classList.classes.add(c);
        } else if (force) {
          this.classList.classes.add(c);
        } else {
          this.classList.classes.delete(c);
        }
      },
      contains: (c) => this.classList.classes.has(c)
    };
    this.children = [];
    this.attributes = {};
  }
  setAttribute(k, v) { this.attributes[k] = v; }
  getAttribute(k) { return this.attributes[k] || null; }
  appendChild(child) { this.children.push(child); return child; }
  querySelector(sel) { return new MockElement(); }
  querySelectorAll(sel) { return []; }
  addEventListener(evt, fn) {}
}

const elements = {};
function getOrCreateElement(id) {
  if (!elements[id]) {
    elements[id] = new MockElement(id);
  }
  return elements[id];
}

const mockStorage = {};
const localStorageMock = {
  getItem: (k) => mockStorage[k] || null,
  setItem: (k, v) => { mockStorage[k] = String(v); },
  removeItem: (k) => { delete mockStorage[k]; },
  clear: () => { Object.keys(mockStorage).forEach(k => delete mockStorage[k]); }
};

let lastCopiedText = '';
const mockContext = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Date,
  Math,
  String,
  Number,
  Boolean,
  Array,
  Object,
  JSON,
  encodeURIComponent,
  decodeURIComponent,
  escape,
  unescape,
  btoa: (str) => Buffer.from(str, 'binary').toString('base64'),
  atob: (b64) => Buffer.from(b64, 'base64').toString('binary'),
  URLSearchParams,
  localStorage: localStorageMock,
  isSecureContext: true,
  navigator: {
    clipboard: {
      writeText: async (t) => { lastCopiedText = t; }
    }
  },
  location: {
    search: '',
    origin: 'http://localhost',
    pathname: '/split.html'
  },
  window: {},
  document: {
    body: new MockElement('body'),
    getElementById: (id) => getOrCreateElement(id),
    querySelectorAll: (sel) => [],
    createElement: (tag) => new MockElement('', tag),
    activeElement: null
  },
  firebase: {
    initializeApp: () => {},
    database: () => ({
      ref: () => ({
        set: async () => {},
        on: () => {},
        off: () => {},
        child: () => ({
          set: async () => {},
          on: () => {},
          off: () => {},
          push: () => ({ key: '123' })
        })
      }),
      ServerValue: { TIMESTAMP: Date.now() }
    })
  },
  QRCode: function() {}
};

mockContext.window = mockContext;
vm.createContext(mockContext);

// Run the script in our context
vm.runInContext(scriptCode, mockContext);

console.log('--- RUNNING SPLIT.HTML INTEGRATION TESTS ---');

const appState = mockContext.getState();
assert(appState, 'State should be initialized');
assert.strictEqual(appState.poolMode, 'individual', 'Default poolMode should be individual');

// Test 1: sanitizeState backward compatibility
{
  console.log('Integration Test 1: sanitizeState backward compatibility');
  const legacyData = {
    billTitle: '舊帳單',
    members: [{ id: '1', name: 'A' }, { id: '2', name: 'B' }],
    expenses: [
      { id: 'e1', name: '飯錢', amount: 200, payerId: '1', splitMode: 'equal', participantIds: ['1', '2'] }
    ],
    pool: { '1': 100 }
  };
  const sanitized = mockContext.sanitizeState(legacyData);
  assert.strictEqual(sanitized.poolMode, 'individual', 'Omitted poolMode defaults to individual');
  assert.strictEqual(sanitized.members.length, 2);
  assert.strictEqual(sanitized.expenses.length, 1);
  assert.strictEqual(sanitized.pool['1'], 100);
  assert.strictEqual(sanitized.pool['2'], 0);

  const equalData = { ...legacyData, poolMode: 'equal' };
  const sanitizedEqual = mockContext.sanitizeState(equalData);
  assert.strictEqual(sanitizedEqual.poolMode, 'equal');
  console.log('✅ Integration Test 1 Passed!');
}

// Test 2: Core User Scenario directly on app state
{
  console.log('Integration Test 2: Core User Scenario on split.html exported functions');
  const testState = {
    billTitle: '員工旅遊分帳',
    members: [
      { id: 'sponsor', name: '老闆' },
      { id: 'hua', name: '小華' },
      { id: 'mei', name: '小美' },
      { id: 'hao', name: '阿豪' }
    ],
    expenses: [
      {
        id: 'e1',
        name: '聚餐大餐',
        amount: 2000,
        payerId: 'hua',
        splitMode: 'equal',
        participantIds: ['sponsor', 'hua', 'mei', 'hao'] // 500 each
      }
    ],
    pool: { sponsor: 10000, hua: 0, mei: 0, hao: 0 },
    poolMode: 'individual'
  };

  mockContext.setState(testState);
  const calc = mockContext.computeBalances(mockContext.getState());
  const txs = mockContext.minimizeTransactions(calc.bal);

  console.log('Calculated Balances:', calc.bal);
  console.log('Generated Transfers:', txs);
  console.log('Pool Offsets:', calc.poolOffset);
  console.log('Pool Reimbursed:', calc.poolReimbursed);
  console.log('Pool Personal Remain:', calc.poolPersonalRemain);

  // Assertions:
  // 1. Sponsor owes 0 and receives 0 direct transfer
  assert.strictEqual(calc.bal['sponsor'], 0);
  assert.strictEqual(txs.some(t => t.from === 'sponsor' || t.to === 'sponsor'), false);

  // 2. Hua paid 2000, consumed 500, reimbursed 500 from pool -> bal = +1000
  assert.strictEqual(calc.bal['hua'], 1000);
  assert.strictEqual(calc.poolReimbursed['hua'], 500);

  // 3. Mei owes 500, Hao owes 500
  assert.strictEqual(calc.bal['mei'], -500);
  assert.strictEqual(calc.bal['hao'], -500);

  // 4. Sponsor pool remaining is 9500
  assert.strictEqual(calc.poolOffset['sponsor'], 500);
  assert.strictEqual(calc.poolPersonalRemain['sponsor'], 9500);

  // 5. Zero-sum strictly holds
  const sum = Object.values(calc.bal).reduce((a, b) => a + b, 0);
  assert.strictEqual(Math.abs(sum) < 0.0001, true);

  // 6. Transfers are Mei -> Hua $500, Hao -> Hua $500
  assert.strictEqual(txs.length, 2);
  const txMei = txs.find(t => t.from === 'mei' && t.to === 'hua');
  const txHao = txs.find(t => t.from === 'hao' && t.to === 'hua');
  assert(txMei && txMei.amount === 500);
  assert(txHao && txHao.amount === 500);

  console.log('✅ Integration Test 2 Passed!');
}

// Test 3: Test copyResult text format
{
  console.log('Integration Test 3: verify copyResult output format');
  mockContext.copyResult();
  console.log('Copied settlement text:\n' + lastCopiedText);

  assert(lastCopiedText.includes('【員工旅遊分帳】'));
  assert(lastCopiedText.includes('費用合計：$2000'));
  assert(lastCopiedText.includes('公費/贊助池（個人預繳扣抵）：總預繳 $10000 · 總支出/補償 $500 · 剩餘 $9500'));
  assert(lastCopiedText.includes('老闆：已結清 $0（預繳 $10000，扣抵 $500，餘 $9500）'));
  assert(lastCopiedText.includes('小華：應收 +$1000（由贊助款收回代墊 $500）'));
  assert(lastCopiedText.includes('小美：應付 -$500'));
  assert(lastCopiedText.includes('阿豪：應付 -$500'));
  assert(lastCopiedText.includes('小美 → 小華：$500'));
  assert(lastCopiedText.includes('阿豪 → 小華：$500'));
  assert(lastCopiedText.includes('公費/贊助款退還與代墊補償（由公費保管人處理）：'));
  assert(lastCopiedText.includes('代墊補償：小華 代墊款由公費/贊助款退回 $500'));
  assert(lastCopiedText.includes('餘額退還：老闆 預繳款尚有剩餘 $9500，由公費保管人退還本人。'));

  console.log('✅ Integration Test 3 Passed!');
}

// Test 4: Switching to Equal Mode and Back
{
  console.log('Integration Test 4: Mode switching');
  mockContext.setPoolMode('equal');
  assert.strictEqual(mockContext.getState().poolMode, 'equal');

  const equalCalc = mockContext.computeBalances(mockContext.getState());
  console.log('Equal Mode Balances:', equalCalc.bal);
  // In equal mode, Hua paid 2000, pool is 10000.
  // Pool remain = 10000. Each member share = 2500.
  // Hua: +1500 (exp) - 2500 (pool) = -1000
  // Sponsor: -500 (exp) + (10000 - 2500) = +7000
  // Mei: -500 (exp) - 2500 (pool) = -3000
  // Hao: -500 (exp) - 2500 (pool) = -3000
  assert.strictEqual(equalCalc.bal['sponsor'], 7000);
  assert.strictEqual(equalCalc.bal['hua'], -1000);
  assert.strictEqual(equalCalc.bal['mei'], -3000);
  assert.strictEqual(equalCalc.bal['hao'], -3000);

  // Switch back to individual
  mockContext.setPoolMode('individual');
  assert.strictEqual(mockContext.getState().poolMode, 'individual');
  const indCalc = mockContext.computeBalances(mockContext.getState());
  assert.strictEqual(indCalc.bal['sponsor'], 0);
  assert.strictEqual(indCalc.bal['hua'], 1000);
  console.log('✅ Integration Test 4 Passed!');
}

// Test 5: Expense paid by Pool in individual mode
{
  console.log('Integration Test 5: Expense paid by Pool with accurate pool remaining cash');
  const testState = {
    billTitle: '員工旅遊公費門票',
    members: [
      { id: 'sponsor', name: '老闆' },
      { id: 'hua', name: '小華' },
      { id: 'mei', name: '小美' }
    ],
    expenses: [
      {
        id: 'e1',
        name: '公費門票',
        amount: 1200,
        payerId: 'pool',
        splitMode: 'equal',
        participantIds: ['sponsor', 'hua', 'mei']
      }
    ],
    pool: { sponsor: 10000, hua: 0, mei: 0 },
    poolMode: 'individual'
  };

  mockContext.setState(testState);
  mockContext.renderSettle();
  const poolBodyHtml = getOrCreateElement('settle-pool-body').innerHTML;
  console.log('Pool Body HTML:', poolBodyHtml);
  assert(poolBodyHtml.includes('總繳入 <strong>$10000</strong> · 支出/補償 <strong>$1200</strong> · 剩餘款項 <strong>$8800</strong>'));
  assert(poolBodyHtml.includes('老闆</strong>：預繳 <strong>$10000</strong> · 扣抵個人消費 <strong>$400</strong> · 代墊公費支出 <strong>$800</strong>（由轉帳收回） · 剩餘 <strong>$8800</strong>（退還本人）'));

  mockContext.copyResult();
  console.log('Copied Pool Expense Text:\n' + lastCopiedText);
  assert(lastCopiedText.includes('公費/贊助池（個人預繳扣抵）：總預繳 $10000 · 總支出/補償 $1200 · 剩餘 $8800'));
  assert(lastCopiedText.includes('老闆：應收 +$800（預繳 $10000，扣抵 $400，餘 $8800；代墊公費 $800（由轉帳收回））'));
  assert(lastCopiedText.includes('餘額退還：老闆 預繳款尚有剩餘 $8800，由公費保管人退還本人。'));

  const calc = mockContext.computeBalances();
  assert.strictEqual(calc.bal['sponsor'], 800);
  assert.strictEqual(calc.bal['hua'], -400);
  assert.strictEqual(calc.bal['mei'], -400);
  assert.strictEqual(calc.poolPersonalRemain['sponsor'], 8800);
  const sum = Object.values(calc.bal).reduce((a, b) => a + b, 0);
  assert.strictEqual(Math.abs(sum) < 0.0001, true);

  console.log('✅ Integration Test 5 Passed!');
}

// Test 6: Zero Deposit Pool Expense Deficit Handling
{
  console.log('Integration Test 6: Zero deposit pool expense deficit');
  const testState = {
    billTitle: '赤字測試',
    members: [
      { id: 'm1', name: '小華' },
      { id: 'm2', name: '小美' }
    ],
    expenses: [
      { id: 'e1', name: '公費門票', amount: 1000, payerId: 'pool', splitMode: 'equal', participantIds: ['m1', 'm2'] }
    ],
    pool: { m1: 0, m2: 0 },
    poolMode: 'individual'
  };

  mockContext.setState(testState);
  const calc = mockContext.computeBalances();
  console.log('Zero Deposit Deficit Balances:', calc.bal);
  assert.strictEqual(calc.bal['m1'], 0);
  assert.strictEqual(calc.bal['m2'], 0);
  const sum = Object.values(calc.bal).reduce((a, b) => a + b, 0);
  assert.strictEqual(Math.abs(sum) < 0.0001, true);

  mockContext.renderSettle();
  const poolTitle = getOrCreateElement('settle-pool-title').textContent;
  assert(poolTitle.includes('透支'));

  console.log('✅ Integration Test 6 Passed!');
}

console.log('--- ALL INTEGRATION TESTS PASSED SUCCESSFULLY! ---');
