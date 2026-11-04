// Explicit verification only. --gpu is required to start GPU compute.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {modalSettingsView} from '../core/modal-vault';
import {modalJson, testModalSdk} from '../core/modal-client';
import type {ModalDashboard, ModalJob} from '../shared/modal';

console.log(JSON.stringify({settings: modalSettingsView(), sdk: await testModalSdk()}));
const health = await modalJson<ModalDashboard>('/health');
console.log(JSON.stringify({health}));
if (process.argv.includes('--gpu')) {
  const job = await modalJson<ModalJob>('/jobs', {method: 'POST', body: {kind: 'gpu-test', allowGpu: true, maxSeconds: 30, budgetUsd: 25, requestId: randomUUID()}});
  fs.mkdirSync('.runtime/modal-qa', {recursive: true});
  fs.writeFileSync(path.join('.runtime/modal-qa', 'gpu-test-job.json'), JSON.stringify(job));
  console.log(JSON.stringify({submitted: job}));
}
const id = process.argv.find(a => a.startsWith('--job='))?.slice(6);
if (id) {
  const job = await modalJson<ModalJob>(`/jobs/${id}`);
  console.log(JSON.stringify({job}));
  fs.mkdirSync('.runtime/modal-qa', {recursive: true});
  fs.writeFileSync(path.join('.runtime/modal-qa', `${id}.json`), JSON.stringify(job, null, 2));
}
