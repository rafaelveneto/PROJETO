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
// Configurações de revisão (editáveis pelo usuário)
if (!S.config.revisao) S.config.revisao = {
  limiteUrgente: 60,  // abaixo disso → revisão em diasUrgente
  limiteMedio:   75,  // abaixo disso → revisão em diasMedio
  diasUrgente:   2,
  diasMedio:     7,
  diasBom:       14
};

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
  const titles={hoje:'Foco do Dia',historico:'Histórico',questoes:'Análise de Desempenho',progresso:'Progresso & Previsão',planejamento:'Planejamento',templates:'Templates'};
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
  const hasD=t.comando||t.leiSeca||t.questoes||t.bizus||t.keywords;
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
      ${t.type==='QUESTOES'?`<div class="task-section"><div class="task-section-lbl">📊 Registro de Desempenho</div>
        <div class="acerto-inline">
          <div class="fg"><label>Questões</label><input type="number" id="qr-${t.id}" value="${t.qRespondidas||''}" min="0" placeholder="Ex: 30" oninput="calcPctAcerto('${t.id}')"></div>
          <div class="fg"><label>Acertos</label><input type="number" id="qa-${t.id}" value="${t.qAcertos||''}" min="0" placeholder="Ex: 21" oninput="calcPctAcerto('${t.id}')"></div>
          <div class="fg"><label>% Acerto</label><div id="qpct-${t.id}" class="pct-display" style="color:${(t.pctAcerto||0)>=70?'var(--gr)':'var(--tx3)'}">${t.pctAcerto!=null?t.pctAcerto+'%':'—'}</div></div>
          <button class="btn btn-p" style="padding:7px 14px;font-size:11px;align-self:end" onclick="salvarAcerto('${t.discId}','${t.aulaId}','${t.id}')">Salvar</button>
        </div>
      </div>`:''}
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
  const today=new Date().getDay(), horasHoje=S.config.horasSemana[today]||0;
  const totalMins=horasHoje*60, allP=pendingTarefas();
  const allT=allTarefas(), done=allT.filter(t=>t.status==='concluida');
  const pct=allT.length?Math.round(done.length/allT.length*100):0;
  document.getElementById('statsGrid').innerHTML=`
    <div class="sc"><span class="sv" style="color:var(--gr)">${pct}%</span><span class="sl">Concluído</span></div>
    <div class="sc"><span class="sv">${done.length}</span><span class="sl">Feitas</span></div>
    <div class="sc"><span class="sv" style="color:var(--acc)">${allP.length}</span><span class="sl">Pendentes</span></div>
    <div class="sc"><span class="sv">${horasHoje}h</span><span class="sl">Horas Hoje</span></div>`;
  const hojeBar=document.getElementById('hojeBar'), hojeList=document.getElementById('hojeList');
  if (horasHoje===0){ hojeBar.innerHTML=''; hojeList.innerHTML=`<div style="text-align:center;padding:28px;color:var(--tx3)">🛌 Dia de descanso!</div>`; return; }
  if (!allP.length){
    hojeBar.innerHTML='';
    const temDisc=(S.disciplinas||[]).some(d=>(d.aulas||[]).length>0);
    hojeList.innerHTML=temDisc
      ?`<div style="text-align:center;padding:28px;color:var(--gr);font-size:13px">✅ Todas as tarefas concluídas!</div>`
      :`<div style="text-align:center;padding:28px;color:var(--tx3);font-size:13px">📚 Nenhuma disciplina com aulas ainda.<br><br><button class="btn btn-p" onclick="goTab('planejamento')">Ir para Planejamento</button></div>`;
    return;
  }
  // ── Seção de Revisões Pendentes ──
  const revPend = getRevisoesPendentes();
  if (revPend.length > 0) {
    const revCard = document.createElement('div');
    revCard.className = 'card'; revCard.style.marginBottom='14px';
    const atrasoStr = t => {
      const dias = Math.floor((Date.now() - new Date(t.proximaRevisaoEm)) / 864e5);
      return dias <= 0 ? 'hoje' : `há ${dias} dia(s)`;
    };
    revCard.innerHTML = `
      <div class="ct" style="color:var(--yl)">⏰ Revisões Pendentes (${revPend.length})</div>
      ${revPend.map(t=>`
        <div class="rev-item" style="border-left-color:${t.pctAcerto<60?'var(--re)':t.pctAcerto<75?'var(--yl)':'var(--gr)'}">
          <div>
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px">
              <span class="aula-badge">${t.aulaCod||'A?'}</span>
              <span style="font-size:12px;font-weight:500;color:var(--tx)">${t.topico}</span>
            </div>
            <div style="font-size:10px;color:var(--tx3)">
              <span style="color:${t.discCor}">● ${t.discNome}</span>
              &nbsp;·&nbsp; Acerto: <span style="color:${t.pctAcerto>=70?'var(--gr)':'var(--re)'}">
                ${t.pctAcerto}%</span>
              &nbsp;·&nbsp; Venceu ${atrasoStr(t)}
            </div>
          </div>
          <button class="btn btn-g" style="padding:4px 10px;font-size:11px;flex-shrink:0"
            onclick="marcarRevisao('${t.discId}','${t.aulaId}','${t.id}')">✔ Revisado</button>
        </div>`).join('')}`;
    const card = document.getElementById('hojeBar');
    card.parentNode.insertBefore(revCard, card);
  }

  const todayTasks=buildTodayTasks(totalMins);
  const allocMins=todayTasks.reduce((s,t)=>s+(t.duracaoMin||0),0);
  const livresMins=Math.max(0,totalMins-allocMins);
  const barPct=totalMins>0?Math.min(100,Math.round(allocMins/totalMins*100)):0;
  const doneHoje=todayTasks.filter(t=>t.status==='concluida').length;
  hojeBar.innerHTML=`<div class="hoje-bar-wrap">
    <div class="hoje-bar-labels">
      <span style="font-size:11px;color:var(--tx3)">${fmtMin(allocMins)} alocados · ${doneHoje}/${todayTasks.length} concluídas</span>
      <span style="font-size:11px;color:var(--tx3)">${fmtMin(livresMins)} livres</span>
    </div>
    <div class="hoje-bar-track"><div class="hoje-bar-fill" style="width:${barPct}%"></div></div>
  </div>`;
  hojeList.innerHTML=todayTasks.length
    ?todayTasks.map((t,i)=>renderTaskCard(t,i)).join('')
    :`<div style="color:var(--tx3);font-size:13px;padding:12px 0">Configure a agenda em Planejamento → Trilha.</div>`;
}
window.toggleTarefa = function(discId,aulaId,tarefaId) {
  const d=(S.disciplinas||[]).find(x=>x.id===discId); if (!d) return;
  const aula=(d.aulas||[]).find(a=>a.id===aulaId); if (!aula) return;
  const tarefa=(aula.tarefas||[]).find(t=>t.id===tarefaId); if (!tarefa) return;
  tarefa.status=tarefa.status==='concluida'?'pendente':'concluida';
  saveState(); renderHoje();
  if (document.getElementById('tab-historico')?.classList.contains('active')) renderHistorico();
  if (document.getElementById('tab-progresso')?.classList.contains('active'))  renderProgresso();
};

// Registro inline de acertos em tarefas de Questões
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

// Retorna tarefas de Questões com revisão vencida ou no prazo hoje
function getRevisoesPendentes() {
  const now = new Date();
  return allTarefas().filter(t =>
    t.proximaRevisaoEm &&
    new Date(t.proximaRevisaoEm) <= now
  ).sort((a,b) => new Date(a.proximaRevisaoEm) - new Date(b.proximaRevisaoEm));
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
  const rv = S.config.revisao || { limiteUrgente:60, limiteMedio:75, diasUrgente:2, diasMedio:7, diasBom:14 };
  document.getElementById('semanaGridContainer').innerHTML=`<div class="day-grid">${dias.map((d,i)=>`<div class="day-cell"><div class="day-nm">${d}</div><input type="number" class="day-hi" value="${hs[i]}" min="0" max="16" onchange="updateHoraDia(${i},this.value)"></div>`).join('')}</div>
  <div class="meta-label" style="text-align:right;margin-top:8px">Total Planejado: <strong id="totalSemanaGrid">${hs.reduce((a,b)=>a+b,0)}h</strong></div>
  <div class="card" style="margin-top:16px;background:var(--s2);border:1px solid var(--bd)">
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
window.lerXlsx = function(input) {
  const file=input.files[0]; if (!file) return;
  document.getElementById('file-upload-text').textContent=`📄 ${file.name}`;
  const reader=new FileReader();
  reader.onload=e=>{ try {
    const wb=XLSX.read(e.target.result,{type:'array'}), sheet=wb.Sheets[wb.SheetNames[0]];
    const data=XLSX.utils.sheet_to_json(sheet,{header:1,defval:null,raw:true});
    const headers=data[0].map(h=>String(h||'').trim().toLowerCase());
    const c=n=>headers.findIndex(h=>h.includes(n));
    const idxN=c('índice')>-1?c('índice'):c('indice'), idxH=c('hierarquia'), idxQ=c('resolvidas'), idxA=c('quantidade de acertos'), idxP=c('acertos (%)');
    let discs=[],cur=null,totQ=0,totA=0;
    for (let i=1;i<data.length;i++){ const row=data[i]; if (!row[idxN]) continue; const nome=String(row[idxN]).trim(),hier=String(row[idxH]||'').trim(),qR=Number(row[idxQ])||0,qA=Number(row[idxA])||0,pct=Number(row[idxP])||0; if (hier===''){ cur={nome,qResolvidas:qR,acertos:qA,pctAcerto:pct,topicos:[]}; discs.push(cur); } else if (cur){ cur.topicos.push({nome,qResolvidas:qR,acertos:qA,pctAcerto:pct}); totQ+=qR; totA+=qA; } }
    const pctG=totQ?Math.round(totA/totQ*1000)/10:0, label=document.getElementById('xls-label').value.trim()||new Date().toLocaleDateString('pt-BR');
    _xlsxParsed={id:uid(),importadoEm:new Date().toISOString(),label,total:totQ,pctGeral:pctG,disciplinas:discs};
    const weak=discs.reduce((acc,d)=>{ const cfg=(S.disciplinas||[]).find(x=>x.nome.toLowerCase()===d.nome.toLowerCase()); const meta=cfg?.metaAcerto||80; return acc+(d.topicos||[]).filter(t=>t.pctAcerto<meta&&t.qResolvidas>=5).length; },0);
    const cor=pctG>=70?'var(--gr)':'var(--re)';
    document.getElementById('xls-preview').innerHTML=`<div style="color:var(--tx3);font-size:11px;margin-bottom:8px;text-transform:uppercase;letter-spacing:.06em">Preview — ${label}</div><div class="tec-preview-grid"><div class="tec-preview-card"><div class="tec-preview-val">${totQ}</div><div class="tec-preview-lbl">Questões</div></div><div class="tec-preview-card"><div class="tec-preview-val" style="color:${cor}">${pctG}%</div><div class="tec-preview-lbl">Acerto</div></div><div class="tec-preview-card"><div class="tec-preview-val">${discs.length}</div><div class="tec-preview-lbl">Matérias</div></div><div class="tec-preview-card"><div class="tec-preview-val" style="color:var(--re)">${weak}</div><div class="tec-preview-lbl">Pontos Fracos</div></div></div><div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px"><button class="btn btn-g" onclick="cancelarXlsx()">Cancelar</button><button class="btn btn-p" onclick="confirmarXlsx()">✔ Confirmar e Salvar</button></div>`;
  } catch(err){ showToast('Erro ao processar planilha.','error'); } };
  reader.readAsArrayBuffer(file);
};
window.confirmarXlsx = function() {
  if (!_xlsxParsed) return; (S.questoes_history=S.questoes_history||[]).push(_xlsxParsed); saveState();
  const label=_xlsxParsed.label; _xlsxParsed=null; document.getElementById('xls-preview').innerHTML=''; document.getElementById('xls-file').value=''; document.getElementById('xls-label').value=''; document.getElementById('file-upload-text').textContent='📂 Clique para selecionar o arquivo';
  showToast(`"${label}" importado!`); goTab('questoes');
};
window.cancelarXlsx = function() { _xlsxParsed=null; document.getElementById('xls-preview').innerHTML=''; document.getElementById('xls-file').value=''; document.getElementById('file-upload-text').textContent='📂 Clique para selecionar o arquivo'; };

// ============================================================
// PLANEJAMENTO — DISCIPLINAS CRUD
// ============================================================
function renderDiscList() {
  const container=document.getElementById('discList'); if (!container) return;
  const discs=S.disciplinas||[];
  if (!discs.length){
    container.innerHTML=`<div class="empty-state">
      <div class="empty-state-icon">📚</div>
      <div class="empty-state-title">Nenhuma disciplina cadastrada</div>
      <div class="empty-state-sub">Clique em <strong>+ Nova Disciplina</strong> para adicionar manualmente.</div>
      ${currentUser?`<div style="margin-top:14px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
        <button class="btn btn-p" onclick="pullFirebase(true)">↓ Restaurar dados do Firebase</button>
      </div>`:''}
    </div>`;
    return;
  }
  container.innerHTML=discs.map(d=>{
    const aulas=d.aulas||[];
    return `<div class="disc-card" id="disc-${d.id}">
      <div class="disc-card-header">
        <div style="display:flex;align-items:center;gap:10px">
          <div class="disc-dot" style="background:${d.cor||'#888'}"></div>
          <span class="disc-card-name">${d.nome}</span>
          ${d.nivelConhecimento?`<span class="nivel-badge nivel-${d.nivelConhecimento}">${NIVEL_LABEL[d.nivelConhecimento]}</span>`:''}
        </div>
        <div class="disc-card-actions">
          <button class="btn-icon" onclick="toggleEditDisc('${d.id}')">✏️</button>
          <button class="btn-icon btn-icon-danger" onclick="removeDisc('${d.id}')">🗑️</button>
        </div>
      </div>
      <div id="disc-view-${d.id}" class="disc-meta-row">
        <span class="disc-badge">Peso: ${d.peso||10}</span>
        <span class="disc-badge">Meta: ${d.metaAcerto||80}%</span>
        <span class="disc-badge">${aulas.length} aula(s)</span>
        ${aulas.length>0?`<button class="btn-icon" style="margin-left:auto" onclick="toggleAulaList('${d.id}')">📂 ver aulas</button>`:''}
      </div>
      <div id="disc-edit-${d.id}" class="disc-edit-form" style="display:none">
        <div class="disc-edit-grid">
          <div class="fg"><label>Peso</label><input type="number" id="de-peso-${d.id}" value="${d.peso||10}" min="1" max="100"></div>
          <div class="fg"><label>Meta (%)</label><input type="number" id="de-meta-${d.id}" value="${d.metaAcerto||80}" min="50" max="100"></div>
          <div class="fg"><label>Cor</label><input type="color" id="de-cor-${d.id}" value="${d.cor||'#3b82f6'}" class="input-color"></div>
        </div>
        <div class="fg" style="margin-top:8px"><label>Nível de Conhecimento</label>
          <select id="de-nivel-${d.id}">
            <option value="nunca" ${d.nivelConhecimento==='nunca'?'selected':''}>🔴 Nunca estudei</option>
            <option value="comecei" ${d.nivelConhecimento==='comecei'?'selected':''}>🟡 Comecei</option>
            <option value="terminei" ${d.nivelConhecimento==='terminei'?'selected':''}>🟠 Terminei sem confiança</option>
            <option value="aparar" ${d.nivelConhecimento==='aparar'?'selected':''}>🟢 Aparar arestas</option>
          </select>
        </div>
        <div style="display:flex;gap:6px;margin-top:10px;justify-content:flex-end">
          <button class="btn btn-g" style="padding:6px 12px;font-size:11px" onclick="toggleEditDisc('${d.id}')">Cancelar</button>
          <button class="btn btn-p" style="padding:6px 12px;font-size:11px" onclick="saveEditDisc('${d.id}')">✔ Salvar</button>
        </div>
      </div>
      <div id="disc-aulas-${d.id}" class="disc-aulas-section">
        ${sortedAulas(aulas).map(a=>`<div class="aula-row">
          <div class="aula-row-info">
            <div class="aula-row-title">${a.codigo} — ${a.titulo}</div>
            <div class="aula-row-meta">${(a.tarefas||[]).length} tarefa(s) · ${(a.tarefas||[]).filter(t=>t.status==='concluida').length} concluída(s)</div>
          </div>
          <div class="aula-row-actions">
            ${discs.filter(x=>x.id!==d.id).length>0?`<select class="move-disc-select" id="ms-${a.id}">${discs.filter(x=>x.id!==d.id).map(x=>`<option value="${x.id}">${x.nome}</option>`).join('')}</select><button class="btn-icon" onclick="moverAula('${d.id}','${a.id}')">↗</button>`:''}
            <button class="btn-icon btn-icon-danger" onclick="deleteAula('${d.id}','${a.id}')">🗑️</button>
          </div>
        </div>`).join('')}
      </div>
    </div>`;
  }).join('');
}
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
  const container=document.getElementById('templatesContent'); if (!container) return;
  container.innerHTML=`<div style="color:var(--tx3);font-size:13px;padding:20px 0">Carregando...</div>`;
  try {
    const snap=await db.collection('templates').orderBy('criadoEm','desc').limit(30).get();
    if (snap.empty){ container.innerHTML=`<div class="empty-state"><div class="empty-state-icon">📋</div><div class="empty-state-title">Nenhum template disponível ainda</div><div class="empty-state-sub">Clique em "Publicar meu plano" para compartilhar.</div></div>`; return; }
    container.innerHTML=snap.docs.map(doc=>{ const t=doc.data(), isOwn=t.autorUid===currentUser?.uid;
      return `<div class="template-card" id="tpl-${t.id}">
        <div class="template-header">
          <div style="flex:1;min-width:0">
            <div id="tpl-view-${t.id}" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <span class="template-nome">${t.nome}</span>
              ${isOwn?'<span class="own-badge">SEU</span>':''}
              ${isOwn?`<button class="btn-icon" title="Renomear" onclick="editarNomeTemplate('${t.id}','${t.nome.replace(/'/g,"\'")}')">✏️</button>`:''}
            </div>
            <div id="tpl-edit-${t.id}" style="display:none;margin-top:6px">
              <div style="display:flex;gap:6px;align-items:center">
                <input id="tpl-input-${t.id}" value="${t.nome}" style="flex:1;font-size:13px">
                <button class="btn btn-p" style="padding:5px 10px;font-size:11px" onclick="salvarNomeTemplate('${t.id}')">✔</button>
                <button class="btn btn-g" style="padding:5px 10px;font-size:11px" onclick="cancelarEditTemplate('${t.id}')">✕</button>
              </div>
            </div>
            <div class="template-meta">por ${t.autor} · ${(t.disciplinas||[]).length} disciplinas · ${new Date(t.criadoEm).toLocaleDateString('pt-BR')}</div>
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0">
            ${isOwn?`<button class="btn btn-g" style="font-size:11px;padding:6px 10px" onclick="deletarTemplate('${t.id}')">🗑️</button>`:''}
            <button class="btn btn-p" style="font-size:12px" onclick="importarTemplate('${t.id}')">↓ Importar</button>
          </div>
        </div>
        <div class="template-discs">${(t.disciplinas||[]).map(d=>`<span class="disc-badge-sm" style="color:${d.cor};border-color:${d.cor}30;background:${d.cor}15">${d.nome}</span>`).join('')}</div>
      </div>`;
    }).join('');
  } catch(e){ container.innerHTML=`<div class="alert-box alert-info">Erro: ${e.code||e.message}</div>`; }
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
  document.getElementById('saudBlock').textContent=`${h<12?'Bom dia':h<18?'Boa tarde':'Boa noite'}! Foco total rumo à aprovação.`;
  renderHoje();
  renderDiscList();
  if (document.getElementById('tab-questoes')?.classList.contains('active'))  renderQuestoes();
  if (document.getElementById('tab-progresso')?.classList.contains('active')) renderProgresso();
  if (document.getElementById('tab-historico')?.classList.contains('active')) renderHistorico();
}
renderAll();
