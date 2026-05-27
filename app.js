// ============================================================
// FIREBASE CONFIG
// ============================================================
const firebaseConfig = {
  apiKey: "AIzaSyCdjd_0Ubn1d7JFfAOX5lNjghsdMetp3vU",
  authDomain: "aprovado-tracker.firebaseapp.com",
  projectId: "aprovado-tracker",
  storageBucket: "aprovado-tracker.firebasestorage.app",
  messagingSenderId: "457948327236",
  appId: "1:457948327236:web:7b04a9f70361807f3bbb11"
};
if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db   = firebase.firestore();

// ============================================================
// CONSTANTES & ESTADO
// ============================================================
const TYPES = {
  TEORIA:    { label:'Teoria',     cor:'#60a5fa' },
  LEI_SECA:  { label:'Lei Seca',   cor:'#4ade80' },
  TEORIA_LEI:{ label:'Teoria+Lei', cor:'#a78bfa' },
  QUESTOES:  { label:'Questões',   cor:'#f5a623' },
  REVISAO:   { label:'Revisão',    cor:'#22d3ee' }
};
const STATUS_EDITAL = [
  { value:'previsto',     label:'Previsto'          },
  { value:'cobrado',      label:'Cobrado / Exigido' },
  { value:'nao_previsto', label:'Não previsto'      }
];
const NIVEL_LABEL  = { nunca:'🔴 Nunca estudei', comecei:'🟡 Comecei', terminei:'🟠 Terminei sem confiança', aparar:'🟢 Aparar arestas' };
const NIVEL_WEIGHT = { nunca:1.35, comecei:1.15, terminei:1.0, aparar:0.85 };
const MOCK_GLOBAL  = { avgAcerto:76.5 };
const SEED = { config:{ lastModified:0, horasSemana:[0,4,4,4,4,4,2] }, disciplinas:[], questoes_history:[] };

let S              = JSON.parse(localStorage.getItem('aprovado-v6')) || SEED;
if (!S.config)            S.config = {};
if (!S.config.horasSemana) S.config.horasSemana = [0,4,4,4,4,4,2];
if (!S.questoes_history)   S.questoes_history   = [];
if (!S.disciplinas)        S.disciplinas        = [];
if (!S.concursos)          S.concursos          = [];
// Configurações de revisão (editáveis pelo usuário)
if (!S.config.discsSelecionadas) S.config.discsSelecionadas = null; // null = todas
if (!S.config.revisao) S.config.revisao = {
  limiteUrgente: 60,
  limiteMedio:   75,
  diasUrgente:   2,
  diasMedio:     7,
  diasBom:       14
};
// Migração: criar concurso padrão e associar disciplinas órfãs
(function migrateConcursos() {
  if (!S.concursos.length) {
    const defaultId = 'c-' + Date.now();
    S.concursos.push({ id: defaultId, nome: 'Analista Legislativo' });
    S.concursoAtivo = defaultId;
  }
  if (!S.concursoAtivo) S.concursoAtivo = S.concursos[0].id;
  // Associar disciplinas sem concursoId ao concurso padrão
  (S.disciplinas||[]).forEach(d => {
    if (!d.concursoId) d.concursoId = S.concursoAtivo;
    // Migrar peso → percentual
    if (d.percentual == null && d.peso != null) { d.percentual = d.peso; delete d.peso; }
    if (d.percentual == null) d.percentual = 20;
  });
})();

let currentUser    = null;
let qPeriod        = 'all';
let qDiscSel       = 'all';
let qChartInstance = null;
let _parsedTasks   = [];
let _xlsxParsed    = null;
let _pendingToggle = null;
let tfForms        = [];

// ============================================================
// UTILITÁRIOS
// ============================================================
const uid    = () => Math.random().toString(36).slice(2,9);
const fmtMin = m  => { const h=Math.floor(m/60),r=m%60; return r?`${h}h ${r}m`:`${h}h`; };

function sortedAulas(aulas) {
  if (!Array.isArray(aulas)) return [];
  return [...aulas].sort((a,b)=>{
    const nA=parseInt((a.codigo||'').replace(/\D/g,''))||0;
    const nB=parseInt((b.codigo||'').replace(/\D/g,''))||0;
    return nA-nB;
  });
}
function allTarefas() {
  return (S.disciplinas||[]).flatMap(d=>
    sortedAulas(d.aulas).flatMap(a=>(a.tarefas||[]).map(t=>({
      ...t, discId:d.id, discNome:d.nome, discCor:d.cor,
      aulaId:a.id, aulaCod:a.codigo, aulaTit:a.titulo
    })))
  );
}
function pendingTarefas()         { return allTarefas().filter(t=>t.status==='pendente'); }
function getPendingForDisc(id)    { return pendingTarefas().filter(t=>t.discId===id); }
function getLatestStatsForDisc(n) {
  if (!(S.questoes_history||[]).length) return null;
  const latest=S.questoes_history[S.questoes_history.length-1];
  return (latest.disciplinas||[]).find(d=>d.nome.toLowerCase()===n.toLowerCase())||null;
}
function isReforco(discId,type) {
  if (!['QUESTOES','REVISAO'].includes(type)) return false;
  const d=(S.disciplinas||[]).find(x=>x.id===discId); if (!d) return false;
  const s=getLatestStatsForDisc(d.nome); if (!s) return false;
  return s.pctAcerto<(d.metaAcerto||80);
}
function getSequentialQueue(discId) {
  const d=(S.disciplinas||[]).find(x=>x.id===discId); if (!d) return [];
  const first=sortedAulas(d.aulas).find(a=>(a.tarefas||[]).some(t=>t.status==='pendente'));
  if (!first) return [];
  return (first.tarefas||[]).filter(t=>t.status==='pendente').map(t=>({
    ...t, discId:d.id, discNome:d.nome, discCor:d.cor,
    aulaId:first.id, aulaCod:first.codigo, aulaTit:first.titulo
  }));
}
function buildTodayTasks(totalMins) {
  const queues=(S.disciplinas||[]).map(d=>{
    const tasks=getSequentialQueue(d.id);
    return tasks.length?{tasks:[...tasks]}:null;
  }).filter(Boolean);
  if (!queues.length) return [];
  const sel=[]; let budget=totalMins, rounds=0;
  while (budget>0&&rounds<100) {
    rounds++; let added=false;
    for (const q of queues) {
      if (!q.tasks.length||budget<=0) continue;
      const t=q.tasks[0];
      if (t.duracaoMin<=budget+15){ q.tasks.shift(); sel.push(t); budget-=t.duracaoMin; added=true; }
    }
    if (!added) break;
  }
  return sel;
}

// ============================================================
// TOAST
// ============================================================
window.showToast = function(msg,type='success') {
  const c=document.getElementById('toastContainer'); if (!c) return;
  const t=document.createElement('div'); t.className=`toast toast-${type}`; t.textContent=msg;
  c.appendChild(t);
  requestAnimationFrame(()=>requestAnimationFrame(()=>t.classList.add('show')));
  setTimeout(()=>{ t.classList.remove('show'); setTimeout(()=>t.remove(),300); },3200);
};

// ============================================================
// FIREBASE AUTH & SYNC
// ============================================================
function setSyncState(state) {
  const dot=document.getElementById('syncDot'), txt=document.getElementById('syncText');
  if (!dot) return;
  dot.className='sync-dot s-'+state;
  txt.textContent=state==='synced'?'Sincronizado':state==='syncing'?'Sincronizando...':'Off';
}

function applyFirebaseData(r) {
  if (!r) return false;
  // Aplica SEMPRE — sem condição — o que vier do Firebase
  S = r;
  if (!S.config)             S.config = {};
  if (!S.config.horasSemana) S.config.horasSemana = [0,4,4,4,4,4,2];
  if (!S.questoes_history)   S.questoes_history = [];
  if (!S.disciplinas)        S.disciplinas = [];
  if (!S.concursos)          S.concursos = [];
  // Migração pós-Firebase: criar concurso padrão e migrar disciplinas
  (function migFB() {
    if (!S.concursos.length) {
      const did = 'c-' + Date.now();
      S.concursos.push({ id: did, nome: 'Analista Legislativo' });
      S.concursoAtivo = did;
    }
    if (!S.concursoAtivo) S.concursoAtivo = S.concursos[0].id;
    (S.disciplinas||[]).forEach(function(d) {
      if (!d.concursoId) d.concursoId = S.concursoAtivo;
      if (d.percentual == null && d.peso != null) { d.percentual = d.peso; delete d.peso; }
      if (d.percentual == null) d.percentual = 20;
    });
  })();
  // Garante que aulas seja sempre array em cada disciplina
  S.disciplinas = S.disciplinas.map(d => ({
    ...d, aulas: Array.isArray(d.aulas) ? d.aulas.map(a => ({
      ...a, tarefas: Array.isArray(a.tarefas) ? a.tarefas : []
    })) : []
  }));
  localStorage.setItem('aprovado-v6', JSON.stringify(S));
  console.log('[applyFirebaseData] aplicado! disciplinas:', S.disciplinas.length);
  return true;
}

function saveState() {
  S.config.lastModified=Date.now();
  localStorage.setItem('aprovado-v6',JSON.stringify(S));
  pushFirebase();
}

async function pushFirebase() {
  if (!currentUser) return;
  if (!S.disciplinas?.length&&!S.questoes_history?.length) {
    console.warn('[push] bloqueado: estado vazio'); return;
  }
  try {
    setSyncState('syncing');
    await db.collection('usuarios_pro').doc(currentUser.uid).set(JSON.parse(JSON.stringify(S)));
    setSyncState('synced');
  } catch(e) { setSyncState('error'); showToast(`Erro ao salvar: ${e.code||e.message}`,'error'); }
}

window.pullFirebase = async function(force=false) {
  if (!currentUser){ setSyncState('error'); return; }
  setSyncState('syncing');
  try {
    const snap=await db.collection('usuarios_pro').doc(currentUser.uid).get();
    if (snap.exists) {
      const r=snap.data();
      const discsFB=r.disciplinas?.length||0;
      if (force||!S.disciplinas?.length||(r.config?.lastModified||0)>(S.config?.lastModified||0)) {
        const ok=applyFirebaseData(r);
        renderAll();
        if (force) showToast(ok?`✅ ${S.disciplinas.length} disciplina(s) restaurada(s)!`:'⚠️ Firebase sem dados.','success');
      }
    } else {
      if (force) showToast('Documento não encontrado no Firebase.','info');
    }
    setSyncState('synced');
  } catch(e){ setSyncState('error'); showToast(`Erro: ${e.code||e.message}`,'error'); }
};

window.loginFirebase = async function() {
  const provider=new firebase.auth.GoogleAuthProvider();
  try { await auth.signInWithPopup(provider); }
  catch(e) {
    if (['auth/popup-blocked','auth/popup-closed-by-user','auth/cancelled-popup-request'].includes(e.code)) {
      try { await auth.signInWithRedirect(provider); } catch(e2) { showToast(`Erro: ${e2.message}`,'error'); }
    } else if (e.code!=='auth/popup-closed-by-user') { showToast(`Erro: ${e.code||e.message}`,'error'); }
  }
};
window.logoutFirebase = async()=>{ if (confirm('Sair da conta?')){ await auth.signOut(); location.reload(); } };

// Captura redirect result (fallback para popup bloqueado)
auth.getRedirectResult().catch(e=>{ if (e.code&&e.code!=='auth/no-auth-event') showToast(`Erro pós-redirect: ${e.code}`,'error'); });

// *** PONTO CRÍTICO: aguarda Firebase ANTES de renderizar ***
auth.onAuthStateChanged(async user=>{
  if (user) {
    currentUser=user;
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('appShell').style.display='flex';
    document.getElementById('sbUserName').textContent=user.displayName?.split(' ')[0]||'Aluno';
    setSyncState('syncing');
    try {
      const snap=await db.collection('usuarios_pro').doc(user.uid).get();
      if (snap.exists) {
        applyFirebaseData(snap.data()); // aplica dados do Firebase ANTES de renderizar
      }
      setSyncState('synced');
    } catch(e) { setSyncState('error'); }
    renderAll(); // renderiza UMA VEZ após dados carregados
  } else {
    document.getElementById('loginScreen').classList.remove('hidden');
    document.getElementById('appShell').style.display='none';
  }
});

// ============================================================
// NAVEGAÇÃO
// ============================================================
window.toggleSidebar = ()=>{ document.getElementById('sidebar').classList.toggle('open'); document.getElementById('sidebarOverlay').classList.toggle('open'); };
window.closeSidebar  = ()=>{ document.getElementById('sidebar').classList.remove('open'); document.getElementById('sidebarOverlay').classList.remove('open'); };

window.goTab = function(name) {
  document.querySelectorAll('.tab,.nav-item').forEach(e=>e.classList.remove('active'));
  document.getElementById('tab-'+name)?.classList.add('active');
  document.getElementById('nav-'+name)?.classList.add('active');
  const titles={hoje:'Metas da Semana',historico:'Histórico',questoes:'Análise de Desempenho — TecConcursos',progresso:'Progresso & Previsão',planejamento:'Planejamento',templates:'Templates'};
  document.getElementById('pageTitle').textContent=titles[name]||name;
  if (name==='hoje')         renderHoje();
  if (name==='historico')    renderHistorico();
  if (name==='questoes')     { populateDiscDropdowns(); renderQuestoes(); }
  if (name==='progresso')    renderProgresso();
  if (name==='planejamento') { renderAgendaGrid(); renderDiscList(); populateDiscDropdowns(); }
  if (name==='templates')    renderTemplates();
  closeSidebar();
};
window.switchPlan = function(panel,btn) {
  document.querySelectorAll('.plan-tab').forEach(b=>b.classList.remove('active'));
  document.querySelectorAll('.plan-panel').forEach(p=>p.classList.remove('active'));
  if (btn) btn.classList.add('active');
  document.getElementById('plan-'+panel)?.classList.add('active');
  if (panel==='trilha')       renderAgendaGrid();
  if (panel==='disciplinas')  renderDiscList();
  if (panel==='importar')     populateDiscDropdowns();
};
window.switchImp = function(mode,btn) {
  document.querySelectorAll('.imp-tab').forEach(b=>b.classList.remove('active'));
  document.querySelectorAll('.imp-panel').forEach(p=>p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('imp-'+mode)?.classList.add('active');
  if (mode==='form') initForm();
  populateDiscDropdowns();
};
window.irParaTrilha      = ()=>{ goTab('planejamento'); setTimeout(()=>switchPlan('trilha',document.getElementById('ptab-trilha')),60); };
window.irParaDisciplinas = ()=>{ goTab('planejamento'); setTimeout(()=>switchPlan('disciplinas',document.getElementById('ptab-disciplinas')),60); };
window.irParaImport = function(panel) {
  goTab('planejamento');
  setTimeout(()=>{ switchPlan('importar',document.getElementById('ptab-importar')); setTimeout(()=>{ const btns=document.querySelectorAll('.imp-tab'); const idx=['nlm','form','xlsx'].indexOf(panel); if (idx>=0&&btns[idx]) btns[idx].click(); },60); },60);
};
window.populateDiscDropdowns = function() {
  const opts=(S.disciplinas||[]).map(d=>`<option value="${d.id}">${d.nome}</option>`).join('');
  ['nlm-disc','f-disc'].forEach(id=>{ const el=document.getElementById(id); if (el) el.innerHTML=opts; });
  const fEl=document.getElementById('qDiscFilter');
  if (fEl){ const cur=fEl.value; fEl.innerHTML='<option value="all">Todas as Disciplinas</option>'+(S.disciplinas||[]).map(d=>`<option value="${d.id}">${d.nome}</option>`).join(''); if (cur) fEl.value=cur; }
};

// ============================================================
// RENDERIZAÇÃO DE TAREFAS
// ============================================================
function parseLeiSeca(text) {
  if (!text) return '';
  const rows=text.split('\n').filter(r=>r.trim()&&r.includes('|'));
  if (!rows.length) return `<p style="font-size:12px;color:var(--tx2);line-height:1.5;white-space:pre-line">${text}</p>`;
  return `<table class="lei-seca-table"><thead><tr><th>Dispositivo</th><th>Artigos</th><th>Por que cai</th></tr></thead><tbody>${rows.map(r=>{ const p=r.split('|').map(s=>s.trim()); return `<tr><td class="ls-dispositivo">${p[0]||''}</td><td class="ls-artigos">${p[1]||''}</td><td class="ls-motivo">${p[2]||''}</td></tr>`; }).join('')}</tbody></table>`;
}
function parseBizus(text) {
  if (!text) return '';
  return text.split('\n').filter(l=>l.trim()).map(b=>`<div class="bizu-card">${b.replace(/^[•\-]\s*/,'').trim()}</div>`).join('');
}
function parseKeywords(text) {
  if (!text) return '';
  return text.replace(/^[•\-]\s*/,'').split(',').map(k=>k.trim()).filter(Boolean).map(k=>`<span class="kw-pill">${k}</span>`).join('');
}
function renderTaskCard(t,idx) {
  const ti=TYPES[t.type]||TYPES.TEORIA, done=t.status==='concluida';
  const reforco=isReforco(t.discId,t.type), disc=(S.disciplinas||[]).find(d=>d.id===t.discId);
  const hasD=true; // form de acerto sempre disponível
  const fDur=m=>{ const h=Math.floor(m/60),r=m%60; return h>0?`${h}h${r>0?' '+r+'min':''}`:`${m}min`; };
  const dMin=t.duracaoMin||60, dMax=Math.round(dMin*1.25);
  const eBadge=(t.statusEdital&&!t.statusEdital.toLowerCase().includes('não'))?'<span class="edital-badge">✅ Edital</span>':'';
  return `<div class="task-card${done?' task-done':''}">
    <div class="task-card-main">
      <div class="task-chk${done?' checked':''}" onclick="toggleTarefa('${t.discId}','${t.aulaId}','${t.id}')">
        ${done?'<svg width="10" height="10" viewBox="0 0 10 10"><path d="M1.5 5L4 7.5L8.5 2.5" stroke="#09090b" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>':''}
      </div>
      <div class="task-body">
        <div class="task-tags">
          <span class="aula-badge">${t.aulaCod||'A?'}</span>
          <span class="task-num">Tarefa ${idx+1}</span>
          <span class="tag" style="color:${ti.cor};border-color:${ti.cor}30;background:${ti.cor}18">${ti.label}</span>
          ${eBadge}${reforco?'<span class="tag-reforco">⚠️ REFORÇO</span>':''}
        </div>
        <div class="task-title${done?' done':''}">${t.topico}</div>
        <div class="task-meta-row">
          ${t.paginas&&t.paginas!=='—'?`<span>📄 Pág.&nbsp;${t.paginas}</span>`:''}
          <span>🕐 ${fDur(dMin)}–${fDur(dMax)}</span>
          <span style="color:${disc?.cor||'var(--acc)'}">● ${t.discNome}</span>
          ${t.pctAcerto!=null?`<span class="acerto-badge" style="color:${t.pctAcerto>=70?'var(--gr)':'var(--re)'}">⚡ ${t.qAcertos||0}/${t.qRespondidas||0} · ${t.pctAcerto}%</span>`:''}
        </div>
      </div>
      ${hasD?`<button class="detail-btn" onclick="toggleTaskDetail('${t.id}')">▸ detalhes</button>`:''}
    </div>
    ${hasD?`<div class="task-detail" id="td-${t.id}">
      ${t.comando?`<div class="task-section"><div class="task-section-lbl">📖 Comando de Estudo</div><div class="cmd-box">${t.comando}</div></div>`:''}
      ${t.leiSeca?`<div class="task-section"><div class="task-section-lbl">⚖️ Lei Seca</div>${parseLeiSeca(t.leiSeca)}</div>`:''}
      ${t.bizus?`<div class="task-section"><div class="task-section-lbl">💡 Bizus</div>${parseBizus(t.bizus)}</div>`:''}
      ${t.questoes?`<div class="task-section"><div class="task-section-lbl">📝 Questões de Fixação</div><p style="font-size:12px;color:var(--tx2);white-space:pre-line;line-height:1.5">${t.questoes}</p></div>`:''}
      ${t.keywords?`<div class="task-section"><div class="task-section-lbl">🔑 Palavras-chave</div><div class="kw-pills">${parseKeywords(t.keywords)}</div></div>`:''}
      <div class="task-section"><div class="task-section-lbl">📊 Registro de Acerto</div>
        <div style="background:#111114;border:1px solid #3f3f46;border-radius:8px;padding:14px">
          <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:10px;align-items:end;margin-bottom:12px">
            <div class="fg" style="margin:0">
              <label style="font-size:10px;color:#a1a1aa;font-weight:600;display:block;margin-bottom:4px">TOTAL DE QUESTÕES</label>
              <input type="number" id="qr-${t.id}" value="${t.qRespondidas||''}" min="0" placeholder="Ex: 30"
                style="width:100%;padding:8px 10px;background:#18181b;border:1px solid #3f3f46;color:#f4f4f5;border-radius:6px;font-size:14px"
                oninput="calcPctAcerto('${t.id}')">
            </div>
            <div class="fg" style="margin:0">
              <label style="font-size:10px;color:#a1a1aa;font-weight:600;display:block;margin-bottom:4px">ACERTOS</label>
              <input type="number" id="qa-${t.id}" value="${t.qAcertos||''}" min="0" placeholder="Ex: 21"
                style="width:100%;padding:8px 10px;background:#18181b;border:1px solid #3f3f46;color:#f4f4f5;border-radius:6px;font-size:14px"
                oninput="calcPctAcerto('${t.id}')">
            </div>
            <div style="text-align:center;padding:8px 12px;background:#18181b;border:1px solid #3f3f46;border-radius:6px;min-width:70px">
              <div id="qpct-${t.id}" style="font-size:22px;font-weight:700;font-family:monospace;color:${(t.pctAcerto||0)>=70?'#22c55e':(t.pctAcerto||0)>=60?'#eab308':'#ef4444'}">${t.pctAcerto!=null?t.pctAcerto+'%':'—'}</div>
              <div style="font-size:9px;color:#71717a;margin-top:2px">ACERTO</div>
            </div>
          </div>
          <div id="rev-preview-${t.id}" style="font-size:11px;color:#a1a1aa;margin-bottom:10px;padding:6px 10px;background:#18181b;border-radius:6px;display:${t.pctAcerto!=null?'block':'none'}">${t.pctAcerto!=null?'⏰ Próxima revisão: '+(t.pctAcerto<(S.config.revisao?.limiteUrgente||60)?'<strong style=color:#ef4444>'+(S.config.revisao?.diasUrgente||2)+' dias (urgente)</strong>':t.pctAcerto<(S.config.revisao?.limiteMedio||75)?'<strong style=color:#eab308>'+(S.config.revisao?.diasMedio||7)+' dias</strong>':'<strong style=color:#22c55e>'+(S.config.revisao?.diasBom||14)+' dias</strong>'):''}</div>
          <button class="btn btn-p" style="width:100%;padding:9px;font-size:12px;font-weight:600" onclick="salvarAcerto('${t.discId}','${t.aulaId}','${t.id}')">💾 Salvar Resultado</button>
        </div>
      </div>
    </div>`:''}
  </div>`;
}
window.toggleTaskDetail = function(id) {
  const el=document.getElementById('td-'+id); if (!el) return;
  el.classList.toggle('open');
  const btn=el.closest('.task-card')?.querySelector('.detail-btn');
  if (btn) btn.textContent=el.classList.contains('open')?'▾ fechar':'▸ detalhes';
};

// ============================================================
// TAB: HOJE
// ============================================================
function renderHoje() {
  // ── Stats globais ──
  var allT  = allTarefas();
  var done  = allT.filter(function(t){return t.status==='concluida';});
  var allP  = pendingTarefas();
  var pct   = allT.length ? Math.round(done.length/allT.length*100) : 0;
  var todayDow  = new Date().getDay();
  var horasHoje = (S.config.horasSemana||[])[todayDow]||0;

  var sg = document.getElementById('statsGrid');
  if (sg) sg.innerHTML =
    '<div class="sc"><span class="sv" style="color:var(--gr)">' + pct + '%</span><span class="sl">Concluído</span></div>' +
    '<div class="sc"><span class="sv">' + done.length + '</span><span class="sl">Feitas</span></div>' +
    '<div class="sc"><span class="sv" style="color:var(--acc)">' + allP.length + '</span><span class="sl">Pendentes</span></div>' +
    '<div class="sc"><span class="sv">' + horasHoje + 'h</span><span class="sl">Horas Hoje</span></div>';

  // ── Revisões Pendentes ──
  try {
    document.querySelectorAll('.rev-pend-section').forEach(function(el){el.remove();});
    var revPend = getRevisoesPendentes();
    var hojeBarEl = document.getElementById('hojeBar');
    if (revPend.length > 0 && hojeBarEl && hojeBarEl.parentNode) {
      var revCard = document.createElement('div');
      revCard.className = 'card rev-pend-section'; revCard.style.marginBottom='14px';
      var rh = '<div class="ct" style="color:#eab308">⏰ Revisões Pendentes (' + revPend.length + ')</div>';
      revPend.forEach(function(t) {
        var d = Math.floor((Date.now()-new Date(t.proximaRevisaoEm))/864e5);
        var borCor=(t.pctAcerto||0)<60?'#ef4444':(t.pctAcerto||0)<75?'#eab308':'#22c55e';
        rh+='<div class="rev-item" style="border-left-color:'+borCor+'"><div>';
        rh+='<div style="display:flex;align-items:center;gap:6px;margin-bottom:3px"><span class="aula-badge">'+(t.aulaCod||'A?')+'</span>';
        rh+='<span style="font-size:12px;font-weight:500;color:#fafafa">'+(t.topico||'—')+'</span></div>';
        rh+='<div style="font-size:10px;color:#52525b"><span style="color:'+(t.discCor||'#f5a623')+'">● '+(t.discNome||'?')+'</span>';
        rh+=' · Acerto: <span style="color:'+((t.pctAcerto||0)>=70?'#22c55e':'#ef4444')+'">'+(t.pctAcerto||0)+'%</span>';
        rh+=' · '+(d<=0?'hoje':'há '+d+' dia(s)')+'</div></div>';
        rh+='<button class="btn btn-g" style="padding:4px 10px;font-size:11px;flex-shrink:0" ';
        rh+='onclick="marcarRevisao('+JSON.stringify(t.discId)+','+JSON.stringify(t.aulaId)+','+JSON.stringify(t.id)+')">✔ Revisado</button></div>';
      });
      revCard.innerHTML = rh;
      hojeBarEl.parentNode.insertBefore(revCard, hojeBarEl);
    }
  } catch(eRev){ console.warn('[renderHoje] revisões:',eRev); }

  // ── Plano semanal vertical ──
  var hojeBar  = document.getElementById('hojeBar');
  var hojeList = document.getElementById('hojeList');
  if (!hojeBar || !hojeList) return;

  var plan    = buildWeekPlan();
  var HS_IDX  = [1,2,3,4,5,6,0];
  var hojeIdx = HS_IDX.indexOf(todayDow);
  if (hojeIdx < 0) hojeIdx = 0;

  // Barra de progresso do dia
  var hojeDay    = plan[hojeIdx] || { tasks:[], horas:0 };
  var todayTasks = hojeDay.tasks || [];
  var allocMins  = todayTasks.reduce(function(s,t){return s+(t.duracaoMin||0);},0);
  var livresMins = Math.max(0, horasHoje*60 - allocMins);
  var barPct     = horasHoje>0 ? Math.min(100,Math.round(allocMins/(horasHoje*60)*100)) : 0;
  var doneHoje   = todayTasks.filter(function(t){return t.status==='concluida';}).length;

  hojeBar.innerHTML = horasHoje > 0
    ? '<div class="hoje-bar-wrap"><div class="hoje-bar-labels">'
        + '<span style="font-size:11px;color:var(--tx3)">' + fmtMin(allocMins) + ' alocados · ' + doneHoje + '/' + todayTasks.length + ' concluídas</span>'
        + '<span style="font-size:11px;color:var(--tx3)">' + fmtMin(livresMins) + ' livres</span>'
      + '</div><div class="hoje-bar-track"><div class="hoje-bar-fill" style="width:' + barPct + '%"></div></div></div>'
    : '';

  // Monta semana a partir de hoje
  var today = new Date();
  var html  = '';
  for (var i=0; i<plan.length; i++) {
    var day    = plan[(hojeIdx + i) % plan.length];
    var isHoje = (i === 0);
    var dayDate = new Date(today); dayDate.setDate(today.getDate() + i);
    var dateStr = dayDate.getDate() + '/' + (dayDate.getMonth()+1);
    var secColor = isHoje ? 'var(--acc)' : 'var(--tx3)';

    html += '<div style="margin-bottom:' + (isHoje?'24':'18') + 'px">';
    // Cabeçalho do dia
    if (isHoje) {
      html += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;padding:10px 14px;background:rgba(245,166,35,.15);border:1px solid rgba(245,166,35,.3);border-radius:8px">';
      html += '<span style="font-size:13px;font-weight:700;color:#f5a623">📌 Hoje</span>';
      html += '<span style="font-size:13px;font-weight:600;color:#e4e4e7">' + dateStr + '</span>';
      html += '<span style="font-size:12px;color:#a1a1aa;margin-left:auto">' + day.horas + 'h programadas</span>';
      html += '</div>';
    } else {
      html += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;padding:8px 12px;background:#18181b;border:1px solid #3f3f46;border-radius:8px">';
      html += '<span style="font-size:12px;font-weight:700;color:#d4d4d8">📅 ' + day.nome + '</span>';
      html += '<span style="font-size:12px;color:#a1a1aa">' + dateStr + '</span>';
      html += '<span style="font-size:11px;color:#71717a;margin-left:auto">' + (day.horas > 0 ? day.horas + 'h' : 'folga') + '</span>';
      html += '</div>';
    }

    if (day.horas === 0) {
      html += '<div style="padding:12px 16px;text-align:center;color:#71717a;font-size:13px;background:#111114;border-radius:6px;margin-bottom:4px">🛌 Dia de descanso</div>';
    } else if (!day.tasks || day.tasks.length === 0) {
      html += '<div style="padding:10px 14px;color:#a1a1aa;font-size:12px;background:#111114;border-radius:6px;margin-bottom:4px">— Sem tarefas pendentes para este dia</div>';
    } else if (isHoje) {
      // Cards completos com detalhes para hoje
      for (var j=0; j<day.tasks.length; j++) { html += renderTaskCard(day.tasks[j], j); }
    } else {
      // Cards compactos para outros dias
      for (var j=0; j<day.tasks.length; j++) {
        var t = day.tasks[j];
        var ti = TYPES[t.type] || TYPES.TEORIA;
        var dis = null;
        var ds = S.disciplinas||[]; for(var k=0;k<ds.length;k++){if(ds[k].id===t.discId){dis=ds[k];break;}}
        var cor = (dis && dis.cor) ? dis.cor : 'var(--acc)';
        html += '<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:#1c1c1f;border:1px solid #3f3f46;border-left:3px solid '+cor+';border-radius:6px;margin-bottom:6px">';
        html += '<span style="background:rgba(245,166,35,.18);color:#f5a623;font-size:9px;font-weight:700;padding:2px 6px;border-radius:4px;white-space:nowrap">'+(t.aulaCod||'A?')+'</span>';
        html += '<span style="font-size:9px;font-weight:600;color:'+ti.cor+';white-space:nowrap">'+ti.label+'</span>';
        html += '<span style="font-size:12px;color:#e4e4e7;flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-weight:500">'+(t.topico||'—')+'</span>';
        html += '<span style="font-size:10px;color:#a1a1aa;flex-shrink:0;white-space:nowrap">⏱ '+(t.duracaoMin||0)+'min</span>';
        html += '</div>';
      }
    }
    html += '</div>';
  }

  hojeList.innerHTML = html || '<div style="text-align:center;padding:28px;color:var(--tx3)">📚 Configure a agenda em Planejamento → Trilha.</div>';
}

window.toggleTarefa = function(discId,aulaId,tarefaId) {
  const d=(S.disciplinas||[]).find(x=>x.id===discId); if (!d) return;
  const aula=(d.aulas||[]).find(a=>a.id===aulaId); if (!aula) return;
  const tarefa=(aula.tarefas||[]).find(t=>t.id===tarefaId); if (!tarefa) return;

  const wasDone = tarefa.status === 'concluida';
  tarefa.status = wasDone ? 'pendente' : 'concluida';

  if (tarefa.status === 'concluida') {
    tarefa.concluidaEm = new Date().toISOString();
    // Se o card estiver aberto e os campos de acerto preenchidos, salvar junto
    const qrEl = document.getElementById('qr-'+tarefaId);
    const qaEl = document.getElementById('qa-'+tarefaId);
    if (qrEl && qaEl) {
      const qR = parseInt(qrEl.value)||0;
      const qA = Math.min(parseInt(qaEl.value)||0, qR);
      if (qR > 0) {
        tarefa.qRespondidas = qR; tarefa.qAcertos = qA;
        tarefa.pctAcerto    = Math.round(qA/qR*100);
        const rv   = S.config?.revisao||{limiteUrgente:60,limiteMedio:75,diasUrgente:2,diasMedio:7,diasBom:14};
        const dias = tarefa.pctAcerto<rv.limiteUrgente?rv.diasUrgente:tarefa.pctAcerto<rv.limiteMedio?rv.diasMedio:rv.diasBom;
        tarefa.proximaRevisaoEm = new Date(Date.now()+dias*864e5).toISOString();
        const emoji = tarefa.pctAcerto<rv.limiteUrgente?'🔴':tarefa.pctAcerto<rv.limiteMedio?'🟡':'🟢';
        showToast('Concluída · '+tarefa.pctAcerto+'% · revisão em '+dias+'d '+emoji);
      } else {
        showToast('Tarefa concluída! ✅');
      }
    } else {
      showToast('Tarefa concluída! ✅');
    }
  } else {
    delete tarefa.concluidaEm; delete tarefa.proximaRevisaoEm;
    showToast('Tarefa reaberta.');
  }
  saveState(); renderHoje();
  if (document.getElementById('tab-historico')?.classList.contains('active')) renderHistorico();
  if (document.getElementById('tab-progresso')?.classList.contains('active'))  renderProgresso();
};

window.calcPctAcerto = function(tarefaId) {
  const qR=parseInt(document.getElementById('qr-'+tarefaId)?.value)||0;
  const qA=parseInt(document.getElementById('qa-'+tarefaId)?.value)||0;
  const pct=qR>0?Math.round(qA/qR*100):0;
  const el=document.getElementById('qpct-'+tarefaId);
  if (el){ el.textContent=qR>0?pct+'%':'—'; el.style.color=pct>=70?'var(--gr)':'var(--re)'; }
};
window.salvarAcerto = function(discId,aulaId,tarefaId) {
  const d=(S.disciplinas||[]).find(x=>x.id===discId);
  const aula=(d?.aulas||[]).find(a=>a.id===aulaId);
  const tarefa=(aula?.tarefas||[]).find(t=>t.id===tarefaId); if (!tarefa) return;
  const qR=parseInt(document.getElementById('qr-'+tarefaId)?.value)||0;
  const qA=parseInt(document.getElementById('qa-'+tarefaId)?.value)||0;
  if (qA>qR){ showToast('Acertos não pode ser maior que o total de questões.','error'); return; }
  tarefa.qRespondidas=qR; tarefa.qAcertos=qA;
  tarefa.pctAcerto=qR>0?Math.round(qA/qR*100):0;

  // Agenda revisão automática usando configurações do usuário
  const pct = tarefa.pctAcerto;
  const rv  = S.config.revisao || { limiteUrgente:60, limiteMedio:75, diasUrgente:2, diasMedio:7, diasBom:14 };
  const dias = pct < rv.limiteUrgente ? rv.diasUrgente : pct < rv.limiteMedio ? rv.diasMedio : rv.diasBom;
  tarefa.proximaRevisaoEm = new Date(Date.now() + dias * 864e5).toISOString();
  tarefa.revisaoAulaRef   = aula.codigo || '';
  tarefa.revisaoDiscNome  = d.nome || '';

  const emoji = pct < rv.limiteUrgente ? '🔴' : pct < rv.limiteMedio ? '🟡' : '🟢';
  const label = `${emoji} ${dias} dias`;
  saveState();
  showToast(`${qA}/${qR} · ${pct}% salvo — revisão agendada: ${label}`);
  renderHoje();
};

window.marcarRevisao = function(discId,aulaId,tarefaId) {
  const d=(S.disciplinas||[]).find(x=>x.id===discId);
  const aula=(d?.aulas||[]).find(a=>a.id===aulaId);
  const tarefa=(aula?.tarefas||[]).find(t=>t.id===tarefaId); if (!tarefa) return;
  delete tarefa.proximaRevisaoEm;
  delete tarefa.revisaoAulaRef;
  delete tarefa.revisaoDiscNome;
  saveState(); renderHoje(); showToast('Revisão concluída ✅');
};

// Retorna disciplinas do concurso ativo
function activeDiscs() {
  return (S.disciplinas||[]).filter(d => d.concursoId === S.concursoAtivo);
}

// Retorna tarefas de Questões com revisão vencida ou no prazo hoje
function getRevisoesPendentes() {
  const now = new Date();
  return allTarefas().filter(t =>
    t.proximaRevisaoEm &&
    new Date(t.proximaRevisaoEm) <= now
  ).sort((a,b) => new Date(a.proximaRevisaoEm) - new Date(b.proximaRevisaoEm));
}

// ============================================================
// TAB: SEMANA
// ============================================================
function buildWeekPlan() {
  const today   = new Date();
  const todayDow = today.getDay(); // 0=Dom…6=Sáb
  // Segunda desta semana
  const monday  = new Date(today);
  monday.setDate(today.getDate() - (todayDow === 0 ? 6 : todayDow - 1));
  monday.setHours(0,0,0,0);

  // Ordem Seg→Dom. horasSemana indexado [0=Dom,1=Seg…6=Sáb]
  const HS_IDX  = [1,2,3,4,5,6,0];   // índices em horasSemana
  const NOMES   = ['Seg','Ter','Qua','Qui','Sex','Sáb','Dom'];
  const hs      = S.config.horasSemana || [0,4,4,4,4,4,2];

  // Filas com TODAS as tarefas pendentes em ordem, filtradas por discsSelecionadas
  const sel = S.config?.discsSelecionadas; // null = todas
  const queues = activeDiscs()
    .filter(d => !sel || sel.includes(d.id))
    .map(d=>{
      const tasks = getPendingForDisc(d.id);
      return tasks.length ? { tasks:[...tasks] } : null;
    }).filter(Boolean);

  return HS_IDX.map((hsIdx, i) => {
    const date = new Date(monday);
    date.setDate(monday.getDate() + i);
    const horas = hs[hsIdx] || 0;
    const tasks = [];

    if (horas > 0 && queues.length) {
      let budget = horas * 60, rounds = 0;
      while (budget > 0 && rounds < 100) {
        rounds++; let added = false;
        for (const q of queues) {
          if (!q.tasks.length || budget <= 0) continue;
          const t = q.tasks[0];
          if (t.duracaoMin <= budget + 15) {
            q.tasks.shift(); tasks.push(t); budget -= t.duracaoMin; added = true;
          }
        }
        if (!added) break;
      }
    }

    return {
      nome:    NOMES[i],
      dia:     date.getDate(),
      mes:     date.getMonth() + 1,
      isHoje:  date.toDateString() === today.toDateString(),
      isPast:  date < new Date(today.getFullYear(), today.getMonth(), today.getDate()),
      horas,
      tasks
    };
  });
}

function renderSemana() {
  const headerEl  = document.getElementById('semanaViewHeader');
  const contentEl = document.getElementById('semanaViewContent');
  if (!headerEl || !contentEl) {
    console.error('[Semana] Elementos não encontrados no DOM');
    return;
  }

  var plan;
  try {
    plan = buildWeekPlan();
    console.log('[Semana] plan gerado:', plan.length, 'dias, tarefas:', plan.reduce(function(s,d){return s+d.tasks.length;},0));
  } catch(e) {
    console.error('[Semana] Erro no buildWeekPlan:', e);
    contentEl.innerHTML = '<div style="padding:20px;color:#ef4444">Erro ao gerar semana: ' + e.message + '</div>';
    return;
  }

  var totalTarefas = plan.reduce(function(s,d){return s+d.tasks.length;},0);
  var totalMins    = plan.reduce(function(s,d){return s+d.tasks.reduce(function(x,t){return x+(t.duracaoMin||0);},0);},0);
  var totalHoras   = plan.reduce(function(s,d){return s+d.horas;},0);

  headerEl.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;padding:4px 0 12px 0">'
    + '<span style="font-size:12px;color:#a1a1aa">' + totalTarefas + ' tarefa(s) · ' + fmtMin(totalMins) + ' · ' + totalHoras + 'h/semana</span>'
    + '<button class="btn btn-g" style="font-size:11px" onclick="irParaTrilha()">⚙️ Editar horas</button>'
    + '</div>';

  var html = '<div style="display:flex;gap:8px;overflow-x:auto;padding-bottom:12px">';
  for (var i=0; i<plan.length; i++) {
    var day = plan[i];
    var borderCor = day.isHoje ? '#f5a623' : '#27272a';
    var numCor    = day.isHoje ? '#f5a623' : '#fafafa';
    html += '<div style="min-width:140px;flex:1;background:#111114;border:1px solid ' + borderCor + ';border-radius:8px;overflow:hidden">';
    // Cabeçalho
    html += '<div style="padding:10px;text-align:center;background:#18181b;border-bottom:1px solid #27272a">';
    html += '<div style="font-size:10px;font-weight:700;color:#52525b;text-transform:uppercase;margin-bottom:2px">' + day.nome + '</div>';
    html += '<div style="font-size:22px;font-weight:700;font-family:monospace;color:' + numCor + ';line-height:1;margin-bottom:2px">' + day.dia + '</div>';
    html += '<div style="font-size:10px;color:#52525b">' + (day.horas > 0 ? day.horas+'h' : 'folga') + '</div>';
    html += '</div>';
    // Corpo
    html += '<div style="padding:8px;display:flex;flex-direction:column;gap:5px;min-height:80px">';
    if (day.horas === 0) {
      html += '<div style="text-align:center;padding:16px 0;font-size:18px">🛌</div>';
    } else if (day.tasks.length === 0) {
      html += '<div style="text-align:center;padding:12px 0;font-size:11px;color:#52525b">sem tarefas</div>';
    } else {
      for (var j=0; j<day.tasks.length; j++) {
        var t    = day.tasks[j];
        var ti   = TYPES[t.type] || TYPES.TEORIA;
        var disc = null;
        var discs = S.disciplinas || [];
        for (var k=0; k<discs.length; k++) { if (discs[k].id===t.discId){disc=discs[k];break;} }
        var cor  = (disc && disc.cor) ? disc.cor : '#f5a623';
        html += '<div style="background:#18181b;border:1px solid #27272a;border-left:3px solid ' + cor + ';border-radius:6px;padding:7px 8px">';
        html += '<div style="display:flex;align-items:center;gap:4px;margin-bottom:3px">';
        html += '<span style="background:rgba(245,166,35,.18);color:#f5a623;font-size:9px;font-weight:700;padding:1px 5px;border-radius:4px">' + (t.aulaCod||'A?') + '</span>';
        html += '<span style="font-size:9px;color:' + ti.cor + '">' + ti.label + '</span>';
        html += '</div>';
        html += '<div style="font-size:11px;font-weight:500;color:#fafafa;line-height:1.35;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;margin-bottom:2px">' + (t.topico||'—') + '</div>';
        html += '<div style="font-size:10px;color:#52525b">⏱ ' + (t.duracaoMin||0) + 'min</div>';
        html += '</div>';
      }
    }
    html += '</div></div>';
  }
  html += '</div>';
  contentEl.innerHTML = html;
  console.log('[Semana] renderizado com sucesso');
}

// ============================================================
// TAB: HISTÓRICO
// ============================================================
function renderHistorico() {
  const container=document.getElementById('historicoContent'); if (!container) return;
  const done=allTarefas().filter(t=>t.status==='concluida');
  if (!done.length){ container.innerHTML=`<div class="empty-state"><div class="empty-state-icon">✅</div><div class="empty-state-title">Nenhuma tarefa concluída ainda</div><div class="empty-state-sub">Conclua tarefas na aba Hoje.</div></div>`; return; }
  const grouped={};
  done.forEach(t=>{ if (!grouped[t.discId]) grouped[t.discId]={nome:t.discNome,cor:t.discCor,tasks:[]}; grouped[t.discId].tasks.push(t); });
  let html=`<div style="font-size:12px;color:var(--tx3);margin-bottom:14px">${done.length} tarefa(s) concluída(s)</div>`;
  Object.values(grouped).forEach(g=>{
    html+=`<div class="card"><div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><div style="width:10px;height:10px;border-radius:50%;background:${g.cor}"></div><span style="font-size:14px;font-weight:600;color:var(--tx)">${g.nome}</span><span class="disc-badge">${g.tasks.length} concluída(s)</span></div>
      ${g.tasks.map(t=>`<div class="hist-task-row"><div class="hist-task-info"><div style="display:flex;align-items:center;gap:6px;margin-bottom:2px"><span class="aula-badge">${t.aulaCod}</span><span class="hist-task-title">${t.topico}</span></div>
        <div class="hist-task-meta">${TYPES[t.type]?.label||t.type} · ${t.duracaoMin}min${t.pctAcerto!=null?` · <span style="color:${t.pctAcerto>=70?'var(--gr)':'var(--re)'}">⚡ ${t.qAcertos||0}/${t.qRespondidas||0} (${t.pctAcerto}%)</span>`:''}</div></div>
        <button class="btn btn-g" style="padding:4px 10px;font-size:11px;flex-shrink:0" onclick="toggleTarefa('${t.discId}','${t.aulaId}','${t.id}')">↩ Desfazer</button>
      </div>`).join('')}</div>`;
  });
  container.innerHTML=html;
}

// ============================================================
// TAB: ANÁLISE DE DESEMPENHO
// ============================================================
window.renderQuestoes = function() {
  const container=document.getElementById('questoesContent'); if (!container) return;
  if (!(S.questoes_history||[]).length){ container.innerHTML=`<div class="empty-state"><div class="empty-state-icon">📊</div><div class="empty-state-title">Nenhum dado importado ainda</div><div class="empty-state-sub">Importe estatísticas do TecConcursos.</div><button class="btn btn-p" onclick="irParaImport('xlsx')">📂 Importar</button></div>`; return; }
  const now=new Date();
  let hist=(S.questoes_history||[]).filter(h=>{ if (qPeriod==='all') return true; return Math.abs(now-new Date(h.importadoEm))/(864e5)<=parseInt(qPeriod); });
  hist.sort((a,b)=>new Date(a.importadoEm)-new Date(b.importadoEm));
  if (!hist.length){ container.innerHTML=`<div class="empty-state"><div class="empty-state-sub">Sem dados no período.</div></div>`; return; }
  const latest=hist[hist.length-1];
  const discFilt=qDiscSel!=='all'?(S.disciplinas||[]).find(d=>d.id===qDiscSel):null;
  const discNomeFilt=discFilt?.nome||null;
  const getBelt=acc=>acc>=85?'<span class="belt-badge belt-black">Faixa Preta</span>':acc>=75?'<span class="belt-badge belt-blue">Faixa Azul</span>':'<span class="belt-badge belt-white">Faixa Branca</span>';
  let acertoD,totalD,diffStr,diffCls;
  if (discNomeFilt){ const ld=(latest.disciplinas||[]).find(d=>d.nome.toLowerCase()===discNomeFilt.toLowerCase()); const cfg=(S.disciplinas||[]).find(d=>d.nome.toLowerCase()===discNomeFilt.toLowerCase()); acertoD=ld?ld.pctAcerto+'%':'—'; totalD=ld?ld.qResolvidas:'—'; const diff=ld?(ld.pctAcerto-(cfg?.metaAcerto||80)).toFixed(1):0; diffCls=diff>=0?'vs-up':'vs-down'; diffStr=`${diff>=0?'▲':'▼'} ${Math.abs(diff)}% vs meta`; }
  else { const diff=(latest.pctGeral-MOCK_GLOBAL.avgAcerto).toFixed(1); acertoD=latest.pctGeral+'%'; totalD=latest.total; diffCls=diff>=0?'vs-up':'vs-down'; diffStr=`${diff>=0?'▲':'▼'} ${Math.abs(diff)}% vs média`; }
  let html=`<div class="bench-grid">
    <div class="bench-card"><div class="bench-title">${discNomeFilt||'Acerto Global'}</div><div class="bench-val">${acertoD}</div><div class="bench-vs ${diffCls}">${diffStr}</div></div>
    <div class="bench-card"><div class="bench-title">Nível</div><div style="margin-top:8px">${getBelt(parseFloat(acertoD)||0)}</div><div class="bench-vs vs-flat" style="margin-top:12px;color:var(--tx3)">Amostra: ${totalD} questões</div></div>
  </div><div class="chart-container" style="height:260px;margin-bottom:20px"><canvas id="qChartAdvanced"></canvas></div>`;
  let criticas=[];
  (discNomeFilt?(latest.disciplinas||[]).filter(d=>d.nome.toLowerCase()===discNomeFilt.toLowerCase()):(latest.disciplinas||[])).forEach(d=>{ const cfg=(S.disciplinas||[]).find(x=>x.nome.toLowerCase()===d.nome.toLowerCase()); const meta=cfg?.metaAcerto||80; (d.topicos||[]).forEach(t=>{ if (t.qResolvidas>=10&&t.pctAcerto<meta){ const temR=cfg?getPendingForDisc(cfg.id).some(p=>['QUESTOES','REVISAO'].includes(p.type)):false; criticas.push({disc:d.nome,topico:t.nome,acerto:t.pctAcerto,meta,temR}); } }); });
  if (criticas.length){ criticas.sort((a,b)=>a.acerto-b.acerto); html+=`<div class="card"><div class="ct" style="color:var(--re)">⚠️ UTI / Revisão Crítica</div><div class="rev-list">${criticas.slice(0,10).map(r=>`<div class="rev-item"><div><div class="rev-topic">${r.topico}${r.temR?'<span class="tag-reforco" style="margin-left:6px">⚠️ REFORÇO</span>':''}</div><div class="rev-disc">${r.disc}</div></div><div class="rev-metrics"><div class="rev-metric-box"><span class="rev-metric-lbl">Acerto</span><span class="rev-metric-val val-danger">${Math.round(r.acerto)}%</span></div><div class="rev-metric-box"><span class="rev-metric-lbl">Meta</span><span class="rev-metric-val" style="color:var(--tx2)">${r.meta}%</span></div></div></div>`).join('')}</div></div>`; }
  // ── Lista de imports gerenciáveis ──────────────────────────
  const histAll = (S.questoes_history||[]).slice().reverse();
  if (histAll.length) {
    html += '<div class="card" style="margin-top:16px">';
    html += '<div class="ct">📂 Importações Salvas (' + histAll.length + ')</div>';
    html += '<div style="display:flex;flex-direction:column;gap:6px">';
    histAll.forEach(function(h, idx) {
      var corH = h.pctGeral>=70?'#22c55e':h.pctGeral>=60?'#eab308':'#ef4444';
      // Usar idx como chave — sem problema de aspas
      html += '<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:#1c1c1f;border:1px solid #3f3f46;border-radius:6px" data-imp-id="'+h.id+'">';
      // View
      html += '<div id="impv-'+idx+'" style="display:flex;align-items:center;gap:8px;flex:1;min-width:0">';
      html += '<span style="font-size:13px;font-weight:500;color:#f4f4f5;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+h.label+'</span>';
      html += '<span style="font-size:12px;color:'+corH+';font-weight:700;flex-shrink:0">'+h.pctGeral+'%</span>';
      html += '<span style="font-size:11px;color:#71717a;flex-shrink:0">'+h.total+' q</span>';
      html += '<button class="btn-icon" onclick="iniciarRenomearImport('+idx+')" title="Renomear">✏️</button>';
      html += '<button class="btn-icon" onclick="excluirImport('+idx+')" title="Excluir" style="color:#ef4444">🗑️</button>';
      html += '</div>';
      // Edit
      html += '<div id="impe-'+idx+'" style="display:none;align-items:center;gap:6px;flex:1">';
      html += '<input id="impn-'+idx+'" value="'+h.label.replace(/"/g,'&quot;')+'" style="flex:1;padding:5px 8px;background:#111114;border:1px solid #3f3f46;color:#f4f4f5;border-radius:5px;font-size:12px">';
      html += '<button class="btn btn-p" style="padding:4px 10px;font-size:11px" onclick="salvarRenomearImport('+idx+')">✔</button>';
      html += '<button class="btn btn-g" style="padding:4px 10px;font-size:11px" onclick="cancelarRenomearImport('+idx+')">✕</button>';
      html += '</div>';
      html += '</div>';
    });
    html += '</div></div>';
  }
  container.innerHTML=html;
  setTimeout(()=>{
    const ctx=document.getElementById('qChartAdvanced')?.getContext('2d'); if (!ctx) return;
    if (qChartInstance) qChartInstance.destroy();
    let cA,cV;
    if (discNomeFilt){ cA=hist.map(h=>{ const d=(h.disciplinas||[]).find(d=>d.nome.toLowerCase()===discNomeFilt.toLowerCase()); return d?d.pctAcerto:null; }); cV=hist.map(h=>{ const d=(h.disciplinas||[]).find(d=>d.nome.toLowerCase()===discNomeFilt.toLowerCase()); return d?d.qResolvidas:null; }); }
    else { cA=hist.map(h=>h.pctGeral); cV=hist.map(h=>h.total); }
    const cor=discFilt?.cor||'#f5a623';
    qChartInstance=new Chart(ctx,{type:'line',data:{labels:hist.map(h=>h.label||new Date(h.importadoEm).toLocaleDateString('pt-BR')),datasets:[{label:'% Acerto',data:cA,borderColor:cor,backgroundColor:cor+'1a',borderWidth:3,fill:true,tension:0.3,yAxisID:'y',spanGaps:true},{label:'Volume',type:'bar',data:cV,backgroundColor:'rgba(59,130,246,0.15)',borderRadius:4,yAxisID:'y1'}]},options:{responsive:true,maintainAspectRatio:false,scales:{y:{type:'linear',position:'left',min:0,max:100,grid:{color:'#27272a'}},y1:{type:'linear',position:'right',beginAtZero:true,grid:{drawOnChartArea:false}}}}});
  },100);
};

// ============================================================
// TAB: PROGRESSO & PREVISÃO
// ============================================================
function renderProgresso() {
  const container=document.getElementById('progressoContent'); if (!container) return;
  const allT=allTarefas(), done=allT.filter(t=>t.status==='concluida'), pend=allT.filter(t=>t.status==='pendente');
  const pct=allT.length?Math.round(done.length/allT.length*100):0;
  const pendMins=pend.reduce((s,t)=>s+(t.duracaoMin||60),0);
  const semAtual=Math.round((S.config.horasSemana||[]).reduce((a,b)=>a+b,0));
  const discProg=(S.disciplinas||[]).map(d=>{ const dAll=allTarefas().filter(t=>t.discId===d.id), dDone=dAll.filter(t=>t.status==='concluida'); return {disc:d,total:dAll.length,done:dDone.length,pct:dAll.length?Math.round(dDone.length/dAll.length*100):0}; });
  const semanas=semAtual>0?Math.ceil(pendMins/(semAtual*60)):null;
  const eta=semanas?new Date(Date.now()+semanas*7*864e5):null;
  const etaStr=eta?eta.toLocaleDateString('pt-BR',{day:'2-digit',month:'long',year:'numeric'}):'—';
  container.innerHTML=`<div class="sh"><div class="stit">Progresso & Previsão</div></div>
  <div class="sg" style="grid-template-columns:repeat(4,1fr);margin-bottom:20px">
    <div class="sc"><span class="sv" style="color:var(--gr)">${pct}%</span><span class="sl">Concluído</span></div>
    <div class="sc"><span class="sv">${done.length}</span><span class="sl">Feitas</span></div>
    <div class="sc"><span class="sv" style="color:var(--acc)">${pend.length}</span><span class="sl">Pendentes</span></div>
    <div class="sc"><span class="sv">${fmtMin(pendMins)}</span><span class="sl">Horas Restantes</span></div>
  </div>
  <div class="card">
    <div class="ct">🎯 Previsão de Conclusão</div>
    <div style="margin-bottom:16px">${semanas?`<div style="font-size:22px;font-weight:700;color:var(--acc);font-family:monospace">${etaStr}</div><div style="font-size:11px;color:var(--tx3);margin-top:3px">${semanas} semanas com ${semAtual}h/semana</div>`:`<div style="color:var(--tx3)">Configure a agenda na Trilha para ver a previsão.</div>`}</div>
    <div class="ct">⚡ Simulador</div>
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <input type="number" id="simHoras" value="${semAtual}" min="1" max="120" style="width:80px;text-align:center;font-size:20px;font-weight:700;font-family:monospace;padding:8px" oninput="simularProgresso()">
      <span style="font-size:13px;color:var(--tx2)">horas / semana</span>
    </div>
    <div id="simResult" style="margin-top:10px"></div>
  </div>
  <div class="card">
    <div class="ct">📚 Progresso por Disciplina</div>
    ${discProg.map(d=>`<div class="disc-prog-row">
      <div class="disc-prog-header">
        <div style="display:flex;align-items:center;gap:8px">
          <div style="width:8px;height:8px;border-radius:50%;background:${d.disc.cor}"></div>
          <span style="font-size:13px;color:var(--tx)">${d.disc.nome}</span>
          ${d.disc.nivelConhecimento?`<span class="nivel-badge nivel-${d.disc.nivelConhecimento}">${NIVEL_LABEL[d.disc.nivelConhecimento]}</span>`:''}
        </div>
        <span style="font-size:11px;color:var(--tx3);font-family:monospace">${d.done}/${d.total} · ${d.pct}%</span>
      </div>
      <div class="disc-prog-bar-track"><div class="disc-prog-bar-fill" style="width:${d.pct}%;background:${d.disc.cor}"></div></div>
      <div class="disc-aula-dots">${sortedAulas(d.disc.aulas).map(a=>{ const aD=(a.tarefas||[]).filter(t=>t.status==='concluida').length, aT=(a.tarefas||[]).length; const ap=aT>0?aD/aT:0; const col=ap===1?'var(--gr)':ap>0?'var(--acc)':'var(--bd2)'; return `<div class="aula-dot" style="background:${col}" title="${a.codigo}: ${aD}/${aT}"></div>`; }).join('')}</div>
    </div>`).join('')}
  </div>`;
  simularProgresso();
}
window.simularProgresso = function() {
  const horas=parseFloat(document.getElementById('simHoras')?.value)||0;
  const pend=allTarefas().filter(t=>t.status==='pendente');
  const pendMins=pend.reduce((s,t)=>s+(t.duracaoMin||60),0);
  const semanas=horas>0?Math.ceil(pendMins/(horas*60)):null;
  const eta=semanas?new Date(Date.now()+semanas*7*864e5):null;
  const etaStr=eta?eta.toLocaleDateString('pt-BR',{day:'2-digit',month:'long',year:'numeric'}):'—';
  const semAtual=Math.round((S.config.horasSemana||[]).reduce((a,b)=>a+b,0));
  const diff=horas-semAtual, diffCor=diff>0?'var(--gr)':diff<0?'var(--re)':'var(--tx3)';
  const diffStr=diff>0?`+${diff}h a mais`:diff<0?`${diff}h a menos`:'mesmo ritmo';
  const res=document.getElementById('simResult'); if (!res) return;
  res.innerHTML=semanas?`<div class="sim-box"><div class="sim-result-val">${etaStr}</div><div style="font-size:11px;color:var(--tx3)">${semanas} semanas · <span style="color:${diffCor}">${diffStr}</span></div></div>`:
    `<div style="font-size:13px;color:var(--tx3);margin-top:8px">Insira as horas para simular.</div>`;
};

// ============================================================
// SELETOR DE DISCIPLINAS PARA META DA SEMANA
// ============================================================
function renderSelectorDiscs() {
  const el = document.getElementById('discSelectorBody'); if (!el) return;
  const discs = activeDiscs();
  const sel   = S.config.discsSelecionadas; // null = todas
  if (!discs.length) { el.innerHTML = '<div style="color:#a1a1aa;font-size:12px;padding:8px">Nenhuma disciplina cadastrada.</div>'; return; }

  var html = '<div style="display:flex;flex-direction:column;gap:6px;margin-top:10px">';
  discs.forEach(function(d) {
    var checked = !sel || sel.includes(d.id);
    html += '<label style="display:flex;align-items:center;gap:10px;padding:7px 10px;background:#111114;border:1px solid #3f3f46;border-radius:6px;cursor:pointer">';
    html += '<input type="checkbox" id="dsel-'+d.id+'" '+(checked?'checked':'')+' onchange="toggleDiscSel(\"'+d.id+'\")" style="width:14px;height:14px;accent-color:#f5a623">';
    html += '<span style="width:8px;height:8px;border-radius:50%;background:'+(d.cor||'#a1a1aa')+';display:inline-block;flex-shrink:0"></span>';
    html += '<span style="font-size:13px;color:#f4f4f5;flex:1">'+d.nome+'</span>';
    html += '<span style="font-size:11px;color:#71717a">'+(d.percentual||0)+'%</span>';
    html += '</label>';
  });
  html += '</div>';
  html += '<div style="display:flex;gap:8px;margin-top:10px">';
  html += '<button class="btn btn-g" style="font-size:11px" onclick="selecionarTodasDiscs(true)">Selecionar todas</button>';
  html += '<button class="btn btn-g" style="font-size:11px" onclick="selecionarTodasDiscs(false)">Desmarcar todas</button>';
  html += '</div>';
  el.innerHTML = html;
}
window.toggleDiscSel = function(id) {
  var discs = activeDiscs();
  var sel   = S.config.discsSelecionadas;
  if (!sel) sel = discs.map(function(d){ return d.id; }); // todas checadas → clonar
  var idx = sel.indexOf(id);
  if (idx > -1) sel.splice(idx, 1); else sel.push(id);
  // Se todas marcadas, usar null (mais simples)
  S.config.discsSelecionadas = sel.length === discs.length ? null : sel;
  saveState();
};
window.selecionarTodasDiscs = function(todas) {
  S.config.discsSelecionadas = todas ? null : [];
  saveState(); renderSelectorDiscs();
};
window.toggleDiscSelector = function() {
  var body = document.getElementById('discSelectorBody');
  var btn  = document.getElementById('discSelectorBtn');
  if (!body) return;
  var open = body.style.display !== 'none';
  body.style.display = open ? 'none' : 'block';
  btn.textContent = open ? '▸ expandir' : '▾ recolher';
  if (!open) renderSelectorDiscs();
};

// ============================================================
// CONFIGURAÇÕES DE REVISÃO
// ============================================================
function renderConfigRevisao() {
  const rv = S.config.revisao || { limiteUrgente:60, limiteMedio:75, diasUrgente:2, diasMedio:7, diasBom:14 };
  const el = document.getElementById('configRevisaoBody'); if (!el) return;
  el.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:10px">
      <div>
        <div style="font-size:10px;color:var(--re);font-weight:700;margin-bottom:6px">🔴 URGENTE</div>
        <div class="fg" style="margin-bottom:6px"><label>Acerto abaixo de (%)</label>
          <input type="number" id="rv-limUrgente" value="${rv.limiteUrgente}" min="1" max="99" style="width:100%"></div>
        <div class="fg"><label>Revisar em (dias)</label>
          <input type="number" id="rv-diasUrgente" value="${rv.diasUrgente}" min="1" max="30" style="width:100%"></div>
      </div>
      <div>
        <div style="font-size:10px;color:var(--yl);font-weight:700;margin-bottom:6px">🟡 MÉDIO</div>
        <div class="fg" style="margin-bottom:6px"><label>Acerto abaixo de (%)</label>
          <input type="number" id="rv-limMedio" value="${rv.limiteMedio}" min="1" max="100" style="width:100%"></div>
        <div class="fg"><label>Revisar em (dias)</label>
          <input type="number" id="rv-diasMedio" value="${rv.diasMedio}" min="1" max="60" style="width:100%"></div>
      </div>
      <div>
        <div style="font-size:10px;color:var(--gr);font-weight:700;margin-bottom:6px">🟢 BOM</div>
        <div class="fg" style="margin-bottom:6px"><label>Acerto ≥ Médio</label>
          <div style="padding:8px 10px;background:var(--s3);border-radius:6px;font-size:12px;color:var(--tx3)">automático</div></div>
        <div class="fg"><label>Revisar em (dias)</label>
          <input type="number" id="rv-diasBom" value="${rv.diasBom}" min="1" max="90" style="width:100%"></div>
      </div>
    </div>
    <div style="margin-top:12px;font-size:11px;color:var(--tx3)">
      Ex. atual: &lt;${rv.limiteUrgente}% → ${rv.diasUrgente}d · ${rv.limiteUrgente}–${rv.limiteMedio}% → ${rv.diasMedio}d · ≥${rv.limiteMedio}% → ${rv.diasBom}d
    </div>
    <div style="display:flex;gap:8px;margin-top:12px;justify-content:flex-end">
      <button class="btn btn-p" onclick="salvarConfigRevisao()">✔ Salvar</button>
    </div>`;
}

window.salvarConfigRevisao = function() {
  const lu = parseInt(document.getElementById('rv-limUrgente')?.value)||60;
  const lm = parseInt(document.getElementById('rv-limMedio')?.value)||75;
  const du = parseInt(document.getElementById('rv-diasUrgente')?.value)||2;
  const dm = parseInt(document.getElementById('rv-diasMedio')?.value)||7;
  const db_ = parseInt(document.getElementById('rv-diasBom')?.value)||14;
  if (lu >= lm){ showToast('Limiar urgente deve ser menor que o médio.','error'); return; }
  S.config.revisao = { limiteUrgente:lu, limiteMedio:lm, diasUrgente:du, diasMedio:dm, diasBom:db_ };
  saveState(); renderConfigRevisao();
  showToast('Configuração de revisão salva!');
};

window.toggleConfigRevisao = function() {
  const body = document.getElementById('configRevisaoBody');
  const btn  = document.getElementById('configRevisaoBtn');
  if (!body) return;
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : 'block';
  btn.textContent = open ? '▸ expandir' : '▾ recolher';
  if (!open) renderConfigRevisao();
};

// ============================================================
// PLANEJAMENTO — TRILHA
// ============================================================
function calcMeta(totalMins) {
  return (S.disciplinas||[]).map(d=>{ const stats=getLatestStatsForDisc(d.nome); let w=d.peso||10; if (stats){ if (stats.pctAcerto>=(d.metaAcerto||80)+5) w*=0.85; else if (stats.pctAcerto<(d.metaAcerto||80)-5) w*=1.25; } w*=(NIVEL_WEIGHT[d.nivelConhecimento||'nunca']||1.0); return {disc:d,rawW:d.peso,adjW:w,tasks:getPendingForDisc(d.id)}; })
    .map((d,_,arr)=>{ const tot=arr.reduce((s,x)=>s+x.adjW,0); d.alloc=tot>0?Math.round(totalMins*(d.adjW/tot)):0; return d; })
    .map(d=>{ let bud=d.alloc; d.selected=[]; for (let t of d.tasks){ if (bud<=0) break; if (t.duracaoMin<=bud+15){d.selected.push(t);bud-=t.duracaoMin;} } return d; });
}
window.renderAgendaGrid = function() {
  const hs=S.config.horasSemana||[0,4,4,4,4,4,2], dias=['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  const rv  = S.config.revisao || { limiteUrgente:60, limiteMedio:75, diasUrgente:2, diasMedio:7, diasBom:14 };
  const sel = S.config.discsSelecionadas;
  const discs = activeDiscs();
  const nSel  = sel ? sel.length : discs.length;
  document.getElementById('semanaGridContainer').innerHTML=`<div class="day-grid">${dias.map((d,i)=>`<div class="day-cell"><div class="day-nm">${d}</div><input type="number" class="day-hi" value="${hs[i]}" min="0" max="16" onchange="updateHoraDia(${i},this.value)"></div>`).join('')}</div>
  <div class="meta-label" style="text-align:right;margin-top:8px">Total Planejado: <strong id="totalSemanaGrid">${hs.reduce((a,b)=>a+b,0)}h</strong></div>
  <div class="card" style="margin-top:16px;background:var(--s2);border:1px solid var(--bd)">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div>
        <div class="ct" style="margin-bottom:2px">📚 Disciplinas desta semana</div>
        <div style="font-size:11px;color:var(--tx3)">${nSel} de ${discs.length} disciplina(s) selecionada(s)</div>
      </div>
      <button id="discSelectorBtn" class="btn btn-g" style="font-size:11px" onclick="toggleDiscSelector()">▸ expandir</button>
    </div>
    <div id="discSelectorBody" style="display:none"></div>
  </div>
  <div class="card" style="margin-top:12px;background:var(--s2);border:1px solid var(--bd)">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div>
        <div class="ct" style="margin-bottom:2px">🔁 Intervalos de Revisão</div>
        <div style="font-size:11px;color:var(--tx3)">
          🔴 &lt;${rv.limiteUrgente}% → ${rv.diasUrgente}d &nbsp;·&nbsp;
          🟡 &lt;${rv.limiteMedio}% → ${rv.diasMedio}d &nbsp;·&nbsp;
          🟢 ≥${rv.limiteMedio}% → ${rv.diasBom}d
        </div>
      </div>
      <button id="configRevisaoBtn" class="btn btn-g" style="font-size:11px" onclick="toggleConfigRevisao()">▸ expandir</button>
    </div>
    <div id="configRevisaoBody" style="display:none"></div>
  </div>`;
};
window.updateHoraDia = function(idx,val) { S.config.horasSemana[idx]=Math.min(16,Math.max(0,parseInt(val)||0)); saveState(); document.getElementById('totalSemanaGrid').textContent=S.config.horasSemana.reduce((a,b)=>a+b,0)+'h'; };
window.renderMeta = function() {
  const totalMins=(S.config.horasSemana||[]).reduce((a,b)=>a+b,0)*60;
  if (!totalMins){ document.getElementById('metaContent').innerHTML=`<div class="empty-state"><div class="empty-state-sub">Preencha as horas na grade acima.</div></div>`; return; }
  const data=calcMeta(totalMins);
  let html=`<div class="card" style="margin-top:20px"><div class="ct">Alocação Baseada em Desempenho</div>`;
  data.forEach(d=>{ if (!d.selected.length) return; const stats=getLatestStatsForDisc(d.disc.nome), acc=stats?stats.pctAcerto:'--'; const ind=d.adjW>d.rawW?'<span style="color:var(--re);font-size:10px">↑ CARGA EXTRA</span>':d.adjW<d.rawW?'<span style="color:var(--gr);font-size:10px">↓ MANUTENÇÃO</span>':''; const temR=d.selected.some(t=>isReforco(d.disc.id,t.type));
    html+=`<div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--bd);padding:8px 0"><div><div style="font-size:13px;color:var(--tx)">${d.disc.nome} ${ind}${temR?' <span class="tag-reforco">⚠️ REFORÇO</span>':''}</div><div style="font-size:10px;color:var(--tx3)">Acerto: ${acc}% · Meta: ${d.disc.metaAcerto||80}%${d.disc.nivelConhecimento?' · '+NIVEL_LABEL[d.disc.nivelConhecimento]:''}</div></div><div style="text-align:right"><div style="color:var(--acc);font-family:monospace;font-size:14px;font-weight:600">${fmtMin(d.alloc)}</div><div style="font-size:9px;color:var(--tx3)">${d.selected.length} tarefa(s)</div></div></div>`; });
  html+=`</div>`;
  const totPend=pendingTarefas().length, totAloc=data.reduce((s,d)=>s+d.selected.length,0), semEst=totAloc>0?Math.ceil(totPend/totAloc):'—';
  html+=`<div class="card" style="margin-top:12px"><div class="ct">🚀 Velocidade de Cruzeiro</div><div class="sg" style="grid-template-columns:repeat(3,1fr);margin-bottom:0"><div class="sc"><span class="sv">${totPend}</span><span class="sl">Pendentes</span></div><div class="sc"><span class="sv" style="color:var(--acc)">${totAloc}</span><span class="sl">Esta semana</span></div><div class="sc"><span class="sv" style="color:${typeof semEst==='number'&&semEst<=4?'var(--gr)':'var(--yl)'}">${semEst}</span><span class="sl">Semanas p/ fechar</span></div></div></div>`;
  document.getElementById('metaContent').innerHTML=html;
};
window.imprimirAgenda = function() {
  const hs=S.config.horasSemana||[], totalMins=hs.reduce((a,b)=>a+b,0)*60;
  if (!totalMins){ showToast('Preencha as horas antes de imprimir.','error'); return; }
  const daysFull=['Domingo','Segunda-feira','Terça-feira','Quarta-feira','Quinta-feira','Sexta-feira','Sábado'];
  const data=calcMeta(totalMins); let allT=[]; data.forEach(d=>{ if (d.selected) allT.push(...d.selected); }); allT=allT.sort(()=>Math.random()-0.5);
  let html=`<div class="print-header"><h1>Trilha Estratégica</h1><p>Gerado em ${new Date().toLocaleDateString('pt-BR')} · ${totalMins/60}h programadas</p></div>`;
  let idx=0; hs.forEach((h,i)=>{ if (!h){ html+=`<div class="print-day"><div class="print-day-header"><h2>${daysFull[i]}</h2><span>DESCANSO</span></div></div>`; return; } let bud=h*60, day=[]; while (idx<allT.length&&bud>0){ const t=allT[idx]; if (t.duracaoMin<=bud+15){day.push(t);bud-=t.duracaoMin;idx++;}else{ if (!day.length){day.push(t);idx++;} break; } } html+=`<div class="print-day"><div class="print-day-header"><h2>${daysFull[i]}</h2><span>${h}h</span></div><ul class="print-task-list">${!day.length?'<li style="font-size:12px;color:#666">Nenhuma tarefa.</li>':day.map(t=>`<li class="print-task-item"><div class="print-checkbox"></div><div class="print-task-content"><span class="print-disc-badge" style="background:${t.discCor}">${t.discNome}</span><div class="print-task-title">[${t.aulaCod}] ${t.topico}</div><div class="print-task-meta">${t.type} · ${t.duracaoMin}min</div></div></li>`).join('')}</ul></div>`; });
  document.getElementById('printArea').innerHTML=html; window.print();
};

// ============================================================
// PLANEJAMENTO — IMPORTAR DADOS
// ============================================================
window.parsearNLM = function() {
  const txt=document.getElementById('nlm-txt').value, cod=document.getElementById('nlm-cod').value.trim(), tit=document.getElementById('nlm-tit').value.trim();
  if (!txt.trim()||!cod||!tit){ showToast('Preencha Código, Título e cole o texto.','error'); return; }
  _parsedTasks=[];
  const raw=txt.replace(/\nRESUMO EXECUTIVO[\s\S]*/i,'');
  const blocks=raw.split(/(?=TAREFA\s+\d+\s*[—\-])/i).map(b=>b.trim()).filter(b=>/^TAREFA\s+\d+/i.test(b));
  if (!blocks.length){ showToast('Nenhuma tarefa encontrada.','error'); return; }
  blocks.forEach((block,i)=>{
    const hm=block.match(/^TAREFA\s+\d+\s*[—\-]+\s*([A-Z_]+)/im);
    const type=hm?hm[1].toUpperCase().trim():'TEORIA';
    const finalType=['TEORIA','LEI_SECA','TEORIA_LEI','QUESTOES','REVISAO'].includes(type)?type:'TEORIA';
    const pagM=block.match(/P[áa]ginas\s+da\s+Teoria\s*:\s*([\d]+\s*[–\-]\s*[\d]+)/i);
    const paginas=pagM?pagM[1].replace(/\s/g,''):'—';
    const durM=block.match(/Dura[çc][ãa]o\s+estimada\s*:\s*(\d+)/i), durMin=durM?parseInt(durM[1]):60;
    const edM=block.match(/Edital\s*:\s*(.+)/i), statusEdital=edM?edM[1].trim():'';
    const topM=block.match(/T[óo]pico\s+principal\s*:\s*(.+)/i), topico=topM?topM[1].trim():`Tarefa ${i+1}`;
    const subM=block.match(/Subt[óo]picos\s+abordados\s*:\s*(.+)/i), subtopicos=subM?subM[1].trim():'';
    const cmdM=block.match(/📖[^\n]*\n+([\s\S]+?)(?=⚖️|📝|💡|🔑|$)/), lsM=block.match(/⚖️[^\n]*\n+([\s\S]+?)(?=📝|💡|🔑|$)/);
    const qfM=block.match(/📝[^\n]*\n+([\s\S]+?)(?=💡|🔑|$)/), bzM=block.match(/💡[^\n]*\n+([\s\S]+?)(?=🔑|$)/), kwM=block.match(/🔑[^\n]*\n+([\s\S]+?)(?=\n\n|$)/);
    _parsedTasks.push({id:uid(),label:`Tarefa ${i+1}`,type:finalType,paginas,topico,subtopicos,duracaoMin:durMin,status:'pendente',statusEdital,
      comando:cmdM?cmdM[1].trim():'', leiSeca:lsM?lsM[1].replace(/Dispositivo\s*\|[^\n]+\n?/i,'').trim():'',
      questoes:qfM?qfM[1].trim():'', bizus:bzM?bzM[1].trim():'', keywords:kwM?kwM[1].replace(/^[•\-]\s*/gm,'').trim():''});
  });
  if (!_parsedTasks.length){ showToast('Nenhuma tarefa detectada.','error'); return; }
  document.getElementById('nlm-preview').innerHTML=buildNLMPreviewHTML(_parsedTasks);
};
function buildNLMPreviewHTML(tasks) {
  let html=`<div class="parse-preview"><div style="display:flex;align-items:center;gap:8px;margin-bottom:14px"><span style="color:var(--gr);font-weight:600;font-size:13px">✔ ${tasks.length} tarefa(s)</span></div>`;
  tasks.forEach((t,i)=>{ const ti=TYPES[t.type]||TYPES.TEORIA, hasD=t.comando||t.leiSeca||t.questoes||t.bizus||t.keywords;
    html+=`<div class="nlm-task-card"><div class="nlm-task-header" onclick="toggleNLMCard(${i})"><div class="nlm-task-header-left"><span class="tag" style="color:${ti.cor};border-color:${ti.cor}30;background:${ti.cor}18;white-space:nowrap">${ti.label}</span><span class="nlm-task-title-text">${t.topico}</span></div><div class="nlm-task-header-right">${t.statusEdital&&!t.statusEdital.toLowerCase().includes('não')?'<span class="edital-badge">✅ Edital</span>':''}<span class="nlm-task-detail-meta">📄 ${t.paginas}</span><span class="nlm-task-detail-meta">⏱ ${t.duracaoMin}m</span>${hasD?'<span class="nlm-expand-btn">▾ ver</span>':''}</div></div>${t.subtopicos?`<div style="padding:0 12px 8px;font-size:11px;color:var(--tx3)">${t.subtopicos}</div>`:''}${hasD?`<div class="nlm-task-details" id="nlm-card-${i}">${t.comando?`<div class="nlm-detail-row"><span class="nlm-detail-label">📖 Comando</span><p>${t.comando}</p></div>`:''} ${t.leiSeca?`<div class="nlm-detail-row"><span class="nlm-detail-label">⚖️ Lei Seca</span><pre>${t.leiSeca}</pre></div>`:''} ${t.questoes?`<div class="nlm-detail-row"><span class="nlm-detail-label">📝 Questões</span><p style="white-space:pre-line">${t.questoes}</p></div>`:''} ${t.bizus?`<div class="nlm-detail-row"><span class="nlm-detail-label">💡 Bizus</span><p style="white-space:pre-line">${t.bizus}</p></div>`:''} ${t.keywords?`<div class="nlm-detail-row"><span class="nlm-detail-label">🔑 Palavras-chave</span><p style="color:var(--acc)">${t.keywords}</p></div>`:''}</div>`:''}</div>`;
  });
  html+=`<div style="display:flex;gap:10px;margin-top:16px;justify-content:flex-end"><button class="btn btn-g" onclick="cancelarNLM()">Cancelar</button><button class="btn btn-p" onclick="confirmarNLM()">✔ Confirmar Importação</button></div></div>`;
  return html;
}
window.toggleNLMCard = i=>{ const el=document.getElementById(`nlm-card-${i}`); if (el) el.classList.toggle('open'); };
window.limparNLM = ()=>{ document.getElementById('nlm-txt').value=''; document.getElementById('nlm-preview').innerHTML=''; _parsedTasks=[]; };
window.cancelarNLM = ()=>{ _parsedTasks=[]; document.getElementById('nlm-preview').innerHTML=''; };
window.confirmarNLM = function() {
  const discId=document.getElementById('nlm-disc').value, cod=document.getElementById('nlm-cod').value.trim(), tit=document.getElementById('nlm-tit').value.trim();
  const d=(S.disciplinas||[]).find(x=>x.id===discId); if (!d) return;
  const qtd=_parsedTasks.length; d.aulas.push({id:uid(),codigo:cod,titulo:tit,tarefas:_parsedTasks});
  saveState(); limparNLM(); document.getElementById('nlm-cod').value=''; document.getElementById('nlm-tit').value='';
  showToast(`${qtd} tarefa(s) importadas em "${d.nome}"!`); irParaDisciplinas(); renderAll();
};
window.initForm = ()=>{ tfForms=[{id:uid()}]; renderForms(); };
window.addTF    = ()=>{ tfForms.push({id:uid()}); renderForms(); };
window.removeTF = id=>{ tfForms=tfForms.filter(t=>t.id!==id); renderForms(); };
window.renderForms = function() {
  const typeOpts=Object.keys(TYPES).map(k=>`<option value="${k}">${TYPES[k].label}</option>`).join('');
  const edOpts=STATUS_EDITAL.map(s=>`<option value="${s.value}">${s.label}</option>`).join('');
  document.getElementById('tfList').innerHTML=tfForms.map((t,i)=>`<div class="tblock" id="tf-${t.id}"><div class="tbh"><span style="color:var(--acc);font-weight:600;font-size:12px">Tarefa ${i+1}</span>${tfForms.length>1?`<button class="btn btn-g" style="padding:4px 10px;font-size:11px" onclick="removeTF('${t.id}')">✕</button>`:''}</div>
    <div class="tf-fields-grid">
      <div class="fg"><label>Tipo</label><select id="ty-${t.id}">${typeOpts}</select></div>
      <div class="fg"><label>Status Edital</label><select id="ed-${t.id}">${edOpts}</select></div>
      <div class="fg"><label>Páginas</label><input id="pg-${t.id}" placeholder="Ex: 40–55"></div>
      <div class="fg"><label>Duração (min)</label><input id="du-${t.id}" type="number" value="60" min="10"></div>
      <div class="fg full"><label>Tópico Principal</label><input id="tp-${t.id}"></div>
      <div class="fg full"><label>Comando de Estudo</label><textarea id="cm-${t.id}" rows="2"></textarea></div>
      <div class="fg full"><label>Lei Seca — Dispositivo | Artigos | Motivo</label><textarea id="ls-${t.id}" rows="3"></textarea></div>
      <div class="fg full"><label>Questões de Fixação</label><textarea id="qf-${t.id}" rows="2"></textarea></div>
      <div class="fg full"><label>Bizus</label><textarea id="bz-${t.id}" rows="2"></textarea></div>
      <div class="fg full"><label>Palavras-chave</label><input id="kw-${t.id}"></div>
    </div></div>`).join('');
};
window.salvarManual = function() {
  const discId=document.getElementById('f-disc').value, cod=document.getElementById('f-cod').value.trim(), tit=document.getElementById('f-tit').value.trim();
  if (!cod||!tit){ showToast('Preencha Código e Título.','error'); return; }
  const d=(S.disciplinas||[]).find(x=>x.id===discId); if (!d){ showToast('Selecione uma disciplina.','error'); return; }
  const tarefas=tfForms.map((t,i)=>({id:uid(),label:`Tarefa ${i+1}`,type:document.getElementById('ty-'+t.id).value,statusEdital:document.getElementById('ed-'+t.id).value,paginas:document.getElementById('pg-'+t.id).value,topico:document.getElementById('tp-'+t.id).value||`Tarefa ${i+1}`,duracaoMin:parseInt(document.getElementById('du-'+t.id).value)||60,comando:document.getElementById('cm-'+t.id).value,leiSeca:document.getElementById('ls-'+t.id).value,questoes:document.getElementById('qf-'+t.id).value,bizus:document.getElementById('bz-'+t.id).value,keywords:document.getElementById('kw-'+t.id).value,status:'pendente'}));
  d.aulas.push({id:uid(),codigo:cod,titulo:tit,tarefas}); saveState(); showToast(`Aula salva em "${d.nome}"!`); irParaDisciplinas(); renderAll();
};
// ── Dispatcher: detecta XLSX ou CSV automaticamente ──────────
window.handleXlsOrCsvUpload = function(input) {
  const file = input.files[0]; if (!file) return;
  const ext  = file.name.split('.').pop().toLowerCase();
  if (ext === 'csv' || ext === 'tsv' || ext === 'txt') {
    handleCsvUpload(input);
  } else {
    window.lerXlsx(input);
  }
};

window.lerXlsx = function(input) {
  const file=input.files[0]; if (!file) return;
  document.getElementById('file-upload-text').textContent=`📄 ${file.name}`;
  const reader=new FileReader();
  reader.onload=e=>{ try {
    // ── Leitura célula-por-célula (mais confiável que sheet_to_json) ──
    const wb = XLSX.read(e.target.result, {type:'array'});
    console.log('[TecConcursos] Sheets:', wb.SheetNames);
    const sheet = wb.Sheets[wb.SheetNames[0]];
    console.log('[TecConcursos] Ref:', sheet['!ref']);

    // Ler diretamente pelas células — evita bugs do sheet_to_json
    const range  = XLSX.utils.decode_range(sheet['!ref'] || 'A1');
    const rawRows = [];
    for (let r = range.s.r; r <= range.e.r; r++) {
      const row = [];
      for (let cc = range.s.c; cc <= range.e.c; cc++) {
        const addr = XLSX.utils.encode_cell({r, c: cc});
        const cell = sheet[addr];
        row.push(cell !== undefined ? cell.v : '');
      }
      rawRows.push(row);
    }
    console.log('[TecConcursos] Linhas lidas:', rawRows.length, '| Header:', rawRows[0]);

    if (rawRows.length < 2) {
      showToast('Arquivo sem dados. Verifique o arquivo TecConcursos.','error'); return;
    }

    parsearEExibir(rawRows);

  } catch(err) {
    console.error('[TecConcursos] Erro XLSX:', err);
    showToast('Erro ao ler arquivo: ' + err.message,'error');
  }
};
reader.readAsArrayBuffer(file);
};
window.confirmarXlsx = function() {
  if (!_xlsxParsed) return; (S.questoes_history=S.questoes_history||[]).push(_xlsxParsed); saveState();
  const label=_xlsxParsed.label; _xlsxParsed=null; document.getElementById('xls-preview').innerHTML=''; document.getElementById('xls-file').value=''; document.getElementById('xls-label').value=''; document.getElementById('file-upload-text').textContent='📂 Clique para selecionar o arquivo';
  showToast(`"${label}" importado!`); goTab('questoes');
};
window.cancelarXlsx = function() {
  _xlsxParsed=null;
  document.getElementById('xls-preview').innerHTML='';
  document.getElementById('xls-file').value='';
  document.getElementById('file-upload-text').textContent='📂 Clique para selecionar o arquivo';
};

// ── Gestão de histórico de imports TecConcursos ──────────────
// idx = posição no array REVERSO (histAll = history.slice().reverse())
function getImportByIdx(idx) {
  const hist = (S.questoes_history||[]).slice().reverse();
  return hist[idx] || null;
}
window.excluirImport = function(idx) {
  const entry = getImportByIdx(idx);
  if (!entry) return;
  if (!confirm('Excluir o import "' + entry.label + '"?')) return;
  S.questoes_history = (S.questoes_history||[]).filter(h => h.id !== entry.id);
  saveState(); renderQuestoes(); showToast('Import excluído.','info');
};
window.iniciarRenomearImport = function(idx) {
  document.getElementById('impv-'+idx).style.display='none';
  const ed = document.getElementById('impe-'+idx);
  if (ed) { ed.style.display='flex'; document.getElementById('impn-'+idx)?.focus(); }
};
window.cancelarRenomearImport = function(idx) {
  document.getElementById('impv-'+idx).style.display='flex';
  const ed = document.getElementById('impe-'+idx);
  if (ed) ed.style.display='none';
};
window.salvarRenomearImport = function(idx) {
  const entry = getImportByIdx(idx); if (!entry) return;
  const novo  = document.getElementById('impn-'+idx)?.value.trim();
  if (!novo) { showToast('Nome não pode ser vazio.','error'); return; }
  entry.label = novo;
  saveState(); renderQuestoes(); showToast('Nome atualizado!');
};

// ============================================================
// PLANEJAMENTO — DISCIPLINAS CRUD
// ============================================================
function renderDiscList() {
  const container = document.getElementById('discListContainer');
  if (!container) return;

  const discs = activeDiscs();
  const concs = S.concursos || [];
  const ativo = concs.find(c => c.id === S.concursoAtivo);
  const totalPct = discs.reduce((s,d) => s + (Number(d.percentual)||0), 0);
  const pctOk = Math.abs(totalPct - 100) < 1;

  // ── Seletor de concurso ──
  let html = '<div style="margin-bottom:18px">';
  html += '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px">';
  html += '<label style="font-size:11px;font-weight:700;color:#a1a1aa;text-transform:uppercase;letter-spacing:.08em">Concurso</label>';
  html += '<select id="concursoSelect" onchange="switchConcurso(this.value)" style="flex:1;max-width:320px;padding:7px 10px;background:#111114;border:1px solid #3f3f46;color:#f4f4f5;border-radius:6px;font-size:13px">';
  concs.forEach(c => {
    html += '<option value="' + c.id + '"' + (c.id === S.concursoAtivo ? ' selected' : '') + '>' + c.nome + '</option>';
  });
  html += '</select>';
  html += '<button class="btn btn-p" style="font-size:11px" onclick="openNovoConcurso()">+ Novo concurso</button>';
  if (concs.length > 1) {
    html += '<button class="btn btn-g" style="font-size:11px;color:#ef4444;border-color:#ef4444" onclick="deletarConcurso()">🗑️</button>';
  }
  html += '</div>';

  // Formulário inline novo concurso
  html += '<div id="novoConcursoForm" style="display:none;background:#111114;border:1px solid #3f3f46;border-radius:8px;padding:12px;margin-bottom:12px">';
  html += '<div style="font-size:12px;font-weight:600;color:#f4f4f5;margin-bottom:8px">Novo Concurso</div>';
  html += '<div style="display:flex;gap:8px">';
  html += '<input id="novoConcursoNome" placeholder="Ex: Receita Federal — Auditor" style="flex:1;padding:7px 10px;background:#18181b;border:1px solid #3f3f46;color:#f4f4f5;border-radius:6px;font-size:13px">';
  html += '<button class="btn btn-p" onclick="salvarNovoConcurso()">Criar</button>';
  html += '<button class="btn btn-g" onclick="fecharNovoConcurso()">✕</button>';
  html += '</div></div>';

  // Indicador de % total
  html += '<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:' + (pctOk ? 'rgba(34,197,94,.08)' : 'rgba(234,179,8,.08)') + ';border:1px solid ' + (pctOk ? 'rgba(34,197,94,.25)' : 'rgba(234,179,8,.25)') + ';border-radius:6px;font-size:12px">';
  html += '<span style="color:' + (pctOk ? '#22c55e' : '#eab308') + '">' + (pctOk ? '✅' : '⚠️') + ' Total alocado: <strong>' + totalPct + '%</strong></span>';
  if (!pctOk) html += '<span style="color:#a1a1aa;margin-left:4px">— ajuste os percentuais para somar 100%</span>';
  html += '</div>';
  html += '</div>';

  // ── Lista de disciplinas ──
  if (!discs.length) {
    html += '<div class="empty-state"><div class="empty-state-icon">📚</div><div class="empty-state-title">Nenhuma disciplina cadastrada</div><div class="empty-state-sub">Clique em <strong>+ Nova Disciplina</strong> para começar.</div></div>';
    container.innerHTML = html;
    return;
  }

  html += discs.map(d => {
    const isOpen = d._editOpen;
    const pct = Number(d.percentual)||0;
    let cardHtml = '<div class="disc-card" id="dc-' + d.id + '">';
    cardHtml += '<div class="disc-card-header">';
    cardHtml += '<div style="display:flex;align-items:center;gap:8px">';
    cardHtml += '<span style="width:10px;height:10px;border-radius:50%;background:' + (d.cor||'#a1a1aa') + ';display:inline-block;flex-shrink:0"></span>';
    cardHtml += '<span class="disc-card-name">' + d.nome + '</span>';
    cardHtml += '</div>';
    cardHtml += '<div style="display:flex;align-items:center;gap:6px">';
    cardHtml += '<button class="btn-icon" onclick="editDisc(\'' + d.id + '\')" title="Editar">✏️</button>';
    cardHtml += '<button class="btn-icon" onclick="deleteDisc(\'' + d.id + '\')" title="Excluir">🗑️</button>';
    cardHtml += '</div></div>';

    if (isOpen) {
      cardHtml += '<div class="disc-edit-form">';
      cardHtml += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">';
      cardHtml += '<div class="fg"><label>Percentual (%)</label><input type="number" id="dp-' + d.id + '" value="' + pct + '" min="0" max="100" style="width:100%"></div>';
      cardHtml += '<div class="fg"><label>Meta de acerto (%)</label><input type="number" id="dm-' + d.id + '" value="' + (d.metaAcerto||80) + '" min="0" max="100" style="width:100%"></div>';
      cardHtml += '</div>';
      cardHtml += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">';
      cardHtml += '<div class="fg" style="flex:1"><label>Nível de conhecimento</label>';
      cardHtml += '<select id="dn-' + d.id + '" style="width:100%">';
      [['nunca','🔴 Nunca estudei'],['pouco','🟡 Estudei pouco'],['medio','🟢 Conheço razoavelmente'],['bom','💪 Conheço bem']].forEach(([v,l]) => {
        cardHtml += '<option value="' + v + '"' + (d.nivelConhecimento===v?' selected':'') + '>' + l + '</option>';
      });
      cardHtml += '</select></div>';
      cardHtml += '<div class="fg" style="flex-shrink:0"><label>Cor</label><input type="color" id="dc2-' + d.id + '" value="' + (d.cor||'#6366f1') + '" style="width:48px;height:36px;padding:2px;border-radius:6px;border:1px solid #3f3f46;background:transparent;cursor:pointer"></div>';
      cardHtml += '</div>';
      cardHtml += '<div style="display:flex;gap:8px;justify-content:flex-end">';
      cardHtml += '<button class="btn btn-g" onclick="editDisc(\'' + d.id + '\')">Cancelar</button>';
      cardHtml += '<button class="btn btn-p" onclick="saveDisc(\'' + d.id + '\')">✔ Salvar</button>';
      cardHtml += '</div></div>';
    } else {
      cardHtml += '<div class="disc-badges">';
      cardHtml += '<span class="disc-badge">' + pct + '%</span>';
      cardHtml += '<span class="disc-badge">Meta: ' + (d.metaAcerto||80) + '%</span>';
      const aulasCount = (d.aulas||[]).length;
      if (aulasCount) cardHtml += '<span class="disc-badge">' + aulasCount + ' aula(s)</span>';
      cardHtml += '<button class="btn btn-g" style="font-size:11px;padding:3px 10px;margin-left:auto" onclick="verAulas(\'' + d.id + '\')">📁 ver aulas</button>';
      cardHtml += '</div>';
    }
    cardHtml += '</div>';
    return cardHtml;
  }).join('');

  container.innerHTML = html;
}

window.switchConcurso = function(id) {
  S.concursoAtivo = id;
  saveState(); renderDiscList(); renderHoje(); populateDiscDropdowns();
  showToast('Concurso alterado!');
};
window.openNovoConcurso = function() {
  document.getElementById('novoConcursoForm').style.display = 'block';
  document.getElementById('novoConcursoNome').focus();
};
window.fecharNovoConcurso = function() {
  document.getElementById('novoConcursoForm').style.display = 'none';
};
window.salvarNovoConcurso = function() {
  const nome = document.getElementById('novoConcursoNome')?.value.trim();
  if (!nome) { showToast('Digite um nome.','error'); return; }
  const id = 'c-' + Date.now();
  (S.concursos = S.concursos||[]).push({ id, nome });
  S.concursoAtivo = id;
  saveState(); renderDiscList();
  showToast('Concurso "' + nome + '" criado!');
};
window.deletarConcurso = function() {
  if ((S.concursos||[]).length <= 1) { showToast('Não é possível excluir o único concurso.','error'); return; }
  const ativo = (S.concursos||[]).find(c => c.id === S.concursoAtivo);
  if (!ativo) return;
  if (!confirm('Excluir "' + ativo.nome + '" e TODAS as suas disciplinas/aulas/tarefas?')) return;
  S.disciplinas = (S.disciplinas||[]).filter(d => d.concursoId !== S.concursoAtivo);
  S.concursos   = (S.concursos||[]).filter(c => c.id !== S.concursoAtivo);
  S.concursoAtivo = S.concursos[0].id;
  saveState(); renderDiscList(); renderHoje();
  showToast('Concurso excluído.');
};

window.openAddDisc  = ()=>{ const f=document.getElementById('addDiscForm'); f.style.display='block'; document.getElementById('nd-nome').focus(); f.scrollIntoView({behavior:'smooth',block:'nearest'}); };
window.closeAddDisc = ()=>{ document.getElementById('addDiscForm').style.display='none'; document.getElementById('nd-nome').value=''; document.getElementById('nd-peso').value='20'; document.getElementById('nd-meta').value='80'; document.getElementById('nd-cor').value='#3b82f6'; document.getElementById('nd-nivel').value='nunca'; };
window.salvarNovaDisc = function() {
  const nome=document.getElementById('nd-nome').value.trim(); if (!nome){ showToast('Preencha o nome.','error'); return; }
  (S.disciplinas=S.disciplinas||[]).push({id:uid(),nome,peso:parseInt(document.getElementById('nd-peso').value)||20,metaAcerto:parseInt(document.getElementById('nd-meta').value)||80,cor:document.getElementById('nd-cor').value,nivelConhecimento:document.getElementById('nd-nivel').value,aulas:[]});
  saveState(); closeAddDisc(); renderDiscList(); populateDiscDropdowns(); showToast(`"${nome}" adicionada!`);
};
window.removeDisc = function(id) {
  const d=(S.disciplinas||[]).find(x=>x.id===id); if (!d) return;
  if (!confirm(`Remover "${d.nome}"?`)) return;
  S.disciplinas=S.disciplinas.filter(x=>x.id!==id); saveState(); renderDiscList(); populateDiscDropdowns(); showToast('Disciplina removida.','info');
};
window.toggleEditDisc = function(id) { const v=document.getElementById(`disc-view-${id}`), e=document.getElementById(`disc-edit-${id}`); if (!v||!e) return; const ed=e.style.display!=='none'; v.style.display=ed?'flex':'none'; e.style.display=ed?'none':'block'; };
window.saveEditDisc = function(id) {
  const d=(S.disciplinas||[]).find(x=>x.id===id); if (!d) return;
  d.peso=parseInt(document.getElementById(`de-peso-${id}`).value)||d.peso;
  d.metaAcerto=parseInt(document.getElementById(`de-meta-${id}`).value)||d.metaAcerto;
  d.cor=document.getElementById(`de-cor-${id}`).value;
  d.nivelConhecimento=document.getElementById(`de-nivel-${id}`).value;
  saveState(); renderDiscList(); showToast('Disciplina atualizada!');
};
window.toggleAulaList = id=>{ document.getElementById('disc-aulas-'+id)?.classList.toggle('open'); };
window.deleteAula = function(discId,aulaId) {
  const d=(S.disciplinas||[]).find(x=>x.id===discId), a=(d?.aulas||[]).find(x=>x.id===aulaId); if (!d||!a) return;
  if (!confirm(`Excluir "${a.codigo} — ${a.titulo}"?`)) return;
  d.aulas=d.aulas.filter(x=>x.id!==aulaId); saveState(); renderDiscList(); renderHoje(); showToast('Aula excluída.','info');
};
window.moverAula = function(fromId,aulaId) {
  const toId=document.getElementById('ms-'+aulaId)?.value; if (!toId) return;
  const from=(S.disciplinas||[]).find(d=>d.id===fromId), to=(S.disciplinas||[]).find(d=>d.id===toId); if (!from||!to) return;
  const aula=(from.aulas||[]).find(a=>a.id===aulaId); if (!aula) return;
  from.aulas=from.aulas.filter(a=>a.id!==aulaId); (to.aulas=to.aulas||[]).push(aula);
  saveState(); renderDiscList(); renderHoje(); showToast(`Aula movida para "${to.nome}"!`);
};

// ============================================================
// TEMPLATES
// ============================================================
window.renderTemplates = async function() {
  const container = document.getElementById('templatesContent'); if (!container) return;
  container.innerHTML = '<div style="color:var(--tx3);font-size:13px;padding:20px 0">Carregando...</div>';
  try {
    const snap = await db.collection('templates').orderBy('criadoEm','desc').limit(30).get();
    if (snap.empty) {
      container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📋</div><div class="empty-state-title">Nenhum template disponível ainda</div><div class="empty-state-sub">Clique em "Publicar meu plano" para compartilhar.</div></div>';
      return;
    }
    container.innerHTML = snap.docs.map(doc => {
      const t = doc.data(), isOwn = t.autorUid === currentUser?.uid;
      const editing = _editingTemplate && _editingTemplate.id === t.id;

      let html = '<div class="template-card" id="tpl-'+t.id+'">';
      // ── Cabeçalho ─────────────────────────────────────────────
      html += '<div class="template-header">';
      html += '<div style="flex:1;min-width:0">';
      // Nome (view / edit)
      html += '<div id="tpl-view-'+t.id+'" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">';
      html += '<span class="template-nome">' + t.nome + '</span>';
      if (isOwn) html += '<span class="own-badge">SEU</span>';
      if (isOwn) html += '<button class="btn-icon" title="Renomear" onclick="editarNomeTemplate(\''+t.id+'\',\''+t.nome.replace(/'/g,"\\'")+'\')" >✏️</button>';
      html += '</div>';
      html += '<div id="tpl-edit-'+t.id+'" style="display:none;margin-top:6px"><div style="display:flex;gap:6px;align-items:center"><input id="tpl-input-'+t.id+'" value="'+t.nome+'" style="flex:1;font-size:13px"><button class="btn btn-p" style="padding:5px 10px;font-size:11px" onclick="salvarNomeTemplate(\''+t.id+'\')">✔</button><button class="btn btn-g" style="padding:5px 10px;font-size:11px" onclick="cancelarEditTemplate(\''+t.id+'\')">✕</button></div></div>';
      html += '<div class="template-meta">por ' + t.autor + ' · ' + (editing ? _editingTemplate.disciplinas.length : (t.disciplinas||[]).length) + ' disciplinas · ' + new Date(t.criadoEm).toLocaleDateString('pt-BR') + '</div>';
      html += '</div>';
      // Botões de ação
      html += '<div style="display:flex;gap:6px;flex-shrink:0">';
      if (isOwn && !editing) html += '<button class="btn btn-g" style="font-size:11px" onclick="abrirEdicaoTemplate(\''+t.id+'\')">✏️ Editar</button>';
      if (isOwn && editing)  html += '<button class="btn btn-g" style="font-size:11px;color:#ef4444;border-color:#ef4444" onclick="cancelarEdicaoTemplate()">✕ Cancelar</button>';
      if (isOwn) html += '<button class="btn btn-g" style="font-size:11px;padding:6px 10px" onclick="deletarTemplate(\''+t.id+'\')">🗑️</button>';
      if (!editing) html += '<button class="btn btn-p" style="font-size:12px" onclick="importarTemplate(\''+t.id+'\')">↓ Importar</button>';
      html += '</div></div>';

      if (editing) {
        // ── Editor inline de disciplinas ─────────────────────────
        html += '<div style="margin-top:14px;background:#111114;border:1px solid #3f3f46;border-radius:8px;padding:14px">';
        html += '<div style="font-size:11px;font-weight:700;color:#a1a1aa;text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px">Disciplinas no template</div>';

        if (!_editingTemplate.disciplinas.length) {
          html += '<div style="color:#71717a;font-size:12px;padding:8px 0">Nenhuma disciplina. Adicione abaixo.</div>';
        } else {
          _editingTemplate.disciplinas.forEach(function(d, idx) {
            html += '<div style="display:flex;align-items:center;gap:8px;padding:7px 10px;background:#1c1c1f;border:1px solid #3f3f46;border-radius:6px;margin-bottom:5px">';
            html += '<span style="width:8px;height:8px;border-radius:50%;background:'+(d.cor||'#a1a1aa')+';flex-shrink:0"></span>';
            html += '<span style="font-size:13px;color:#f4f4f5;flex:1">' + d.nome + '</span>';
            html += '<span style="font-size:11px;color:#71717a">' + ((d.aulas||[]).length) + ' aulas</span>';
            html += '<button class="btn btn-g" style="font-size:11px;padding:4px 8px;color:#ef4444;border-color:#ef4444" onclick="removerDiscDoTemplate('+idx+')">× Remover</button>';
            html += '</div>';
          });
        }

        // Adicionar do concurso ativo
        const discsAtivos = activeDiscs();
        const nomesNoTemplate = _editingTemplate.disciplinas.map(function(d){ return d.nome.toLowerCase(); });
        const disponiveis = discsAtivos.filter(function(d){ return !nomesNoTemplate.includes(d.nome.toLowerCase()); });

        if (disponiveis.length) {
          html += '<div style="font-size:11px;font-weight:700;color:#a1a1aa;text-transform:uppercase;letter-spacing:.08em;margin-top:14px;margin-bottom:8px">Adicionar do concurso: ' + ((S.concursos||[]).find(function(c){ return c.id===S.concursoAtivo; })||{nome:'?'}).nome + '</div>';
          disponiveis.forEach(function(d) {
            html += '<div style="display:flex;align-items:center;gap:8px;padding:7px 10px;background:#18181b;border:1px solid #27272a;border-radius:6px;margin-bottom:5px;opacity:.8">';
            html += '<span style="width:8px;height:8px;border-radius:50%;background:'+(d.cor||'#a1a1aa')+';flex-shrink:0"></span>';
            html += '<span style="font-size:13px;color:#d4d4d8;flex:1">' + d.nome + '</span>';
            html += '<span style="font-size:11px;color:#71717a">' + ((d.aulas||[]).length) + ' aulas</span>';
            html += '<button class="btn btn-p" style="font-size:11px;padding:4px 8px" onclick="adicionarDiscAoTemplate(\''+d.id+'\')">+ Adicionar</button>';
            html += '</div>';
          });
        }

        html += '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">';
        html += '<button class="btn btn-g" onclick="cancelarEdicaoTemplate()">Cancelar</button>';
        html += '<button class="btn btn-p" onclick="salvarEdicaoTemplate()">💾 Salvar no Firebase</button>';
        html += '</div></div>';
      } else {
        // Badges normais
        html += '<div class="template-discs">' + (t.disciplinas||[]).map(function(d){ return '<span class="disc-badge-sm" style="color:'+d.cor+';border-color:'+d.cor+'30;background:'+d.cor+'15">'+d.nome+'</span>'; }).join('') + '</div>';
      }
      html += '</div>'; // template-card
      return html;
    }).join('');
  } catch(e) {
    container.innerHTML = '<div class="alert-box alert-info">Erro: ' + (e.code||e.message) + '</div>';
  }
};


// ── Editor de disciplinas do template ────────────────────────
window.abrirEdicaoTemplate = async function(id) {
  try {
    const snap = await db.collection('templates').doc(id).get();
    if (!snap.exists) { showToast('Template não encontrado.','error'); return; }
    _editingTemplate = { id, ...snap.data() };
    // Garantir cópia profunda das disciplinas para edição local
    _editingTemplate.disciplinas = JSON.parse(JSON.stringify(_editingTemplate.disciplinas||[]));
    renderTemplates();
  } catch(e) { showToast('Erro: ' + e.message,'error'); }
};

window.cancelarEdicaoTemplate = function() {
  _editingTemplate = null; renderTemplates();
};

window.removerDiscDoTemplate = function(idx) {
  if (!_editingTemplate) return;
  _editingTemplate.disciplinas.splice(idx, 1);
  renderTemplates();
};

window.adicionarDiscAoTemplate = function(discId) {
  if (!_editingTemplate) return;
  const disc = activeDiscs().find(function(d){ return d.id===discId; });
  if (!disc) return;
  const nomesAtuais = _editingTemplate.disciplinas.map(function(d){ return d.nome.toLowerCase(); });
  if (nomesAtuais.includes(disc.nome.toLowerCase())) { showToast('Disciplina já está no template.','info'); return; }
  const copia = JSON.parse(JSON.stringify(disc));
  // Zerar status das tarefas na cópia
  (copia.aulas||[]).forEach(function(a){
    (a.tarefas||[]).forEach(function(t){ t.status='pendente'; delete t.pctAcerto; delete t.qAcertos; delete t.qRespondidas; delete t.proximaRevisaoEm; });
  });
  _editingTemplate.disciplinas.push(copia);
  renderTemplates();
};

window.salvarEdicaoTemplate = async function() {
  if (!_editingTemplate) return;
  const btn = document.querySelector('[onclick="salvarEdicaoTemplate()"]');
  if (btn) btn.textContent = 'Salvando...';
  try {
    await db.collection('templates').doc(_editingTemplate.id).update({
      disciplinas: _editingTemplate.disciplinas
    });
    showToast('Template atualizado! (' + _editingTemplate.disciplinas.length + ' disciplinas)');
    _editingTemplate = null; renderTemplates();
  } catch(e) { showToast('Erro ao salvar: ' + e.message,'error'); }
};


window.editarNomeTemplate = function(id, nomeAtual) {
  document.getElementById(`tpl-view-${id}`).style.display='none';
  document.getElementById(`tpl-edit-${id}`).style.display='block';
  const inp = document.getElementById(`tpl-input-${id}`);
  if (inp){ inp.value=nomeAtual; inp.focus(); inp.select(); }
};
window.cancelarEditTemplate = function(id) {
  document.getElementById(`tpl-view-${id}`).style.display='flex';
  document.getElementById(`tpl-edit-${id}`).style.display='none';
};
window.salvarNomeTemplate = async function(id) {
  const novoNome = document.getElementById(`tpl-input-${id}`)?.value.trim();
  if (!novoNome){ showToast('Nome não pode ser vazio.','error'); return; }
  try {
    await db.collection('templates').doc(id).update({ nome: novoNome });
    showToast('Nome atualizado!'); renderTemplates();
  } catch(e){ showToast(`Erro: ${e.code}`,'error'); }
};
window.abrirFormPublicar = function() {
  const discs = S.disciplinas||[];
  if (!currentUser){ showToast('Faça login primeiro.','error'); return; }
  if (!discs.length){
    showToast('Nenhuma disciplina carregada. Clique no ● Sincronizado para restaurar.','info');
    return;
  }
  document.getElementById('publishForm').style.display='block';
  document.getElementById('template-nome').value='';
  document.getElementById('template-disc-info').textContent=
    `${discs.length} disciplina(s) serão incluídas com status zerado.`;
  document.getElementById('template-nome').focus();
};
window.fecharFormPublicar = function() {
  document.getElementById('publishForm').style.display='none';
};
window.confirmarPublicarTemplate = async function() {
  const nome = document.getElementById('template-nome').value.trim();
  if (!nome){ showToast('Dê um nome ao template.','error'); return; }
  const discs=JSON.parse(JSON.stringify(S.disciplinas||[])).map(d=>({...d,aulas:(d.aulas||[]).map(a=>({...a,tarefas:(a.tarefas||[]).map(t=>({...t,status:'pendente'}))}))}));
  try {
    await db.collection('templates').doc(uid()).set({
      id:uid(), nome, autor:currentUser.displayName||'Anônimo',
      autorUid:currentUser.uid, disciplinas:discs, criadoEm:new Date().toISOString()
    });
    showToast('Template publicado com sucesso!');
    fecharFormPublicar();
    renderTemplates();
  } catch(e){ showToast(`Erro: ${e.code||e.message}`,'error'); }
};
window.importarTemplate = async function(id) {
  if (!confirm('Importar template? As disciplinas serão ADICIONADAS ao seu plano.')) return;
  try {
    const snap=await db.collection('templates').doc(id).get(); if (!snap.exists){ showToast('Template não encontrado.','error'); return; }
    const novas=JSON.parse(JSON.stringify((snap.data().disciplinas||[]))).map(d=>({...d,id:uid(),aulas:(d.aulas||[]).map(a=>({...a,id:uid(),tarefas:(a.tarefas||[]).map(x=>({...x,id:uid(),status:'pendente'}))}))}));
    (S.disciplinas=S.disciplinas||[]).push(...novas); saveState(); renderDiscList(); populateDiscDropdowns(); showToast(`${novas.length} disciplina(s) importadas!`); irParaDisciplinas();
  } catch(e){ showToast(`Erro: ${e.code}`,'error'); }
};
window.deletarTemplate = async function(id) {
  if (!confirm('Remover seu template?')) return;
  try { await db.collection('templates').doc(id).delete(); showToast('Template removido.','info'); renderTemplates(); }
  catch(e){ showToast(`Erro: ${e.code}`,'error'); }
};

// ============================================================
// INICIALIZAÇÃO
// ============================================================
function renderAll() {
  const h=new Date().getHours();
  const sb=document.getElementById('saudBlock');
  if(sb) sb.textContent=(h<12?'Bom dia':h<18?'Boa tarde':'Boa noite')+'! Foco total rumo à aprovação.';
  try { renderHoje(); }     catch(e){ console.error('[renderAll] renderHoje:',e); }
  try { renderDiscList(); } catch(e){ console.error('[renderAll] renderDiscList:',e); }
  try { if(document.getElementById('tab-questoes')?.classList.contains('active'))  renderQuestoes(); }  catch(e){ console.error(e); }
  try { if(document.getElementById('tab-progresso')?.classList.contains('active')) renderProgresso(); } catch(e){ console.error(e); }
  try { if(document.getElementById('tab-historico')?.classList.contains('active')) renderHistorico(); } catch(e){ console.error(e); }
}
renderAll();
