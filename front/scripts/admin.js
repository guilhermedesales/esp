// ===== CONFIGURAÇÃO =====
const SUPABASE_URL = 'https://nyqvxezfiibojfdarsqn.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im55cXZ4ZXpmaWlib2pmZGFyc3FuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ1MTczOTQsImV4cCI6MjA4MDA5MzM5NH0.nYVYqH1FuSsGQ2j6RMXT-mlG_th-nKWoV02TDiFOSTo';

const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// MQTT - HiveMQ Cloud
const client = mqtt.connect('wss://3c16c837ea4f4ac0966899396b41ab08.s1.eu.hivemq.cloud:8884/mqtt', {
  username: 'guilherme',
  password: 'Guilherme123',
  protocol: 'wss'
});

client.on("connect", ()=>{
  console.log("MQTT Conectado");
  mqttConectado = true;
  atualizarStatusSistema();
  adicionarLog("✅ Conexão MQTT estabelecida");
  
  client.subscribe("estacionamento/acessos", (err)=>{
    if(!err) console.log("Inscrito em estacionamento/acessos");
  });
  client.subscribe("vaga/topico", (err)=>{
    if(!err) console.log("Inscrito em vaga/topico");
  });
  
  // Carregar dados históricos e estado inicial do Supabase
  carregarEstadoInicial();
  carregarDadosHistoricos().then(() => {
    renderizarGraficoAcessos();
  });
  
  // Atualizar status ESP32 a cada 5 segundos
  setInterval(atualizarStatusESP32, 5000);
  atualizarStatusESP32();
});

client.on("error", (err)=>{
  console.error("Erro MQTT:", err);
  mqttConectado = false;
  atualizarStatusSistema();
  adicionarLog("❌ Erro na conexão MQTT");
});

// Controle vagas
let bloqueado1=false, bloqueado2=false;
let valor1="livre", valor2="livre"; // Estados atuais das vagas
const statusEl1=document.getElementById("s1");
const statusEl2=document.getElementById("s2");
const btnBloq1=document.getElementById("btnBloq1");
const btnDesbloq1=document.getElementById("btnDesbloq1");
const btnBloq2=document.getElementById("btnBloq2");
const btnDesbloq2=document.getElementById("btnDesbloq2");

// Estados iniciais (serão carregados do banco ou via MQTT)
let totalAcessos=0;
let contVaga1=0, contVaga2=0;

// Históricos para gráficos
let historicoAcessos = [];

// Estado do sistema
let dbConectado = false;
let mqttConectado = false;
let ultimaAtualizacaoESP = null;

// Log de eventos (últimos 50)
let logEventos = [];

// Dados para cálculos de métricas
let mudancasVagasHoje = [];

// Controle para evitar salvar o mesmo acesso múltiplas vezes (múltiplas abas)
let ultimoAcessoTimestamp = 0;

function atualizarBotoes(){
  btnBloq1.className=bloqueado1?"btn disabled":"btn bloquear";
  btnDesbloq1.className=!bloqueado1?"btn disabled":"btn desbloquear";
  btnBloq2.className=bloqueado2?"btn disabled":"btn bloquear";
  btnDesbloq2.className=!bloqueado2?"btn disabled":"btn desbloquear";
}

client.on("message",(topic,msg)=>{
  msg=msg.toString();
  console.log("📨 MQTT recebido:");
  console.log("   Tópico:", topic);
  console.log("   Mensagem:", msg);
  
  if(topic=="estacionamento/acessos"){
    // IGNORA o valor do ESP - apenas incrementa 1
    // O banco é a fonte da verdade, não o ESP32
    totalAcessos++;
    console.log("✅ Novo acesso registrado! Total agora:", totalAcessos, "(ESP enviou:", msg, ")");
    document.getElementById("acessos").textContent=totalAcessos;
    ultimaAtualizacaoESP = Date.now();
    adicionarLog(`🚗 Novo acesso registrado (#${totalAcessos})`);
    adicionarAcesso();
  }
  
  if(topic=="vaga/topico"){
    // Formato: "vaga1:ocupada" ou "vaga2:livre" ou "vaga1:bloqueada"
    const partes = msg.split(":");
    console.log("   Split:", partes);
    
    if(partes.length !== 2) {
      console.error("❌ Formato inválido, esperado 'vaga:estado'");
      return;
    }
    
    const vaga = partes[0];  // "vaga1" ou "vaga2"
    const estado = partes[1]; // "ocupada", "livre" ou "bloqueada"
    
    console.log("   Vaga:", vaga, "| Estado:", estado);
    
    let el = vaga==="vaga1" ? statusEl1 : statusEl2;
    let estadoAnterior = vaga==="vaga1" ? valor1 : valor2;
    const numVaga = vaga==="vaga1" ? 1 : 2;

    console.log("   Estado anterior:", estadoAnterior);

    // Atualiza estado da vaga (agora inclui bloqueada)
    if(vaga==="vaga1") {
      valor1 = estado;
      // Atualiza flag de bloqueio local
      bloqueado1 = (estado === "bloqueada");
      console.log("   Valor1 agora:", valor1, "| Bloqueado1:", bloqueado1);
    }
    if(vaga==="vaga2") {
      valor2 = estado;
      // Atualiza flag de bloqueio local
      bloqueado2 = (estado === "bloqueada");
      console.log("   Valor2 agora:", valor2, "| Bloqueado2:", bloqueado2);
    }

    // Mostra status correto baseado no estado recebido
    if(estado==="bloqueada"){
      el.textContent="bloqueada";
      el.className="status status-bloqueada";
      console.log("   ⚠️ Exibindo como BLOQUEADA");
      adicionarLog(`⚠️ Vaga ${numVaga} bloqueada`);
    } else if(estado==="ocupada"){
      el.textContent="ocupada";
      el.className="status status-ocupada";
      console.log("   🔴 Exibindo como OCUPADA");
      ultimaAtualizacaoESP = Date.now();
      adicionarLog(`🔴 Vaga ${numVaga} ocupada`);
      
      // Incrementa contador em tempo real quando muda de livre/bloqueada para ocupada
      if(estadoAnterior!=="ocupada" && estadoAnterior!=="bloqueada"){
        if(vaga==="vaga1") {
          contVaga1++;
          console.log("   📊 ContVaga1:", contVaga1);
        }
        if(vaga==="vaga2") {
          contVaga2++;
          console.log("   📊 ContVaga2:", contVaga2);
        }
        atualizarGraficoVagas();
      }
    } else {
      el.textContent="livre";
      el.className="status status-livre";
      console.log("   🟢 Exibindo como LIVRE");
      ultimaAtualizacaoESP = Date.now();
      adicionarLog(`🟢 Vaga ${numVaga} liberada`);
    }
    
    // Salvar mudança no Supabase
    salvarMudancaVaga(numVaga, estado, estadoAnterior);

    atualizarBotoes();
    atualizarResumo();
    console.log("---");
  }
});

function bloquear(n){
  // Publica estado bloqueado direto no tópico principal
  client.publish("vaga/topico", `vaga${n}:bloqueada`);
  // Mantém compatibilidade com ESP32 antigo
  client.publish(`estacionamento/vaga${n}/bloqueio`,"true");
  adicionarLog(`🔒 Comando de bloqueio enviado para Vaga ${n}`);
}
function desbloquear(n){
  // Publica estado livre direto no tópico principal
  client.publish("vaga/topico", `vaga${n}:livre`);
  // Mantém compatibilidade com ESP32 antigo
  client.publish(`estacionamento/vaga${n}/bloqueio`,"false");
  adicionarLog(`🔓 Comando de desbloqueio enviado para Vaga ${n}`);
}

function enviarLCD(){
  const texto = document.getElementById("lcdInput").value;
  if(texto.length > 0){
    client.publish("estacionamento/lcd", texto);
    document.getElementById("lcdInput").value = "";
    adicionarLog(`📟 Mensagem LCD enviada: "${texto}"`);
  }
}

// GRÁFICO COMPARATIVO VAGAS
const ctx2=document.getElementById("graficoVagas").getContext("2d");
const dadosVagas={
  labels:["Vaga 1","Vaga 2"],
  datasets:[{label:"Uso",data:[0,0],backgroundColor:["#1976d2","#fbc02d"]}]
};
const graficoVagas=new Chart(ctx2,{type:"bar",data:dadosVagas,options:{responsive:true,scales:{y:{beginAtZero:true}}}});
function atualizarGraficoVagas(){
  dadosVagas.datasets[0].data=[contVaga1,contVaga2];
  graficoVagas.update();
}

// GRÁFICO DE ACESSOS
const ctx = document.getElementById("graficoAcessos").getContext("2d");
const dadosAcessos = { labels:[], datasets:[{label:"Acessos",data:[], borderColor:"#1976d2", backgroundColor:"#90caf9", fill:true}] };
const graficoAcessos = new Chart(ctx, {type:"bar", data:dadosAcessos, options:{responsive:true,scales:{y:{beginAtZero:true}}}});

// GRÁFICO DE OCUPAÇÃO PERCENTUAL (PIZZA)
const ctxOcupacao = document.getElementById("graficoOcupacao").getContext("2d");
const dadosOcupacao = {
  labels:["Livre","Ocupada","Bloqueada"],
  datasets:[{
    label:"Ocupação",
    data:[2,0,0],
    backgroundColor:["#388e3c","#d32f2f","#fbc02d"]
  }]
};
const graficoOcupacao = new Chart(ctxOcupacao,{
  type:"doughnut",
  data:dadosOcupacao,
  options:{responsive:true,plugins:{legend:{position:'bottom'}}}
});

// Atualiza resumo e gráfico de ocupação
function atualizarResumo(){
  let livres = 0;
  let ocupadas = 0;
  let bloqueadas = 0;

  // Vaga 1
  if(bloqueado1) {
    bloqueadas++;
  } else if(valor1==="ocupada") {
    ocupadas++;
  } else {
    livres++;
  }

  // Vaga 2
  if(bloqueado2) {
    bloqueadas++;
  } else if(valor2==="ocupada") {
    ocupadas++;
  } else {
    livres++;
  }

  document.getElementById("livres").textContent = livres;
  document.getElementById("ocupadas").textContent = ocupadas;
  
  // Atualiza gráfico de pizza
  dadosOcupacao.datasets[0].data = [livres, ocupadas, bloqueadas];
  graficoOcupacao.update();
}

// Inicializa resumo
atualizarResumo();

async function adicionarAcesso(){
  const now = new Date();
  const nowTimestamp = now.getTime();
  
  // Verifica se já foi salvo há menos de 2 segundos (múltiplas abas)
  if(nowTimestamp - ultimoAcessoTimestamp < 2000) {
    console.log('⏭️ Acesso ignorado (já salvo por outra aba há menos de 2s)');
    return;
  }
  
  ultimoAcessoTimestamp = nowTimestamp;
  historicoAcessos.push(now);
  // Usa renderizarGraficoAcessos() para apenas atualizar visual
  // NÃO usa atualizarGraficoAcessos() que recarrega tudo do banco
  renderizarGraficoAcessos();
  
  // Salvar no Supabase
  try {
    const { error } = await supabase
      .from('acessos')
      .insert({ 
        timestamp: now.toISOString(),
        total: totalAcessos
      });
    
    if(error) {
      console.error('Erro ao salvar acesso:', error);
      // Se falhou, reseta timestamp para permitir retry
      ultimoAcessoTimestamp = 0;
    } else {
      console.log('✅ Acesso salvo no Supabase');
      // Recalcular horário de pico
      calcularHorarioPico();
    }
  } catch(e) {
    console.error('Erro Supabase:', e);
    // Se falhou, reseta timestamp para permitir retry
    ultimoAcessoTimestamp = 0;
  }
}

// Função para salvar mudança de estado de vaga
async function salvarMudancaVaga(numeroVaga, estadoNovo, estadoAnterior){
  // Só salva se o estado realmente mudou
  if(estadoNovo === estadoAnterior) {
    console.log(`⏭️ Estado da vaga ${numeroVaga} não mudou (${estadoNovo}), não salva no banco`);
    return false;
  }
  
  try {
    const { error } = await supabase
      .from('historico_vagas')
      .insert({
        numero_vaga: numeroVaga,
        estado_anterior: estadoAnterior,
        estado_novo: estadoNovo,
        timestamp: new Date().toISOString()
      });
    
    if(error) {
      console.error('Erro ao salvar mudança:', error);
      return false;
    } else {
      console.log(`✅ Mudança vaga ${numeroVaga} salva`);
      
      // Adicionar mudança ao array local e recalcular métricas
      mudancasVagasHoje.push({
        numero_vaga: numeroVaga,
        estado_anterior: estadoAnterior,
        estado_novo: estadoNovo,
        timestamp: new Date().toISOString()
      });
      await calcularMetricas();
      
      return true;
    }
  } catch(e) {
    console.error('Erro Supabase:', e);
    return false;
  }
}

// Carregar estado inicial das vagas do banco
async function carregarEstadoInicial(){
  try {
    // Buscar última mudança de cada vaga
    const { data: vaga1, error: error1 } = await supabase
      .from('historico_vagas')
      .select('estado_novo')
      .eq('numero_vaga', 1)
      .order('timestamp', { ascending: false })
      .limit(1);
    
    const { data: vaga2, error: error2 } = await supabase
      .from('historico_vagas')
      .select('estado_novo')
      .eq('numero_vaga', 2)
      .order('timestamp', { ascending: false })
      .limit(1);
    
    // Aplicar estado da vaga 1 (ou deixar livre se não houver dado)
    if(!error1 && vaga1 && vaga1.length > 0){
      const estado = vaga1[0].estado_novo;
      valor1 = estado;
      bloqueado1 = (estado === "bloqueada");
      statusEl1.textContent = estado;
      statusEl1.className = `status status-${estado}`;
      console.log(`✅ Vaga 1 carregada do banco: ${estado}`);
    } else {
      // Fallback: deixar livre
      valor1 = "livre";
      statusEl1.textContent = "livre";
      statusEl1.className = "status status-livre";
      console.log('💡 Vaga 1 iniciada como livre (sem dados no banco)');
    }
    
    // Aplicar estado da vaga 2 (ou deixar livre se não houver dado)
    if(!error2 && vaga2 && vaga2.length > 0){
      const estado = vaga2[0].estado_novo;
      valor2 = estado;
      bloqueado2 = (estado === "bloqueada");
      statusEl2.textContent = estado;
      statusEl2.className = `status status-${estado}`;
      console.log(`✅ Vaga 2 carregada do banco: ${estado}`);
    } else {
      // Fallback: deixar livre
      valor2 = "livre";
      statusEl2.textContent = "livre";
      statusEl2.className = "status status-livre";
      console.log('💡 Vaga 2 iniciada como livre (sem dados no banco)');
    }
    
    // Carregar total de acessos do dia (CONTAR todos registros de hoje)
    const hoje = new Date();
    hoje.setHours(0,0,0,0);
    const { data: acessosHoje, error: errorAcessos } = await supabase
      .from('acessos')
      .select('*', { count: 'exact' })
      .gte('timestamp', hoje.toISOString());
    
    if(!errorAcessos && acessosHoje){
      totalAcessos = acessosHoje.length; // Conta quantos registros tem hoje
      document.getElementById('acessos').textContent = totalAcessos;
      console.log(`✅ Total de acessos do dia carregado: ${totalAcessos} registros`);
    } else {
      totalAcessos = 0;
      document.getElementById('acessos').textContent = 0;
      console.log('💡 Total de acessos iniciado em 0 (sem dados do dia)');
    }
    
    // Carregar contadores de uso das vagas (quantas vezes ficaram ocupadas hoje)
    const { data: mudancasHoje, error: errorMudancas } = await supabase
      .from('historico_vagas')
      .select('numero_vaga, estado_novo')
      .gte('timestamp', hoje.toISOString())
      .eq('estado_novo', 'ocupada');
    
    if(!errorMudancas && mudancasHoje){
      contVaga1 = mudancasHoje.filter(m => m.numero_vaga === 1).length;
      contVaga2 = mudancasHoje.filter(m => m.numero_vaga === 2).length;
      atualizarGraficoVagas();
      console.log(`✅ Contadores carregados - Vaga1: ${contVaga1}, Vaga2: ${contVaga2}`);
    } else {
      contVaga1 = 0;
      contVaga2 = 0;
      atualizarGraficoVagas();
      console.log('💡 Contadores iniciados em 0 (sem dados do dia)');
    }
    
    atualizarBotoes();
    atualizarResumo();
    
    // Marcar DB como conectado
    dbConectado = true;
    atualizarStatusSistema();
    adicionarLog("✅ Estado inicial carregado do banco de dados");
    
    // Carregar mudanças das vagas para cálculos de métricas
    await carregarMudancasVagasHoje();
    
    // Calcular métricas
    await calcularMetricas();
    
  } catch(e) {
    console.warn('⚠️ Erro ao carregar estado inicial:', e.message);
    dbConectado = false;
    atualizarStatusSistema();
    adicionarLog("⚠️ Erro ao carregar estado inicial do banco");
    // Fallback: deixar tudo livre e contadores zerados
    valor1 = "livre";
    valor2 = "livre";
    statusEl1.textContent = "livre";
    statusEl1.className = "status status-livre";
    statusEl2.textContent = "livre";
    statusEl2.className = "status status-livre";
    totalAcessos = 0;
    document.getElementById('acessos').textContent = 0;
    contVaga1 = 0;
    contVaga2 = 0;
    atualizarBotoes();
    atualizarResumo();
    atualizarGraficoVagas();
    console.log('💡 Sistema iniciado com valores padrão (fallback)');
  }
}

// Carregar dados históricos do banco
async function carregarDadosHistoricos(){
  try {
    // Determinar período baseado no filtro atual
    const filtro = document.getElementById("filtroTempo").value;
    const agora = new Date();
    let dataInicio = new Date();
    
    if(filtro === "dia"){
      dataInicio.setHours(0,0,0,0);
    } else if(filtro === "semana"){
      dataInicio.setDate(agora.getDate() - agora.getDay());
      dataInicio.setHours(0,0,0,0);
    } else if(filtro === "mes"){
      dataInicio.setDate(1);
      dataInicio.setHours(0,0,0,0);
    }
    
    const { data: acessos, error } = await supabase
      .from('acessos')
      .select('timestamp')
      .gte('timestamp', dataInicio.toISOString())
      .order('timestamp', { ascending: true });
    
    if(error) {
      console.warn('⚠️ Supabase não configurado corretamente:', error.message);
      console.log('💡 Gráficos funcionarão apenas com novos dados via MQTT');
      return;
    }
    
    if(acessos){
      historicoAcessos = acessos.map(a => new Date(a.timestamp));
      console.log(`✅ Carregados ${acessos.length} acessos do período selecionado`);
    }
  } catch(e) {
    console.warn('⚠️ Erro ao carregar histórico:', e.message);
    console.log('💡 Gráficos funcionarão apenas com novos dados via MQTT');
  }
}

// Função que recarrega do banco (chamada apenas quando filtro mudar)
async function atualizarGraficoAcessos(){
  await carregarDadosHistoricos();
  renderizarGraficoAcessos();
}

// Função que apenas renderiza com dados já em memória
function renderizarGraficoAcessos(){
  const filtro = document.getElementById("filtroTempo").value;
  let labels=[], counts=[];
  const now=new Date();

  if(filtro==="dia"){ // Últimas 24h, por hora
    for(let h=0; h<24; h++){
      labels.push(h+":00");
      counts.push(historicoAcessos.filter(d=>d.getHours()===h && sameDay(d,now)).length);
    }
  } else if(filtro==="semana"){ // Dias da semana atual
    const dias=["Dom","Seg","Ter","Qua","Qui","Sex","Sáb"];
    for(let i=0;i<7;i++){
      labels.push(dias[i]);
      counts.push(historicoAcessos.filter(d=>d.getDay()===i && sameWeek(d,now)).length);
    }
  } else if(filtro==="mes"){ // Dias do mês atual
    const diasDoMes = new Date(now.getFullYear(), now.getMonth()+1,0).getDate();
    for(let d=1; d<=diasDoMes; d++){
      labels.push(d.toString());
      counts.push(historicoAcessos.filter(x=>x.getDate()===d && x.getMonth()===now.getMonth() && x.getFullYear()===now.getFullYear()).length);
    }
  }

  dadosAcessos.labels=labels;
  dadosAcessos.datasets[0].data=counts;
  graficoAcessos.update();
}

function sameDay(d1,d2){
  return d1.getDate()===d2.getDate() && d1.getMonth()===d2.getMonth() && d1.getFullYear()===d2.getFullYear();
}
function sameWeek(d1,d2){
  const onejan=new Date(d2.getFullYear(),0,1);
  const weekNum = Math.ceil((((d2-onejan)/86400000)+onejan.getDay()+1)/7);
  const weekNum2= Math.ceil((((d1-onejan)/86400000)+onejan.getDay()+1)/7);
  return weekNum===weekNum2;
}

// ===== FUNÇÕES DE LOG E STATUS =====
function adicionarLog(mensagem) {
  const timestamp = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  logEventos.unshift({ timestamp, mensagem });
  
  // Manter apenas últimos 50 eventos
  if(logEventos.length > 50) {
    logEventos = logEventos.slice(0, 50);
  }
  
  atualizarLogVisual();
}

function atualizarLogVisual() {
  const logContainer = document.getElementById('logEventos');
  if(!logContainer) return;
  
  if(logEventos.length === 0) {
    logContainer.innerHTML = '<div style="text-align:center; color:#999; padding:20px;">Aguardando eventos...</div>';
    return;
  }
  
  logContainer.innerHTML = logEventos.map(log => `
    <div style="padding:8px; border-bottom:1px solid #eee; display:flex; justify-content:space-between; align-items:center;">
      <span style="flex:1;">${log.mensagem}</span>
      <span style="color:#999; font-size:11px; white-space:nowrap; margin-left:10px;">${log.timestamp}</span>
    </div>
  `).join('');
}

function atualizarStatusSistema() {
  const statusMQTT = document.getElementById('statusMQTT');
  const statusDB = document.getElementById('statusDB');
  
  if(statusMQTT) {
    statusMQTT.textContent = mqttConectado ? '● Conectado' : '● Desconectado';
    statusMQTT.style.color = mqttConectado ? '#4caf50' : '#f44336';
  }
  
  if(statusDB) {
    statusDB.textContent = dbConectado ? '● Conectado' : '● Desconectado';
    statusDB.style.color = dbConectado ? '#4caf50' : '#f44336';
  }
}

function atualizarStatusESP32() {
  const statusEl = document.getElementById('esp32Status');
  if(!statusEl) return;
  
  if(!ultimaAtualizacaoESP) {
    statusEl.textContent = 'Aguardando...';
    statusEl.style.color = '#999';
    return;
  }
  
  const diff = Date.now() - ultimaAtualizacaoESP;
  const segundos = Math.floor(diff / 1000);
  
  if(segundos < 30) {
    statusEl.textContent = '🟢 Online';
    statusEl.style.color = '#4caf50';
  } else if(segundos < 120) {
    statusEl.textContent = '🟡 Inativo';
    statusEl.style.color = '#ff9800';
  } else {
    statusEl.textContent = '🔴 Offline';
    statusEl.style.color = '#f44336';
  }
}

function atualizarUltimaAtualizacao() {
  const ultimaAttEl = document.getElementById('ultimaAtt');
  if(!ultimaAttEl) return;
  
  if(!ultimaAtualizacaoESP) {
    ultimaAttEl.textContent = 'Nunca';
    return;
  }
  
  const agora = Date.now();
  const diff = agora - ultimaAtualizacaoESP;
  const segundos = Math.floor(diff / 1000);
  const minutos = Math.floor(segundos / 60);
  
  if(minutos < 1) {
    ultimaAttEl.textContent = `${segundos}s atrás`;
  } else if(minutos < 60) {
    ultimaAttEl.textContent = `${minutos}min atrás`;
  } else {
    const horas = Math.floor(minutos / 60);
    ultimaAttEl.textContent = `${horas}h atrás`;
  }
}

// ===== FUNÇÕES DE CÁLCULO DE MÉTRICAS =====
async function carregarMudancasVagasHoje() {
  try {
    const hoje = new Date();
    hoje.setHours(0,0,0,0);
    
    const { data, error } = await supabase
      .from('historico_vagas')
      .select('numero_vaga, estado_anterior, estado_novo, timestamp')
      .gte('timestamp', hoje.toISOString())
      .order('timestamp', { ascending: true });
    
    if(!error && data) {
      mudancasVagasHoje = data;
      console.log(`✅ Carregadas ${data.length} mudanças de vagas de hoje`);
    }
  } catch(e) {
    console.warn('⚠️ Erro ao carregar mudanças das vagas:', e.message);
  }
}

async function calcularMetricas() {
  calcularTaxaOcupacao();
  await calcularTempoMedio();
  calcularHorarioPico();
}

function calcularTaxaOcupacao() {
  const taxaEl = document.getElementById('taxaOcupacao');
  if(!taxaEl) return;
  
  // Calcular taxa de ocupação instantânea (quantas vagas estão ocupadas agora)
  const NUM_VAGAS = 2;
  let vagasOcupadas = 0;
  
  if(valor1 === 'ocupada') vagasOcupadas++;
  if(valor2 === 'ocupada') vagasOcupadas++;
  
  const taxaOcupacao = (vagasOcupadas / NUM_VAGAS) * 100;
  
  taxaEl.textContent = Math.round(taxaOcupacao);
}

async function calcularTempoMedio() {
  const tempoEl = document.getElementById('tempoMedio');
  if(!tempoEl) return;

  try {
    // Buscar últimas 200 mudanças para processar pares ocupada->livre
    const { data, error } = await supabase
      .from('historico_vagas')
      .select('numero_vaga, estado_anterior, estado_novo, timestamp')
      .order('timestamp', { ascending: false })
      .limit(200);

    if(error || !data) {
      console.log('💡 Não foi possível carregar histórico para tempo médio');
      // fallback: manter cálculo local se existir
      if(window.temposOcupacao && window.temposOcupacao.length) {
        const mediaMs = window.temposOcupacao.reduce((a,b)=>a+b,0)/window.temposOcupacao.length;
        tempoEl.textContent = formatarTempoAdmin(mediaMs);
        return;
      }
      tempoEl.textContent = '--';
      return;
    }

    // Processar cronologicamente
    const historico = data.reverse();
    const timestampsOcupacao = {};
    const ocupacoesCompletas = []; // {duracao, timestampFim}

    for(const mudanca of historico) {
      const vagaNum = mudanca.numero_vaga;
      const ts = new Date(mudanca.timestamp).getTime();

      if(mudanca.estado_novo === 'ocupada' && mudanca.estado_anterior !== 'ocupada') {
        timestampsOcupacao[vagaNum] = ts;
      } else if(mudanca.estado_anterior === 'ocupada' && mudanca.estado_novo === 'livre') {
        if(timestampsOcupacao[vagaNum]) {
          const duracao = ts - timestampsOcupacao[vagaNum];
          // Ignorar ocupações muito curtas (<5s)
          if(duracao >= 5000) {
            ocupacoesCompletas.push({ duracao, timestampFim: ts });
          }
          delete timestampsOcupacao[vagaNum];
        }
      }
    }

    // Ordenar por fim mais recente e pegar últimas 30
    ocupacoesCompletas.sort((a,b) => b.timestampFim - a.timestampFim);
    const ultimas = ocupacoesCompletas.slice(0,30).map(o => o.duracao);

    if(ultimas.length === 0) {
      tempoEl.textContent = '--';
      return;
    }

    const mediaMs = ultimas.reduce((a,b)=>a+b,0)/ultimas.length;
    tempoEl.textContent = formatarTempoAdmin(mediaMs);
  } catch(e) {
    console.warn('Erro ao calcular tempo médio (admin):', e.message);
  }
}

function formatarTempoAdmin(ms) {
  const segundos = Math.floor(ms / 1000);
  const minutos = Math.floor(segundos / 60);
  const horas = Math.floor(minutos / 60);

  if(segundos < 60) return `${segundos}s`;
  if(minutos < 60) return `${minutos}min ${segundos % 60}s`;
  return `${horas}h ${minutos % 60}min`;
}

function calcularHorarioPico() {
  const picoEl = document.getElementById('horarioPico');
  if(!picoEl) return;
  
  if(historicoAcessos.length === 0) {
    picoEl.textContent = '--';
    return;
  }
  
  // Contar acessos por hora
  const hoje = new Date();
  const acessosHoje = historicoAcessos.filter(d => sameDay(d, hoje));
  
  if(acessosHoje.length === 0) {
    picoEl.textContent = '--';
    return;
  }
  
  const contagemPorHora = {};
  for(let h = 0; h < 24; h++) {
    contagemPorHora[h] = 0;
  }
  
  acessosHoje.forEach(d => {
    contagemPorHora[d.getHours()]++;
  });
  
  // Encontrar hora com mais acessos
  let maxHora = 0;
  let maxAcessos = 0;
  
  for(let h = 0; h < 24; h++) {
    if(contagemPorHora[h] > maxAcessos) {
      maxAcessos = contagemPorHora[h];
      maxHora = h;
    }
  }
  
  if(maxAcessos === 0) {
    picoEl.textContent = '--';
  } else {
    picoEl.textContent = `${maxHora}:00`;
  }
}

// Atualizar última atualização ESP32 a cada 10 segundos
setInterval(() => {
  atualizarUltimaAtualizacao();
  atualizarStatusESP32();
}, 10000);

// ========================================
// SISTEMA QR CODE - PAGAMENTOS
// ========================================
const API_URL = 'http://127.0.0.1:3000';

async function atualizarEstatisticasQR() {
  try {
    console.log('📊 Atualizando estatísticas QR...');
    const res = await fetch(`${API_URL}/api/dashboard/stats`);
    console.log('✅ Stats resposta:', res.status);
    if (!res.ok) {
      console.warn('⚠️ Stats falhou:', res.status, res.statusText);
      return;
    }
    const data = await res.json();
    console.log('📊 Dados recebidos:', data);
    
    const e1 = document.getElementById('entradasHoje');
    const e2 = document.getElementById('saidasHoje');
    const e3 = document.getElementById('faturamentoHoje');
    
    if (e1) e1.textContent = data.entradas_hoje || 0;
    if (e2) e2.textContent = data.saidas_hoje || 0;
    if (e3) e3.textContent = `R$ ${(data.faturamento_hoje || 0).toFixed(2)}`;
    
    console.log('✅ Stats atualizado na tela');
  } catch (err) {
    console.error('❌ Erro stats QR:', err);
    if (err.name === 'TypeError' && err.message.includes('Failed to fetch')) {
      console.error('💡 Dica: Backend pode estar offline ou CORS bloqueado');
    }
  }
}

async function carregarPrecosQR() {
  try {
    const res = await fetch(`${API_URL}/api/config/pricing`);
    if (!res.ok) return;
    const cfg = await res.json();
    
    const t = document.getElementById('tipoCobranca');
    const v = document.getElementById('valorUnidade');
    const min = document.getElementById('valorMinimo');
    const max = document.getElementById('valorMaximo');
    
    if (t) t.value = cfg.tipo_cobranca;
    if (v) v.value = parseFloat(cfg.valor_unidade);
    if (min) min.value = parseFloat(cfg.valor_minimo);
    if (max) max.value = parseFloat(cfg.valor_maximo || 0);
  } catch (err) {
    console.error('Erro preços QR:', err);
  }
}

async function salvarPrecosQR() {
  const cfg = {
    tipo_cobranca: document.getElementById('tipoCobranca').value,
    valor_unidade: parseFloat(document.getElementById('valorUnidade').value),
    valor_minimo: parseFloat(document.getElementById('valorMinimo').value),
    valor_maximo: parseFloat(document.getElementById('valorMaximo').value) || null
  };
  
  try {
    const res = await fetch(`${API_URL}/api/config/pricing`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg)
    });
    
    if (res.ok) {
      mostrarMsgQR('✅ Salvo!', 'success');
      carregarPrecosQR();
    } else {
      mostrarMsgQR('❌ Erro ao salvar', 'error');
    }
  } catch (err) {
    console.error('Erro salvar QR:', err);
    mostrarMsgQR('❌ Erro de conexão', 'error');
  }
}

function mostrarMsgQR(texto, tipo) {
  const msg = document.getElementById('msgConfig');
  if (!msg) return;
  
  msg.textContent = texto;
  msg.style.display = 'block';
  msg.style.background = tipo === 'success' ? '#d4edda' : '#f8d7da';
  msg.style.color = tipo === 'success' ? '#155724' : '#721c24';
  
  setTimeout(() => msg.style.display = 'none', 3000);
}

async function carregarVeiculosQRAtivos() {
  try {
    const res = await fetch(`${API_URL}/api/vehicles/active`);
    if (!res.ok) return;
    const data = await res.json();
    
    const lista = document.getElementById('listaVeiculosQR');
    if (!lista) return;
    
    if (!data.veiculos || data.veiculos.length === 0) {
      lista.innerHTML = '<div style="padding:20px; text-align:center; color:#999;">Nenhum veículo</div>';
      return;
    }
    
    lista.innerHTML = data.veiculos.map(v => {
      const val = v.valor_atual || v.valor_calculado || 0;
      return `
        <div style="padding:12px; background:#f8f9fa; border-radius:8px; margin-bottom:8px; display:flex; justify-content:space-between;">
          <div>
            <strong>${v.qr_code}</strong>
            <div style="font-size:12px; color:#666;">${v.tempo_formatado || '--'}</div>
          </div>
          <strong style="color:#667eea;">R$ ${parseFloat(val).toFixed(2)}</strong>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error('Erro veículos QR:', err);
  }
}

async function carregarHistoricoQR() {
  try {
    const res = await fetch(`${API_URL}/api/vehicles/all`);
    if (!res.ok) return;
    const data = await res.json();
    
    const tb = document.getElementById('historicoQRTabela');
    if (!tb) return;
    
    if (!data.veiculos || data.veiculos.length === 0) {
      tb.innerHTML = '<tr><td colspan="6" style="padding:20px; text-align:center; color:#999;">Sem registros</td></tr>';
      return;
    }
    
    const badges = {
      ativo: '🟢 Ativo',
      aguardando_pagamento: '💳 Aguardando',
      pago: '✅ Pago'
    };
    
    tb.innerHTML = data.veiculos.map(v => {
      const val = v.valor_calculado || v.valor_atual_calc || 0;
      return `
        <tr>
          <td style="padding:12px;"><strong>${v.qr_code}</strong></td>
          <td style="padding:12px;">${new Date(v.entrada).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</td>
          <td style="padding:12px;">${v.saida ? new Date(v.saida).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '--'}</td>
          <td style="padding:12px;">${v.tempo_formatado || '--'}</td>
          <td style="padding:12px;"><strong>R$ ${parseFloat(val).toFixed(2)}</strong></td>
          <td style="padding:12px;">${badges[v.status] || v.status}</td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    console.error('Erro histórico QR:', err);
  }
}

function atualizarTudoQR() {
  atualizarEstatisticasQR();
  carregarVeiculosQRAtivos();
  carregarHistoricoQR();
}

// Inicializar sistema QR (se existir no HTML)
if (document.getElementById('tipoCobranca')) {
  console.log('✅ Módulo QR Code detectado');
  carregarPrecosQR();
  atualizarTudoQR();
  setInterval(atualizarTudoQR, 5000);
}
