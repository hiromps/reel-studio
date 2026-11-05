"""Private, resumable CPU-only media transfers. No GPU is invoked here."""
import asyncio
import base64
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shutil
import time
from uuid import UUID

from modal_backend.render_contracts import (
    CHUNK_BYTES, MAX_FILE_BYTES, MAX_PROJECT_BYTES, MAX_ALL_PROJECT_BYTES,
    RETENTION_SECONDS, required_assets, safe_asset,
)

ROOT = Path('/data/cloud/sessions')


def uuid_value(value):
    try:
        return str(UUID(str(value)))
    except (ValueError, TypeError, AttributeError):
        raise ValueError('Invalid ID') from None


def session_view(session):
    return {k: session[k] for k in ('id', 'prepared', 'expiresAt', 'totalBytes')} | {
        'files': [{k: v for k, v in f.items() if k not in {'parts'}} for f in session['files']]}


def mount_media(web, state, storage, control_lock, ledger):
    from fastapi import HTTPException, Request
    from fastapi.responses import StreamingResponse
    io_lock = asyncio.Lock()

    async def load(session_id):
        try:
            session_id = uuid_value(session_id)
        except ValueError:
            raise HTTPException(400, 'Invalid session')
        session = await state.get.aio('render-session:' + session_id, None)
        if not session:
            raise HTTPException(404, 'Media session not found')
        if session['expiresUnix'] < time.time():
            raise HTTPException(410, 'Media session expired')
        return session

    async def save(session):
        await state.put.aio('render-session:' + session['id'], session)

    async def active_sessions():
        return await state.get.aio('render-session-index', {})

    def directory(session_id):
        return ROOT / uuid_value(session_id)

    async def validate_job(payload):
        session = await load(payload.sessionId)
        if not all(f['complete'] for f in session['files']):
            raise HTTPException(409, 'Upload incomplete')
        paths = {f['path'] for f in session['files']}
        if not required_assets(payload).issubset(paths):
            raise HTTPException(409, 'Required video, font, narration or sound is missing')
        return session

    async def apply_result(result):
        update = result.get('sessionUpdate')
        if not update:
            return
        session = await load(update['id'])
        session['prepared'] = True
        session['derived'] = update['derived']
        for f in session['files']:
            if f['id'] in update['probes']:
                f['probe'] = update['probes'][f['id']]
        await save(session)

    @web.post('/render/sessions')
    async def create_session(request: Request):
        try:
            body = await request.json()
            ident = uuid_value(body['id'])
            if body.get('allowUpload') is not True or not set(body).issubset({'id', 'files', 'allowUpload', 'reuseSessionId'}):
                raise ValueError()
            files = body['files']
            if not isinstance(files, list) or not 1 <= len(files) <= 128:
                raise ValueError()
            total = 0
            for f in files:
                if set(f) != {'id', 'path', 'size'} or not safe_asset(f['path']):
                    raise ValueError()
                f['id'] = uuid_value(f['id'])
                if type(f['size']) is not int or not 0 < f['size'] <= MAX_FILE_BYTES:
                    raise ValueError()
                total += f['size']
            if total > MAX_PROJECT_BYTES or len({f['id'] for f in files}) != len(files) or len({f['path'] for f in files}) != len(files):
                raise ValueError()
        except (ValueError, TypeError, KeyError):
            raise HTTPException(422, 'Invalid media manifest')
        fingerprint = hashlib.sha256(json.dumps({'files': files, 'reuse': body.get('reuseSessionId')}, sort_keys=True).encode()).hexdigest()
        async with control_lock():
            old = await state.get.aio('render-session:' + ident, None)
            if old:
                if old['fingerprint'] != fingerprint:
                    raise HTTPException(409, 'Session ID already used')
                return session_view(await load(ident))
            index = await active_sessions()
            v = await ledger()
            reused = await load(body['reuseSessionId']) if body.get('reuseSessionId') else None
            if reused:
                if not all(f['complete'] for f in reused['files']):
                    raise HTTPException(409, 'Previous upload incomplete')
                total += reused['totalBytes']
                combined = reused['files'] + files
                if total > MAX_PROJECT_BYTES or len(combined) > 128 or len({f['path'] for f in combined}) != len(combined) or len({f['id'] for f in combined}) != len(combined):
                    raise HTTPException(422, 'Combined project exceeds media limits')
            active = {j.get('sessionId') for j in v['jobs'].values() if j['status'] not in {'completed', 'cancelled', 'failed'}}
            # Expiry cleanup is CPU-only and only runs on an explicit upload.
            async with io_lock:
                await storage.reload.aio()
                for key, item in list(index.items()):
                    if item['expiresUnix'] < time.time() and key not in active:
                        target = directory(key)
                        if target.is_relative_to(ROOT) and not target.is_symlink() and target.exists():
                            shutil.rmtree(target)
                        await state.pop.aio('render-session:' + key, None)
                        del index[key]
                if len(index) >= 16 or sum(s['totalBytes'] for s in index.values()) + total > MAX_ALL_PROJECT_BYTES:
                    raise HTTPException(429, 'Private media storage allowance reached')
                directory(ident).mkdir(parents=True, exist_ok=True)
                if reused:
                    assets = directory(ident) / 'assets'
                    assets.mkdir(exist_ok=True)
                    for f in reused['files']:
                        source = directory(reused['id']) / 'assets' / uuid_value(f['id'])
                        if source.is_symlink():
                            raise HTTPException(503, 'Invalid stored asset')
                        shutil.copyfile(source, assets / f['id'])
                await storage.commit.aio()
            expires = time.time() + RETENTION_SECONDS
            session = {'id': ident, 'fingerprint': fingerprint, 'files': [f | {'complete': False, 'parts': {}} for f in files],
                       'prepared': False, 'derived': {}, 'totalBytes': total, 'expiresUnix': expires,
                       'expiresAt': datetime.fromtimestamp(expires, timezone.utc).isoformat()}
            if reused:
                session['files'] = reused['files'] + session['files']
            await save(session)
            index[ident] = {'totalBytes': total, 'expiresUnix': expires}
            await state.put.aio('render-session-index', index)
            return session_view(session)

    @web.get('/render/sessions/{session_id}')
    async def get_session(session_id: str):
        async with control_lock():
            await ledger()  # Incorporates a completed preview job, if any.
            return session_view(await load(session_id))

    @web.post('/render/sessions/{session_id}/files/{file_id}/chunks/{index}')
    async def upload_chunk(session_id: str, file_id: str, index: int, request: Request):
        try:
            file_id = uuid_value(file_id)
            body = await request.json()
            if set(body) != {'data', 'sha256'} or not re.fullmatch('[a-f0-9]{64}', body['sha256']):
                raise ValueError()
            raw = base64.b64decode(body['data'], validate=True)
            if len(raw) > CHUNK_BYTES or hashlib.sha256(raw).hexdigest() != body['sha256']:
                raise ValueError()
        except (ValueError, TypeError, KeyError):
            raise HTTPException(422, 'Invalid media chunk')
        async with control_lock():
            session = await load(session_id)
            f = next((f for f in session['files'] if f['id'] == file_id), None)
            if f is None:
                raise HTTPException(404, 'File not found')
            if f['complete']:
                raise HTTPException(409, 'File is immutable')
            count = (f['size'] + CHUNK_BYTES - 1) // CHUNK_BYTES
            if not 0 <= index < count or len(raw) != min(CHUNK_BYTES, f['size'] - index * CHUNK_BYTES):
                raise HTTPException(422, 'Chunk size or index is invalid')
            existing = f['parts'].get(str(index))
            if existing and existing != body['sha256']:
                raise HTTPException(409, 'Chunk already contains different data')
            async with io_lock:
                await storage.reload.aio()
                from modal_backend.contracts import disk_usage_bytes
                if disk_usage_bytes(Path('/data')) + len(raw) > 80 * 1024**3:
                    raise HTTPException(429, 'Physical storage limit reached')
                target = directory(session['id']) / 'parts' / file_id / str(index)
                target.parent.mkdir(parents=True, exist_ok=True)
                if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() != body['sha256']:
                    raise HTTPException(409, 'Chunk conflict')
                target.write_bytes(raw)
                await storage.commit.aio()
            f['parts'][str(index)] = body['sha256']
            await save(session)
            return {'ok': True, 'index': index}

    @web.post('/render/sessions/{session_id}/files/{file_id}/complete')
    async def finish_file(session_id: str, file_id: str):
        try:
            file_id = uuid_value(file_id)
        except ValueError:
            raise HTTPException(400, 'Invalid file')
        async with control_lock():
            session = await load(session_id)
            f = next((f for f in session['files'] if f['id'] == file_id), None)
            if f is None:
                raise HTTPException(404, 'File not found')
            if f['complete']:
                return session_view(session)
            count = (f['size'] + CHUNK_BYTES - 1) // CHUNK_BYTES
            if len(f['parts']) != count:
                raise HTTPException(409, 'Upload incomplete')
            async with io_lock:
                await storage.reload.aio()
                base = directory(session['id'])
                target = base / 'assets' / file_id
                target.parent.mkdir(exist_ok=True)
                digest = hashlib.sha256()
                with target.with_suffix('.part').open('wb') as output:
                    for i in range(count):
                        data = (base / 'parts' / file_id / str(i)).read_bytes()
                        if hashlib.sha256(data).hexdigest() != f['parts'][str(i)]:
                            raise HTTPException(409, 'Stored chunk failed integrity check')
                        output.write(data)
                        digest.update(data)
                if target.with_suffix('.part').stat().st_size != f['size']:
                    raise HTTPException(409, 'File size mismatch')
                target.with_suffix('.part').replace(target)
                parts = base / 'parts' / file_id
                if not parts.is_relative_to(ROOT) or parts.is_symlink():
                    raise HTTPException(503, 'Storage unavailable')
                shutil.rmtree(parts)
                await storage.commit.aio()
            f.update(complete=True, sha256=digest.hexdigest(), parts={})
            await save(session)
            return session_view(session)

    @web.delete('/render/sessions/{session_id}')
    async def delete_session(session_id: str):
        async with control_lock():
            session_id = uuid_value(session_id)
            v = await ledger()
            if any(j.get('sessionId') == session_id and j['status'] not in {'completed', 'failed', 'cancelled'} for j in v['jobs'].values()):
                raise HTTPException(409, 'Media is in use by a job')
            async with io_lock:
                await storage.reload.aio()
                target = directory(session_id)
                if target.is_relative_to(ROOT) and not target.is_symlink() and target.exists():
                    shutil.rmtree(target)
                await storage.commit.aio()
            await state.pop.aio('render-session:' + session_id, None)
            index = await active_sessions()
            index.pop(session_id, None)
            await state.put.aio('render-session-index', index)
            return {'ok': True}

    @web.get('/render/sessions/{session_id}/assets/{asset_path:path}')
    async def asset(session_id: str, asset_path: str, request: Request):
        clean = asset_path.removeprefix('light/')
        if not safe_asset(clean):
            raise HTTPException(400, 'Invalid asset')
        async with control_lock():
            await ledger()
            session = await load(session_id)
            original = next((f for f in session['files'] if f['path'] == clean and f['complete']), None)
            derived = session.get('derived', {}).get(asset_path)
            if derived and re.fullmatch(r'(?:previews|thumbs)/[a-f0-9-]{36}\.(?:mp4|jpg)', derived):
                target = directory(session['id']) / derived
            elif original:
                target = directory(session['id']) / 'assets' / original['id']
            else:
                raise HTTPException(404, 'Asset unavailable')
        async with io_lock:
            await storage.reload.aio()
            if target.is_symlink() or not target.resolve().is_relative_to(directory(session['id']).resolve()) or not target.is_file():
                raise HTTPException(404, 'Asset unavailable')
            size = target.stat().st_size
        start, end, status = 0, size - 1, 200
        value = request.headers.get('range')
        if value:
            match = re.fullmatch(r'bytes=(\d*)-(\d*)', value)
            if not match or not any(match.groups()):
                raise HTTPException(416, 'Invalid range')
            a, b = match.groups()
            if a:
                start, end = int(a), min(int(b) if b else size - 1, size - 1)
            else:
                start = max(0, size - int(b))
            if start > end or start >= size:
                raise HTTPException(416, 'Range unavailable')
            status = 206
        async def stream():
            # Keep reload/commit away from open file descriptors, including disconnects.
            async with io_lock:
                await storage.reload.aio()
                with target.open('rb') as source:
                    source.seek(start)
                    remaining = end - start + 1
                    while remaining:
                        block = source.read(min(1024**2, remaining))
                        if not block:
                            break
                        remaining -= len(block)
                        yield block
                        await asyncio.sleep(0)
        import mimetypes
        headers = {'Accept-Ranges': 'bytes', 'Content-Length': str(end-start+1), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff'}
        if status == 206:
            headers['Content-Range'] = f'bytes {start}-{end}/{size}'
        return StreamingResponse(stream(), status_code=status, media_type=mimetypes.guess_type(clean)[0] or 'application/octet-stream', headers=headers)

    return {'load': load, 'validate_job': validate_job, 'apply_result': apply_result}
