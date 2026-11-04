// Live cancellation/concurrency/budget verification. Starts one GPU job only
// with --live. Never run as an automatic or scheduled test.
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {modalJson} from '../core/modal-client';
import {modalConfig} from '../core/modal-vault';
import type {ModalDashboard, ModalJob} from '../shared/modal';

if (!process.argv.includes('--live')) throw new Error('Pass --live to explicitly authorize one GPU verification job');
const base = process.env.REEL_MODAL_LOCAL_URL || 'http://127.0.0.1:4329';
const session = await (await fetch(`${base}/api/modal/session`, {headers: {'X-Reel-Modal-Client': 'reel-studio'}})).json() as {token: string};
const headers = {'X-Reel-Modal-Session': session.token, 'Content-Type': 'application/json'};
const request = (route: string, body?: unknown, method = body ? 'POST' : 'GET') => fetch(`${base}/api/modal${route}`, {method, headers, body: body ? JSON.stringify(body) : undefined});
const assert = (ok: boolean, message: string) => {if (!ok) throw new Error(message);};
const result: Record<string, unknown> = {};
const settings = modalConfig();
const body = {kind: 'text-to-video', allowGpu: true, requestId: randomUUID(), prompt: 'A bowl of ramen with gently rising steam', width: 640, height: 640, steps: 40, frames: 49, maxSeconds: 300};
const initial = await modalJson<ModalDashboard>('/health');
assert(!initial.usage.activeJobId, 'Finish the current GPU job before verifying guards');
const unauthenticated = await fetch(`${settings.endpointUrl}/health`);
assert(unauthenticated.status === 401 || unauthenticated.status === 403, 'Modal proxy must reject unauthenticated access');
result.proxyRejectsUnauthenticated = unauthenticated.status;
try {
  assert((await request('/settings', {monthlyBudgetUsd: 0}, 'PUT')).ok, 'Failed to set verification budget');
  const denied = await request('/jobs', body);
  assert(denied.status === 429, 'Budget must reject BEFORE GPU launch');
  result.budgetRejection = denied.status;
} finally {
  assert((await request('/settings', {monthlyBudgetUsd: settings.monthlyBudgetUsd}, 'PUT')).ok, 'Restore budget setting before continuing');
}
const before = await modalJson<ModalDashboard>('/health');
assert(before.usage.committedUsd === initial.usage.committedUsd, 'Rejected job must not change the reservation ledger');
const created = await request('/jobs', body);
assert(created.status === 202, 'Verification job was not admitted');
const job = await created.json() as ModalJob;
fs.mkdirSync('.runtime/modal-qa', {recursive: true});
fs.writeFileSync('.runtime/modal-qa/cancel-job.json', JSON.stringify(job, null, 2));
try {
  const duplicate = await (await request('/jobs', body)).json() as ModalJob;
  assert(duplicate.id === job.id, 'Retry must return the same GPU job');
  result.idempotentJobId = duplicate.id;
  const conflict = await request('/jobs', {...body, requestId: randomUUID()});
  assert(conflict.status === 409, 'Second GPU job must not start concurrently');
  result.concurrencyRejection = conflict.status;
  // Give the admitted container time to start, then terminate it.
  await new Promise(resolve => setTimeout(resolve, 8000));
} finally {
  const cancelled = await request(`/jobs/${job.id}/cancel`, {});
  assert(cancelled.ok, 'Cancellation request failed');
  result.cancelAccepted = true;
}
for (let attempt = 0; attempt < 8; attempt++) {
  const current = await (await request(`/jobs/${job.id}`)).json() as ModalJob;
  result.finalStatus = current.status;
  if (current.status === 'cancelled') break;
  await new Promise(resolve => setTimeout(resolve, 1000));
}
const after = await modalJson<ModalDashboard>('/health');
result.usage = after.usage;
fs.writeFileSync('.runtime/modal-qa/guard-results.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
assert(result.finalStatus === 'cancelled', 'Cancellation has not yet been confirmed; inspect the saved job ID');
