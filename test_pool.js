// Comprehensive Test Suite for Bill Split Pool and Settlement Logic
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

// Load computeBalances and minimizeTransactions directly from split.html
const html = fs.readFileSync('split.html', 'utf8');
const scriptMatch = html.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/i);
assert(scriptMatch, 'Inline script should exist in split.html');
const scriptCode = scriptMatch[1];

class MockElement {
  constructor(id = '') {
    this.id = id;
    this.style = {};
    this.classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
    this.children = [];
  }
  setAttribute() {}
  getAttribute() { return null; }
  appendChild(c) { this.children.push(c); return c; }
  querySelector() { return new MockElement(); }
  querySelectorAll() { return []; }
  addEventListener() {}
}

const elements = {};
function getEl(id) {
  if (!elements[id]) elements[id] = new MockElement(id);
  return elements[id];
}

const sandbox = {
  document: {
    getElementById: getEl,
    createElement: (tag) => new MockElement(tag),
    querySelectorAll: () => [],
    addEventListener: () => {}
  },
  window: {},
  navigator: { clipboard: { writeText: () => Promise.resolve() } },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  location: { search: '', hash: '', origin: 'http://localhost', pathname: '/split.html' },
  URLSearchParams,
  setTimeout: () => {},
  clearTimeout: () => {},
  console: console
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(scriptCode, sandbox);

const computeBalances = sandbox.computeBalances;
const minimizeTransactions = sandbox.minimizeTransactions;

console.log('--- RUNNING TEST SUITE ---');

// Test 1: Core Sponsor Scenario
{
  console.log('Test 1: Core Sponsor Scenario');
  const s = {
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
        participantIds: ['sponsor', 'hua', 'mei', 'hao']
      }
    ],
    pool: { sponsor: 10000, hua: 0, mei: 0, hao: 0 },
    poolMode: 'individual'
  };

  const res = computeBalances(s);
  const txs = minimizeTransactions(res.bal);

  console.log('Balances:', res.bal);
  console.log('Transfers:', txs);
  console.log('Pool offsets:', res.poolOffset);
  console.log('Pool reimbursed to payers:', res.poolReimbursed);
  console.log('Pool remain per member:', res.poolPersonalRemain);

  assert.strictEqual(res.bal['sponsor'], 0);
  assert.strictEqual(res.bal['hua'], 1000);
  assert.strictEqual(res.bal['mei'], -500);
  assert.strictEqual(res.bal['hao'], -500);

  assert.strictEqual(res.poolOffset['sponsor'], 500);
  assert.strictEqual(res.poolPersonalRemain['sponsor'], 9500);
  assert.strictEqual(res.poolReimbursed['hua'], 500);

  const sum = Object.values(res.bal).reduce((a, b) => a + b, 0);
  assert.strictEqual(Math.abs(sum) < 0.001, true, 'Sum of balances must be 0');
  console.log('✅ Test 1 Passed!');
}

// Test 2: Expense paid by Pool
{
  console.log('Test 2: Expense paid by Pool with accurate pool remaining cash');
  const s = {
    members: [
      { id: 'sponsor', name: 'Sponsor' },
      { id: 'hua', name: '小華' },
      { id: 'mei', name: '小美' },
      { id: 'hao', name: '阿豪' }
    ],
    expenses: [
      {
        id: 'e1',
        name: '公費門票',
        amount: 1000,
        payerId: 'pool',
        splitMode: 'equal',
        participantIds: ['sponsor', 'hua', 'mei', 'hao']
      }
    ],
    pool: { sponsor: 10000, hua: 0, mei: 0, hao: 0 },
    poolMode: 'individual'
  };

  const res = computeBalances(s);
  const txs = minimizeTransactions(res.bal);

  console.log('Balances:', res.bal);
  console.log('Transfers:', txs);
  console.log('Pool personal remain:', res.poolPersonalRemain);

  // Sponsor:
  // Paid 10000 into pool envelope.
  // Pool paid 1000 out for tickets.
  // Cash remaining in pool envelope = 9000!
  // res.poolPersonalRemain['sponsor'] must equal 9000!
  assert.strictEqual(res.poolPersonalRemain['sponsor'], 9000);
  assert.strictEqual(res.poolOffset['sponsor'], 250);
  assert.strictEqual(res.poolCred['sponsor'], 750);

  // Transfers: Hua, Mei, Hao owe Sponsor 250 each
  assert.strictEqual(res.bal['sponsor'], 750);
  assert.strictEqual(res.bal['hua'], -250);
  assert.strictEqual(res.bal['mei'], -250);
  assert.strictEqual(res.bal['hao'], -250);

  // Sponsor receives: $9,000 (pool cash) + $750 (transfers) = $9,750
  // Net spent by Sponsor = $10,000 - $9,750 = $250 (exact share)
  const sum = Object.values(res.bal).reduce((a, b) => a + b, 0);
  assert.strictEqual(Math.abs(sum) < 0.001, true, 'Sum must be 0');
  console.log('✅ Test 2 Passed!');
}

// Test 3: Mixed (Member paid + Pool paid)
{
  console.log('Test 3: Mixed expenses');
  const s = {
    members: [
      { id: 'sponsor', name: 'Sponsor' },
      { id: 'hua', name: '小華' },
      { id: 'mei', name: '小美' }
    ],
    expenses: [
      {
        id: 'e1',
        name: '午餐',
        amount: 1500,
        payerId: 'hua',
        splitMode: 'equal',
        participantIds: ['sponsor', 'hua', 'mei'] // 500 each
      },
      {
        id: 'e2',
        name: '計程車',
        amount: 600,
        payerId: 'pool',
        splitMode: 'equal',
        participantIds: ['sponsor', 'hua', 'mei'] // 200 each
      }
    ],
    pool: { sponsor: 5000, hua: 0, mei: 0 },
    poolMode: 'individual'
  };

  const res = computeBalances(s);
  const txs = minimizeTransactions(res.bal);

  console.log('Balances:', res.bal);
  console.log('Transfers:', txs);

  // Sponsor deposited 5000.
  // Pool paid: 600 (taxi) + 500 (reimbursed to Hua) = 1100.
  // Cash remaining in pool envelope = 5000 - 1100 = 3900!
  assert.strictEqual(res.poolPersonalRemain['sponsor'], 3900);
  assert.strictEqual(res.poolReimbursed['hua'], 500);

  // Balances:
  // Sponsor fronted 400 of pool taxi for Hua and Mei -> bal = +400
  // Hua: paid 1500, self 500, reimbursed 500 from pool, owes taxi 200, Mei owes 500 -> net = +300
  // Mei: owes 500 lunch + 200 taxi = -700
  assert.strictEqual(res.bal['sponsor'], 400);
  assert.strictEqual(res.bal['hua'], 300);
  assert.strictEqual(res.bal['mei'], -700);

  const sum = Object.values(res.bal).reduce((a, b) => a + b, 0);
  assert.strictEqual(Math.abs(sum) < 0.001, true, 'Sum must be 0');
  console.log('✅ Test 3 Passed!');
}

// Test 4: Prepaid Pool Exhaustion
{
  console.log('Test 4: Prepaid Pool Exhaustion');
  const s = {
    members: [
      { id: 'sponsor', name: 'Sponsor' },
      { id: 'hua', name: '小華' }
    ],
    expenses: [
      {
        id: 'e1',
        name: '大餐',
        amount: 1000,
        payerId: 'hua',
        splitMode: 'equal',
        participantIds: ['sponsor', 'hua'] // 500 each
      }
    ],
    pool: { sponsor: 300, hua: 0 },
    poolMode: 'individual'
  };

  const res = computeBalances(s);
  assert.strictEqual(res.poolOffset['sponsor'], 300);
  assert.strictEqual(res.poolPersonalRemain['sponsor'], 0);
  assert.strictEqual(res.poolReimbursed['hua'], 300);
  assert.strictEqual(res.bal['sponsor'], -200);
  assert.strictEqual(res.bal['hua'], 200);

  const sum = Object.values(res.bal).reduce((a, b) => a + b, 0);
  assert.strictEqual(Math.abs(sum) < 0.001, true);
  console.log('✅ Test 4 Passed!');
}

// Test 5: Rounding with odd division
{
  console.log('Test 5: Rounding with odd division');
  const s = {
    members: [
      { id: 'm1', name: 'Member 1' },
      { id: 'm2', name: 'Member 2' },
      { id: 'm3', name: 'Member 3' }
    ],
    expenses: [
      {
        id: 'e1',
        name: 'Odd expense',
        amount: 100,
        payerId: 'm1',
        splitMode: 'equal',
        participantIds: ['m1', 'm2', 'm3']
      }
    ],
    pool: {},
    poolMode: 'individual'
  };

  const res = computeBalances(s);
  const sum = Object.values(res.bal).reduce((a, b) => a + b, 0);
  assert.strictEqual(Math.abs(sum) < 0.001, true, 'Sum must be strictly 0');
  console.log('✅ Test 5 Passed!');
}

// Test 6: Legacy Equal Mode
{
  console.log('Test 6: Legacy Equal Mode');
  const s = {
    members: [
      { id: 'm1', name: 'Member 1' },
      { id: 'm2', name: 'Member 2' }
    ],
    expenses: [
      {
        id: 'e1',
        name: 'Expense',
        amount: 200,
        payerId: 'm1',
        splitMode: 'equal',
        participantIds: ['m1', 'm2']
      }
    ],
    pool: { m1: 500, m2: 100 },
    poolMode: 'equal'
  };

  const res = computeBalances(s);
  assert.strictEqual(res.bal['m1'], 300);
  assert.strictEqual(res.bal['m2'], -300);
  const sum = Object.values(res.bal).reduce((a, b) => a + b, 0);
  assert.strictEqual(Math.abs(sum) < 0.001, true);
  console.log('✅ Test 6 Passed!');
}

// Test 7: Multiple Sponsors
{
  console.log('Test 7: Multiple Sponsors');
  const s = {
    members: [
      { id: 's1', name: 'Sponsor 1' },
      { id: 's2', name: 'Sponsor 2' },
      { id: 'm1', name: 'Member 1' },
      { id: 'payer', name: 'Payer' }
    ],
    expenses: [
      {
        id: 'e1',
        name: 'Dinner',
        amount: 1600,
        payerId: 'payer',
        splitMode: 'equal',
        participantIds: ['s1', 's2', 'm1', 'payer'] // 400 each
      }
    ],
    pool: { s1: 5000, s2: 3000, m1: 0, payer: 0 },
    poolMode: 'individual'
  };

  const res = computeBalances(s);
  assert.strictEqual(res.bal['s1'], 0);
  assert.strictEqual(res.bal['s2'], 0);
  assert.strictEqual(res.bal['m1'], -400);
  assert.strictEqual(res.bal['payer'], 400);

  assert.strictEqual(res.poolReimbursed['payer'], 800);
  assert.strictEqual(res.poolPersonalRemain['s1'], 4600);
  assert.strictEqual(res.poolPersonalRemain['s2'], 2600);

  const sum = Object.values(res.bal).reduce((a, b) => a + b, 0);
  assert.strictEqual(Math.abs(sum) < 0.001, true);
  console.log('✅ Test 7 Passed!');
}

// Test 8: Custom Splits with Sponsor
{
  console.log('Test 8: Custom Splits with Sponsor');
  const s = {
    members: [
      { id: 's1', name: 'Sponsor' },
      { id: 'm1', name: 'Member' },
      { id: 'payer', name: 'Payer' }
    ],
    expenses: [
      {
        id: 'e1',
        name: 'Custom',
        amount: 1000,
        payerId: 'payer',
        splitMode: 'custom',
        customSplits: { s1: 300, m1: 500, payer: 200 }
      }
    ],
    pool: { s1: 1000, m1: 0, payer: 0 },
    poolMode: 'individual'
  };

  const res = computeBalances(s);
  assert.strictEqual(res.bal['s1'], 0);
  assert.strictEqual(res.bal['m1'], -500);
  assert.strictEqual(res.bal['payer'], 500);
  assert.strictEqual(res.poolPersonalRemain['s1'], 700);

  const sum = Object.values(res.bal).reduce((a, b) => a + b, 0);
  assert.strictEqual(Math.abs(sum) < 0.001, true);
  console.log('✅ Test 8 Passed!');
}

// Test 9: Zero Expenses, Only Pool
{
  console.log('Test 9: Zero Expenses, Only Pool');
  const s = {
    members: [
      { id: 's1', name: 'Sponsor' },
      { id: 'm1', name: 'Member' }
    ],
    expenses: [],
    pool: { s1: 5000, m1: 0 },
    poolMode: 'individual'
  };

  const res = computeBalances(s);
  assert.strictEqual(res.bal['s1'], 0);
  assert.strictEqual(res.bal['m1'], 0);
  assert.strictEqual(res.poolPersonalRemain['s1'], 5000);
  console.log('✅ Test 9 Passed!');
}

// Test 10: Sponsor pays out-of-pocket
{
  console.log('Test 10: Sponsor pays out-of-pocket');
  const s = {
    members: [
      { id: 's1', name: 'Sponsor' },
      { id: 'm1', name: 'Member' }
    ],
    expenses: [
      {
        id: 'e1',
        name: 'Meal',
        amount: 600,
        payerId: 's1',
        splitMode: 'equal',
        participantIds: ['s1', 'm1']
      }
    ],
    pool: { s1: 5000, m1: 0 },
    poolMode: 'individual'
  };

  const res = computeBalances(s);
  assert.strictEqual(res.bal['s1'], 300);
  assert.strictEqual(res.bal['m1'], -300);
  assert.strictEqual(res.poolPersonalRemain['s1'], 5000);
  console.log('✅ Test 10 Passed!');
}

// Test 11: Deficit with Zero Deposits
{
  console.log('Test 11: Deficit with Zero Deposits');
  const s = {
    members: [
      { id: 'm1', name: 'M1' },
      { id: 'm2', name: 'M2' }
    ],
    expenses: [
      {
        id: 'e1',
        name: 'Pool Expense',
        amount: 1000,
        payerId: 'pool',
        splitMode: 'equal',
        participantIds: ['m1', 'm2']
      }
    ],
    pool: { m1: 0, m2: 0 },
    poolMode: 'individual'
  };

  const res = computeBalances(s);
  assert.strictEqual(res.bal['m1'], 0);
  assert.strictEqual(res.bal['m2'], 0);
  const sum = Object.values(res.bal).reduce((a, b) => a + b, 0);
  assert.strictEqual(Math.abs(sum) < 0.001, true);
  console.log('✅ Test 11 Passed!');
}

// Test 12: Deficit with Partial Deposit
{
  console.log('Test 12: Deficit with Partial Deposit');
  const s = {
    members: [
      { id: 'sponsor', name: 'Sponsor' },
      { id: 'm1', name: 'M1' },
      { id: 'm2', name: 'M2' },
      { id: 'm3', name: 'M3' }
    ],
    expenses: [
      {
        id: 'e1',
        name: 'Pool Expense',
        amount: 1000,
        payerId: 'pool',
        splitMode: 'equal',
        participantIds: ['sponsor', 'm1', 'm2', 'm3'] // 250 each
      }
    ],
    pool: { sponsor: 500, m1: 0, m2: 0, m3: 0 },
    poolMode: 'individual'
  };

  const res = computeBalances(s);
  assert.strictEqual(res.poolOffset['sponsor'], 250);
  assert.strictEqual(res.poolPersonalRemain['sponsor'], 0);
  assert.strictEqual(res.poolCred['sponsor'], 250);
  assert(Math.abs(res.bal['sponsor'] - 250) <= 0.02, 'Sponsor balance adjusted for exact whole cents');

  const sum = Object.values(res.bal).reduce((a, b) => a + b, 0);
  assert.strictEqual(Math.abs(sum) < 0.001, true, 'Sum must be strictly 0');
  console.log('✅ Test 12 Passed!');
}

// Test 13: Multiple sponsors with pool-paid expenses
{
  console.log('Test 13: Multiple sponsors with pool-paid expenses');
  const s = {
    members: [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
      { id: 'c', name: 'C' },
      { id: 'd', name: 'D' }
    ],
    expenses: [
      {
        id: 'e1',
        name: 'Pool Expense',
        amount: 2000,
        payerId: 'pool',
        splitMode: 'equal',
        participantIds: ['a', 'b', 'c', 'd'] // 500 each
      }
    ],
    pool: { a: 5000, b: 3000, c: 0, d: 0 },
    poolMode: 'individual'
  };

  const res = computeBalances(s);
  // Cash remaining in pool envelope = 8000 - 2000 = 6000
  assert.strictEqual(Math.round((res.poolPersonalRemain['a'] + res.poolPersonalRemain['b']) * 100) / 100, 6000);
  assert(Math.abs(res.poolPersonalRemain['a'] - 3857.14) < 0.02);
  assert(Math.abs(res.poolPersonalRemain['b'] - 2142.86) < 0.02);

  // Transfers: C and D owe 500 each. A gets 642.86, B gets 357.14.
  assert(Math.abs(res.bal['a'] - 642.86) < 0.02);
  assert(Math.abs(res.bal['b'] - 357.14) < 0.02);
  assert.strictEqual(res.bal['c'], -500);
  assert.strictEqual(res.bal['d'], -500);

  const sum = Object.values(res.bal).reduce((a, b) => a + b, 0);
  assert.strictEqual(Math.abs(sum) < 0.001, true);
  console.log('✅ Test 13 Passed!');
}

// Test 14: Comprehensive Pool Cash Invariant
{
  console.log('Test 14: Mathematical Invariant of Pool Cash');
  // In any non-overdraft scenario:
  // Initial Pool Cash === Pool Expenses + Reimbursed to Payers + Sum(Pool Personal Remain)
  const scenarios = [
    { poolTotal: 10000, poolExp: 1000, reimbursed: 500 },
    { poolTotal: 5000, poolExp: 600, reimbursed: 500 },
    { poolTotal: 8000, poolExp: 2000, reimbursed: 0 }
  ];

  for (const sc of scenarios) {
    const s = {
      members: [{ id: 's1' }, { id: 'p1' }, { id: 'm1' }],
      expenses: [
        { id: 'e1', amount: sc.reimbursed * 2, payerId: 'p1', splitMode: 'equal', participantIds: ['s1', 'p1'] },
        { id: 'e2', amount: sc.poolExp, payerId: 'pool', splitMode: 'equal', participantIds: ['s1', 'm1'] }
      ],
      pool: { s1: sc.poolTotal, p1: 0, m1: 0 },
      poolMode: 'individual'
    };
    const res = computeBalances(s);
    const sumRemain = Object.values(res.poolPersonalRemain).reduce((a, b) => a + b, 0);
    const sumReimbursed = Object.values(res.poolReimbursed).reduce((a, b) => a + b, 0);
    const totalCashUsed = res.poolExpTotal + sumReimbursed;
    assert.strictEqual(Math.round((totalCashUsed + sumRemain) * 100) / 100, sc.poolTotal);
  }
  console.log('✅ Test 14 Passed!');
}

console.log('--- ALL 14 TESTS PASSED SUCCESSFULLY! ---');
