// ==========================================
// CONFIGURAÇÃO DO FIREBASE (Coloque suas chaves reais)
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
  config: { lastModified: Date.now() },
  disciplinas: [
    {id:'port', nome:'Língua Portuguesa', peso:20, metaAcerto:85, cor:'#3266ad', aulas:[]},
    {id:'dir', nome:'Direito Administrativo', peso:30, metaAcerto:80, cor:'#D85A30', aulas:[]}
  ],
  questoes_history: []
};

// Mock de inteligência competitiva
const MOCK_GLOBAL_STATS = { avgAcertoGeral: 76.5, avgVolumeMensal: 1250, disciplinas: {} };

let S = JSON.parse(localStorage.getItem('aprovado-v6')) || SEED;
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

window.loginFirebase = async function() {
  await auth.signInWithPopup(new firebase.auth.GoogleAuthProvider());
}

window.logoutFirebase = async function() {
  if(confirm("Deseja sair?")) { 
    await auth.signOut(); 
    location.reload(); 
  }
}

window.pullFirebase = async function(force = false) {
  if(!currentUser) return;
  setSyncState('syncing');
  try {
    const docSnap = await db.collection('usuarios_pro').doc(currentUser.uid).get();
    if(docSnap.exists) {
      const remote = docSnap.data();
      if(force || remote.config?.lastModified > S.config.lastModified) {
        S = remote;
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
// INTERFACE E ROTAS SIMPLES
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
  if(name === 'meta') renderMeta();
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
// LÓGICA DE NEGÓCIO E MOTORES INTELIGENTES
// ==========================================
function getLatestStatsForDisc(discName) {
  if (!S.questoes_history || S.questoes_history.length === 0) return null;
  const latestImport = S.questoes_history[S.questoes_history.length - 1];
  return latestImport.disciplinas.find(d => d.nome.toLowerCase() === discName.toLowerCase());
}

function taskCard(t) {
  const tcfg = TYPES[t.type] || TYPES.TEORIA;
  let badgeReforco = '';
  
  // ALERTA DE OVERLAP: Só avisa se for hora de praticar e a proficiência estiver ruim
  if(t.type === 'QUESTOES' || t.type === 'REVISAO') {
     const stats = getLatestStatsForDisc(t.discNome);
     const discConf = S.disciplinas.find(x => x.id === t.discId);
     const meta = discConf?.metaAcerto || 80;
     if(stats && stats.pctAcerto < meta) {
        badgeReforco = `<span class="tag-reforco">⚠️ REFORÇO CRÍTICO (${Math.round(stats.pctAcerto)}% Tec)</span>`;
     }
  }

  return `
  <div class="ti">
    <div class="tb">
      <div class="tr2">
        <span class="tag tag-disc" style="color:${t.discCor}">${t.aulaCod || 'A00'}</span>
        <span class="tag" style="background:${tcfg.cor}22;color:${tcfg.cor}">${tcfg.label}</span>
        ${badgeReforco}
      </div>
      <div class="tt">${t.topico}</div>
      <div class="tm">⏱ ${fmtMin(t.duracaoMin)}</div>
    </div>
  </div>`;
}

// Algoritmo adaptativo de Trilha
function calcMeta(totalMins) {
  let discData = S.disciplinas.map(d => {
    const stats = getLatestStatsForDisc(d.nome);
    let currentWeight = d.peso;
    const metaUsuario = d.metaAcerto || 80;
    
    if (stats) {
      if (stats.pctAcerto >= metaUsuario + 5) currentWeight *= 0.85; // Manutenção
      else if (stats.pctAcerto < metaUsuario - 5) currentWeight *= 1.25; // Reforço Crítico
    }
    return { disc: d, rawWeight: d.peso, adjWeight: currentWeight };
  });

  const totalAdjWeight = discData.reduce((s, d) => s + d.adjWeight, 0);
  discData.forEach(d => {
    d.alloc = totalAdjWeight > 0 ? Math.round(totalMins * (d.adjWeight / totalAdjWeight)) : 0;
  });
  return discData;
}

window.renderMeta = function() {
  const totalMins = Math.round((parseFloat(document.getElementById('metaHoras').value) || 24) * 60);
  const data = calcMeta(totalMins);
  
  let html = `<div class="card"><div class="ct">Alocação de Tempo Baseada em Desempenho</div>`;
  data.forEach(d => {
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
      <span style="color:var(--acc); font-family:monospace; font-size:14px; font-weight:600">${fmtMin(d.alloc)}</span>
    </div>`;
  });
  html += `</div>`;
  document.getElementById('metaContent').innerHTML = html;
}

// Motor de Diagnóstico e Benchmarking Multidimensional
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
  
  // INJETANDO O CHART.JS MULTIDIMENSIONAL
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

// ==========================================
// IMPORTADOR TECCONCURSOS (PARSER XLSX)
// ==========================================
window.lerXlsx = function(input){
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

// Kickstart local
renderAll();