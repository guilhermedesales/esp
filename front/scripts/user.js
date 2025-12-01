// ===== CONFIGURAÇÃO =====
const NUM_VAGAS = 2; // ALTERE AQUI para adicionar mais vagas (ex: 3, 4, 5...)

const SUPABASE_URL = 'https://nyqvxezfiibojfdarsqn.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im55cXZ4ZXpmaWlib2pmZGFyc3FuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ1MTczOTQsImV4cCI6MjA4MDA5MzM5NH0.nYVYqH1FuSsGQ2j6RMXT-mlG_th-nKWoV02TDiFOSTo';

const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const totalDiv = document.getElementById('total');
const statusBadge = document.getElementById('status-badge');
const ultimaAtualizacao = document.getElementById('ultima-atualizacao');
const vagasContainer = document.getElementById('vagas-container');

// Estruturas dinâmicas
let vagas = {}; // {1: {estado: 'livre', livre: 1, timestamp: null, div: element}}
let temposOcupacao = []; // Armazena últimas 30 durações

// Criar vagas dinamicamente
document.getElementById('total-vagas').textContent = NUM_VAGAS;
for(let i = 1; i <= NUM_VAGAS; i++) {
  const vagaDiv = document.createElement('div');
  vagaDiv.id = `vaga${i}`;
  vagaDiv.className = 'vaga livre';
  vagaDiv.innerHTML = `
    <span class="vaga-icon">✅</span>
    <span class="vaga-label">Vaga ${i}</span>
    <span>Livre</span>
  `;
  vagasContainer.appendChild(vagaDiv);
  
  vagas[i] = {
    estado: 'livre',
    livre: 1,
    timestamp: null,
    div: vagaDiv
  };
}

// Atualizar contador inicial
atualizarTotal();

// Configuração HiveMQ Cloud
const client = mqtt.connect('wss://3c16c837ea4f4ac0966899396b41ab08.s1.eu.hivemq.cloud:8884/mqtt', {
  username: 'guilherme',
  password: 'Guilherme123',
  protocol: 'wss'
});

client.on('connect', () => {
  console.log('✅ Conectado ao MQTT');
  client.subscribe('vaga/topico');
  statusBadge.textContent = '● Sistema Online';
  statusBadge.classList.remove('offline');
  statusBadge.classList.add('online');
  
  // Carregar estado inicial das vagas
  carregarEstadoInicial();
});

client.on('error', () => {
  statusBadge.textContent = 'Offline';
  statusBadge.classList.remove('online');
  statusBadge.classList.add('offline');
});

client.on('close', () => {
  statusBadge.textContent = 'Desconectado';
  statusBadge.classList.remove('online');
  statusBadge.classList.add('offline');
});

function atualizarHora() {
  const agora = new Date();
  const hora = agora.toLocaleTimeString('pt-BR');
  ultimaAtualizacao.textContent = `Última atualização: ${hora}`;
}

function atualizarTotal() {
  const livres = Object.values(vagas).reduce((sum, v) => sum + v.livre, 0);
  const classe = livres === 0 ? 'nenhuma' : '';
  totalDiv.innerHTML = `
    <div style="font-size:16px; color:#666; margin-bottom:10px; text-transform:uppercase; letter-spacing:1px;">Vagas Livres</div>
    <span class="total-number ${classe}">${livres}</span>
    <div style="font-size:14px; color:#999; margin-top:8px;">de ${NUM_VAGAS} disponíveis</div>
  `;
  
  // Mostrar/esconder alerta de lotado
  const alertaLotado = document.getElementById('alerta-lotado');
  if(livres === 0) {
    alertaLotado.style.display = 'block';
    atualizarTempoEspera();
  } else {
    alertaLotado.style.display = 'none';
  }
}

function formatarTempo(ms) {
  const segundos = Math.floor(ms / 1000);
  const minutos = Math.floor(segundos / 60);
  const horas = Math.floor(minutos / 60);
  
  if(segundos < 60) return `${segundos}s`;
  if(minutos < 60) return `${minutos}min ${segundos % 60}s`;
  return `${horas}h ${minutos % 60}min`;
}

function calcularTempoMedio() {
  if(temposOcupacao.length === 0) return null;
  const media = temposOcupacao.reduce((a, b) => a + b, 0) / temposOcupacao.length;
  return media;
}

function atualizarTempoEspera() {
  const media = calcularTempoMedio();
  const tempoEsperaEl = document.getElementById('tempo-espera');
  
  if(media) {
    tempoEsperaEl.textContent = `Tempo médio de espera: ${formatarTempo(media)}`;
  } else {
    tempoEsperaEl.textContent = 'Tempo médio de espera: aguardando dados...';
  }
}

function atualizarTempoMedioDisplay() {
  const media = calcularTempoMedio();
  const displayEl = document.getElementById('tempo-medio-user');
  
  if(media) {
    displayEl.textContent = formatarTempo(media);
  } else {
    displayEl.textContent = '--';
  }
}

function getIcone(estado) {
  if(estado === 'livre') return '✅';
  if(estado === 'ocupada') return '🚗';
  if(estado === 'bloqueada') return '🚫';
  return '❓';
}

function getTexto(estado) {
  if(estado === 'livre') return 'Livre';
  if(estado === 'ocupada') return 'Ocupada';
  if(estado === 'bloqueada') return 'Indisponível';
  return 'Carregando';
}

function atualizarVaga(div, numero, estado) {
  div.classList.remove('livre', 'ocupada', 'bloqueada', 'loading');
  div.classList.add(estado);
  
  const icone = getIcone(estado);
  const texto = getTexto(estado);
  
  div.innerHTML = `
    <span class="vaga-icon">${icone}</span>
    <span class="vaga-label">Vaga ${numero}</span>
    <span class="vaga-estado">${texto}</span>
  `;
  
  atualizarHora();
}

client.on('message', (topic, message) => {
  const status = message.toString();

  // Detectar mensagens de vagas (vaga1:livre, vaga2:ocupada, vaga1:bloqueada, etc)
  const match = status.match(/^vaga(\d+):(.+)$/);
  if(match) {
    const numVaga = parseInt(match[1]);
    const novoEstado = match[2];
    
    // Verificar se a vaga existe
    if(!vagas[numVaga]) {
      console.warn(`Vaga ${numVaga} não existe. Configure NUM_VAGAS para ${numVaga} ou mais.`);
      return;
    }
    
    const vaga = vagas[numVaga];
    const estadoAnterior = vaga.estado;
    vaga.estado = novoEstado;
    // Vaga só conta como livre se não estiver bloqueada
    vaga.livre = (novoEstado === "livre") ? 1 : 0;
    
    // Rastrear tempo de ocupação
    if(novoEstado === 'ocupada' && estadoAnterior !== 'ocupada') {
      vaga.timestamp = Date.now();
    } else if(estadoAnterior === 'ocupada' && novoEstado === 'livre') {
      if(vaga.timestamp) {
        const duracao = Date.now() - vaga.timestamp;
        // Ignorar ocupações muito curtas (< 5s) - provavelmente detecção acidental
        if(duracao >= 5000) {
          temposOcupacao.push(duracao);
          if(temposOcupacao.length > 30) temposOcupacao.shift();
          atualizarTempoMedioDisplay();
        } else {
          console.log(`⚠️ Ocupação muito curta ignorada: ${Math.floor(duracao/1000)}s`);
        }
        vaga.timestamp = null;
      }
    }
    
    atualizarVaga(vaga.div, numVaga, novoEstado);
    atualizarTotal();
  }
});

// Carregar estado inicial das vagas do banco
async function carregarEstadoInicial() {
  try {
    // Buscar última mudança de cada vaga com timestamp
    for(let i = 1; i <= NUM_VAGAS; i++) {
      const { data, error } = await supabase
        .from('historico_vagas')
        .select('estado_novo, estado_anterior, timestamp')
        .eq('numero_vaga', i)
        .order('timestamp', { ascending: false })
        .limit(1);
      
      if(!error && data && data.length > 0) {
        const estado = data[0].estado_novo;
        const vaga = vagas[i];
        vaga.estado = estado;
        vaga.livre = (estado === 'livre') ? 1 : 0;
        
        // Se vaga já está ocupada, marcar timestamp do banco (não do F5)
        if(estado === 'ocupada') {
          vaga.timestamp = new Date(data[0].timestamp).getTime();
        }
        
        atualizarVaga(vaga.div, i, estado);
        console.log(`✅ Vaga ${i} carregada do banco: ${estado}`);
      } else {
        console.log(`💡 Vaga ${i} mantida como livre (sem dados no banco)`);
      }
    }
    
    atualizarTotal();
    
    // Carregar tempo médio do banco
    await carregarTempoMedioDoBanco();
    
  } catch(e) {
    console.warn('⚠️ Erro ao carregar estado inicial:', e.message);
    console.log('💡 Sistema funcionará com estados padrão até receber MQTT');
  }
}

// Carregar tempo médio de permanência do banco (últimas 30 ocupações)
async function carregarTempoMedioDoBanco() {
  try {
    // Buscar histórico de mudanças ordenado por tempo (últimas 200 para garantir)
    const { data, error } = await supabase
      .from('historico_vagas')
      .select('numero_vaga, estado_anterior, estado_novo, timestamp')
      .order('timestamp', { ascending: false })
      .limit(200);
    
    if(error || !data) {
      console.log('💡 Não há dados suficientes para calcular tempo médio');
      return;
    }
    
    // Processar dados por vaga para encontrar pares ocupada->livre
    const ocupacoesCompletas = []; // {duracao, timestampFim}
    
    // Ordenar por tempo crescente para processar cronologicamente
    const historico = data.reverse();
    
    // Rastrear quando cada vaga ficou ocupada
    const timestampsOcupacao = {};
    
    for(const mudanca of historico) {
      const vagaNum = mudanca.numero_vaga;
      const timestamp = new Date(mudanca.timestamp).getTime();
      
      // Quando fica ocupada, marcar timestamp
      if(mudanca.estado_novo === 'ocupada' && mudanca.estado_anterior !== 'ocupada') {
        timestampsOcupacao[vagaNum] = timestamp;
      }
      // Quando libera, calcular duração e guardar com timestamp do fim
      else if(mudanca.estado_anterior === 'ocupada' && mudanca.estado_novo === 'livre') {
        if(timestampsOcupacao[vagaNum]) {
          const duracao = timestamp - timestampsOcupacao[vagaNum];
          // Ignorar ocupações muito curtas (< 5s) - provavelmente detecção acidental
          if(duracao >= 5000) {
            ocupacoesCompletas.push({
              duracao: duracao,
              timestampFim: timestamp
            });
          }
          delete timestampsOcupacao[vagaNum];
        }
      }
    }
    
    // Ordenar por timestamp do fim (mais recente primeiro) e pegar últimas 30
    ocupacoesCompletas.sort((a, b) => b.timestampFim - a.timestampFim);
    const ultimas30 = ocupacoesCompletas.slice(0, 30).map(o => o.duracao);
    
    if(ultimas30.length > 0) {
      temposOcupacao = ultimas30;
      atualizarTempoMedioDisplay();
      console.log(`✅ Tempo médio carregado: ${ultimas30.length} ocupações encontradas (≥5s)`);
    } else {
      console.log('💡 Nenhuma ocupação completa encontrada no histórico');
    }
    
  } catch(e) {
    console.warn('⚠️ Erro ao calcular tempo médio:', e.message);
  }
}

// Atualizar hora a cada segundo
setInterval(atualizarHora, 1000);

// === MODO NOTURNO ===
const themeToggle = document.getElementById('theme-toggle');
const body = document.body;

// Carregar preferência salva
const savedTheme = localStorage.getItem('theme');
if(savedTheme === 'dark') {
  body.classList.add('dark-mode');
  themeToggle.textContent = '☀️';
}

// Toggle ao clicar
themeToggle.addEventListener('click', () => {
  body.classList.toggle('dark-mode');
  
  if(body.classList.contains('dark-mode')) {
    themeToggle.textContent = '☀️';
    localStorage.setItem('theme', 'dark');
  } else {
    themeToggle.textContent = '🌙';
    localStorage.setItem('theme', 'light');
  }
});
