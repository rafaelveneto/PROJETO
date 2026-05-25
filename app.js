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
  TEORIA: {label:'Teoria', cor:'#60a5fa'},
  LEI_SECA: {label:'Lei Seca', cor:'#4ade80'},
  QUESTOES: {label:'Questões', cor:'#f5a623'},
  REVISAO: {label:'Revisão', cor:'#22d3ee'}
};

const SEED = {
  config: { lastModified: Date.now(), horasSemana: [0,4,4,4,4,4,2] },
  disciplinas: [
    {id:'port', nome:'Língua Portuguesa', peso:20, metaAcerto:85, cor:'#3266ad', aulas:[]},
    {id:'dir', nome:'Direito Administrativo', peso:30, metaAcerto:80, cor:'#D85A30', aulas:[]}
  ],
  questoes_history: []
};

const MOCK_GLOBAL_STATS = { avgAcertoGeral: 76.5, avgVolumeMensal: 1250, disciplinas: {} };

let S = JSON.parse(localStorage.getItem('aprovado-v6')) || SEED;
if(!S.config.horasSemana) S.config.horasSemana = [0,4,4,4,4,4,2];

let currentUser = null;
let qPeriod = 'all';
let qChartInstance = null;

// ==========================================
// AUTENTICAÇÃO E SINCRONIZAÇÃO
// ==========================================
function setSyncState(state) {
  const dot = document.getElementById('syncDot');
  const text = document.getElementById('syncText');
  if(!dot) return;
  dot.className = 'sync-dot s-'+state;
  text.textContent = state === 'synced' ? 'Sincronizado' : state === 'syncing' ? 'Sincronizando...' : 'Off';
}

function saveState() {
  S.config.lastModified = Date.now();
  localStorage.setItem('aprovado-v6', JSON.stringify(S));
  pushFirebase();
}

window.loginFirebase = async function() { await auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()); }
window.logoutFirebase = async function() { if(confirm("Deseja sair?")) { await auth.signOut(); location.reload(); } }

window.pullFirebase = async function(force = false) {
  if(!currentUser) return;
  setSyncState('syncing');
  try {
    const docSnap = await db.collection('usuarios_pro').doc(currentUser.uid).get();
    if(docSnap.exists) {
      const remote = docSnap.data();
      if(force || remote.config?.lastModified > S.config.lastModified) {
        S = remote;
        if(!S.config.horasSemana) S.config.horasSemana = [0,4,4,4,4,4,2];
        if(!S.questoes_history) S.questoes_history = [];
        saveState();
        renderAll();
      }
    }
    setSyncState('synced');
  } catch(e) { setSyncState('error'); }
}

async function pushFirebase() {
  if(!currentUser) return;
  setSyncState('syncing');
  try {
    await db.collection('usuarios_pro').doc(currentUser.uid).set(JSON.parse(JSON.stringify(S)));
    setSyncState('synced');
  } catch(e) { setSyncState('error'); }
}

auth.onAuthStateChanged(user => {
  if(user) {
    currentUser = user;
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('appShell').style.display='flex';
    document.getElementById('sbUserName').textContent = user.displayName?.split(' ')[0] || 'Aluno';
    pullFirebase();
    renderAll();
  } else {
    document.getElementById('loginScreen').classList.remove('hidden');
    document.getElementById('appShell').style.display='none';
  }
});

// ==========================================
// INTERFACE E ROTAS
// ==========================================
const uid = ()=>Math.random().toString(36).slice(2,9);
function fmtMin(m){ const h=Math.floor(m/60),r=m%60; return r?`${h}h ${r}m`:`${h}h`; }

window.toggleSidebar = function() { 
  document.getElementById('sidebar').classList.toggle('open'); 
  document.getElementById('sidebarOverlay').classList.toggle('open'); 
}
window.closeSidebar = function() { 
  document.getElementById('sidebar').classList.remove('open'); 
  document.getElementById('sidebarOverlay').classList.remove('open'); 
}

window.goTab = function(name) {
  document.querySelectorAll('.tab, .nav-item').forEach(e => e.classList.remove('active'));
  document.getElementById('tab-'+name).classList.add('active');
  const nav = document.getElementById('nav-'+name);
  if(nav) nav.classList.add('active');
  
  const titles = {'hoje':'Foco do Dia', 'meta':'Trilha Adaptativa', 'questoes':'Benchmarking', 'disciplinas':'Disciplinas', 'importar':'Importar Dados'};
  document.getElementById('pageTitle').textContent = titles[name] || name;
  
  if(name === 'questoes') renderQuestoes();
  if(name === 'meta') renderAgendaGrid(); // Apenas renderiza o grid, espera o clique para gerar meta
  if(name === 'importar') populateDiscDropdowns();
  
  closeSidebar();
}

window.openSettings = function() {
  let html = '';
  S.disciplinas.forEach(d => {
    html += `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <span style="flex:1;font-size:12px;color:var(--tx)">${d.nome}</span>
        <span style="font-size:10px;color:var(--tx3)">Peso:</span>
        <input type="number" value="${d.peso}" style="width:50px;padding:4px" onchange="updateDisc('${d.id}','peso',this.value)">
        <span style="font-size:10px;color:var(--tx3);margin-left:8px">Meta (%):</span>
        <input type="number" value="${d.metaAcerto||80}" min="50" max="100" style="width:55px;padding:4px;border-color:var(--acc)" onchange="updateDisc('${d.id}','metaAcerto',this.value)">
      </div>`;
  });
  document.getElementById('weightsSettings').innerHTML = html;
  document.getElementById('modal-settings').classList.add('open');
}
window.closeSettings = function() { document.getElementById('modal-settings').classList.remove('open'); }

window.updateDisc = function(id, field, val) {
  const d = S.disciplinas.find(x => x.id === id);
  if(d) { d[field] = parseInt(val) || 0; saveState(); renderAll(); }
}

// ==========================================
// BUSCADORES DE TAREFAS GLOBAIS
// ==========================================
function allTarefas() {
  return S.disciplinas.flatMap(d => d.aulas.flatMap(a => a.tarefas.map(t => ({
    ...t, discId: d.id, discNome: d.nome, discCor: d.cor, 
    aulaId: a.id, aulaCod: a.codigo, aulaTit: a.titulo
  }))));
}
function pendingTarefas() { return allTarefas().filter(t => t.status === 'pendente'); }
function getPendingForDisc(discId) { return pendingTarefas().filter(t => t.discId === discId); }

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
      if (stats.pctAcerto >= metaUsuario + 5) currentWeight *= 0.85; 
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
    for(let t of d.tasks) {
      if(bud <= 0) break;
      if(t.duracaoMin <= bud + 15) { d.selected.push(t); bud -= t.duracaoMin; }
    }
  });

  return discData;
}

window.renderAgendaGrid = function() {
  const hs = S.config.horasSemana;
  const diasStr = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  const totalHoras = hs.reduce((a,b)=>a+b, 0);
  
  let gridHtml = `<div class="day-grid">`;
  diasStr.forEach((d, i) => {
     gridHtml += `
     <div class="day-cell">
       <div class="day-nm">${d}</div>
       <input type="number" class="day-hi" value="${hs[i]}" min="0" max="14" onchange="updateHoraDia(${i}, this.value)">
     </div>`;
  });
  gridHtml += `</div>
  <div class="meta-label" style="text-align:right; margin-top:8px;">Total Planejado: <strong id="totalSemanaGrid">${totalHoras}h</strong></div>`;
  document.getElementById('semanaGridContainer').innerHTML = gridHtml;
}

window.updateHoraDia = function(idx, val) {
  S.config.horasSemana[idx] = Math.max(0, parseInt(val) || 0);
  saveState();
  const totalHoras = S.config.horasSemana.reduce((a,b)=>a+b, 0);
  document.getElementById('totalSemanaGrid').textContent = totalHoras + 'h';
}

window.renderMeta = function() {
  const totalMins = S.config.horasSemana.reduce((a,b)=>a+b, 0) * 60;
  if(totalMins === 0) {
    document.getElementById('metaContent').innerHTML = `<div class="empty">Preencha as horas na agenda acima para gerar a meta.</div>`;
    return;
  }

  const data = calcMeta(totalMins);
  let html = `<div class="card" style="margin-top: 20px;"><div class="ct">Alocação Baseada em Desempenho</div>`;
  
  data.forEach(d => {
    if(d.selected.length === 0) return;
    const stats = getLatestStatsForDisc(d.disc.nome);
    const currAcc = stats ? stats.pctAcerto : '--';
    const isBuffed = d.adjWeight > d.rawWeight;
    const isNerfed = d.adjWeight < d.rawWeight;
    const indic = isBuffed ? '<span style="color:var(--re);font-size:10px">↑ CARGA EXTRA</span>' : isNerfed ? '<span style="color:var(--gr);font-size:10px">↓ MANUTENÇÃO</span>' : '';
    
    html += `<div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid var(--bd); padding:8px 0;">
      <div>
        <div style="font-size:13px;color:var(--tx)">${d.disc.nome} ${indic}</div>
        <div style="font-size:10px;color:var(--tx3)">Acerto Atual: ${currAcc}% | Meta: ${d.disc.metaAcerto}%</div>
      </div>
      <div style="text-align:right;">
        <div style="color:var(--acc); font-family:monospace; font-size:14px; font-weight:600">${fmtMin(d.alloc)}</div>
        <div style="font-size:9px; color:var(--tx3)">${d.selected.length} tarefas</div>
      </div>
    </div>`;
  });
  html += `</div>`;
  document.getElementById('metaContent').innerHTML = html;
}

// IMPRESSÃO DE AGENDA
window.imprimirAgenda = function() {
  const hs = S.config.horasSemana;
  const totalMins = hs.reduce((a,b)=>a+b, 0) * 60;
  if(totalMins === 0) { alert("Sua agenda está com 0 horas. Preencha a grade da semana."); return; }

  const daysFull = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
  const data = calcMeta(totalMins);
  
  let allTasks = [];
  data.forEach(d => { if(d.selected) allTasks.push(...d.selected); });
  allTasks = allTasks.sort(() => Math.random() - 0.5);

  let printHtml = `
    <div class="print-header">
      <h1>Trilha Estratégica: Agenda da Semana</h1>
      <p>Gerado em ${new Date().toLocaleDateString('pt-BR')} · Total: ${totalMins/60}h programadas.</p>
    </div>
  `;

  let taskIdx = 0;
  hs.forEach((hours, i) => {
    if(hours === 0) {
      printHtml += `<div class="print-day">
        <div class="print-day-header"><h2>${daysFull[i]}</h2><span>DESCANSO</span></div>
      </div>`;
      return;
    }

    let dayBud = hours * 60;
    let dayTasks = [];
    while(taskIdx < allTasks.length && dayBud > 0) {
      let t = allTasks[taskIdx];
      if(t.duracaoMin <= dayBud + 15) {
        dayTasks.push(t);
        dayBud -= t.duracaoMin;
        taskIdx++;
      } else {
        if(dayTasks.length === 0) { dayTasks.push(t); dayBud -= t.duracaoMin; taskIdx++; }
        break; 
      }
    }

    printHtml += `
    <div class="print-day">
      <div class="print-day-header"><h2>${daysFull[i]}</h2><span>Meta: ${hours}h</span></div>
      <ul class="print-task-list">`;

    if(dayTasks.length === 0) {
      printHtml += `<li style="font-size:12px; color:#666;">Nenhuma tarefa alocada para hoje.</li>`;
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
}

// ==========================================
// ANALYTICS & BENCHMARKING (GURUJA STYLE)
// ==========================================
window.renderQuestoes = function() {
  const container = document.getElementById('questoesContent');
  if (!S.questoes_history || S.questoes_history.length === 0) {
    container.innerHTML = `<div class="empty">Importe dados do TecConcursos para gerar o diagnóstico.</div>`;
    return;
  }

  const now = new Date();
  let filteredHistory = S.questoes_history.filter(h => {
    if (qPeriod === 'all') return true;
    const diffDays = Math.abs(now - new Date(h.importadoEm)) / (1000 * 60 * 60 * 24);
    return diffDays <= parseInt(qPeriod);
  });
  filteredHistory.sort((a,b) => new Date(a.importadoEm) - new Date(b.importadoEm));

  if (filteredHistory.length === 0) { container.innerHTML = `<div class="empty">Sem dados no período.</div>`; return; }

  const latestStats = filteredHistory[filteredHistory.length - 1];
  const accDiff = (latestStats.pctGeral - MOCK_GLOBAL_STATS.avgAcertoGeral).toFixed(1);
  const isAccUp = accDiff >= 0;

  const getBelt = (acc) => {
    if(acc >= 85) return '<span class="belt-badge belt-black">Faixa Preta (Alta Concorrência)</span>';
    if(acc >= 75) return '<span class="belt-badge belt-blue">Faixa Azul (Competitivo)</span>';
    return '<span class="belt-badge belt-white">Faixa Branca (Formação)</span>';
  };

  let html = `
    <div class="bench-grid">
      <div class="bench-card">
        <div class="bench-title">Seu Acerto Global</div>
        <div class="bench-val">${latestStats.pctGeral}%</div>
        <div class="bench-vs ${isAccUp ? 'vs-up' : 'vs-down'}">
          ${isAccUp ? '▲' : '▼'} ${Math.abs(accDiff)}% vs Média Concorrência (${MOCK_GLOBAL_STATS.avgAcertoGeral}%)
        </div>
      </div>
      <div class="bench-card">
        <div class="bench-title">Nível Atual</div>
        <div style="margin-top: 8px;">${getBelt(latestStats.pctGeral)}</div>
        <div class="bench-vs vs-flat" style="margin-top: 12px; color: var(--tx3);">Amostra: ${latestStats.total} questões</div>
      </div>
    </div>
    
    <div class="chart-container" style="height: 280px; margin-bottom: 24px;"><canvas id="qChartAdvanced"></canvas></div>
  `;

  // UTI DE REVISÃO CRÍTICA
  let revisoesCriticas = [];
  latestStats.disciplinas.forEach(d => {
    const discConfig = S.disciplinas.find(x => x.nome.toLowerCase() === d.nome.toLowerCase());
    const metaUsuario = discConfig?.metaAcerto || 80;
    
    if(d.topicos) {
      d.topicos.forEach(t => {
        if (t.qResolvidas >= 10 && t.pctAcerto < metaUsuario) {
          revisoesCriticas.push({ disc: d.nome, topico: t.nome, acerto: t.pctAcerto, meta: metaUsuario });
        }
      });
    }
  });

  if (revisoesCriticas.length > 0) {
    revisoesCriticas.sort((a,b) => a.acerto - b.acerto);
    html += `
      <div class="card">
        <div class="ct" style="color: var(--re);">⚠️ UTI / Revisão Crítica</div>
        <div style="font-size: 11px; color: var(--tx3); margin-bottom: 16px;">Tópicos com mais de 10 questões onde você está abaixo da SUA META.</div>
        <div class="rev-list">
          ${revisoesCriticas.slice(0, 10).map(r => `
            <div class="rev-item">
              <div><div class="rev-topic">${r.topico}</div><div class="rev-disc">${r.disc}</div></div>
              <div class="rev-metrics">
                <div class="rev-metric-box"><span class="rev-metric-lbl">Acerto Atual</span><span class="rev-metric-val val-danger">${Math.round(r.acerto)}%</span></div>
                <div class="rev-metric-box"><span class="rev-metric-lbl">Sua Meta</span><span class="rev-metric-val" style="color:var(--tx2)">${r.meta}%</span></div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>`;
  }

  container.innerHTML = html;
  
  setTimeout(() => {
    const ctx = document.getElementById('qChartAdvanced').getContext('2d');
    if(qChartInstance) qChartInstance.destroy();
    
    qChartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels: filteredHistory.map(h => h.label || new Date(h.importadoEm).toLocaleDateString('pt-BR')),
        datasets: [
          {
            label: '% Acerto (Evolução)', data: filteredHistory.map(h => h.pctGeral),
            borderColor: '#f5a623', backgroundColor: 'rgba(245,166,35,0.1)', borderWidth: 3,
            fill: true, tension: 0.3, yAxisID: 'y'
          },
          {
            label: 'Volume Resolvido', type: 'bar', data: filteredHistory.map(h => h.total),
            backgroundColor: 'rgba(59, 130, 246, 0.15)', borderWidth: 1, borderRadius: 4, yAxisID: 'y1'
          }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: {
          y: { type: 'linear', position: 'left', min: 0, max: 100, grid: { color: '#27272a' } },
          y1: { type: 'linear', position: 'right', beginAtZero: true, grid: { drawOnChartArea: false } }
        }
      }
    });
  }, 100);
}

// ==========================================
// MÓDULOS DE IMPORTAÇÃO (NLM, MANUAL, XLSX)
// ==========================================
window.switchImp = function(mode, btn) {
  document.querySelectorAll('.imp-tab').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.imp-panel').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('imp-'+mode).classList.add('active');
  if(mode === 'form') initForm();
  populateDiscDropdowns();
}

window.populateDiscDropdowns = function() {
  const opts = S.disciplinas.map(d => `<option value="${d.id}">${d.nome}</option>`).join('');
  if(document.getElementById('nlm-disc')) document.getElementById('nlm-disc').innerHTML = opts;
  if(document.getElementById('f-disc')) document.getElementById('f-disc').innerHTML = opts;
}

// PARSER: NotebookLM
let _parsedTasks = [];
window.parsearNLM = function() {
  const txt = document.getElementById('nlm-txt').value;
  const cod = document.getElementById('nlm-cod').value.trim();
  const tit = document.getElementById('nlm-tit').value.trim();
  if(!txt.trim() || !cod || !tit) { alert('Preencha Código, Título e cole o texto do NLM.'); return; }
  
  _parsedTasks = [];
  // Regex adaptado ao Prompt Mestre do NLM do usuário
  const blocks = txt.split(/(?=\n?#{0,5}\s*TAREFA\s+\d+\s*[—\-])/i).filter(b=>b.trim()&&/TAREFA\s+\d+/i.test(b));
  
  blocks.forEach((block,i) => {
    const hm = block.match(/TAREFA\s+(\d+)\s*[—\-]+\s*([A-Z_]+)/i);
    const type = hm ? hm[2].toUpperCase().trim() : 'TEORIA';
    const finalType = ['TEORIA','LEI_SECA','TEORIA_LEI','QUESTOES','REVISAO'].includes(type) ? type : 'TEORIA';
    
    const pagM = block.match(/P[áa]ginas.*?:?\s*([\d]+[\s–\-]+[\d]+)/i);
    const paginas = pagM ? pagM[1].replace(/\s/g,'–') : '—';
    
    const durM = block.match(/dura[çc][ãa]o.*?:?\s*(\d+)\s*[–\-]\s*(\d+)/i);
    const durMin = durM ? parseInt(durM[1]) : 60;
    
    const topM = block.match(/T[óo]pico.*?principal.*?:?\s*(.+)/i);
    const topico = topM ? topM[1].replace(/\*\*/g,'').trim() : `Tarefa ${i+1}`;
    
    _parsedTasks.push({
      id: uid(), label: `Tarefa ${i+1}`, type: finalType, paginas, topico, duracaoMin: durMin, status: 'pendente'
    });
  });

  if(!_parsedTasks.length) { alert('Nenhuma tarefa encontrada. Verifique o formato do texto.'); return; }
  
  const discId = document.getElementById('nlm-disc').value;
  const disc = S.disciplinas.find(d => d.id === discId);
  
  let html = `<div class="parse-preview"><div style="color:var(--gr);margin-bottom:12px">✔ ${_parsedTasks.length} tarefa(s) encontrada(s)</div>`;
  _parsedTasks.forEach(t => {
     html += `<div style="background:var(--bg); border:1px solid var(--bd); padding:8px; margin-bottom:4px; font-size:12px;">[${t.type}] ${t.topico} (⏱ ${t.duracaoMin}m)</div>`;
  });
  html += `<div style="margin-top:14px;"><button class="btn btn-p" onclick="confirmarNLM()">✔ Confirmar Importação</button></div></div>`;
  document.getElementById('nlm-preview').innerHTML = html;
}

window.confirmarNLM = function() {
  const discId = document.getElementById('nlm-disc').value;
  const cod = document.getElementById('nlm-cod').value.trim();
  const tit = document.getElementById('nlm-tit').value.trim();
  const d = S.disciplinas.find(x => x.id === discId);
  if(!d) return;
  
  d.aulas.push({ id: uid(), codigo: cod, titulo: tit, tarefas: _parsedTasks });
  saveState();
  document.getElementById('nlm-cod').value = ''; document.getElementById('nlm-tit').value = ''; document.getElementById('nlm-txt').value = ''; document.getElementById('nlm-preview').innerHTML = '';
  alert("Tarefas importadas com sucesso!");
  goTab('disciplinas'); renderAll();
}

// MANUAL FORM
let tfForms = [];
window.initForm = function() { tfForms = [{id:uid()}]; renderForms(); }
window.addTF = function() { tfForms.push({id:uid()}); renderForms(); }
window.renderForms = function() {
  const typeOpts = Object.keys(TYPES).map(k=>`<option value="${k}">${TYPES[k].label}</option>`).join('');
  document.getElementById('tfList').innerHTML = tfForms.map((t,i)=>`
    <div class="tblock">
      <div class="tbh"><span style="color:var(--acc);font-weight:600">Tarefa ${i+1}</span></div>
      <div class="fg2">
        <div class="fg"><label>Tipo</label><select id="ty-${t.id}">${typeOpts}</select></div>
        <div class="fg"><label>Duração (min)</label><input id="du-${t.id}" type="number" value="60"></div>
        <div class="fg full"><label>Tópico</label><input id="tp-${t.id}"></div>
      </div>
    </div>`).join('');
}
window.salvarManual = function() {
  const discId = document.getElementById('f-disc').value, cod = document.getElementById('f-cod').value, tit = document.getElementById('f-tit').value;
  if(!cod || !tit) { alert("Preencha Código e Título."); return; }
  const d = S.disciplinas.find(x => x.id === discId);
  
  const tarefas = tfForms.map((t,i) => {
    return {
      id: uid(), label: `Tarefa ${i+1}`, type: document.getElementById('ty-'+t.id).value, 
      topico: document.getElementById('tp-'+t.id).value || `Tarefa ${i+1}`,
      duracaoMin: parseInt(document.getElementById('du-'+t.id).value) || 60, status: 'pendente'
    };
  });
  d.aulas.push({ id: uid(), codigo: cod, titulo: tit, tarefas });
  saveState(); goTab('disciplinas'); renderAll();
}

// EXCEL (TECCONCURSOS)
window.lerXlsx = function(input) {
  const file = input.files[0]; if(!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const wb = XLSX.read(e.target.result, {type:'array'});
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const data = XLSX.utils.sheet_to_json(sheet, {header:1, defval:null, raw:true});
      
      const headers = data[0].map(h => String(h||'').trim().toLowerCase());
      const c = (name) => headers.findIndex(h => h.includes(name));
      const idxH = c('hierarquia'), idxN = c('índice') > -1 ? c('índice') : c('indice'), idxQ = c('resolvidas'), idxA = c('quantidade de acertos'), idxP = c('acertos (%)');
      
      let disciplinas = [], current = null, totalQ=0, totalA=0;
      for(let i=1; i<data.length; i++) {
        const row = data[i]; if(!row[idxN]) continue;
        const nome = String(row[idxN]).trim(), hier = String(row[idxH]||'').trim();
        const qR = Number(row[idxQ])||0, qA = Number(row[idxA])||0, pct = Number(row[idxP])||0;
        
        if(hier === '') { current = {nome, qResolvidas:qR, acertos:qA, pctAcerto:pct, topicos:[]}; disciplinas.push(current); }
        else if(current) { current.topicos.push({nome, qResolvidas:qR, acertos:qA, pctAcerto:pct}); totalQ+=qR; totalA+=qA; }
      }
      
      const pctGlobal = totalQ ? Math.round((totalA/totalQ)*1000)/10 : 0;
      const lbl = document.getElementById('xls-label').value || new Date().toLocaleDateString('pt-BR');
      
      S.questoes_history.push({ id:uid(), importadoEm: new Date().toISOString(), label: lbl, total: totalQ, pctGeral: pctGlobal, disciplinas });
      saveState();
      alert(`✅ Importado: ${totalQ} questões processadas com ${pctGlobal}% de acerto.`);
      document.getElementById('xls-preview').innerHTML = '';
      goTab('questoes');
    } catch(err) { alert('Erro ao processar planilha. Exporte "Por Tópicos" no TecConcursos.'); }
  };
  reader.readAsArrayBuffer(file);
}

// ==========================================
// INICIALIZAÇÃO
// ==========================================
function renderAll() {
  const h = new Date().getHours();
  document.getElementById('saudBlock').textContent = `${h<12?'Bom dia':h<18?'Boa tarde':'Boa noite'}! Foco total rumo à aprovação.`;
  
  document.getElementById('discList').innerHTML = S.disciplinas.map(d => `
    <div style="background:var(--s2); border:1px solid var(--bd); padding:12px; margin-bottom:8px; border-radius:8px; display:flex; justify-content:space-between;">
      <div><strong style="color:${d.cor}">${d.nome}</strong><br><span style="font-size:11px;color:var(--tx3)">Peso: ${d.peso} | Meta: ${d.metaAcerto||80}%</span></div>
      <div>${d.aulas.length} Aulas</div>
    </div>
  `).join('');

  if(document.getElementById('tab-questoes').classList.contains('active')) renderQuestoes();
}

renderAll();