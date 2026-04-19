/* ══════════════════════════════════════════════════════
   Automation Reports — app.js v2
   Auth + Folders + Filters + Multi-instance
   ══════════════════════════════════════════════════════ */

const API = '/api';

// ── AUTH ───────────────────────────────────────────────
function getToken() { return localStorage.getItem('ar_token'); }
function getUser()  { try { return JSON.parse(localStorage.getItem('ar_user')); } catch(e) { return null; } }

function authHeaders() {
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` };
}

async function apiGet(path) {
  const res = await fetch(API + path, { headers: authHeaders() });
  if (res.status === 401) { logout(); return; }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(API + path, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) });
  if (res.status === 401) { logout(); return; }
  if (!res.ok) { const d = await res.json(); throw new Error(d.detail || `HTTP ${res.status}`); }
  return res.json();
}

async function apiDelete(path) {
  const res = await fetch(API + path, { method: 'DELETE', headers: authHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function logout() {
  localStorage.removeItem('ar_token');
  localStorage.removeItem('ar_user');
  window.location.href = '/login';
}

// ── STATE ──────────────────────────────────────────────
const state = {
  instances: [],
  folders: [],
  workflowFolders: {},   // { workflowId: folderId }
  timeSaved: {},         // { instanceId_workflowId: minutes }
  workflows: [],
  executions: [],
  charts: {},
  currentWfModal: null,
  currentAssignWf: null,
  currentFolderEdit: null,
  selectedColor: '#1a5fa8',
  period: 30,
};

// ── UTILS ──────────────────────────────────────────────
const fmt = {
  number: n => n >= 1000 ? (n/1000).toFixed(1).replace(/\.0$/,'') + 'k' : String(n),
  time:   ms => ms >= 60000 ? (ms/60000).toFixed(1) + 'm' : (ms/1000).toFixed(1) + 's',
  hours:  mins => mins >= 60 ? Math.round(mins/60) + 'h' : mins + 'm',
  pct:    n => n.toFixed(1) + '%',
  ago:    iso => {
    if (!iso) return '—';
    const diff = Date.now() - new Date(iso).getTime();
    const m = Math.floor(diff/60000);
    if (m < 1) return 'ahora';
    if (m < 60) return `hace ${m}min`;
    const h = Math.floor(m/60);
    if (h < 24) return `hace ${h}h`;
    return `hace ${Math.floor(h/24)}d`;
  }
};

const $ = id => document.getElementById(id);

function getClientForWorkflow(wfId) {
  const folderId = state.workflowFolders[wfId];
  if (!folderId) return 'Sin clasificar';
  const folder = state.folders.find(f => f.id === folderId);
  return folder ? folder.name : 'Sin clasificar';
}

function getFilteredWorkflows() {
  const clientFilter   = $('filter-client').value;
  const statusFilter   = $('filter-status').value;
  const instanceFilter = $('filter-instance').value;
  const search         = ($('search-workflows')?.value || '').toLowerCase();

  return state.workflows.filter(wf => {
    if (search && !wf.name.toLowerCase().includes(search)) return false;
    if (instanceFilter && String(wf.instanceId) !== instanceFilter) return false;
    if (clientFilter) {
      const client = getClientForWorkflow(wf.id);
      if (client !== clientFilter) return false;
    }
    if (statusFilter === 'active' && !wf.active) return false;
    if (statusFilter === 'inactive' && wf.active) return false;
    return true;
  });
}

function getFilteredExecutions(wfIds) {
  return state.executions.filter(e => wfIds.includes(e.workflowId));
}

// ── LOAD DATA ──────────────────────────────────────────
async function loadInstances() {
  const data = await apiGet('/instances');
  state.instances = data.instances || [];
  renderInstances();
  updateInstanceFilter();
}

async function loadFolders() {
  const data = await apiGet('/folders');
  state.folders = data.folders || [];
  // Load workflow-folder assignments
  const wfData = await apiGet('/workflow-folders');
  state.workflowFolders = wfData.assignments || {};
  renderSidebar();
  updateClientFilter();
}

async function loadTimeSaved() {
  const data = await apiGet('/time-saved');
  state.timeSaved = data.time_saved || {};
}

async function syncInstance(instance) {
  try {
    const [wfData, exData] = await Promise.all([
      apiGet(`/workflows/${instance.id}?period=${state.period}`),
      apiGet(`/executions/${instance.id}?period=${state.period}`),
    ]);
    const wfs = (wfData.workflows || []).map(wf => ({ ...wf, instanceId: instance.id, instanceName: instance.name }));
    const exs = (exData.executions || []).map(ex => ({ ...ex, instanceId: instance.id }));
    // Merge into state
    state.workflows = state.workflows.filter(w => w.instanceId !== instance.id).concat(wfs);
    state.executions = state.executions.filter(e => e.instanceId !== instance.id).concat(exs);
  } catch(e) {
    console.error(`Error syncing instance ${instance.name}:`, e);
  }
}

async function syncAll() {
  if (!state.instances.length) return;
  $('sync-btn').classList.add('spinning');
  state.workflows = [];
  state.executions = [];
  for (const inst of state.instances) {
    await syncInstance(inst);
  }
  renderAll();
  $('sync-btn').classList.remove('spinning');
}

// ── RENDER SIDEBAR ─────────────────────────────────────
function renderSidebar() {
  const list = $('clients-list');
  list.innerHTML = '';

  // Named folders
  state.folders.forEach(folder => {
    const wfCount = Object.values(state.workflowFolders).filter(fid => fid === folder.id).length;
    const div = document.createElement('div');
    div.className = 'client-group';
    div.innerHTML = `
      <div class="client-header" data-folderid="${folder.id}">
        <div class="client-header-left">
          <span class="client-dot" style="background:${folder.color}"></span>
          <span>${folder.name}</span>
        </div>
        <div style="display:flex;align-items:center;gap:4px">
          <span class="client-count">${wfCount}</span>
          <button class="folder-edit-btn" onclick="editFolder(${folder.id})" title="Editar">✎</button>
          <button class="folder-edit-btn" onclick="deleteFolder(${folder.id})" title="Eliminar" style="color:#c0392b">✕</button>
        </div>
      </div>`;
    div.querySelector('.client-header').addEventListener('click', e => {
      if (e.target.tagName === 'BUTTON') return;
      $('filter-client').value = folder.name;
      renderAll();
    });
    list.appendChild(div);
  });

  // Sin clasificar
  const unclassified = state.workflows.filter(wf => !state.workflowFolders[wf.id]).length;
  if (unclassified > 0) {
    const div = document.createElement('div');
    div.className = 'client-group';
    div.innerHTML = `
      <div class="client-header">
        <div class="client-header-left">
          <span class="client-dot dot-gray"></span>
          <span>Sin clasificar</span>
        </div>
        <span class="client-count">${unclassified}</span>
      </div>`;
    div.querySelector('.client-header').addEventListener('click', () => {
      $('filter-client').value = 'Sin clasificar';
      renderAll();
    });
    list.appendChild(div);
  }
}

// ── RENDER INSTANCES VIEW ──────────────────────────────
function renderInstances() {
  const list = $('instances-list');
  if (!state.instances.length) {
    list.innerHTML = '<p style="color:var(--text-muted);font-size:13px;">No hay instancias configuradas. Agrega tu primera instancia de n8n.</p>';
    return;
  }
  list.innerHTML = state.instances.map(inst => `
    <div class="instance-card">
      <div class="instance-card-header">
        <div class="instance-card-name">${inst.name}</div>
        <span class="badge badge-active">conectado</span>
      </div>
      <div class="instance-card-url">${inst.url}</div>
      <div class="instance-card-actions">
        <button class="instance-delete-btn" onclick="deleteInstance(${inst.id})">Eliminar</button>
      </div>
    </div>`).join('');
}

// ── UPDATE FILTERS ─────────────────────────────────────
function updateClientFilter() {
  const sel = $('filter-client');
  const current = sel.value;
  sel.innerHTML = '<option value="">Todos los clientes</option>';
  state.folders.forEach(f => sel.innerHTML += `<option value="${f.name}">${f.name}</option>`);
  sel.innerHTML += '<option value="Sin clasificar">Sin clasificar</option>';
  sel.value = current;

  ['pdf-client','xlsx-client'].forEach(id => {
    const s = $(id);
    if (!s) return;
    s.innerHTML = '<option value="">Todos los clientes</option>';
    state.folders.forEach(f => s.innerHTML += `<option value="${f.name}">${f.name}</option>`);
  });
}

function updateInstanceFilter() {
  const sel = $('filter-instance');
  sel.innerHTML = '<option value="">Todas las instancias</option>';
  state.instances.forEach(i => sel.innerHTML += `<option value="${i.id}">${i.name}</option>`);
}

// ── RENDER KPIs ────────────────────────────────────────
function renderKPIs() {
  const filteredWfs = getFilteredWorkflows();
  const wfIds = filteredWfs.map(w => w.id);
  const exs = getFilteredExecutions(wfIds);

  const total  = exs.length;
  const errors = exs.filter(e => e.status === 'error').length;
  const errPct = total ? (errors/total)*100 : 0;
  const rts    = exs.filter(e => e.runMs).map(e => e.runMs);
  const avgMs  = rts.length ? rts.reduce((a,b)=>a+b,0)/rts.length : 0;

  let savedMins = 0;
  filteredWfs.forEach(wf => {
    const key = `${wf.instanceId}_${wf.id}`;
    const manual = state.timeSaved[key];
    if (!manual) return;
    const wfExs = exs.filter(e => e.workflowId === wf.id && e.status === 'success');
    const avgRun = wfExs.length ? wfExs.reduce((a,e)=>a+e.runMs,0)/wfExs.length/60000 : 0;
    savedMins += wfExs.length * Math.max(0, manual - avgRun);
  });

  $('kpi-total').textContent    = fmt.number(total);
  $('kpi-error').textContent    = fmt.pct(errPct);
  $('kpi-avg-time').textContent = fmt.time(avgMs);
  $('kpi-saved').textContent    = fmt.hours(Math.round(savedMins));

  const clientFilter = $('filter-client').value;
  const title = clientFilter ? `KPIs — ${clientFilter}` : 'KPIs globales';
  $('kpi-section-title').textContent = title;

  $('kpi-total-delta').textContent = '';
  $('kpi-error-delta').textContent = '';
  $('kpi-avg-delta').textContent   = '';
  $('kpi-saved-delta').textContent = savedMins > 0 ? `${Math.round(savedMins)} minutos totales` : '';
}

// ── RENDER CHARTS ──────────────────────────────────────
function renderCharts() {
  const filteredWfs = getFilteredWorkflows();
  const wfIds = filteredWfs.map(w => w.id);
  const exs = getFilteredExecutions(wfIds);

  const days = state.period <= 7 ? 7 : 30;
  const now = Date.now();
  const DAY = 86400000;
  const labels = [], execByDay = [], errByDay = [];
  const hourBuckets = new Array(24).fill(0);

  for (let d = days-1; d >= 0; d--) {
    const s = now - (d+1)*DAY, e2 = now - d*DAY;
    const dayExs = exs.filter(e => { const t = new Date(e.startedAt).getTime(); return t>=s && t<e2; });
    labels.push(d === 0 ? 'Hoy' : `-${d}d`);
    execByDay.push(dayExs.length);
    errByDay.push(dayExs.filter(e=>e.status==='error').length);
  }
  exs.forEach(e => { hourBuckets[new Date(e.startedAt).getHours()]++; });

  if (state.charts.exec) state.charts.exec.destroy();
  state.charts.exec = new Chart($('chart-executions'), {
    type: 'bar',
    data: { labels, datasets: [
      { label:'Ejecuciones', data:execByDay, backgroundColor:'#1a5fa822', borderColor:'#1a5fa8', borderWidth:1.5, borderRadius:3 },
      { label:'Errores', data:errByDay, backgroundColor:'#e8404022', borderColor:'#e84040', borderWidth:1.5, borderRadius:3 }
    ]},
    options: { responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{display:false} },
      scales:{
        x:{ grid:{display:false}, ticks:{font:{family:"'IBM Plex Mono'",size:10},color:'#9a9890',maxTicksLimit:10,autoSkip:true} },
        y:{ grid:{color:'#f0ede8'}, ticks:{font:{family:"'IBM Plex Mono'",size:10},color:'#9a9890'}, beginAtZero:true }
      }
    }
  });

  if (state.charts.hours) state.charts.hours.destroy();
  state.charts.hours = new Chart($('chart-hours'), {
    type: 'bar',
    data: { labels: Array.from({length:24},(_,i)=>i+'h'), datasets:[{
      label:'Ejecuciones', data:hourBuckets,
      backgroundColor:'#e8460a33', borderColor:'#e8460a', borderWidth:1.5, borderRadius:2
    }]},
    options: { responsive:true, maintainAspectRatio:false,
      plugins:{legend:{display:false}},
      scales:{
        x:{grid:{display:false},ticks:{font:{family:"'IBM Plex Mono'",size:9},color:'#9a9890',maxTicksLimit:8,autoSkip:true}},
        y:{grid:{color:'#f0ede8'},ticks:{font:{family:"'IBM Plex Mono'",size:10},color:'#9a9890'},beginAtZero:true}
      }
    }
  });
}

// ── RENDER TABLE ───────────────────────────────────────
function renderTable() {
  const wfs = getFilteredWorkflows();
  const tbody = $('wf-tbody');

  if (!wfs.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="9">No hay workflows que coincidan con los filtros</td></tr>';
    return;
  }

  tbody.innerHTML = wfs.map(wf => {
    const exs    = getFilteredExecutions([wf.id]);
    const errors = exs.filter(e => e.status === 'error');
    const succ   = exs.filter(e => e.status === 'success');
    const errPct = exs.length ? (errors.length/exs.length)*100 : 0;
    const lastEx = exs.sort((a,b) => new Date(b.startedAt)-new Date(a.startedAt))[0];
    const client = getClientForWorkflow(wf.id);
    const key    = `${wf.instanceId}_${wf.id}`;
    const manual = state.timeSaved[key];

    let savedStr = '';
    if (manual && succ.length) {
      const avgRun = succ.reduce((a,e)=>a+e.runMs,0)/succ.length/60000;
      const total  = succ.length * Math.max(0, manual - avgRun);
      savedStr = `<span class="time-saved-val">${fmt.hours(Math.round(total))}</span>`;
    } else {
      savedStr = `<button class="time-saved-btn" onclick="openTimeModal('${wf.id}','${wf.instanceId}')">+ Definir</button>`;
    }

    const clientTag = client === 'Sin clasificar'
      ? `<span class="client-tag unclassified-tag">${client}</span>`
      : `<span class="client-tag" style="border-color:${getFolderColor(client)}20;background:${getFolderColor(client)}15;color:${getFolderColor(client)}">${client}</span>`;

    return `<tr>
      <td style="font-weight:500;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${wf.name}">${wf.name}</td>
      <td>${clientTag}</td>
      <td><span style="font-size:11px;color:var(--text-muted)">${wf.instanceName || '—'}</span></td>
      <td>${wf.active ? '<span class="badge badge-active">active</span>' : '<span class="badge badge-inactive">inactive</span>'}</td>
      <td><span class="exec-count">${fmt.number(exs.length)}</span></td>
      <td><span class="error-pct ${errPct>3?'high':'ok'}">${fmt.pct(errPct)}</span></td>
      <td><span class="last-run">${lastEx ? fmt.ago(lastEx.startedAt) : '—'}</span></td>
      <td>${savedStr}</td>
      <td>
        <button class="action-btn" onclick="openAssignModal('${wf.id}')" title="Asignar a cliente">
          <svg width="13" height="13" viewBox="0 0 15 15" fill="none"><path d="M1 8h13M8 1l7 7-7 7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </td>
    </tr>`;
  }).join('');
}

function getFolderColor(clientName) {
  const folder = state.folders.find(f => f.name === clientName);
  return folder ? folder.color : '#6b6960';
}

// ── RENDER ALL ─────────────────────────────────────────
function renderAll() {
  renderKPIs();
  renderCharts();
  renderTable();
  renderSidebar();
}

// ── MODALS ─────────────────────────────────────────────
function closeModal(id) { $(id).classList.add('hidden'); }
function openModal(id)  { $(id).classList.remove('hidden'); }

function openTimeModal(wfId, instanceId) {
  const wf = state.workflows.find(w => w.id === wfId);
  if (!wf) return;
  const key = `${instanceId}_${wfId}`;
  state.currentWfModal = { wfId, instanceId, key };
  $('modal-wf-name').textContent = wf.name;
  $('modal-minutes').value = state.timeSaved[key] || '';
  $('modal-notes').value = '';
  openModal('modal-time');
}

function openAssignModal(wfId) {
  const wf = state.workflows.find(w => w.id === wfId);
  if (!wf) return;
  state.currentAssignWf = wfId;
  $('assign-wf-name').textContent = wf.name;

  const sel = $('assign-folder');
  sel.innerHTML = '<option value="">Sin clasificar</option>';
  state.folders.forEach(f => {
    sel.innerHTML += `<option value="${f.id}" ${state.workflowFolders[wfId]==f.id?'selected':''}>${f.name}</option>`;
  });
  openModal('modal-assign');
}

function editFolder(folderId) {
  const folder = state.folders.find(f => f.id === folderId);
  if (!folder) return;
  state.currentFolderEdit = folderId;
  $('folder-modal-title').textContent = 'Editar carpeta';
  $('folder-name').value = folder.name;
  state.selectedColor = folder.color;
  document.querySelectorAll('.color-opt').forEach(el => {
    el.classList.toggle('selected', el.dataset.color === folder.color);
  });
  openModal('modal-folder');
}

async function deleteFolder(folderId) {
  if (!confirm('¿Eliminar esta carpeta? Los workflows quedarán sin clasificar.')) return;
  try {
    await apiDelete(`/folders/${folderId}`);
    await loadFolders();
    renderAll();
  } catch(e) { alert('Error al eliminar: ' + e.message); }
}

async function deleteInstance(instanceId) {
  if (!confirm('¿Eliminar esta instancia? Se borrarán sus credenciales.')) return;
  try {
    await apiDelete(`/instances/${instanceId}`);
    state.workflows = state.workflows.filter(w => w.instanceId !== instanceId);
    state.executions = state.executions.filter(e => e.instanceId !== instanceId);
    await loadInstances();
    renderAll();
  } catch(e) { alert('Error: ' + e.message); }
}

// ── EXPORT ─────────────────────────────────────────────
async function exportReport(format) {
  const clientId = format === 'pdf' ? $('pdf-client').value : $('xlsx-client').value;
  try {
    const res = await fetch(`${API}/export/${format}?client=${encodeURIComponent(clientId)}&period=${state.period}`,
      { headers: { 'Authorization': `Bearer ${getToken()}` } });
    if (!res.ok) throw new Error();
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `reporte_${clientId||'todos'}_${new Date().toISOString().slice(0,10)}.${format==='pdf'?'pdf':'xlsx'}`;
    a.click();
    URL.revokeObjectURL(url);
  } catch(e) { alert('Error al exportar. Verifica que el servidor esté activo.'); }
}

// ── NAVIGATION ─────────────────────────────────────────
function setView(viewId) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.getElementById('view-'+viewId)?.classList.remove('hidden');
  document.querySelectorAll('.nav-item[data-view]').forEach(n => n.classList.toggle('active', n.dataset.view === viewId));
  const titles = { dashboard:'Dashboard Global', reportes:'Reportes', instancias:'Instancias n8n' };
  $('page-title').textContent = titles[viewId] || '';
  $('filters').style.display = viewId === 'dashboard' ? 'flex' : 'none';
}

// ── INIT ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Check auth
  if (!getToken()) { window.location.href = '/login'; return; }

  const user = getUser();
  if (user) $('user-info').textContent = user.name || user.email;

  // Nav
  document.querySelectorAll('.nav-item[data-view]').forEach(n => {
    n.addEventListener('click', e => { e.preventDefault(); setView(n.dataset.view); });
  });

  // Logout
  $('logout-btn').addEventListener('click', logout);

  // Sync btn
  $('sync-btn').addEventListener('click', syncAll);

  // Period filter
  $('period-select').addEventListener('change', e => { state.period = parseInt(e.target.value); syncAll(); });

  // Client / status / instance filters
  ['filter-client','filter-status','filter-instance'].forEach(id => {
    $(id).addEventListener('change', renderAll);
  });

  // Search
  $('search-workflows').addEventListener('input', renderTable);

  // New folder btn
  $('new-folder-btn').addEventListener('click', () => {
    state.currentFolderEdit = null;
    $('folder-modal-title').textContent = 'Nueva carpeta';
    $('folder-name').value = '';
    state.selectedColor = '#1a5fa8';
    document.querySelectorAll('.color-opt').forEach((el,i) => el.classList.toggle('selected', i===0));
    openModal('modal-folder');
  });

  // Color options
  document.querySelectorAll('.color-opt').forEach(el => {
    el.addEventListener('click', () => {
      document.querySelectorAll('.color-opt').forEach(e => e.classList.remove('selected'));
      el.classList.add('selected');
      state.selectedColor = el.dataset.color;
    });
  });

  // Save folder
  $('folder-save').addEventListener('click', async () => {
    const name = $('folder-name').value.trim();
    if (!name) return;
    try {
      if (state.currentFolderEdit) {
        await apiPost(`/folders/${state.currentFolderEdit}`, { name, color: state.selectedColor });
      } else {
        await apiPost('/folders', { name, color: state.selectedColor });
      }
      closeModal('modal-folder');
      await loadFolders();
      updateClientFilter();
      renderAll();
    } catch(e) { alert('Error: ' + e.message); }
  });

  // Save time modal
  $('modal-save').addEventListener('click', async () => {
    const { wfId, instanceId, key } = state.currentWfModal || {};
    if (!wfId) return;
    const mins = parseInt($('modal-minutes').value, 10);
    if (!mins || mins < 1) return;
    try {
      await apiPost('/time-saved', { workflow_id: wfId, instance_id: instanceId, minutes: mins, notes: $('modal-notes').value });
      state.timeSaved[key] = mins;
      closeModal('modal-time');
      renderAll();
    } catch(e) { alert('Error: ' + e.message); }
  });

  // Save assign
  $('assign-save').addEventListener('click', async () => {
    const wfId = state.currentAssignWf;
    const folderId = $('assign-folder').value;
    try {
      await apiPost('/workflow-folders', { workflow_id: wfId, folder_id: folderId ? parseInt(folderId) : null });
      if (folderId) state.workflowFolders[wfId] = parseInt(folderId);
      else delete state.workflowFolders[wfId];
      closeModal('modal-assign');
      renderAll();
    } catch(e) { alert('Error: ' + e.message); }
  });

  // Add instance
  $('add-instance-btn').addEventListener('click', () => {
    $('inst-name').value = ''; $('inst-url').value = ''; $('inst-apikey').value = '';
    $('inst-status').textContent = '';
    openModal('modal-instance');
  });

  $('inst-save').addEventListener('click', async () => {
    const name   = $('inst-name').value.trim();
    const url    = $('inst-url').value.trim();
    const apiKey = $('inst-apikey').value.trim();
    if (!name || !url || !apiKey) { $('inst-status').textContent = 'Completa todos los campos.'; return; }
    $('inst-save').textContent = 'Guardando...';
    $('inst-save').disabled = true;
    try {
      await apiPost('/instances', { name, url, api_key: apiKey });
      closeModal('modal-instance');
      await loadInstances();
      await syncAll();
    } catch(e) {
      $('inst-status').textContent = e.message;
    } finally {
      $('inst-save').textContent = 'Guardar';
      $('inst-save').disabled = false;
    }
  });

  // Close modals on overlay click / ESC
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => { if(e.target === overlay) overlay.classList.add('hidden'); });
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') document.querySelectorAll('.modal-overlay').forEach(o => o.classList.add('hidden'));
  });

  // Load everything
  try {
    await Promise.all([loadInstances(), loadFolders(), loadTimeSaved()]);
    if (state.instances.length) await syncAll();
    else {
      $('wf-tbody').innerHTML = '<tr class="empty-row"><td colspan="9">Agrega una instancia de n8n para empezar →</td></tr>';
      setView('instancias');
    }
  } catch(e) {
    console.error('Init error:', e);
  }
});
