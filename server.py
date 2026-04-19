"""
Automation Reports — server.py v2
Auth + Postgres + Multi-instance + Folders + Filters
pip install fastapi uvicorn httpx psycopg2-binary cryptography passlib[bcrypt] python-jose openpyxl
"""
from __future__ import annotations
import os, secrets
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

import httpx
from fastapi import FastAPI, HTTPException, Query, Depends
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel
import psycopg2, psycopg2.extras
from passlib.context import CryptContext
from cryptography.fernet import Fernet
import io

# ── CONFIG ──────────────────────────────────────────────
DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://postgres:password@localhost:5432/postgres")
SECRET_KEY   = os.environ.get("SECRET_KEY", secrets.token_hex(32))
_fernet_key = os.environ.get("FERNET_KEY", "")
if not _fernet_key:
    _fernet_key = Fernet.generate_key().decode()
try:
    fernet = Fernet(_fernet_key.encode() if isinstance(_fernet_key, str) else _fernet_key)
except Exception:
    fernet = Fernet(Fernet.generate_key())

pwd_ctx  = CryptContext(schemes=["bcrypt"], deprecated="auto")

security = HTTPBearer()

app = FastAPI(title="Automation Reports API", version="2.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ── DB ──────────────────────────────────────────────────
def get_db():
    conn = psycopg2.connect(DATABASE_URL)
    conn.autocommit = True
    return conn

def db_query(sql, params=None, fetch=None):
    conn = get_db()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(sql, params or ())
        if fetch == 'one':  return dict(cur.fetchone()) if cur.rowcount or cur.description else None
        if fetch == 'all':  return [dict(r) for r in cur.fetchall()]
        if fetch == 'scalar': row = cur.fetchone(); return row[0] if row else None
        return None
    finally:
        conn.close()

# ── AUTH ──────────────────────────────────────────────── 
def hash_password(pw): return pwd_ctx.hash(pw)
def verify_password(pw, h): return pwd_ctx.verify(pw, h)

def create_token(user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    expires = datetime.now(timezone.utc) + timedelta(days=30)
    db_query("INSERT INTO ar_sessions (token, user_id, expires_at) VALUES (%s, %s, %s)",
             (token, user_id, expires))
    return token

def get_current_user(creds: HTTPAuthorizationCredentials = Depends(security)):
    token = creds.credentials
    row = db_query(
        "SELECT u.id, u.email, u.name FROM ar_sessions s JOIN ar_users u ON u.id=s.user_id "
        "WHERE s.token=%s AND s.expires_at > NOW()", (token,), fetch='one')
    if not row:
        raise HTTPException(status_code=401, detail="Token inválido o expirado")
    return row

# ── MODELS ─────────────────────────────────────────────
class LoginRequest(BaseModel):
    email: str
    password: str

class RegisterRequest(BaseModel):
    email: str
    password: str
    name: str = ""

class InstanceRequest(BaseModel):
    name: str
    url: str
    api_key: str

class FolderRequest(BaseModel):
    name: str
    color: str = "#1a5fa8"

class WorkflowFolderRequest(BaseModel):
    workflow_id: str
    folder_id: Optional[int] = None

class TimeSavedRequest(BaseModel):
    workflow_id: str
    instance_id: int
    minutes: int
    notes: str = ""

# ── HELPERS ────────────────────────────────────────────
def parse_dt(s):
    if not s: return None
    try: return datetime.fromisoformat(str(s).replace("Z","+00:00"))
    except: return None

def extract_client(name):
    import re
    m = re.match(r"^\[([^\]]+)\]", name)
    return m.group(1) if m else "Sin clasificar"

async def n8n_get(url: str, api_key: str, path: str):
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.get(url.rstrip("/")+path, headers={"X-N8N-API-KEY": api_key})
        r.raise_for_status()
        return r.json()

async def fetch_executions(url, api_key, period_days):
    all_execs, cursor = [], None
    cutoff = datetime.now(timezone.utc) - timedelta(days=period_days)
    while True:
        path = f"/api/v1/executions?limit=250{('&cursor='+cursor) if cursor else ''}"
        try: data = await n8n_get(url, api_key, path)
        except Exception as e: print(f"Exec fetch error: {e}"); break
        items      = data if isinstance(data, list) else data.get("data", [])
        next_cursor = None if isinstance(data, list) else data.get("nextCursor")
        if not items: break
        stop = False
        for ex in items:
            started = parse_dt(ex.get("startedAt"))
            if started and started < cutoff: stop = True; break
            stopped = parse_dt(ex.get("stoppedAt"))
            run_ms = (stopped-started).total_seconds()*1000 if started and stopped else 0
            status = ex.get("status","")
            if not status:
                status = "success" if ex.get("finished") else "error"
            all_execs.append({
                "id": str(ex.get("id","")), "workflowId": str(ex.get("workflowId","")),
                "status": status, "startedAt": ex.get("startedAt"),
                "stoppedAt": ex.get("stoppedAt"), "runMs": round(run_ms),
            })
        if stop or not next_cursor: break
        cursor = next_cursor
    return all_execs

# ── AUTH ROUTES ────────────────────────────────────────
@app.post("/api/auth/register")
async def register(req: RegisterRequest):
    existing = db_query("SELECT id FROM ar_users WHERE email=%s", (req.email,), fetch='one')
    if existing: raise HTTPException(400, "Email ya registrado")
    db_query("INSERT INTO ar_users (email, password_hash, name) VALUES (%s,%s,%s)",
             (req.email, hash_password(req.password), req.name))
    user = db_query("SELECT id, email, name FROM ar_users WHERE email=%s", (req.email,), fetch='one')
    token = create_token(user['id'])
    return {"token": token, "user": user}

@app.post("/api/auth/login")
async def login(req: LoginRequest):
    user = db_query("SELECT id, email, name, password_hash FROM ar_users WHERE email=%s",
                    (req.email,), fetch='one')
    if not user or not verify_password(req.password, user['password_hash']):
        raise HTTPException(401, "Email o contraseña incorrectos")
    token = create_token(user['id'])
    return {"token": token, "user": {"id": user['id'], "email": user['email'], "name": user['name']}}

@app.post("/api/auth/logout")
async def logout_route(user=Depends(get_current_user), creds: HTTPAuthorizationCredentials = Depends(security)):
    db_query("DELETE FROM ar_sessions WHERE token=%s", (creds.credentials,))
    return {"ok": True}

# ── INSTANCES ──────────────────────────────────────────
@app.get("/api/instances")
async def get_instances(user=Depends(get_current_user)):
    rows = db_query("SELECT id, name, url FROM ar_instances WHERE user_id=%s ORDER BY id",
                    (user['id'],), fetch='all')
    return {"instances": rows or []}

@app.post("/api/instances")
async def add_instance(req: InstanceRequest, user=Depends(get_current_user)):
    # Test connection first
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(req.url.rstrip("/")+"/api/v1/workflows?limit=1",
                                 headers={"X-N8N-API-KEY": req.api_key})
            r.raise_for_status()
    except Exception as e:
        raise HTTPException(502, f"No se puede conectar a n8n: {str(e)}")
    encrypted = fernet.encrypt(req.api_key.encode()).decode()
    db_query("INSERT INTO ar_instances (user_id, name, url, api_key_encrypted) VALUES (%s,%s,%s,%s)",
             (user['id'], req.name, req.url.rstrip("/"), encrypted))
    return {"ok": True}

@app.delete("/api/instances/{instance_id}")
async def delete_instance(instance_id: int, user=Depends(get_current_user)):
    db_query("DELETE FROM ar_instances WHERE id=%s AND user_id=%s", (instance_id, user['id']))
    return {"ok": True}

# ── WORKFLOWS & EXECUTIONS ─────────────────────────────
@app.get("/api/workflows/{instance_id}")
async def get_workflows(instance_id: int, period: int = Query(30), user=Depends(get_current_user)):
    row = db_query("SELECT url, api_key_encrypted FROM ar_instances WHERE id=%s AND user_id=%s",
                   (instance_id, user['id']), fetch='one')
    if not row: raise HTTPException(404, "Instancia no encontrada")
    api_key = fernet.decrypt(row['api_key_encrypted'].encode()).decode()
    try:
        data = await n8n_get(row['url'], api_key, "/api/v1/workflows?limit=250")
        raw  = data if isinstance(data, list) else data.get("data", [])
        wfs  = [{"id": str(w["id"]), "name": w.get("name",""), "active": w.get("active",False),
                 "createdAt": w.get("createdAt"), "updatedAt": w.get("updatedAt")} for w in raw]
        return {"workflows": wfs}
    except Exception as e:
        raise HTTPException(502, str(e))

@app.get("/api/executions/{instance_id}")
async def get_executions(instance_id: int, period: int = Query(30), user=Depends(get_current_user)):
    row = db_query("SELECT url, api_key_encrypted FROM ar_instances WHERE id=%s AND user_id=%s",
                   (instance_id, user['id']), fetch='one')
    if not row: raise HTTPException(404, "Instancia no encontrada")
    api_key = fernet.decrypt(row['api_key_encrypted'].encode()).decode()
    try:
        execs = await fetch_executions(row['url'], api_key, period)
        return {"executions": execs, "total": len(execs)}
    except Exception as e:
        raise HTTPException(502, str(e))

# ── FOLDERS ────────────────────────────────────────────
@app.get("/api/folders")
async def get_folders(user=Depends(get_current_user)):
    rows = db_query("SELECT id, name, color FROM ar_folders WHERE user_id=%s ORDER BY name",
                    (user['id'],), fetch='all')
    return {"folders": rows or []}

@app.post("/api/folders")
async def create_folder(req: FolderRequest, user=Depends(get_current_user)):
    db_query("INSERT INTO ar_folders (user_id, name, color) VALUES (%s,%s,%s)",
             (user['id'], req.name, req.color))
    return {"ok": True}

@app.post("/api/folders/{folder_id}")
async def update_folder(folder_id: int, req: FolderRequest, user=Depends(get_current_user)):
    db_query("UPDATE ar_folders SET name=%s, color=%s WHERE id=%s AND user_id=%s",
             (req.name, req.color, folder_id, user['id']))
    return {"ok": True}

@app.delete("/api/folders/{folder_id}")
async def delete_folder(folder_id: int, user=Depends(get_current_user)):
    db_query("DELETE FROM ar_folders WHERE id=%s AND user_id=%s", (folder_id, user['id']))
    return {"ok": True}

# ── WORKFLOW-FOLDER ASSIGNMENTS ────────────────────────
@app.get("/api/workflow-folders")
async def get_wf_folders(user=Depends(get_current_user)):
    rows = db_query(
        "SELECT wf.workflow_id, wf.folder_id FROM ar_workflow_folders wf "
        "JOIN ar_folders f ON f.id=wf.folder_id WHERE f.user_id=%s",
        (user['id'],), fetch='all')
    assignments = {str(r['workflow_id']): r['folder_id'] for r in (rows or [])}
    return {"assignments": assignments}

@app.post("/api/workflow-folders")
async def assign_wf_folder(req: WorkflowFolderRequest, user=Depends(get_current_user)):
    db_query("DELETE FROM ar_workflow_folders WHERE workflow_id=%s", (req.workflow_id,))
    if req.folder_id:
        db_query("INSERT INTO ar_workflow_folders (workflow_id, folder_id) VALUES (%s,%s)",
                 (req.workflow_id, req.folder_id))
    return {"ok": True}

# ── TIME SAVED ─────────────────────────────────────────
@app.get("/api/time-saved")
async def get_time_saved(user=Depends(get_current_user)):
    rows = db_query("SELECT workflow_id, minutes_per_execution, notes FROM ar_time_saved WHERE user_id=%s",
                    (user['id'],), fetch='all')
    ts = {r['workflow_id']: r['minutes_per_execution'] for r in (rows or [])}
    return {"time_saved": ts}

@app.post("/api/time-saved")
async def save_time_saved(req: TimeSavedRequest, user=Depends(get_current_user)):
    key = f"{req.instance_id}_{req.workflow_id}"
    db_query("""INSERT INTO ar_time_saved (workflow_id, user_id, minutes_per_execution, notes, updated_at)
                VALUES (%s,%s,%s,%s,NOW())
                ON CONFLICT (workflow_id, user_id) DO UPDATE
                SET minutes_per_execution=%s, notes=%s, updated_at=NOW()""",
             (key, user['id'], req.minutes, req.notes, req.minutes, req.notes))
    return {"ok": True}

# ── HEALTH ─────────────────────────────────────────────
@app.get("/api/health")
async def health():
    try:
        db_query("SELECT 1")
        return {"ok": True, "db": "connected"}
    except Exception as e:
        return {"ok": False, "db": str(e)}

# ── SERVE FRONTEND ─────────────────────────────────────
static_dir = Path(__file__).parent

@app.get("/")
async def serve_index():
    return FileResponse(str(static_dir / "index.html"))

@app.get("/login")
async def serve_login():
    return FileResponse(str(static_dir / "login.html"))

@app.get("/style.css")
async def serve_css():
    return FileResponse(str(static_dir / "style.css"), media_type="text/css")

@app.get("/app.js")
async def serve_js():
    return FileResponse(str(static_dir / "app.js"), media_type="application/javascript")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=True)
