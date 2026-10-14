import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

const source = process.argv[2] ?? new URL("../crates/oriel-relay/test/usage-measurement.json", import.meta.url);
const measured = JSON.parse(readFileSync(source, "utf8"));
const old = measured.current, next = measured.combinedPrototype;
const seconds = 86400, days = 30;
const counts = { checks: seconds / 5, fullLists: seconds / 900, devices: seconds / 300,
  accountAlarms: seconds / 40, terminalAlarmsBefore: seconds / 10, terminalAlarmsAfter: seconds / 30 };
const assumptions = {
  days, devices: 1, issues: 48, hows: 1, pullRequests: 0, activeHoursPerDay: 24,
  dashboardProgressSockets: 1, codexBrowserSockets: 0, terminalBrowserSockets: 1,
  webhookUpdatesPerDay: 0, counts,
  accountAlarmSeconds: 40, terminalAlarmAfterSeconds: 30, batchSeconds: 0.2,
  durationSeconds: { currentCheck: 1, currentFullList: 5, otherDOEvent: 0.001 },
  durationNotice: "Duration inputs are assumptions, not production measurements. Per-object overlapping intervals are merged.",
  sqlNotice: "After SQL values below cover steady periodic work only. Add measured reloads (7 rows per active snapshot reload), constructor SQL, bootstrap, writes and management operations.",
  outputNotice: "Equally spaced output on each channel; only output data is batched, not approvals, requests or control frames.",
  requestNotice: "Application auto-response messages are included at 20:1 for request budgeting. Initial connections, provider token renewals and task actions are extra.",
  reloadsPerDayForExample: 24,
};

// Simulate one 1800-second repeating window. This is a multiple of every
// declared period; merging intervals avoids charging one DO twice at once.
function occupied(events) {
  const window = 1800, intervals = [];
  for (const { period, duration, phase = 0 } of events) {
    if (!Number.isFinite(period)) continue;
    for (let i = 0; i < window / period; i++) {
      const start = (i * period + phase) % window, end = start + duration;
      intervals.push([start, Math.min(end, window)]);
      if (end > window) intervals.push([0, end - window]);
    }
  }
  intervals.sort((a, b) => a[0] - b[0]);
  let total = 0, start = 0, end = 0;
  for (const [left, right] of intervals) {
    if (left > end) { total += end - start; start = left; end = right; }
    else end = Math.max(end, right);
  }
  return (total + end - start) * seconds / window;
}
assert.equal(occupied([{ period: 5, duration: 1 }, { period: 5, duration: 1 }]), counts.checks);

function monthlyFee(workerRequests, doRequests, gbSeconds, cpuMs = 0, rowsRead = 0, rowsWritten = 0) {
  const unit = (value, included, size, price) => Math.max(0, Math.ceil((value - included) / size)) * price;
  return 5 + Math.max(0, workerRequests - 10000000) / 1000000 * 0.30
    + Math.max(0, cpuMs - 30000000) / 1000000 * 0.02
    + unit(doRequests, 1000000, 1000000, 0.15)
    + unit(gbSeconds, 400000, 1000000, 12.50)
    + Math.max(0, rowsRead - 25000000000) / 1000000 * 0.001
    + Math.max(0, rowsWritten - 50000000) / 1000000;
}
assert.equal(monthlyFee(0, 1000001, 0), 5.15);
assert.equal(monthlyFee(0, 0, 663552), 17.5);

function scenario(rate) {
  const batchedRate = Math.min(rate, 1 / assumptions.batchSeconds);
  const accountBefore = occupied([
    { period: 5, duration: assumptions.durationSeconds.currentCheck },
    { period: 900, duration: assumptions.durationSeconds.currentFullList },
    { period: 300, duration: 0.001 }, { period: 40, duration: 0.001 },
    { period: rate ? 1 / rate : Infinity, duration: 0.001, phase: 0.4 },
  ]);
  const accountAfter = occupied([
    { period: 5, duration: 0.001 }, { period: 5, duration: 0.001, phase: 1 },
    { period: 900, duration: 0.001 }, { period: 900, duration: 0.001, phase: 5 },
    { period: 40, duration: 0.001 },
    { period: batchedRate ? 1 / batchedRate : Infinity, duration: 0.001, phase: 0.4 },
  ]);
  const terminalBefore = occupied([
    { period: 10, duration: 0.001, phase: 0.2 },
    { period: 10, duration: 0.001, phase: 0.21 },
    { period: 300, duration: 0.001 },
    { period: rate ? 1 / rate : Infinity, duration: 0.001, phase: 0.5 },
  ]);
  const terminalAfter = occupied([
    { period: 30, duration: 0.001, phase: 5 },
    { period: batchedRate ? 1 / batchedRate : Infinity, duration: 0.001, phase: 0.5 },
  ]);
  const before = {
    rowsRead: old.activeSnapshot.rowsRead * counts.checks + old.webList.rowsRead * counts.fullLists
      + old.devicesListRepeat.rowsRead * counts.devices + old.deadlineAlarm.rowsRead * counts.accountAlarms
      + 2 * counts.terminalAlarmsBefore + counts.devices + seconds * rate * (old.codexOutput.rowsRead + 1),
    rowsWritten: counts.accountAlarms + 6 * counts.terminalAlarmsBefore + 2 * counts.devices,
    workerRequests: counts.fullLists + counts.devices,
    doRequests: counts.checks / 20 + (seconds / 10 + seconds / 15) / 20
      + counts.terminalAlarmsBefore * 1.05 + counts.fullLists + 2 * counts.devices
      + counts.accountAlarms + seconds * rate * 2 / 20,
    providerRequests: old.activeSnapshot.providerRequests * counts.checks + old.webList.providerRequests * counts.fullLists,
    gbSeconds: (accountBefore + terminalBefore) * 0.128,
  };
  const after = {
    rowsRead: 0,
    rowsWritten: counts.accountAlarms + counts.terminalAlarmsAfter,
    workerRequests: counts.checks + counts.fullLists,
    doRequests: 2 * (counts.checks + counts.fullLists) + counts.accountAlarms + counts.terminalAlarmsAfter
      + (2 * seconds / 10 + seconds / 15 + seconds / 10) / 20 + seconds * batchedRate * 2 / 20,
    providerRequests: next.activeSnapshot.providerRequests * counts.checks + next.webList.providerRequests * counts.fullLists,
    gbSeconds: (accountAfter + terminalAfter) * 0.128,
  };
  const month = value => Object.fromEntries(Object.entries(value).map(([key, number]) => [key, Number((number * days).toFixed(9))]));
  const beforeMonth = month(before), afterMonth = month(after);
  return { outputMessagesPerSecondPerChannel: rate, afterOutputMessagesPerSecondPerChannel: batchedRate,
    beforeDay: before, afterDay: after, beforeMonth, afterMonth,
    monthlyFeeExcludingUnmeasuredCPUStorageAndNonperiodicWork: {
      before: monthlyFee(beforeMonth.workerRequests, beforeMonth.doRequests, beforeMonth.gbSeconds, 0, beforeMonth.rowsRead, beforeMonth.rowsWritten),
      after: monthlyFee(afterMonth.workerRequests, afterMonth.doRequests, afterMonth.gbSeconds, 0, afterMonth.rowsRead, afterMonth.rowsWritten),
    } };
}
const scenarios = [0, 1, 10].map(scenario);
const reloadReads = next.constructorSqlReplay.rowsRead + next.activeSnapshotAfterConstructorSql.rowsRead
  + next.devicesListAfterConstructorSql.rowsRead;
const reloads = assumptions.reloadsPerDayForExample;
const primary = scenarios[1];
const beforeReadTotal = primary.beforeMonth.rowsRead + old.constructorSqlReplay.rowsRead * reloads * days;
const afterReadTotal = primary.afterMonth.rowsRead + reloadReads * reloads * days;
const report = { assumptions, samples: measured, scenarios,
  primarySqlExample: { reloadReadsPerCycle: reloadReads, reloadsPerDay: reloads,
    beforeRowsReadPerMonth: beforeReadTotal, afterRowsReadPerMonth: afterReadTotal,
    reductionPercent: (1 - afterReadTotal / beforeReadTotal) * 100,
    notice: "Each cycle replays initialization SQL, reloads one active snapshot and loads the device list. These are measured operations, not a measurement of complete DO cold starts. Other management/bootstrap SQL is not included." },
  reloadSensitivity: [1, 24, counts.checks].map(count => ({ reloadCyclesPerDay: count,
    afterRowsReadPerDay: count * reloadReads, afterRowsReadPerMonth: count * reloadReads * days })) };
const json = `${JSON.stringify(report, null, 2)}\n`;
if (process.argv[3]) writeFileSync(process.argv[3], json);
else process.stdout.write(json);
