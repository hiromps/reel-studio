// Integration smoke through Reel Studio HTTP API. GPU is started only when an
// explicit --submit=<task> flag is passed. Poll manually with --job=<uuid>.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {ModalDashboard, ModalJob} from '../shared/modal';
const base = process.env.REEL_MODAL_LOCAL_URL || 'http://127.0.0.1:4329';
const arg = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const session = await fetch(`${base}/api/modal/session`, {headers: {'X-Reel-Modal-Client': 'reel-studio'}});
if (!session.ok) throw new Error('Local authentication failed');
const token = (await session.json() as {token: string}).token;
const request = async (route: string, body?: unknown) => {
  const r = await fetch(`${base}/api/modal${route}`, {method: body ? 'POST' : 'GET', headers: {'X-Reel-Modal-Session': token, 'Content-Type': 'application/json'}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(90_000)});
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  return r;
};
const output = path.resolve('.runtime/modal-qa');
fs.mkdirSync(output, {recursive: true});
const submit = arg('submit');
if (submit) {
  const imageFile = arg('image');
  const size = Number(arg('size') || 256);
  const body = {kind: submit, allowGpu: true, requestId: randomUUID(), prompt: 'Cinematic close-up of a bowl of Japanese ramen, steaming hot broth, warm restaurant lighting, realistic food photography', width: size, height: size, steps: Number(arg('steps') || 4), frames: Number(arg('frames') || 5), ...(imageFile ? {imageBase64: fs.readFileSync(imageFile).toString('base64')} : {}), maxSeconds: Number(arg('seconds') || 300)};
  const estimate = await (await request('/estimate', body)).json();
  const job = await (await request('/jobs', body)).json() as ModalJob;
  fs.writeFileSync(path.join(output, `${job.id}.json`), JSON.stringify(job, null, 2));
  fs.writeFileSync(path.join(output, `latest-${submit}.json`), JSON.stringify(job, null, 2));
  console.log(JSON.stringify({estimate, job}));
}
const cancel = arg('cancel');
if (cancel) console.log(JSON.stringify({cancelled: await (await request(`/jobs/${cancel}/cancel`, {})).json()}));
const id = arg('job');
if (id) {
  const job = await (await request(`/jobs/${id}`)).json() as ModalJob;
  fs.writeFileSync(path.join(output, `${id}.json`), JSON.stringify(job, null, 2));
  console.log(JSON.stringify({job}));
  if (job.status === 'completed' && job.resultType && process.argv.includes('--download')) {
    const r = await request(`/jobs/${id}/result`);
    const target = path.join(output, `${id}.${job.resultType === 'video/mp4' ? 'mp4' : 'png'}`);
    fs.writeFileSync(target, Buffer.from(await r.arrayBuffer()));
    console.log(JSON.stringify({download: target, bytes: fs.statSync(target).size}));
  }
}
const health = await (await request('/health')).json() as ModalDashboard;
fs.writeFileSync(path.join(output, 'dashboard.json'), JSON.stringify(health, null, 2));
console.log(JSON.stringify({usage: health.usage, gpuInfo: health.gpuInfo}));
