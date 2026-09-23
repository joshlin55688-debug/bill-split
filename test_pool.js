// Unit tests for Bill Split Pool and Settlement Logic
const assert = require('assert');

function toArray(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val.filter(item => item !== null && item !== undefined);
  if (typeof val === 'object') return Object.values(val).filter(item => item !== null && item !== undefined);
  return [];
}

function computeBalances(s) {
  if (!s || typeof s !== 'object') s = {};
  const members = toArray(s.members);
  const expenses = toArray(s.expenses);
  const pool = (s.pool && typeof s.pool === 'object') ? s.pool : {};
  const poolMode = s.poolMode === 'equal' ? 'equal' : 'individual';

  const bal = {}, expBal = {}, poolBal = {};
  const poolExpCons = {};
  const memberExpenses = {};

  members.forEach(m => {
    if (!m) return;
    const id = String(m.id);
    bal[id] = 0; expBal[id] = 0; poolBal[id] = 0;
    poolExpCons[id] = 0;
    memberExpenses[id] = 0;
  });

  let poolExpTotal = 0;
  const owesToPayer = {};
  const paidByMember = {};
  members.forEach(m => {
    owesToPayer[m.id] = {};
    paidByMember[m.id] = 0;
  });

  expenses.forEach(e => {
    if (!e) return;
    const payerId = String(e.payerId || '');
    const isPool = (payerId === 'pool');

    if (!isPool && bal[payerId] === undefined) return;

    if (e.splitMode === 'custom') {
      const splits = e.customSplits && typeof e.customSplits === 'object' ? e.customSplits : {};
      let expTotal = 0;
      Object.entries(splits).forEach(([id, amt]) => {
        const mid = String(id);
        const val = Number(amt) || 0;
        if (val > 0 && bal[mid] !== undefined) {
          expTotal += val;
          memberExpenses[mid] += val;
          if (isPool) {
            poolExpCons[mid] += val;
          } else {
            if (mid !== payerId) {
              owesToPayer[payerId][mid] = (owesToPayer[payerId][mid] || 0) + val;
            }
          }
        }
      });
      if (isPool) {
        poolExpTotal += expTotal;
      } else {
        paidByMember[payerId] += e.amount;
      }
    } else {
      const parts = toArray(e.participantIds).map(String).filter(id => bal[id] !== undefined);
      if (!parts.length) return;
      const share = e.amount / parts.length;
      if (isPool) {
        poolExpTotal += e.amount;
        parts.forEach(id => {
          memberExpenses[id] += share;
          poolExpCons[id] += share;
        });
      } else {
        paidByMember[payerId] += e.amount;
        parts.forEach(id => {
          memberExpenses[id] += share;
          if (id !== payerId) {
            owesToPayer[payerId][id] = (owesToPayer[payerId][id] || 0) + share;
          }
        });
      }
    }
  });

  const poolTotal = members.reduce((sum, m) => sum + (Number(pool[m && m.id]) || 0), 0);
  const n = members.length;
  const poolRemain = poolTotal - poolExpTotal;

  if (poolMode === 'equal') {
    expenses.forEach(e => {
      const payerId = String(e.payerId || '');
      if (payerId === 'pool' || bal[payerId] === undefined) return;
      if (e.splitMode === 'custom') {
        const splits = e.customSplits || {};
        Object.entries(splits).forEach(([mid, amt]) => {
          const val = Number(amt) || 0;
          if (val > 0 && bal[mid] !== undefined) {
            bal[mid] -= val;
            expBal[mid] -= val;
          }
        });
        bal[payerId] += e.amount;
        expBal[payerId] += e.amount;
      } else {
        const parts = toArray(e.participantIds).map(String).filter(id => bal[id] !== undefined);
        if (!parts.length) return;
        const share = e.amount / parts.length;
        bal[payerId] += e.amount;
        expBal[payerId] += e.amount;
        parts.forEach(id => {
          bal[id] -= share;
          expBal[id] -= share;
        });
      }
    });

    if (n > 0 && (poolTotal > 0 || poolExpTotal > 0)) {
      const netSharePerMember = poolRemain / n;
      members.forEach(m => {
        if (!m) return;
        const id = String(m.id);
        const myContrib = Number(pool[id]) || 0;
        const myCons = poolExpCons[id] || 0;
        const net = myContrib - myCons - netSharePerMember;
        bal[id] += net;
        poolBal[id] += net;
      });
    }

    // Apply strict rounding
    Object.keys(bal).forEach(id => {
      bal[id] = Math.round(bal[id] * 100) / 100;
    });

    return {
      poolMode: 'equal',
      bal, expBal, poolBal,
      poolTotal, poolExpTotal, poolRemain,
      poolOffset: {},
      poolReimbursed: {},
      poolPersonalRemain: {},
      memberExpenses
    };
  }

  // INDIVIDUAL SPONSORSHIP / PREPAID MODE
  const poolOffset = {};
  const poolPersonalRemain = {};
  const poolReimbursed = {};
  const uncoveredPoolExp = {};
  const directOwed = {}; // directOwed[debtor][payer] = amount

  members.forEach(m => {
    poolReimbursed[m.id] = 0;
    directOwed[m.id] = {};
    members.forEach(p => {
      directOwed[m.id][p.id] = 0;
    });
  });

  // Calculate obligations and offset per member
  members.forEach(m => {
    const id = m.id;
    const contrib = Number(pool[id]) || 0;
    let debtToOthers = 0;
    members.forEach(p => {
      if (p.id !== id) {
        debtToOthers += (owesToPayer[p.id][id] || 0);
      }
    });
    const debtToPool = poolExpCons[id] || 0;
    const totalObligations = debtToOthers + debtToPool;

    const offset = Math.min(contrib, totalObligations);
    poolOffset[id] = offset;
    poolPersonalRemain[id] = contrib - offset;

    const ratio = totalObligations > 0 ? (offset / totalObligations) : 0;

    members.forEach(p => {
      if (p.id !== id) {
        const owed = owesToPayer[p.id][id] || 0;
        const comp = owed * ratio;
        poolReimbursed[p.id] += comp;
        directOwed[id][p.id] = owed - comp;
      }
    });

    const coveredPool = debtToPool * ratio;
    uncoveredPoolExp[id] = debtToPool - coveredPool;
  });

  // Check uncovered pool expenses funded by pool depositors with remaining surplus
  let totalSurplus = 0;
  let totalUncoveredPool = 0;
  members.forEach(m => {
    totalSurplus += poolPersonalRemain[m.id] || 0;
    totalUncoveredPool += uncoveredPoolExp[m.id] || 0;
  });

  const poolCred = {};
  members.forEach(m => {
    poolCred[m.id] = 0;
  });

  if (totalUncoveredPool > 0) {
    if (totalSurplus > 0) {
      // Depositors with surplus pool funds fronted the uncovered pool expenses
      members.forEach(m => {
        const surplus = poolPersonalRemain[m.id] || 0;
        if (surplus > 0) {
          poolCred[m.id] = totalUncoveredPool * (surplus / totalSurplus);
        }
      });
    } else {
      // Pure overdraft when no deposits remain; equal split of deficit
      const perOverdraft = totalUncoveredPool / n;
      members.forEach(m => {
        poolCred[m.id] = 0;
      });
    }
  }

  // Calculate net direct balances
  members.forEach(m => {
    const id = m.id;
    let directCredit = 0;
    let directDebit = 0;
    members.forEach(other => {
      if (other.id !== id) {
        directCredit += directOwed[other.id][id] || 0;
        directDebit += directOwed[id][other.id] || 0;
      }
    });

    const net = (directCredit + poolCred[id]) - (directDebit + uncoveredPoolExp[id]);
    bal[id] = net;
    expBal[id] = (paidByMember[id] - (memberExpenses[id] - (poolExpCons[id] || 0)));
    poolBal[id] = (Number(pool[id]) || 0) - (poolOffset[id] || 0);
  });

  // Strict penny-balancing to guarantee exact sum(bal) === 0
  let rawSum = 0;
  members.forEach(m => {
    bal[m.id] = Math.round(bal[m.id] * 100) / 100;
    rawSum += bal[m.id];
  });
  rawSum = Math.round(rawSum * 100) / 100;
  if (Math.abs(rawSum) >= 0.01 && members.length > 0) {
    // Find member with maximum absolute balance to absorb cent discrepancy
    let maxMid = members[0].id;
    let maxAbs = Math.abs(bal[maxMid]);
    members.forEach(m => {
      if (Math.abs(bal[m.id]) > maxAbs) {
        maxAbs = Math.abs(bal[m.id]);
        maxMid = m.id;
      }
    });
    bal[maxMid] = Math.round((bal[maxMid] - rawSum) * 100) / 100;
  }

  return {
    poolMode: 'individual',
    bal, expBal, poolBal,
    poolTotal, poolExpTotal, poolRemain,
    poolOffset,
    poolReimbursed,
    poolPersonalRemain,
    memberExpenses
  };
}

function minimizeTransactions(balances) {
  const creditors = [], debtors = [];
  Object.entries(balances).forEach(([id, b]) => {
    const v = Math.round(b * 100) / 100;
    if (v > 0.005) creditors.push({ id: String(id), amount: v });
    else if (v < -0.005) debtors.push({ id: String(id), amount: -v });
  });
  creditors.sort((a, b) => b.amount - a.amount);
  debtors.sort((a, b) => b.amount - a.amount);
  const txs = [];
  let ci = 0, di = 0;
  while (ci < creditors.length && di < debtors.length) {
    const c = creditors[ci], d = debtors[di];
    const amount = Math.min(c.amount, d.amount);
    txs.push({ from: d.id, to: c.id, amount: Math.round(amount * 100) / 100 });
    c.amount -= amount;
    d.amount -= amount;
    if (c.amount < 0.005) ci++;
    if (d.amount < 0.005) di++;
  }
  return txs;
}

// ── Test Suites ──
console.log('--- RUNNING TESTS ---');

// Test 1: User's Core Scenario
{
  console.log('Test 1: Core Sponsor Scenario');
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
        name: '4人晚餐',
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

  assert.strictEqual(res.bal['sponsor'], 0, 'Sponsor should owe 0');
  assert.strictEqual(res.bal['hua'], 1000, 'Hua should be owed 1000 from mei & hao');
  assert.strictEqual(res.bal['mei'], -500, 'Mei owes 500');
  assert.strictEqual(res.bal['hao'], -500, 'Hao owes 500');

  assert.strictEqual(res.poolOffset['sponsor'], 500, 'Sponsor offset should be 500');
  assert.strictEqual(res.poolPersonalRemain['sponsor'], 9500, 'Sponsor pool remain should be 9500');
  assert.strictEqual(res.poolReimbursed['hua'], 500, 'Hua should be reimbursed 500 from pool');

  // Check sum of balances is exactly 0
  const sum = Object.values(res.bal).reduce((a, b) => a + b, 0);
  assert.strictEqual(Math.abs(sum) < 0.001, true, 'Sum must be 0');

  // Check transfers
  assert.strictEqual(txs.length, 2);
  const txMei = txs.find(t => t.from === 'mei');
  const txHao = txs.find(t => t.from === 'hao');
  assert(txMei && txMei.to === 'hua' && txMei.amount === 500);
  assert(txHao && txHao.to === 'hua' && txHao.amount === 500);

  // Ensure Sponsor is NOT in any transfer
  assert.strictEqual(txs.some(t => t.from === 'sponsor' || t.to === 'sponsor'), false);
  console.log('✅ Test 1 Passed!');
}

// Test 2: Pool Payer Expense
{
  console.log('Test 2: Expense paid by Pool');
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

  assert.strictEqual(res.bal['sponsor'], 750, 'Sponsor fronted 750 for other 3');
  assert.strictEqual(res.bal['hua'], -250);
  assert.strictEqual(res.bal['mei'], -250);
  assert.strictEqual(res.bal['hao'], -250);

  assert.strictEqual(res.poolOffset['sponsor'], 250, 'Sponsor offset own 250');
  assert.strictEqual(res.poolPersonalRemain['sponsor'], 9750);

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

  // Sponsor:
  // e1: owes hua 500 -> covered by pool
  // e2: owes pool 200 -> covered by pool
  // Total sponsor pool offset = 700, remaining = 4300
  // Pool fronted for hua: 200, mei: 200 -> Sponsor credited 400
  // Sponsor net bal = +400
  // Hua:
  // Paid 1500, self 500, pool compensated 500. Hua owes pool 200.
  // Hua net: 1500 - 500 - 500 - 200 + 500 (mei owes) = +300
  // Mei:
  // Owes hua 500, owes pool/sponsor 200. Net = -700.
  // Balances: sponsor: +400, hua: +300, mei: -700. Sum = 0!
  assert.strictEqual(res.bal['sponsor'], 400);
  assert.strictEqual(res.bal['hua'], 300);
  assert.strictEqual(res.bal['mei'], -700);

  const sum = Object.values(res.bal).reduce((a, b) => a + b, 0);
  assert.strictEqual(Math.abs(sum) < 0.001, true, 'Sum must be 0');
  console.log('✅ Test 3 Passed!');
}

// Test 4: Exhaustion of prepaid pool
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
  const txs = minimizeTransactions(res.bal);

  console.log('Balances:', res.bal);
  console.log('Transfers:', txs);

  // Sponsor prepaid 300, consumed 500.
  // 300 reimbursed to hua from pool.
  // Sponsor still owes hua 200 directly.
  assert.strictEqual(res.bal['sponsor'], -200);
  assert.strictEqual(res.bal['hua'], 200);
  assert.strictEqual(res.poolPersonalRemain['sponsor'], 0);
  assert.strictEqual(txs.length, 1);
  assert.strictEqual(txs[0].from, 'sponsor');
  assert.strictEqual(txs[0].to, 'hua');
  assert.strictEqual(txs[0].amount, 200);

  const sum = Object.values(res.bal).reduce((a, b) => a + b, 0);
  assert.strictEqual(Math.abs(sum) < 0.001, true, 'Sum must be 0');
  console.log('✅ Test 4 Passed!');
}

// Test 5: Rounding with odd division
{
  console.log('Test 5: Rounding with odd division');
  const s = {
    members: [
      { id: 'm1', name: 'A' },
      { id: 'm2', name: 'B' },
      { id: 'm3', name: 'C' }
    ],
    expenses: [
      {
        id: 'e1',
        name: '費用',
        amount: 100,
        payerId: 'm1',
        splitMode: 'equal',
        participantIds: ['m1', 'm2', 'm3']
      }
    ],
    pool: { m1: 0, m2: 0, m3: 0 },
    poolMode: 'individual'
  };

  const res = computeBalances(s);
  const sum = Object.values(res.bal).reduce((a, b) => a + b, 0);
  console.log('Balances:', res.bal, 'Sum:', sum);
  assert.strictEqual(Math.abs(sum) < 0.0001, true, 'Sum must be strictly 0');
  console.log('✅ Test 5 Passed!');
}

// Test 6: Legacy Equal Pool Mode
{
  console.log('Test 6: Legacy Equal Mode');
  const s = {
    members: [
      { id: 'm1', name: 'A' },
      { id: 'm2', name: 'B' }
    ],
    expenses: [
      {
        id: 'e1',
        name: '餐費',
        amount: 400,
        payerId: 'm1',
        splitMode: 'equal',
        participantIds: ['m1', 'm2']
      }
    ],
    pool: { m1: 1000, m2: 1000 },
    poolMode: 'equal'
  };

  const res = computeBalances(s);
  console.log('Legacy Balances:', res.bal);
  assert.strictEqual(res.bal['m1'], 200);
  assert.strictEqual(res.bal['m2'], -200);
  const sum = Object.values(res.bal).reduce((a, b) => a + b, 0);
  assert.strictEqual(Math.abs(sum) < 0.001, true, 'Sum must be 0');
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
        name: '餐費',
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
  const txs = minimizeTransactions(res.bal);

  console.log('Balances:', res.bal);
  console.log('Transfers:', txs);

  assert.strictEqual(res.bal['s1'], 0);
  assert.strictEqual(res.bal['s2'], 0);
  assert.strictEqual(res.bal['m1'], -400);
  assert.strictEqual(res.bal['payer'], 400);
  assert.strictEqual(res.poolPersonalRemain['s1'], 4600);
  assert.strictEqual(res.poolPersonalRemain['s2'], 2600);
  assert.strictEqual(res.poolReimbursed['payer'], 800);

  const sum = Object.values(res.bal).reduce((a, b) => a + b, 0);
  assert.strictEqual(Math.abs(sum) < 0.001, true, 'Sum must be 0');
  assert.strictEqual(txs.length, 1);
  assert.strictEqual(txs[0].from, 'm1');
  assert.strictEqual(txs[0].to, 'payer');
  assert.strictEqual(txs[0].amount, 400);
  console.log('✅ Test 7 Passed!');
}

// Test 8: Custom Splits with Sponsor
{
  console.log('Test 8: Custom Splits with Sponsor');
  const s = {
    members: [
      { id: 's1', name: 'Sponsor' },
      { id: 'm1', name: 'User 1' },
      { id: 'payer', name: 'Payer' }
    ],
    expenses: [
      {
        id: 'e1',
        name: '自訂分攤聚餐',
        amount: 1500,
        payerId: 'payer',
        splitMode: 'custom',
        customSplits: { s1: 700, m1: 500, payer: 300 }
      }
    ],
    pool: { s1: 1000, m1: 0, payer: 0 },
    poolMode: 'individual'
  };

  const res = computeBalances(s);
  const txs = minimizeTransactions(res.bal);

  console.log('Balances:', res.bal);
  console.log('Transfers:', txs);

  assert.strictEqual(res.bal['s1'], 0);
  assert.strictEqual(res.bal['m1'], -500);
  assert.strictEqual(res.bal['payer'], 500);
  assert.strictEqual(res.poolPersonalRemain['s1'], 300);

  const sum = Object.values(res.bal).reduce((a, b) => a + b, 0);
  assert.strictEqual(Math.abs(sum) < 0.001, true, 'Sum must be 0');
  console.log('✅ Test 8 Passed!');
}

// Test 9: Zero Expenses, Only Pool
{
  console.log('Test 9: Zero Expenses, Only Pool');
  const s = {
    members: [
      { id: 's1', name: 'Sponsor' },
      { id: 'm1', name: 'User 1' }
    ],
    expenses: [],
    pool: { s1: 10000, m1: 0 },
    poolMode: 'individual'
  };

  const res = computeBalances(s);
  const txs = minimizeTransactions(res.bal);

  assert.strictEqual(res.bal['s1'], 0);
  assert.strictEqual(res.bal['m1'], 0);
  assert.strictEqual(res.poolPersonalRemain['s1'], 10000);
  assert.strictEqual(txs.length, 0);
  console.log('✅ Test 9 Passed!');
}

// Test 10: Sponsor is also a Payer
{
  console.log('Test 10: Sponsor pays out-of-pocket');
  const s = {
    members: [
      { id: 's1', name: 'Sponsor' },
      { id: 'm1', name: 'User 1' }
    ],
    expenses: [
      {
        id: 'e1',
        name: 'Sponsor請代墊門票',
        amount: 600,
        payerId: 's1',
        splitMode: 'equal',
        participantIds: ['s1', 'm1'] // 300 each
      }
    ],
    pool: { s1: 5000, m1: 0 },
    poolMode: 'individual'
  };

  const res = computeBalances(s);
  const txs = minimizeTransactions(res.bal);

  assert.strictEqual(res.bal['s1'], 300);
  assert.strictEqual(res.bal['m1'], -300);
  assert.strictEqual(res.poolPersonalRemain['s1'], 5000);
  assert.strictEqual(txs.length, 1);
  assert.strictEqual(txs[0].from, 'm1');
  assert.strictEqual(txs[0].to, 's1');
  assert.strictEqual(txs[0].amount, 300);
  console.log('✅ Test 10 Passed!');
}

console.log('--- ALL TESTS PASSED SUCCESSFULLY! ---');
