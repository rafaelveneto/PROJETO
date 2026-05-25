// ==========================================
// CONFIGURAÇÃO DO FIREBASE
// ==========================================
const firebaseConfig = {
  apiKey: "AIzaSyCdjd_0Ubn1d7JFfAOX5lNjghsdMetp3vU",
  authDomain: "aprovado-tracker.firebaseapp.com",
  projectId: "aprovado-tracker",
  storageBucket: "aprovado-tracker.firebasestorage.app",
  messagingSenderId: "457948327236",
  appId: "1:457948327236:web:7b04a9f70361807f3bbb11"
};

if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}
const auth = firebase.auth();
const db = firebase.firestore();

// ==========================================
// ESTADO GLOBAL & MOCKS
// ==========================================
const TYPES = {
  TEORIA:    { label: 'Teoria',    cor: '#60a5fa' },
  LEI_SECA:  { label: 'Lei Seca',  cor: '#4ade80' },
  QUESTOES:  { label: 'Questões',  cor: '#f5a623' },
  REVISAO:   { label: 'Revisão',   cor: '#22d3ee' }
};

const STATUS_EDITAL = [
  { value: 'previsto',    label: 'Previsto'          },
  { value: 'cobrado',     label: 'Cobrado / Exigido' },
  { value: 'nao_previsto',label: 'Não previsto'      }
];

const SEED = {
  config: { lastModified: Date.now(), horasSemana: [0,4,4,4,4,4,2] },
  disciplinas: [
    { id: 'port', nome: 'Língua Portuguesa',      peso: 20, metaAcerto: 85, cor: '#3266ad', aulas: [] },
    { id: 'dir',  nome: 'Direito Administrativo', peso: 30, metaAcerto: 80, cor: '#D85A30', aulas: [] }
  ],
  questoes_history: []
};

const MOCK_GLOBAL_STATS = { avgAcertoGeral: 76.5, avgVolumeMensal: 1250, disciplinas: {} };

let S = JSON.parse(localStorage.getItem('aprovado-v6')) || SEED;
if (!S.config.horasSemana) S.config.horasSemana = [0, 4, 4, 4, 4, 4, 2];

let currentUser     = null;
let qPeriod         = 'all';
let qChartInstance  = null;
let qDiscSel        = 'all';

// ==========================================
// TOAST NOTIFICATIONS
// ==========================================
window.showToast = function(msg, type = 'success') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => toast.classList.add('show'));
  });
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 3200);
};

// ==========================================
// AUTENTICAÇÃO E SINCRONIZAÇÃO
// ==========================================
function setSyncState(state) {
  const dot  = document.getElementById('syncDot');
  const text = document.getElementById('syncText');
  if (!dot) return;
  dot.className  = 'sync-dot s-' + state;
  text.textContent = state === 'synced' ? 'Sincronizado'
                   : state === 'syncing' ? 'Sincronizando...'
                   : 'Off';
}

function saveState() {
  S.config.lastModified = Date.now();
  localStorage.setItem('aprovado-v6', JSON.stringify(S));
  pushFirebase();
}

window.loginFirebase  = async function() { await auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()); };
window.logoutFirebase = async function() {
  if (confirm('Deseja sair da conta?')) { await auth.signOut(); location.reload(); }
};

window.pullFirebase = async function(force = false) {
  if (!currentUser) { setSyncState('error'); return; }
  setSyncState('syncing');
  try {
    const docSnap = await db.collection('usuarios_pro').doc(currentUser.uid).get();
    if (docSnap.exists) {
      const remote = docSnap.data();
      if (force || remote.config?.lastModified > S.config.lastModified) {
        S = remote;
        if (!S.config.horasSemana) S.config.horasSemana = [0,4,4,4,4,4,2];
        if (!S.questoes_history)   S.questoes_history   = [];
        saveState();
        renderAll();
      }
    }
    setSyncState('synced');
  } catch(e) {
    setSyncState('error');
    console.error('[Firebase pull error]', e);
    showToast(`Erro de sync: ${e.code || e.message}`, 'error');
  }
};

async function pushFirebase() {
  if (!currentUser) return;
  setSyncState('syncing');
  try {
    await db.collection('usuarios_pro').doc(currentUser.uid).set(JSON.parse(JSON.stringify(S)));
    setSyncState('synced');
  } catch(e) {
    setSyncState('error');
    console.error('[Firebase push error]', e);
    showToast(`Erro ao salvar: ${e.code || e.message}`, 'error');
  }
}

auth.onAuthStateChanged(user => {
  if (user) {
    currentUser = user;
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('appShell').style.display = 'flex';
    document.getElementById('sbUserName').textContent = user.displayName?.split(' ')[0] || 'Aluno';
    pullFirebase();
    renderAll();
  } else {
    document.getElementById('loginScreen').classList.remove('hidden');
    document.getElementById('appShell').style.display = 'none';
  }
});

// ==========================================
// INTERFACE E ROTAS
// ==========================================
const uid = () => Math.random().toString(36).slice(2, 9);
function fmtMin(m) { const h = Math.floor(m/60), r = m%60; return r ? `${h}h ${r}m` : `${h}h`; }

window.toggleSidebar = function() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebarOverlay').classList.toggle('open');
};
window.closeSidebar = function() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarOverlay').classList.remove('open');
};

window.goTab = function(name) {
  document.querySelectorAll('.tab, .nav-item').forEach(e => e.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  const nav = document.getElementById('nav-' + name);
  if (nav) nav.classList.add('active');

  // MUDANÇA 2: título renomeado para "Análise de Desempenho"
  const titles = {
    'hoje':        'Foco do Dia',
    'meta':        'Trilha Adaptativa',
    'questoes':    'Análise de Desempenho',
    'disciplinas': 'Disciplinas',
    'importar':    'Importar Dados'
  };
  document.getElementById('pageTitle').textContent = titles[name] || name;

  if (name === 'hoje')        renderHoje();
  if (name === 'questoes')    { populateDiscDropdowns(); renderQuestoes(); }
  if (name === 'meta')        renderAgendaGrid();
  if (name === 'importar')    populateDiscDropdowns();
  if (name === 'disciplinas') renderDiscList();

  closeSidebar();
};

// Navegar para aba de importação e abrir painel específico
window.irParaImport = function(panel) {
  goTab('importar');
  setTimeout(() => {
    const btns = document.querySelectorAll('.imp-tab');
    const panels = ['nlm', 'form', 'xlsx'];
    const idx = panels.indexOf(panel);
    if (idx >= 0 && btns[idx]) btns[idx].click();
  }, 50);
};

// ==========================================
// BUSCADORES DE TAREFAS GLOBAIS
// ==========================================
// Ordena aulas pelo número extraído do código (ex: "Aula 03" → 3)
function sortedAulas(aulas) {
  return [...aulas].sort((a, b) => {
    const nA = parseInt(a.codigo.replace(/\D/g, '')) || 0;
    const nB = parseInt(b.codigo.replace(/\D/g, '')) || 0;
    return nA - nB;
  });
}

function allTarefas() {
  return S.disciplinas.flatMap(d =>
    sortedAulas(d.aulas).flatMap(a => a.tarefas.map(t => ({
      ...t, discId: d.id, discNome: d.nome, discCor: d.cor,
      aulaId: a.id, aulaCod: a.codigo, aulaTit: a.titulo
    })))
  );
}
function pendingTarefas()          { return allTarefas().filter(t => t.status === 'pendente'); }
function getPendingForDisc(discId) { return pendingTarefas().filter(t => t.discId === discId); }

// Retorna tarefas pendentes SOMENTE da primeira aula incompleta da disciplina
function getSequentialQueue(discId) {
  const d = S.disciplinas.find(x => x.id === discId);
  if (!d) return [];
  // Primeira aula (em ordem) que ainda tem tarefas pendentes
  const firstPending = sortedAulas(d.aulas)
    .find(a => a.tarefas.some(t => t.status === 'pendente'));
  if (!firstPending) return [];
  return firstPending.tarefas
    .filter(t => t.status === 'pendente')
    .map(t => ({
      ...t, discId: d.id, discNome: d.nome, discCor: d.cor,
      aulaId: firstPending.id, aulaCod: firstPending.codigo, aulaTit: firstPending.titulo
    }));
}

// Round-robin entre disciplinas respeitando o orçamento de minutos do dia
function buildTodayTasks(totalMins) {
  const queues = S.disciplinas
    .map(d => {
      const tasks = getSequentialQueue(d.id);
      return tasks.length > 0 ? { tasks } : null;
    })
    .filter(Boolean);

  if (queues.length === 0) return [];

  const selected = [];
  let budget     = totalMins;
  const MAX      = 100; // safety limit
  let rounds     = 0;

  while (budget > 0 && rounds < MAX) {
    rounds++;
    let addedAny = false;
    for (const q of queues) {
      if (!q.tasks.length || budget <= 0) continue;
      const task = q.tasks[0];
      // Permite leve estouro (+15min) como o calcMeta original
      if (task.duracaoMin <= budget + 15) {
        q.tasks.shift();
        selected.push(task);
        budget -= task.duracaoMin;
        addedAny = true;
      }
    }
    if (!addedAny) break;
  }
  return selected;
}

// ==========================================
// TRILHA ADAPTATIVA (AGENDA DA SEMANA)
// ==========================================
function getLatestStatsForDisc(discName) {
  if (!S.questoes_history || S.questoes_history.length === 0) return null;
  const latestImport = S.questoes_history[S.questoes_history.length - 1];
  return latestImport.disciplinas.find(d => d.nome.toLowerCase() === discName.toLowerCase());
}

function calcMeta(totalMins) {
  let discData = S.disciplinas.map(d => {
    const stats = getLatestStatsForDisc(d.nome);
    let currentWeight = d.peso;
    const metaUsuario = d.metaAcerto || 80;
    if (stats) {
      if (stats.pctAcerto >= metaUsuario + 5)  currentWeight *= 0.85;
      else if (stats.pctAcerto < metaUsuario - 5) currentWeight *= 1.25;
    }
    return { disc: d, rawWeight: d.peso, adjWeight: currentWeight, tasks: getPendingForDisc(d.id) };
  });

  const totalAdjWeight = discData.reduce((s, d) => s + d.adjWeight, 0);
  discData.forEach(d => {
    d.alloc = totalAdjWeight > 0 ? Math.round(totalMins * (d.adjWeight / totalAdjWeight)) : 0;
  });
  discData.forEach(d => {
    let bud = d.alloc;
    d.selected = [];
    for (let t of d.tasks) {
      if (bud <= 0) break;
      if (t.duracaoMin <= bud + 15) { d.selected.push(t); bud -= t.duracaoMin; }
    }
  });
  return discData;
}

window.renderAgendaGrid = function() {
  const hs = S.config.horasSemana;
  const diasStr = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  const totalHoras = hs.reduce((a, b) => a + b, 0);

  // MUDANÇA 1: grade horizontal (.day-grid com 7 colunas no CSS)
  let gridHtml = `<div class="day-grid">`;
  diasStr.forEach((d, i) => {
    gridHtml += `
      <div class="day-cell">
        <div class="day-nm">${d}</div>
        <input type="number" class="day-hi" value="${hs[i]}" min="0" max="14"
               onchange="updateHoraDia(${i}, this.value)">
      </div>`;
  });
  gridHtml += `</div>
  <div class="meta-label" style="text-align:right;margin-top:8px;">
    Total Planejado: <strong id="totalSemanaGrid">${totalHoras}h</strong>
  </div>`;
  document.getElementById('semanaGridContainer').innerHTML = gridHtml;
};

window.updateHoraDia = function(idx, val) {
  S.config.horasSemana[idx] = Math.min(16, Math.max(0, parseInt(val) || 0));
  saveState();
  const totalHoras = S.config.horasSemana.reduce((a, b) => a + b, 0);
  document.getElementById('totalSemanaGrid').textContent = totalHoras + 'h';
};

window.renderMeta = function() {
  const totalMins = S.config.horasSemana.reduce((a, b) => a + b, 0) * 60;
  if (totalMins === 0) {
    document.getElementById('metaContent').innerHTML =
      `<div class="empty-state"><div class="empty-state-sub">Preencha as horas na agenda acima para gerar a meta.</div></div>`;
    return;
  }

  const data = calcMeta(totalMins);
  let html = `<div class="card" style="margin-top:20px"><div class="ct">Alocação Baseada em Desempenho</div>`;

  data.forEach(d => {
    if (d.selected.length === 0) return;
    const stats   = getLatestStatsForDisc(d.disc.nome);
    const currAcc = stats ? stats.pctAcerto : '--';
    const isBuffed = d.adjWeight > d.rawWeight;
    const isNerfed = d.adjWeight < d.rawWeight;
    const indic = isBuffed ? '<span style="color:var(--re);font-size:10px">↑ CARGA EXTRA</span>'
                : isNerfed ? '<span style="color:var(--gr);font-size:10px">↓ MANUTENÇÃO</span>'
                : '';
    const temReforco = d.selected.some(t => isReforco(d.disc.id, t.type));
    const reforcoTag = temReforco ? '<span class="tag-reforco" style="margin-left:6px">⚠️ REFORÇO</span>' : '';
    html += `
      <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--bd);padding:8px 0">
        <div>
          <div style="font-size:13px;color:var(--tx)">${d.disc.nome} ${indic} ${reforcoTag}</div>
          <div style="font-size:10px;color:var(--tx3)">Acerto Atual: ${currAcc}% · Meta: ${d.disc.metaAcerto}%</div>
        </div>
        <div style="text-align:right">
          <div style="color:var(--acc);font-family:monospace;font-size:14px;font-weight:600">${fmtMin(d.alloc)}</div>
          <div style="font-size:9px;color:var(--tx3)">${d.selected.length} tarefa(s)</div>
        </div>
      </div>`;
  });
  html += `</div>`;

  // ── Velocidade de Cruzeiro ──
  const totalPending  = pendingTarefas().length;
  const totalAlocado  = data.reduce((sum, d) => sum + d.selected.length, 0);
  const semanasEst    = totalAlocado > 0 ? Math.ceil(totalPending / totalAlocado) : '—';
  const pctConcluido  = totalPending + totalAlocado > 0
    ? Math.round((allTarefas().filter(t => t.status !== 'pendente').length / allTarefas().length) * 100) || 0
    : 0;

  html += `
    <div class="card" style="margin-top:12px">
      <div class="ct">🚀 Velocidade de Cruzeiro</div>
      <div class="sg" style="grid-template-columns:repeat(3,1fr);margin-bottom:0">
        <div class="sc">
          <span class="sv">${totalPending}</span>
          <span class="sl">Tarefas Pendentes</span>
        </div>
        <div class="sc">
          <span class="sv" style="color:var(--acc)">${totalAlocado}</span>
          <span class="sl">Alocadas esta semana</span>
        </div>
        <div class="sc">
          <span class="sv" style="color:${typeof semanasEst === 'number' && semanasEst <= 4 ? 'var(--gr)' : 'var(--yl)'}">${semanasEst}</span>
          <span class="sl">Semanas para fechar</span>
        </div>
      </div>
    </div>`;

  document.getElementById('metaContent').innerHTML = html;
};

// IMPRESSÃO DE AGENDA
window.imprimirAgenda = function() {
  const hs = S.config.horasSemana;
  const totalMins = hs.reduce((a, b) => a + b, 0) * 60;
  if (totalMins === 0) { showToast('Preencha as horas na grade antes de imprimir.', 'error'); return; }

  const daysFull = ['Domingo','Segunda-feira','Terça-feira','Quarta-feira','Quinta-feira','Sexta-feira','Sábado'];
  const data = calcMeta(totalMins);

  let allTasks = [];
  data.forEach(d => { if (d.selected) allTasks.push(...d.selected); });
  allTasks = allTasks.sort(() => Math.random() - 0.5);

  let printHtml = `
    <div class="print-header">
      <h1>Trilha Estratégica: Agenda da Semana</h1>
      <p>Gerado em ${new Date().toLocaleDateString('pt-BR')} · Total: ${totalMins/60}h programadas.</p>
    </div>`;

  let taskIdx = 0;
  hs.forEach((hours, i) => {
    if (hours === 0) {
      printHtml += `<div class="print-day">
        <div class="print-day-header"><h2>${daysFull[i]}</h2><span>DESCANSO</span></div>
      </div>`;
      return;
    }
    let dayBud = hours * 60;
    let dayTasks = [];
    while (taskIdx < allTasks.length && dayBud > 0) {
      let t = allTasks[taskIdx];
      if (t.duracaoMin <= dayBud + 15) {
        dayTasks.push(t); dayBud -= t.duracaoMin; taskIdx++;
      } else {
        if (dayTasks.length === 0) { dayTasks.push(t); dayBud -= t.duracaoMin; taskIdx++; }
        break;
      }
    }
    printHtml += `
      <div class="print-day">
        <div class="print-day-header"><h2>${daysFull[i]}</h2><span>Meta: ${hours}h</span></div>
        <ul class="print-task-list">`;
    if (dayTasks.length === 0) {
      printHtml += `<li style="font-size:12px;color:#666">Nenhuma tarefa alocada.</li>`;
    } else {
      dayTasks.forEach(t => {
        printHtml += `
          <li class="print-task-item">
            <div class="print-checkbox"></div>
            <div class="print-task-content">
              <span class="print-disc-badge" style="background:${t.discCor}">${t.discNome}</span>
              <div class="print-task-title">[${t.aulaCod || 'A00'}] ${t.topico}</div>
              <div class="print-task-meta">${t.type} · ⏱ ${t.duracaoMin} min</div>
            </div>
          </li>`;
      });
    }
    printHtml += `</ul></div>`;
  });

  document.getElementById('printArea').innerHTML = printHtml;
  window.print();
};

// ==========================================
// GESTÃO DE DISCIPLINAS — CRUD (MUDANÇA 3)
// ==========================================
function renderDiscList() {
  const container = document.getElementById('discList');
  if (!container) return;

  if (S.disciplinas.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📚</div>
        <div class="empty-state-title">Nenhuma disciplina cadastrada</div>
        <div class="empty-state-sub">Clique em <strong>+ Nova Disciplina</strong> para começar a montar seu plano de estudos.</div>
      </div>`;
    return;
  }

  container.innerHTML = S.disciplinas.map(d => `
    <div class="disc-card" id="disc-${d.id}">
      <div class="disc-card-header">
        <div style="display:flex;align-items:center;gap:10px">
          <div class="disc-dot" style="background:${d.cor}"></div>
          <span class="disc-card-name">${d.nome}</span>
        </div>
        <div class="disc-card-actions">
          <button class="btn-icon" title="Editar" onclick="toggleEditDisc('${d.id}')">✏️</button>
          <button class="btn-icon btn-icon-danger" title="Remover" onclick="removeDisc('${d.id}')">🗑️</button>
        </div>
      </div>
      <div id="disc-view-${d.id}" class="disc-meta-row">
        <span class="disc-badge">Peso: ${d.peso}</span>
        <span class="disc-badge">Meta: ${d.metaAcerto || 80}%</span>
        <span class="disc-badge">${d.aulas.length} aula(s)</span>
        ${d.aulas.length > 0 ? `<button class="btn-icon" style="margin-left:auto" onclick="toggleAulaList('${d.id}')">📂 ver aulas</button>` : ''}
      </div>
      <!-- Lista de aulas colapsável -->
      <div id="disc-aulas-${d.id}" class="disc-aulas-section">
        ${sortedAulas(d.aulas).map(a => `
          <div class="aula-row">
            <div class="aula-row-info">
              <div class="aula-row-title">${a.codigo} — ${a.titulo}</div>
              <div class="aula-row-meta">${a.tarefas.length} tarefa(s) · ${a.tarefas.filter(t=>t.status==='concluida').length} concluída(s)</div>
            </div>
            <div class="aula-row-actions">
              ${S.disciplinas.filter(x=>x.id!==d.id).length > 0 ? `
                <select class="move-disc-select" id="ms-${a.id}">
                  ${S.disciplinas.filter(x=>x.id!==d.id).map(x=>`<option value="${x.id}">${x.nome}</option>`).join('')}
                </select>
                <button class="btn-icon" title="Mover para disciplina selecionada" onclick="moverAula('${d.id}','${a.id}')">↗</button>
              ` : ''}
              <button class="btn-icon btn-icon-danger" title="Excluir aula" onclick="deleteAula('${d.id}','${a.id}')">🗑️</button>
            </div>
          </div>`).join('')}
      </div>
      <div id="disc-edit-${d.id}" class="disc-edit-form" style="display:none">
        <div class="disc-edit-grid">
          <div class="fg">
            <label>Peso</label>
            <input type="number" id="de-peso-${d.id}" value="${d.peso}" min="1" max="100">
          </div>
          <div class="fg">
            <label>Meta de Acerto (%)</label>
            <input type="number" id="de-meta-${d.id}" value="${d.metaAcerto || 80}" min="50" max="100">
          </div>
          <div class="fg">
            <label>Cor</label>
            <input type="color" id="de-cor-${d.id}" value="${d.cor}" class="input-color">
          </div>
        </div>
        <div style="display:flex;gap:6px;margin-top:10px;justify-content:flex-end">
          <button class="btn btn-g" style="padding:6px 12px;font-size:11px" onclick="toggleEditDisc('${d.id}')">Cancelar</button>
          <button class="btn btn-p" style="padding:6px 12px;font-size:11px" onclick="saveEditDisc('${d.id}')">✔ Salvar</button>
        </div>
      </div>
    </div>`
  ).join('');
}

window.openAddDisc = function() {
  const form = document.getElementById('addDiscForm');
  form.style.display = 'block';
  document.getElementById('nd-nome').focus();
  form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};

window.closeAddDisc = function() {
  document.getElementById('addDiscForm').style.display = 'none';
  document.getElementById('nd-nome').value  = '';
  document.getElementById('nd-peso').value  = '20';
  document.getElementById('nd-meta').value  = '80';
  document.getElementById('nd-cor').value   = '#3b82f6';
};

window.salvarNovaDisc = function() {
  const nome = document.getElementById('nd-nome').value.trim();
  if (!nome) { showToast('Preencha o nome da disciplina.', 'error'); return; }

  const novaDisc = {
    id: uid(),
    nome,
    peso:       parseInt(document.getElementById('nd-peso').value) || 20,
    metaAcerto: parseInt(document.getElementById('nd-meta').value) || 80,
    cor:        document.getElementById('nd-cor').value,
    aulas:      []
  };

  S.disciplinas.push(novaDisc);
  saveState();
  closeAddDisc();
  renderDiscList();
  populateDiscDropdowns();
  showToast(`"${nome}" adicionada com sucesso!`);
};

window.removeDisc = function(id) {
  const disc = S.disciplinas.find(d => d.id === id);
  if (!disc) return;
  if (!confirm(`Remover "${disc.nome}" e todas as suas aulas?\nEsta ação não pode ser desfeita.`)) return;
  S.disciplinas = S.disciplinas.filter(d => d.id !== id);
  saveState();
  renderDiscList();
  populateDiscDropdowns();
  showToast(`Disciplina removida.`, 'info');
};

window.toggleEditDisc = function(id) {
  const viewEl = document.getElementById(`disc-view-${id}`);
  const editEl = document.getElementById(`disc-edit-${id}`);
  if (!viewEl || !editEl) return;
  const isEditing = editEl.style.display !== 'none';
  viewEl.style.display = isEditing ? 'flex'  : 'none';
  editEl.style.display = isEditing ? 'none'  : 'block';
};

window.saveEditDisc = function(id) {
  const d = S.disciplinas.find(x => x.id === id);
  if (!d) return;
  d.peso       = parseInt(document.getElementById(`de-peso-${id}`).value) || d.peso;
  d.metaAcerto = parseInt(document.getElementById(`de-meta-${id}`).value) || d.metaAcerto;
  d.cor        = document.getElementById(`de-cor-${id}`).value;
  saveState();
  renderDiscList();
  showToast('Disciplina atualizada!');
};

// ==========================================
// ANALYTICS — ANÁLISE DE DESEMPENHO (MUDANÇA 2)
// ==========================================
// ── HELPER: verifica se uma tarefa pendente merece badge de REFORÇO CRÍTICO ──
function isReforco(discId, taskType) {
  if (!['QUESTOES','REVISAO'].includes(taskType)) return false;
  const disc  = S.disciplinas.find(d => d.id === discId);
  if (!disc) return false;
  const stats = getLatestStatsForDisc(disc.nome);
  if (!stats) return false;
  return stats.pctAcerto < (disc.metaAcerto || 80);
}

window.renderQuestoes = function() {
  const container = document.getElementById('questoesContent');
  if (!S.questoes_history || S.questoes_history.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📊</div>
        <div class="empty-state-title">Nenhum dado importado ainda</div>
        <div class="empty-state-sub">Importe suas estatísticas do TecConcursos para ver seu diagnóstico completo de desempenho.</div>
        <button class="btn btn-p" onclick="irParaImport('xlsx')">📂 Importar dados do TecConcursos</button>
      </div>`;
    return;
  }

  const now = new Date();
  let filteredHistory = S.questoes_history.filter(h => {
    if (qPeriod === 'all') return true;
    const diffDays = Math.abs(now - new Date(h.importadoEm)) / (1000 * 60 * 60 * 24);
    return diffDays <= parseInt(qPeriod);
  });
  filteredHistory.sort((a, b) => new Date(a.importadoEm) - new Date(b.importadoEm));

  if (filteredHistory.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-sub">Sem dados no período selecionado.</div></div>`;
    return;
  }

  const latestStats  = filteredHistory[filteredHistory.length - 1];

  // ── Disciplina selecionada no filtro ──
  const discFiltrada = qDiscSel !== 'all'
    ? S.disciplinas.find(d => d.id === qDiscSel)
    : null;
  const discNomeFiltro = discFiltrada?.nome || null;

  const getBelt = (acc) => {
    if (acc >= 85) return '<span class="belt-badge belt-black">Faixa Preta (Alta Concorrência)</span>';
    if (acc >= 75) return '<span class="belt-badge belt-blue">Faixa Azul (Competitivo)</span>';
    return '<span class="belt-badge belt-white">Faixa Branca (Formação)</span>';
  };

  // ── Cards de resumo ──
  let acertoDisplay, totalDisplay, diffDisplay, diffClass, diffSinal;
  if (discNomeFiltro) {
    // Visão de disciplina específica
    const latestDisc  = latestStats.disciplinas.find(d => d.nome.toLowerCase() === discNomeFiltro.toLowerCase());
    const discConfig  = S.disciplinas.find(d => d.nome.toLowerCase() === discNomeFiltro.toLowerCase());
    acertoDisplay     = latestDisc ? latestDisc.pctAcerto + '%' : '—';
    totalDisplay      = latestDisc ? latestDisc.qResolvidas : '—';
    const meta        = discConfig?.metaAcerto || 80;
    const diff        = latestDisc ? (latestDisc.pctAcerto - meta).toFixed(1) : 0;
    diffClass         = diff >= 0 ? 'vs-up' : 'vs-down';
    diffSinal         = diff >= 0 ? '▲' : '▼';
    diffDisplay       = `${diffSinal} ${Math.abs(diff)}% vs sua meta (${meta}%)`;
  } else {
    // Visão global
    const accDiff = (latestStats.pctGeral - MOCK_GLOBAL_STATS.avgAcertoGeral).toFixed(1);
    acertoDisplay = latestStats.pctGeral + '%';
    totalDisplay  = latestStats.total;
    diffClass     = accDiff >= 0 ? 'vs-up' : 'vs-down';
    diffSinal     = accDiff >= 0 ? '▲' : '▼';
    diffDisplay   = `${diffSinal} ${Math.abs(accDiff)}% vs Média Concorrência (${MOCK_GLOBAL_STATS.avgAcertoGeral}%)`;
  }

  let html = `
    <div class="bench-grid">
      <div class="bench-card">
        <div class="bench-title">${discNomeFiltro ? discNomeFiltro : 'Acerto Global'}</div>
        <div class="bench-val">${acertoDisplay}</div>
        <div class="bench-vs ${diffClass}">${diffDisplay}</div>
      </div>
      <div class="bench-card">
        <div class="bench-title">Nível Atual</div>
        <div style="margin-top:8px">${getBelt(parseFloat(acertoDisplay) || 0)}</div>
        <div class="bench-vs vs-flat" style="margin-top:12px;color:var(--tx3)">Amostra: ${totalDisplay} questões</div>
      </div>
    </div>
    <div class="chart-container" style="height:280px;margin-bottom:24px"><canvas id="qChartAdvanced"></canvas></div>`;

  // ── UTI de revisão crítica ──
  let revisoesCriticas = [];
  const discsFonte = discNomeFiltro
    ? latestStats.disciplinas.filter(d => d.nome.toLowerCase() === discNomeFiltro.toLowerCase())
    : latestStats.disciplinas;

  discsFonte.forEach(d => {
    const discConfig  = S.disciplinas.find(x => x.nome.toLowerCase() === d.nome.toLowerCase());
    const metaUsuario = discConfig?.metaAcerto || 80;
    if (d.topicos) {
      d.topicos.forEach(t => {
        if (t.qResolvidas >= 10 && t.pctAcerto < metaUsuario) {
          // Verifica se há tarefa QUESTOES/REVISAO pendente nessa disciplina
          const temTarefaReforco = discConfig
            ? getPendingForDisc(discConfig.id).some(p => ['QUESTOES','REVISAO'].includes(p.type))
            : false;
          revisoesCriticas.push({ disc: d.nome, topico: t.nome, acerto: t.pctAcerto, meta: metaUsuario, temTarefaReforco });
        }
      });
    }
  });

  if (revisoesCriticas.length > 0) {
    revisoesCriticas.sort((a, b) => a.acerto - b.acerto);
    html += `
      <div class="card">
        <div class="ct" style="color:var(--re)">⚠️ UTI / Revisão Crítica</div>
        <div style="font-size:11px;color:var(--tx3);margin-bottom:16px">Tópicos com mais de 10 questões abaixo da sua meta.</div>
        <div class="rev-list">
          ${revisoesCriticas.slice(0, 10).map(r => `
            <div class="rev-item">
              <div>
                <div class="rev-topic">
                  ${r.topico}
                  ${r.temTarefaReforco ? '<span class="tag-reforco" style="margin-left:6px">⚠️ REFORÇO</span>' : ''}
                </div>
                <div class="rev-disc">${r.disc}</div>
              </div>
              <div class="rev-metrics">
                <div class="rev-metric-box">
                  <span class="rev-metric-lbl">Acerto Atual</span>
                  <span class="rev-metric-val val-danger">${Math.round(r.acerto)}%</span>
                </div>
                <div class="rev-metric-box">
                  <span class="rev-metric-lbl">Sua Meta</span>
                  <span class="rev-metric-val" style="color:var(--tx2)">${r.meta}%</span>
                </div>
              </div>
            </div>`).join('')}
        </div>
      </div>`;
  }

  container.innerHTML = html;

  // ── Gráfico ──
  setTimeout(() => {
    const ctx = document.getElementById('qChartAdvanced')?.getContext('2d');
    if (!ctx) return;
    if (qChartInstance) qChartInstance.destroy();

    // Dados do gráfico dependem do filtro de disciplina
    let chartAcerto, chartVolume;
    if (discNomeFiltro) {
      chartAcerto = filteredHistory.map(h => {
        const d = h.disciplinas?.find(d => d.nome.toLowerCase() === discNomeFiltro.toLowerCase());
        return d ? d.pctAcerto : null;
      });
      chartVolume = filteredHistory.map(h => {
        const d = h.disciplinas?.find(d => d.nome.toLowerCase() === discNomeFiltro.toLowerCase());
        return d ? d.qResolvidas : null;
      });
    } else {
      chartAcerto = filteredHistory.map(h => h.pctGeral);
      chartVolume = filteredHistory.map(h => h.total);
    }

    const discCor = discFiltrada?.cor || '#f5a623';

    qChartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels: filteredHistory.map(h => h.label || new Date(h.importadoEm).toLocaleDateString('pt-BR')),
        datasets: [
          {
            label: discNomeFiltro ? `% Acerto — ${discNomeFiltro}` : '% Acerto Global',
            data: chartAcerto,
            borderColor: discCor, backgroundColor: discCor + '1a', borderWidth: 3,
            fill: true, tension: 0.3, yAxisID: 'y', spanGaps: true
          },
          {
            label: 'Volume Resolvido', type: 'bar',
            data: chartVolume,
            backgroundColor: 'rgba(59,130,246,0.15)', borderWidth: 1, borderRadius: 4, yAxisID: 'y1'
          }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: {
          y:  { type: 'linear', position: 'left',  min: 0, max: 100, grid: { color: '#27272a' } },
          y1: { type: 'linear', position: 'right', beginAtZero: true, grid: { drawOnChartArea: false } }
        }
      }
    });
  }, 100);
};

// ==========================================
// MÓDULOS DE IMPORTAÇÃO (MUDANÇA 4)
// ==========================================
window.switchImp = function(mode, btn) {
  document.querySelectorAll('.imp-tab').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.imp-panel').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('imp-' + mode).classList.add('active');
  if (mode === 'form') initForm();
  populateDiscDropdowns();
};

window.populateDiscDropdowns = function() {
  const opts = S.disciplinas.map(d => `<option value="${d.id}">${d.nome}</option>`).join('');
  ['nlm-disc','f-disc'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = opts;
  });
  // Filtro de disciplina na Análise de Desempenho
  const filterEl = document.getElementById('qDiscFilter');
  if (filterEl) {
    const cur = filterEl.value;
    filterEl.innerHTML = '<option value="all">Todas as Disciplinas</option>' +
      S.disciplinas.map(d => `<option value="${d.id}">${d.nome}</option>`).join('');
    if (cur) filterEl.value = cur;
  }
};

// ── NLM PARSER (formato baseado no Prompt Mestre com emojis como separadores de seção) ──
let _parsedTasks = [];

window.parsearNLM = function() {
  const txt = document.getElementById('nlm-txt').value;
  const cod = document.getElementById('nlm-cod').value.trim();
  const tit = document.getElementById('nlm-tit').value.trim();
  if (!txt.trim() || !cod || !tit) {
    showToast('Preencha Código, Título e cole o texto do NLM.', 'error'); return;
  }

  _parsedTasks = [];

  // Remove o RESUMO EXECUTIVO ao final (não é uma tarefa)
  const raw = txt.replace(/\nRESUMO EXECUTIVO[\s\S]*/i, '');

  // Divide pelo marcador de tarefa
  const blocks = raw.split(/(?=TAREFA\s+\d+\s*[—\-])/i)
                    .map(b => b.trim())
                    .filter(b => /^TAREFA\s+\d+/i.test(b));

  if (!blocks.length) {
    showToast('Nenhuma tarefa encontrada. Verifique o formato do texto.', 'error'); return;
  }

  blocks.forEach((block, i) => {
    // ── Tipo ──
    const hm        = block.match(/^TAREFA\s+\d+\s*[—\-]+\s*([A-Z_]+)/im);
    const type      = hm ? hm[1].toUpperCase().trim() : 'TEORIA';
    const finalType = ['TEORIA','LEI_SECA','TEORIA_LEI','QUESTOES','REVISAO'].includes(type) ? type : 'TEORIA';

    // ── Páginas da Teoria ──
    const pagM    = block.match(/P[áa]ginas\s+da\s+Teoria\s*:\s*([\d]+\s*[–\-]\s*[\d]+)/i);
    const paginas = pagM ? pagM[1].replace(/\s/g,'') : '—';

    // ── Duração (primeiro número da faixa) ──
    const durM   = block.match(/Dura[çc][ãa]o\s+estimada\s*:\s*(\d+)/i);
    const durMin = durM ? parseInt(durM[1]) : 60;

    // ── Status Edital ──
    const edM        = block.match(/Edital\s*:\s*(.+)/i);
    const statusEdital = edM ? edM[1].trim() : '';

    // ── Tópico principal ──
    const topM   = block.match(/T[óo]pico\s+principal\s*:\s*(.+)/i);
    const topico = topM ? topM[1].trim() : `Tarefa ${i+1}`;

    // ── Subtópicos ──
    const subM      = block.match(/Subt[óo]picos\s+abordados\s*:\s*(.+)/i);
    const subtopicos = subM ? subM[1].trim() : '';

    // ── Seções delimitadas por emoji ──
    // 📖 Comando de Estudo
    const cmdM   = block.match(/📖[^\n]*\n+([\s\S]+?)(?=⚖️|📝|💡|🔑|$)/);
    const comando = cmdM ? cmdM[1].trim() : '';

    // ⚖️ Lei Seca (remove a linha de cabeçalho da tabela)
    const lsM    = block.match(/⚖️[^\n]*\n+([\s\S]+?)(?=📝|💡|🔑|$)/);
    const leiSeca = lsM
      ? lsM[1].replace(/Dispositivo\s*\|[^\n]+\n?/i, '').trim()
      : '';

    // 📝 Questões de Fixação
    const qfM     = block.match(/📝[^\n]*\n+([\s\S]+?)(?=💡|🔑|$)/);
    const questoes = qfM ? qfM[1].trim() : '';

    // 💡 Bizus
    const bzM  = block.match(/💡[^\n]*\n+([\s\S]+?)(?=🔑|$)/);
    const bizus = bzM ? bzM[1].trim() : '';

    // 🔑 Palavras-chave (remove bullet "• " inicial)
    const kwM      = block.match(/🔑[^\n]*\n+([\s\S]+?)(?=\n\n|$)/);
    const keywords = kwM ? kwM[1].replace(/^[•\-]\s*/gm, '').trim() : '';

    _parsedTasks.push({
      id: uid(), label: `Tarefa ${i+1}`, type: finalType,
      paginas, topico, subtopicos, duracaoMin: durMin, status: 'pendente',
      statusEdital, comando, leiSeca, questoes, bizus, keywords
    });
  });

  if (!_parsedTasks.length) {
    showToast('Nenhuma tarefa detectada. Verifique o formato.', 'error'); return;
  }

  document.getElementById('nlm-preview').innerHTML = buildNLMPreviewHTML(_parsedTasks);
};

function buildNLMPreviewHTML(tasks) {
  let html = `<div class="parse-preview">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px">
      <span style="color:var(--gr);font-weight:600;font-size:13px">✔ ${tasks.length} tarefa(s) encontrada(s)</span>
    </div>`;

  tasks.forEach((t, i) => {
    const typeInfo   = TYPES[t.type] || TYPES.TEORIA;
    const hasDetails = t.comando || t.leiSeca || t.questoes || t.bizus || t.keywords;

    html += `
    <div class="nlm-task-card">
      <div class="nlm-task-header" onclick="toggleNLMCard(${i})">
        <div class="nlm-task-header-left">
          <span class="tag" style="color:${typeInfo.cor};border-color:${typeInfo.cor}30;background:${typeInfo.cor}18;white-space:nowrap">${typeInfo.label}</span>
          <span class="nlm-task-title-text">${t.topico}</span>
        </div>
        <div class="nlm-task-header-right">
          ${t.statusEdital ? `<span class="nlm-task-detail-meta" style="color:var(--gr);font-size:10px">✅ Edital</span>` : ''}
          <span class="nlm-task-detail-meta">📄 ${t.paginas}</span>
          <span class="nlm-task-detail-meta">⏱ ${t.duracaoMin}m</span>
          ${hasDetails ? '<span class="nlm-expand-btn">▾ ver</span>' : ''}
        </div>
      </div>
      ${t.subtopicos ? `<div style="padding:0 12px 8px;font-size:11px;color:var(--tx3)">${t.subtopicos}</div>` : ''}
      ${hasDetails ? `
      <div class="nlm-task-details" id="nlm-card-${i}">
        ${t.comando  ? `<div class="nlm-detail-row"><span class="nlm-detail-label">📖 Comando de Estudo</span><p>${t.comando}</p></div>` : ''}
        ${t.leiSeca  ? `<div class="nlm-detail-row"><span class="nlm-detail-label">⚖️ Lei Seca</span><pre>${t.leiSeca}</pre></div>` : ''}
        ${t.questoes ? `<div class="nlm-detail-row"><span class="nlm-detail-label">📝 Questões de Fixação</span><p style="white-space:pre-line">${t.questoes}</p></div>` : ''}
        ${t.bizus    ? `<div class="nlm-detail-row"><span class="nlm-detail-label">💡 Bizus</span><p style="white-space:pre-line">${t.bizus}</p></div>` : ''}
        ${t.keywords ? `<div class="nlm-detail-row"><span class="nlm-detail-label">🔑 Palavras-chave</span><p style="color:var(--acc)">${t.keywords}</p></div>` : ''}
      </div>` : ''}
    </div>`;
  });

  html += `
    <div style="display:flex;gap:10px;margin-top:16px;justify-content:flex-end">
      <button class="btn btn-g" onclick="cancelarNLM()">Cancelar</button>
      <button class="btn btn-p" onclick="confirmarNLM()">✔ Confirmar Importação</button>
    </div>
  </div>`;
  return html;
}

window.toggleNLMCard = function(idx) {
  const el = document.getElementById(`nlm-card-${idx}`);
  if (el) el.classList.toggle('open');
};

window.limparNLM = function() {
  document.getElementById('nlm-txt').value = '';
  document.getElementById('nlm-preview').innerHTML = '';
  _parsedTasks = [];
};

window.cancelarNLM = function() {
  _parsedTasks = [];
  document.getElementById('nlm-preview').innerHTML = '';
};

window.confirmarNLM = function() {
  const discId = document.getElementById('nlm-disc').value;
  const cod    = document.getElementById('nlm-cod').value.trim();
  const tit    = document.getElementById('nlm-tit').value.trim();
  const d      = S.disciplinas.find(x => x.id === discId);
  if (!d) return;

  const qtd = _parsedTasks.length;
  d.aulas.push({ id: uid(), codigo: cod, titulo: tit, tarefas: _parsedTasks });
  saveState();
  document.getElementById('nlm-cod').value   = '';
  document.getElementById('nlm-tit').value   = '';
  document.getElementById('nlm-txt').value   = '';
  document.getElementById('nlm-preview').innerHTML = '';
  _parsedTasks = [];
  showToast(`${qtd} tarefa(s) importadas em "${d.nome}"!`);
  goTab('disciplinas');
  renderAll();
};

// ── FORMULÁRIO MANUAL ──
let tfForms = [];

window.initForm = function() { tfForms = [{ id: uid() }]; renderForms(); };
window.addTF    = function() { tfForms.push({ id: uid() }); renderForms(); };
window.removeTF = function(id) {
  tfForms = tfForms.filter(t => t.id !== id);
  renderForms();
};

window.renderForms = function() {
  const typeOpts   = Object.keys(TYPES).map(k => `<option value="${k}">${TYPES[k].label}</option>`).join('');
  const edicaoOpts = STATUS_EDITAL.map(s => `<option value="${s.value}">${s.label}</option>`).join('');

  document.getElementById('tfList').innerHTML = tfForms.map((t, i) => `
    <div class="tblock" id="tf-${t.id}">
      <div class="tbh">
        <span style="color:var(--acc);font-weight:600;font-size:12px">Tarefa ${i+1}</span>
        ${tfForms.length > 1
          ? `<button class="btn btn-g" style="padding:4px 10px;font-size:11px" onclick="removeTF('${t.id}')">✕ Remover</button>`
          : ''}
      </div>
      <div class="tf-fields-grid">
        <div class="fg">
          <label>Tipo de Atividade</label>
          <select id="ty-${t.id}">${typeOpts}</select>
        </div>
        <div class="fg">
          <label>Status no Edital</label>
          <select id="ed-${t.id}">${edicaoOpts}</select>
        </div>
        <div class="fg">
          <label>Páginas</label>
          <input id="pg-${t.id}" placeholder="Ex: 40–55">
        </div>
        <div class="fg">
          <label>Duração (min)</label>
          <input id="du-${t.id}" type="number" value="60" min="10">
        </div>
        <div class="fg full">
          <label>Tópico Principal</label>
          <input id="tp-${t.id}" placeholder="Ex: Processo Legislativo">
        </div>
        <div class="fg full">
          <label>Comando de Estudo</label>
          <textarea id="cm-${t.id}" rows="2" placeholder="Ex: Leia e esquematize os artigos referentes a..."></textarea>
        </div>
        <div class="fg full">
          <label>Lei Seca — Dispositivo | Artigos | Motivo (uma por linha)</label>
          <textarea id="ls-${t.id}" rows="3" placeholder="CF/88 | Art. 51, I | Atribuições privativas da Câmara..."></textarea>
        </div>
        <div class="fg full">
          <label>Questões de Fixação</label>
          <textarea id="qf-${t.id}" rows="2" placeholder="Descreva as questões ou cole enunciados de prova..."></textarea>
        </div>
        <div class="fg full">
          <label>Bizus</label>
          <textarea id="bz-${t.id}" rows="2" placeholder="Dicas, macetes e comparativos importantes..."></textarea>
        </div>
        <div class="fg full">
          <label>Palavras-chave</label>
          <input id="kw-${t.id}" placeholder="Ex: processo, sessão ordinária, plenário">
        </div>
      </div>
    </div>`
  ).join('');
};

window.salvarManual = function() {
  const discId = document.getElementById('f-disc').value;
  const cod    = document.getElementById('f-cod').value.trim();
  const tit    = document.getElementById('f-tit').value.trim();
  if (!cod || !tit) { showToast('Preencha Código e Título.', 'error'); return; }

  const d = S.disciplinas.find(x => x.id === discId);
  if (!d) { showToast('Selecione uma disciplina válida.', 'error'); return; }

  const tarefas = tfForms.map((t, i) => ({
    id:          uid(),
    label:       `Tarefa ${i+1}`,
    type:        document.getElementById('ty-' + t.id).value,
    statusEdital:document.getElementById('ed-' + t.id).value,
    paginas:     document.getElementById('pg-' + t.id).value,
    topico:      document.getElementById('tp-' + t.id).value || `Tarefa ${i+1}`,
    duracaoMin:  parseInt(document.getElementById('du-' + t.id).value) || 60,
    comando:     document.getElementById('cm-' + t.id).value,
    leiSeca:     document.getElementById('ls-' + t.id).value,
    questoes:    document.getElementById('qf-' + t.id).value,
    bizus:       document.getElementById('bz-' + t.id).value,
    keywords:    document.getElementById('kw-' + t.id).value,
    status:      'pendente'
  }));

  d.aulas.push({ id: uid(), codigo: cod, titulo: tit, tarefas });
  saveState();
  showToast(`Aula salva em "${d.nome}"!`);
  goTab('disciplinas');
  renderAll();
};

// ── TECCONCURSOS (XLSX) ──
let _xlsxParsed = null;

window.lerXlsx = function(input) {
  const file = input.files[0];
  if (!file) return;

  // Atualiza texto do botão de upload
  const lbl = document.getElementById('xls-label').value.trim();
  document.getElementById('file-upload-text').textContent = `📄 ${file.name}`;

  const reader = new FileReader();
  reader.onload = e => {
    try {
      const wb      = XLSX.read(e.target.result, { type: 'array' });
      const sheet   = wb.Sheets[wb.SheetNames[0]];
      const data    = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true });
      const headers = data[0].map(h => String(h || '').trim().toLowerCase());
      const c       = (name) => headers.findIndex(h => h.includes(name));

      const idxH = c('hierarquia');
      const idxN = c('índice') > -1 ? c('índice') : c('indice');
      const idxQ = c('resolvidas');
      const idxA = c('quantidade de acertos');
      const idxP = c('acertos (%)');

      let disciplinas = [], current = null, totalQ = 0, totalA = 0;
      for (let i = 1; i < data.length; i++) {
        const row = data[i];
        if (!row[idxN]) continue;
        const nome = String(row[idxN]).trim();
        const hier = String(row[idxH] || '').trim();
        const qR   = Number(row[idxQ]) || 0;
        const qA   = Number(row[idxA]) || 0;
        const pct  = Number(row[idxP]) || 0;

        if (hier === '') {
          current = { nome, qResolvidas: qR, acertos: qA, pctAcerto: pct, topicos: [] };
          disciplinas.push(current);
        } else if (current) {
          current.topicos.push({ nome, qResolvidas: qR, acertos: qA, pctAcerto: pct });
          totalQ += qR; totalA += qA;
        }
      }

      const pctGlobal = totalQ ? Math.round((totalA / totalQ) * 1000) / 10 : 0;
      const label     = lbl || new Date().toLocaleDateString('pt-BR');

      _xlsxParsed = {
        id:          uid(),
        importadoEm: new Date().toISOString(),
        label, total: totalQ, pctGeral: pctGlobal, disciplinas
      };

      renderXlsxPreview(_xlsxParsed);

    } catch(err) {
      showToast('Erro ao processar planilha. Exporte "Por Tópicos" no TecConcursos.', 'error');
    }
  };
  reader.readAsArrayBuffer(file);
};

function renderXlsxPreview(data) {
  const weakSpots = data.disciplinas.reduce((acc, d) => {
    const config      = S.disciplinas.find(x => x.nome.toLowerCase() === d.nome.toLowerCase());
    const metaUsuario = config?.metaAcerto || 80;
    return acc + (d.topicos || []).filter(t => t.pctAcerto < metaUsuario && t.qResolvidas >= 5).length;
  }, 0);

  const acertoCor = data.pctGeral >= 70 ? 'var(--gr)' : 'var(--re)';

  document.getElementById('xls-preview').innerHTML = `
    <div style="color:var(--tx3);font-size:11px;margin-bottom:8px;font-weight:600;letter-spacing:.06em;text-transform:uppercase">
      Preview — ${data.label}
    </div>
    <div class="tec-preview-grid">
      <div class="tec-preview-card">
        <div class="tec-preview-val">${data.total}</div>
        <div class="tec-preview-lbl">Total de Questões</div>
      </div>
      <div class="tec-preview-card">
        <div class="tec-preview-val" style="color:${acertoCor}">${data.pctGeral}%</div>
        <div class="tec-preview-lbl">% de Acerto</div>
      </div>
      <div class="tec-preview-card">
        <div class="tec-preview-val">${data.disciplinas.length}</div>
        <div class="tec-preview-lbl">Total de Matérias</div>
      </div>
      <div class="tec-preview-card">
        <div class="tec-preview-val" style="color:var(--re)">${weakSpots}</div>
        <div class="tec-preview-lbl">Pontos Fracos</div>
      </div>
    </div>
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">
      <button class="btn btn-g" onclick="cancelarXlsx()">Cancelar</button>
      <button class="btn btn-p" onclick="confirmarXlsx()">✔ Confirmar e Salvar</button>
    </div>`;
}

window.confirmarXlsx = function() {
  if (!_xlsxParsed) return;
  S.questoes_history.push(_xlsxParsed);
  saveState();
  const label = _xlsxParsed.label;
  _xlsxParsed = null;
  document.getElementById('xls-preview').innerHTML  = '';
  document.getElementById('xls-file').value          = '';
  document.getElementById('xls-label').value         = '';
  document.getElementById('file-upload-text').textContent = '📂 Clique para selecionar o arquivo';
  showToast(`"${label}" importado com sucesso!`);
  goTab('questoes');
};

window.cancelarXlsx = function() {
  _xlsxParsed = null;
  document.getElementById('xls-preview').innerHTML  = '';
  document.getElementById('xls-file').value          = '';
  document.getElementById('file-upload-text').textContent = '📂 Clique para selecionar o arquivo';
};

// ==========================================
// HELPERS DE RENDERIZAÇÃO DE TAREFAS
// ==========================================
function parseLeiSeca(text) {
  if (!text) return '';
  const rows = text.split('\n').filter(r => r.trim() && r.includes('|'));
  if (!rows.length) return `<p style="font-size:12px;color:var(--tx2);line-height:1.5;white-space:pre-line">${text}</p>`;
  return `<table class="lei-seca-table">
    <thead><tr><th>Dispositivo</th><th>Artigos</th><th>Por que cai</th></tr></thead>
    <tbody>${rows.map(r => {
      const p = r.split('|').map(s => s.trim());
      return `<tr>
        <td class="ls-dispositivo">${p[0]||''}</td>
        <td class="ls-artigos">${p[1]||''}</td>
        <td class="ls-motivo">${p[2]||''}</td>
      </tr>`;
    }).join('')}</tbody>
  </table>`;
}

function parseBizus(text) {
  if (!text) return '';
  return text.split('\n')
    .filter(l => l.trim())
    .map(b => `<div class="bizu-card">${b.replace(/^[•\-]\s*/,'').trim()}</div>`)
    .join('');
}

function parseKeywords(text) {
  if (!text) return '';
  return text.replace(/^[•\-]\s*/,'').split(',')
    .map(k => k.trim()).filter(Boolean)
    .map(k => `<span class="kw-pill">${k}</span>`).join('');
}

function renderTaskCard(t, idx) {
  const typeInfo  = TYPES[t.type] || TYPES.TEORIA;
  const done      = t.status === 'concluida';
  const reforco   = isReforco(t.discId, t.type);
  const disc      = S.disciplinas.find(d => d.id === t.discId);
  const hasDetail = t.comando || t.leiSeca || t.questoes || t.bizus || t.keywords;

  const fDur = m => { const h = Math.floor(m/60), r = m%60; return h > 0 ? `${h}h${r>0?' '+r+'min':''}` : `${m}min`; };
  const dMin = t.duracaoMin || 60;
  const dMax = Math.round(dMin * 1.25);

  const editBadge = (t.statusEdital && !t.statusEdital.toLowerCase().includes('não'))
    ? '<span class="edital-badge">✅ Edital</span>' : '';

  return `
  <div class="task-card${done ? ' task-done' : ''}">
    <div class="task-card-main">
      <div class="task-chk${done ? ' checked' : ''}" onclick="toggleTarefa('${t.discId}','${t.aulaId}','${t.id}')">
        ${done ? '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M1.5 5L4 7.5L8.5 2.5" stroke="#09090b" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>' : ''}
      </div>
      <div class="task-body">
        <div class="task-tags">
          <span class="aula-badge">${t.aulaCod||'A?'}</span>
          <span class="task-num">Tarefa ${idx+1}</span>
          <span class="tag" style="color:${typeInfo.cor};border-color:${typeInfo.cor}30;background:${typeInfo.cor}18">${typeInfo.label}</span>
          ${editBadge}
          ${reforco ? '<span class="tag-reforco">⚠️ REFORÇO</span>' : ''}
        </div>
        <div class="task-title${done ? ' done' : ''}">${t.topico}</div>
        <div class="task-meta-row">
          ${t.paginas && t.paginas !== '—' ? `<span>📄 Pág.&nbsp;${t.paginas}</span>` : ''}
          <span>🕐 ${fDur(dMin)}–${fDur(dMax)}</span>
          <span style="color:${disc?.cor||'var(--acc)'}">● ${t.discNome}</span>
        </div>
      </div>
      ${hasDetail ? `<button class="detail-btn" onclick="toggleTaskDetail('${t.id}')">▸ detalhes</button>` : ''}
    </div>
    ${hasDetail ? `
    <div class="task-detail" id="td-${t.id}">
      ${t.comando  ? `<div class="task-section"><div class="task-section-lbl">📖 Comando de Estudo</div><div class="cmd-box">${t.comando}</div></div>` : ''}
      ${t.leiSeca  ? `<div class="task-section"><div class="task-section-lbl">⚖️ Lei Seca</div>${parseLeiSeca(t.leiSeca)}</div>` : ''}
      ${t.bizus    ? `<div class="task-section"><div class="task-section-lbl">💡 Bizus</div>${parseBizus(t.bizus)}</div>` : ''}
      ${t.questoes ? `<div class="task-section"><div class="task-section-lbl">📝 Questões de Fixação</div><p style="font-size:12px;color:var(--tx2);white-space:pre-line;line-height:1.5">${t.questoes}</p></div>` : ''}
      ${t.keywords ? `<div class="task-section"><div class="task-section-lbl">🔑 Palavras-chave</div><div class="kw-pills">${parseKeywords(t.keywords)}</div></div>` : ''}
    </div>` : ''}
  </div>`;
}

window.toggleTaskDetail = function(id) {
  const el  = document.getElementById('td-' + id);
  if (!el) return;
  el.classList.toggle('open');
  const btn = el.closest('.task-card')?.querySelector('.detail-btn');
  if (btn) btn.textContent = el.classList.contains('open') ? '▾ fechar' : '▸ detalhes';
};

// ==========================================
// TAB HOJE — FOCO DO DIA
// ==========================================
function renderHoje() {
  const today      = new Date().getDay(); // 0=Dom … 6=Sáb
  const horasHoje  = S.config.horasSemana[today] || 0;
  const totalMins  = horasHoje * 60;
  const allPending = pendingTarefas();
  const horasSem   = S.config.horasSemana.reduce((a, b) => a + b, 0);

  // ── Stats ──
  document.getElementById('statsGrid').innerHTML = `
    <div class="sc">
      <span class="sv">${allPending.length}</span>
      <span class="sl">Tarefas Pendentes</span>
    </div>
    <div class="sc">
      <span class="sv" style="color:var(--acc)">${horasHoje}h</span>
      <span class="sl">Horas Hoje</span>
    </div>
    <div class="sc">
      <span class="sv">${horasSem}h</span>
      <span class="sl">Horas na Semana</span>
    </div>
    <div class="sc">
      <span class="sv">${S.disciplinas.length}</span>
      <span class="sl">Disciplinas</span>
    </div>`;

  const hojeBar  = document.getElementById('hojeBar');
  const hojeList = document.getElementById('hojeList');

  // ── Descanso ──
  if (horasHoje === 0) {
    hojeBar.innerHTML  = '';
    hojeList.innerHTML = `<div style="text-align:center;padding:28px;color:var(--tx3);font-size:13px">
      🛌 Dia de descanso — recupere as energias!</div>`;
    return;
  }

  // ── Sem tarefas cadastradas ──
  if (allPending.length === 0) {
    hojeBar.innerHTML  = '';
    hojeList.innerHTML = `<div style="text-align:center;padding:28px;color:var(--gr);font-size:13px">
      ✅ Nenhuma tarefa pendente. Cadastre aulas em Disciplinas & PDFs.</div>`;
    return;
  }

  // ── Tarefas do dia: sequencial por disciplina + round-robin entre elas ──
  const todayTasks = buildTodayTasks(totalMins);

  // Progresso
  const concluidas = allTarefas().filter(t => t.status === 'concluida').length;
  const total      = allTarefas().length;
  const pct        = total > 0 ? Math.round((concluidas / total) * 100) : 0;
  const doneHoje   = todayTasks.filter(t => t.status === 'concluida').length;

  const allocMins  = todayTasks.reduce((s, t) => s + (t.duracaoMin||0), 0);
  const livresMins = Math.max(0, totalMins - allocMins);
  const barPct     = totalMins > 0 ? Math.min(100, Math.round((allocMins / totalMins) * 100)) : 0;

  hojeBar.innerHTML = `
    <div class="hoje-bar-wrap">
      <div class="hoje-bar-labels">
        <span style="font-size:11px;color:var(--tx3)">${fmtMin(allocMins)} alocados · ${doneHoje}/${todayTasks.length} concluídas</span>
        <span style="font-size:11px;color:var(--tx3)">${fmtMin(livresMins)} livres</span>
      </div>
      <div class="hoje-bar-track">
        <div class="hoje-bar-fill" style="width:${barPct}%"></div>
      </div>
    </div>`;

  if (todayTasks.length === 0) {
    hojeList.innerHTML = `<div style="color:var(--tx3);font-size:13px;padding:12px 0">
      Sem tarefas alocadas para hoje. Configure a agenda na Trilha Adaptativa.</div>`;
    return;
  }

  hojeList.innerHTML = todayTasks.map((t, i) => renderTaskCard(t, i)).join('');
}

window.toggleTarefa = function(discId, aulaId, tarefaId) {
  const d = S.disciplinas.find(x => x.id === discId);
  if (!d) return;
  const aula   = d.aulas.find(a => a.id === aulaId);
  if (!aula) return;
  const tarefa = aula.tarefas.find(t => t.id === tarefaId);
  if (!tarefa) return;
  tarefa.status = tarefa.status === 'concluida' ? 'pendente' : 'concluida';
  saveState();
  renderHoje();
};

// ==========================================
// GESTÃO DE AULAS — CRUD
// ==========================================
window.toggleAulaList = function(discId) {
  const el = document.getElementById('disc-aulas-' + discId);
  if (el) el.classList.toggle('open');
};

window.deleteAula = function(discId, aulaId) {
  const d    = S.disciplinas.find(x => x.id === discId);
  const aula = d?.aulas.find(a => a.id === aulaId);
  if (!d || !aula) return;
  if (!confirm(`Excluir "${aula.codigo} — ${aula.titulo}" e todas as suas ${aula.tarefas.length} tarefa(s)?\nEsta ação não pode ser desfeita.`)) return;
  d.aulas = d.aulas.filter(a => a.id !== aulaId);
  saveState();
  renderDiscList();
  renderHoje();
  showToast('Aula excluída.', 'info');
};

window.moverAula = function(fromDiscId, aulaId) {
  const toDiscId = document.getElementById('ms-' + aulaId)?.value;
  if (!toDiscId) return;
  const from = S.disciplinas.find(d => d.id === fromDiscId);
  const to   = S.disciplinas.find(d => d.id === toDiscId);
  if (!from || !to) return;
  const aula = from.aulas.find(a => a.id === aulaId);
  if (!aula) return;
  from.aulas = from.aulas.filter(a => a.id !== aulaId);
  to.aulas.push(aula);
  saveState();
  renderDiscList();
  renderHoje();
  showToast(`Aula movida para "${to.nome}"!`);
};

// ==========================================
// INICIALIZAÇÃO
// ==========================================
function renderAll() {
  const h = new Date().getHours();
  document.getElementById('saudBlock').textContent =
    `${h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite'}! Foco total rumo à aprovação.`;

  renderDiscList();
  renderHoje();

  if (document.getElementById('tab-questoes').classList.contains('active')) renderQuestoes();
}

renderAll();
