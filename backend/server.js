const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const QRCode = require('qrcode');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// =====================================================
// SISTEMA DE ARMAZENAMENTO (PostgreSQL ou Memória)
// =====================================================

// Configuração do PostgreSQL (Supabase)
let pool;
let useMemoryDB = false;

if (process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('[YOUR-PASSWORD]')) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    }
  });
  
  // Configurar timezone para America/Sao_Paulo em todas as conexões
  pool.on('connect', async (client) => {
    await client.query("SET timezone = 'America/Sao_Paulo'");
  });
  
  // Testar e configurar timezone
  pool.query("SET timezone = 'America/Sao_Paulo'").then(() => {
    console.log('✅ Conectado ao PostgreSQL (Supabase) - Timezone: America/Sao_Paulo');
  }).catch(err => {
    console.error('⚠️ Erro ao configurar timezone:', err.message);
  });
} else {
  useMemoryDB = true;
  console.log('⚠️  DATABASE_URL não configurado - usando modo de desenvolvimento em memória');
  console.log('💡 Para produção, configure DATABASE_URL no arquivo .env');
}

// Banco de dados em memória (para desenvolvimento)
const memoryDB = {
  veiculos: [],
  registros: [],
  config: {
    tipo_cobranca: 'por_segundo',
    valor_unidade: 0.00166, // R$ 1,00 por 10 minutos
    valor_minimo: 1.00,
    valor_maximo: 50.00
  },
  nextId: 1
};

// Funções auxiliares para cálculo de valores
function calcularValor(segundos) {
  const config = memoryDB.config;
  let unidades;
  
  switch (config.tipo_cobranca) {
    case 'por_segundo':
      unidades = segundos;
      break;
    case 'por_minuto':
      unidades = Math.ceil(segundos / 60);
      break;
    case 'por_hora':
      unidades = Math.ceil(segundos / 3600);
      break;
    default:
      unidades = segundos;
  }
  
  let valor = unidades * config.valor_unidade;
  
  // Aplicar mínimo e máximo
  if (valor < config.valor_minimo) valor = config.valor_minimo;
  if (config.valor_maximo && valor > config.valor_maximo) valor = config.valor_maximo;
  
  return Math.round(valor * 100) / 100; // Arredondar para 2 casas decimais
}

function formatarTempo(segundos) {
  const horas = Math.floor(segundos / 3600);
  const minutos = Math.floor((segundos % 3600) / 60);
  const segs = segundos % 60;
  
  if (horas > 0) return `${horas}h ${minutos}m ${segs}s`;
  if (minutos > 0) return `${minutos}m ${segs}s`;
  return `${segs}s`;
}

// Wrapper para queries que funciona com PostgreSQL ou memória
async function executeQuery(queryType, params) {
  if (!useMemoryDB) {
    // Usar PostgreSQL
    switch (queryType) {
      case 'check_active':
        return await pool.query(
          'SELECT * FROM veiculos WHERE qr_code = $1 AND status = $2',
          params
        );
      case 'insert_entry':
        return await pool.query(
          `INSERT INTO veiculos (qr_code, entrada, status) 
           VALUES ($1, CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo', 'ativo') 
           RETURNING *`,
          params
        );
      case 'insert_registro':
        return await pool.query(
          `INSERT INTO registros_estacionamento (veiculo_id, qr_code, tipo_evento, valor, detalhes)
           VALUES ($1, $2, $3, $4, $5)`,
          params
        );
      case 'update_saida':
        return await pool.query(
          `UPDATE veiculos 
           SET saida = CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo',
               tempo_permanencia = EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo' - entrada))::INTEGER,
               valor_calculado = calcular_valor_estacionamento(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo' - entrada))::INTEGER),
               status = 'aguardando_pagamento'
           WHERE qr_code = $1 AND status = 'ativo'
           RETURNING *`,
          params
        );
      case 'get_vehicle':
        return await pool.query(
          'SELECT * FROM veiculos WHERE qr_code = $1 ORDER BY id DESC LIMIT 1',
          params
        );
      case 'delete_vehicle':
        return await pool.query(
          'DELETE FROM veiculos WHERE id = $1',
          params
        );
      case 'confirm_payment':
        return await pool.query(
          `UPDATE veiculos 
           SET valor_pago = $1, status = 'pago', pago_em = CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo'
           WHERE id = $2
           RETURNING *`,
          params
        );
      case 'list_active':
        return await pool.query(
          'SELECT * FROM veiculos_ativos ORDER BY entrada DESC'
        );
      case 'get_stats':
        return await pool.query('SELECT * FROM dashboard_veiculos');
      case 'get_config':
        return await pool.query(
          'SELECT * FROM configuracao_precos WHERE ativo = TRUE ORDER BY id DESC LIMIT 1'
        );
      case 'update_config':
        return await pool.query(
          `UPDATE configuracao_precos 
           SET tipo_cobranca = $1, valor_unidade = $2, valor_minimo = $3, valor_maximo = $4
           WHERE ativo = TRUE
           RETURNING *`,
          params
        );
    }
  } else {
    // Usar memória
    const now = new Date();
    
    switch (queryType) {
      case 'check_active':
        const [qr_code, status] = params;
        const active = memoryDB.veiculos.filter(v => v.qr_code === qr_code && v.status === status);
        return { rows: active };
      
      case 'insert_entry':
        const [qr] = params;
        const newVeiculo = {
          id: memoryDB.nextId++,
          qr_code: qr,
          entrada: now,
          saida: null,
          tempo_permanencia: null,
          valor_calculado: null,
          valor_pago: null,
          status: 'ativo',
          pago_em: null
        };
        memoryDB.veiculos.push(newVeiculo);
        memoryDB.registros.push({
          veiculo_id: newVeiculo.id,
          qr_code: qr,
          tipo_evento: 'entrada',
          timestamp: now,
          valor: null
        });
        return { rows: [newVeiculo] };
      
      case 'update_saida':
        const [qr_saida] = params;
        const veiculo = memoryDB.veiculos.find(v => v.qr_code === qr_saida && v.status === 'ativo');
        if (veiculo) {
          const segundos = Math.floor((now - veiculo.entrada) / 1000);
          veiculo.saida = now;
          veiculo.tempo_permanencia = segundos;
          veiculo.valor_calculado = calcularValor(segundos);
          veiculo.status = 'aguardando_pagamento';
          
          memoryDB.registros.push({
            veiculo_id: veiculo.id,
            qr_code: qr_saida,
            tipo_evento: 'saida',
            timestamp: now,
            valor: veiculo.valor_calculado
          });
          
          return { rows: [veiculo] };
        }
        return { rows: [] };
      
      case 'get_vehicle':
        const [qr_get] = params;
        const found = memoryDB.veiculos.filter(v => v.qr_code === qr_get);
        return { rows: found.length > 0 ? [found[found.length - 1]] : [] };
      
      case 'delete_vehicle':
        const [del_id] = params;
        const index = memoryDB.veiculos.findIndex(v => v.id === del_id);
        if (index !== -1) {
          memoryDB.veiculos.splice(index, 1);
        }
        return { rows: [] };
      
      case 'confirm_payment':
        const [valor_pago, veiculo_id] = params;
        const vPay = memoryDB.veiculos.find(v => v.id === veiculo_id);
        if (vPay) {
          vPay.valor_pago = valor_pago;
          vPay.status = 'pago';
          vPay.pago_em = now;
          
          memoryDB.registros.push({
            veiculo_id: veiculo_id,
            qr_code: vPay.qr_code,
            tipo_evento: 'pagamento',
            timestamp: now,
            valor: valor_pago
          });
          
          return { rows: [vPay] };
        }
        return { rows: [] };
      
      case 'list_active':
        const ativos = memoryDB.veiculos.filter(v => v.status === 'ativo').map(v => {
          const segundos = Math.floor((now - v.entrada) / 1000);
          return {
            ...v,
            tempo_decorrido_segundos: segundos,
            valor_atual: calcularValor(segundos)
          };
        });
        return { rows: ativos };
      
      case 'get_stats':
        const hoje = new Date().toDateString();
        const stats = {
          veiculos_ativos: memoryDB.veiculos.filter(v => v.status === 'ativo').length,
          aguardando_pagamento: memoryDB.veiculos.filter(v => v.status === 'aguardando_pagamento').length,
          entradas_hoje: memoryDB.veiculos.filter(v => v.entrada && new Date(v.entrada).toDateString() === hoje).length,
          saidas_hoje: memoryDB.veiculos.filter(v => v.saida && new Date(v.saida).toDateString() === hoje).length,
          faturamento_hoje: memoryDB.veiculos
            .filter(v => v.pago_em && new Date(v.pago_em).toDateString() === hoje)
            .reduce((sum, v) => sum + (v.valor_pago || 0), 0),
          tempo_medio_hoje_segundos: 0 // Calcular se necessário
        };
        return { rows: [stats] };
      
      case 'get_config':
        return { rows: [memoryDB.config] };
      
      case 'update_config':
        const [tipo, valor_u, valor_min, valor_max] = params;
        memoryDB.config = {
          tipo_cobranca: tipo,
          valor_unidade: valor_u,
          valor_minimo: valor_min,
          valor_maximo: valor_max
        };
        return { rows: [memoryDB.config] };
    }
  }
}

// Middleware
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || '*'
}));
app.use(morgan('combined'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// =====================================================
// ROTAS DA API
// =====================================================

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Endpoint para detecção de QR Code (chamado pelo script Python)
// POST /api/detect
// Body: { "qr_code": "ABC123", "action": "entry" | "exit" }
app.post('/api/detect', async (req, res) => {
  const { qr_code, action } = req.body;

  if (!qr_code || !action) {
    return res.status(400).json({ 
      error: 'qr_code e action são obrigatórios',
      exemplo: { qr_code: 'ABC123', action: 'entry' }
    });
  }

  try {
    if (action === 'entry') {
      // ===== ENTRADA =====
      // Verificar se veículo já está ativo
      const checkActive = await executeQuery('check_active', [qr_code, 'ativo']);

      if (checkActive.rows.length > 0) {
        return res.status(409).json({ 
          error: 'Veículo já está no estacionamento',
          veiculo: checkActive.rows[0]
        });
      }

      // Verificar se existe veículo anterior (para permitir reentrada)
      const checkExisting = await executeQuery('get_vehicle', [qr_code]);
      
      if (checkExisting.rows.length > 0) {
        const existing = checkExisting.rows[0];
        
        // Se veículo já existe mas já foi pago ou está aguardando pagamento,
        // deletar o registro antigo e criar novo (permite reentrada)
        if (existing.status === 'pago' || existing.status === 'aguardando_pagamento') {
          await executeQuery('delete_vehicle', [existing.id]);
          console.log(`🔄 Veículo ${qr_code} reentrada permitida (status anterior: ${existing.status})`);
        }
      }

      // Registrar entrada
      const result = await executeQuery('insert_entry', [qr_code]);

      return res.status(201).json({
        message: 'Entrada registrada com sucesso',
        veiculo: result.rows[0],
        action: 'catraca_abrir' // Sinal para abrir catraca
      });

    } else if (action === 'exit') {
      // ===== SAÍDA =====
      // Buscar e atualizar veículo ativo
      const result = await executeQuery('update_saida', [qr_code]);

      if (result.rows.length === 0) {
        return res.status(404).json({ 
          error: 'Veículo não encontrado ou já processado'
        });
      }

      const veiculoData = result.rows[0];
      const tempoPermanencia = veiculoData.tempo_permanencia;
      const valorCalculado = parseFloat(veiculoData.valor_calculado) || 0;

      // Gerar QR code PIX (simplificado - pode integrar com API real)
      const pixPayload = `00020126580014br.gov.bcb.pix0136${qr_code}520400005303986540${valorCalculado.toFixed(2)}5802BR5913ESTACIONAMENTO6009SAO PAULO62070503***6304`;
      const qrPagamento = await QRCode.toDataURL(pixPayload);

      return res.json({
        message: 'Saída registrada. Aguardando pagamento.',
        veiculo: {
          id: veiculoData.id,
          qr_code: qr_code,
          entrada: veiculoData.entrada,
          saida: veiculoData.saida,
          tempo_permanencia_segundos: tempoPermanencia,
          tempo_permanencia_formatado: formatarTempo(tempoPermanencia),
          valor_calculado: valorCalculado,
          qr_pagamento: qrPagamento
        },
        action: 'mostrar_pagamento' // Sinal para mostrar tela de pagamento
      });

    } else {
      return res.status(400).json({ 
        error: 'Action inválida. Use "entry" ou "exit"' 
      });
    }

  } catch (error) {
    console.error('Erro ao processar detecção:', error);
    return res.status(500).json({ 
      error: 'Erro interno do servidor',
      details: error.message 
    });
  }
});

// Consultar status de veículo por QR code
// GET /api/vehicle/:qr_code
app.get('/api/vehicle/:qr_code', async (req, res) => {
  const { qr_code } = req.params;

  try {
    // Buscar veículo mais recente
    const result = await executeQuery('get_vehicle', [qr_code]);

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        error: 'Veículo não encontrado' 
      });
    }

    const veiculo = result.rows[0];
    
    // Calcular valores atuais se veículo está ativo
    if (veiculo.status === 'ativo') {
      const tempoAtual = Math.floor((new Date() - new Date(veiculo.entrada)) / 1000);
      veiculo.tempo_atual_segundos = tempoAtual;
      veiculo.valor_atual = calcularValor(tempoAtual);
      veiculo.tempo_formatado = formatarTempo(tempoAtual);
    } else if (veiculo.tempo_permanencia) {
      veiculo.tempo_formatado = formatarTempo(veiculo.tempo_permanencia);
    }
    
    // Gerar QR de pagamento se aguardando pagamento
    if (veiculo.status === 'aguardando_pagamento' && veiculo.valor_calculado) {
      const valorCalc = parseFloat(veiculo.valor_calculado) || 0;
      const pixPayload = `00020126580014br.gov.bcb.pix0136${qr_code}520400005303986540${valorCalc.toFixed(2)}5802BR5913ESTACIONAMENTO6009SAO PAULO62070503***6304`;
      veiculo.qr_pagamento = await QRCode.toDataURL(pixPayload);
    }
    
    return res.json({
      veiculo: veiculo
    });

  } catch (error) {
    console.error('Erro ao consultar veículo:', error);
    return res.status(500).json({ 
      error: 'Erro interno do servidor',
      details: error.message 
    });
  }
});

// Confirmar pagamento
// POST /api/payment/confirm
// Body: { "veiculo_id": 123, "valor_pago": 5.50, "metodo": "pix" }
app.post('/api/payment/confirm', async (req, res) => {
  const { veiculo_id, valor_pago, metodo } = req.body;

  if (!veiculo_id || !valor_pago) {
    return res.status(400).json({ 
      error: 'veiculo_id e valor_pago são obrigatórios' 
    });
  }

  try {
    // Confirmar pagamento
    const result = await executeQuery('confirm_payment', [valor_pago, veiculo_id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        error: 'Veículo não encontrado ou pagamento já processado' 
      });
    }

    return res.json({
      message: 'Pagamento confirmado com sucesso',
      veiculo_id: veiculo_id,
      action: 'catraca_abrir' // Sinal para abrir catraca de saída
    });

  } catch (error) {
    console.error('Erro ao confirmar pagamento:', error);
    return res.status(500).json({ 
      error: 'Erro interno do servidor',
      details: error.message 
    });
  }
});

// Listar veículos ativos (para dashboard admin)
// GET /api/vehicles/active
app.get('/api/vehicles/active', async (req, res) => {
  try {
    const result = await executeQuery('list_active', []);
    
    return res.json({
      count: result.rows.length,
      veiculos: result.rows.map(v => ({
        ...v,
        tempo_formatado: formatarTempo(v.tempo_decorrido_segundos)
      }))
    });

  } catch (error) {
    console.error('Erro ao listar veículos ativos:', error);
    return res.status(500).json({ 
      error: 'Erro interno do servidor',
      details: error.message 
    });
  }
});

// Listar TODOS os veículos (histórico completo)
// GET /api/vehicles/all
app.get('/api/vehicles/all', async (req, res) => {
  try {
    if (useMemoryDB) {
      // Retornar todos do memoryDB com cálculos atualizados
      const now = new Date();
      const todos = memoryDB.veiculos.map(v => {
        const veiculo = { ...v };
        if (v.status === 'ativo') {
          const segundos = Math.floor((now - v.entrada) / 1000);
          veiculo.tempo_decorrido_segundos = segundos;
          veiculo.valor_atual = calcularValor(segundos);
          veiculo.tempo_formatado = formatarTempo(segundos);
        } else if (v.tempo_permanencia) {
          veiculo.tempo_formatado = formatarTempo(v.tempo_permanencia);
        }
        return veiculo;
      });
      
      return res.json({
        count: todos.length,
        veiculos: todos
      });
    } else {
      // PostgreSQL: buscar todos
      const result = await pool.query(`
        SELECT v.*, 
               CASE 
                 WHEN v.status = 'ativo' THEN EXTRACT(EPOCH FROM (NOW() - v.entrada))::INTEGER
                 ELSE v.tempo_permanencia
               END as tempo_segundos,
               CASE 
                 WHEN v.status = 'ativo' THEN calcular_valor_estacionamento(EXTRACT(EPOCH FROM (NOW() - v.entrada))::INTEGER)
                 ELSE v.valor_calculado
               END as valor_atual_calc
        FROM veiculos v
        ORDER BY v.entrada DESC
      `);
      
      return res.json({
        count: result.rows.length,
        veiculos: result.rows.map(v => ({
          ...v,
          tempo_formatado: formatarTempo(v.tempo_segundos)
        }))
      });
    }
  } catch (error) {
    console.error('Erro ao listar todos os veículos:', error);
    return res.status(500).json({ 
      error: 'Erro interno do servidor',
      details: error.message 
    });
  }
});

// Obter configuração de preços
// GET /api/config/pricing
app.get('/api/config/pricing', async (req, res) => {
  try {
    const result = await executeQuery('get_config', []);

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        error: 'Configuração de preços não encontrada' 
      });
    }

    return res.json(result.rows[0]);

  } catch (error) {
    console.error('Erro ao obter configuração:', error);
    return res.status(500).json({ 
      error: 'Erro interno do servidor',
      details: error.message 
    });
  }
});

// Atualizar configuração de preços (admin)
// PUT /api/config/pricing
// Body: { "tipo_cobranca": "por_segundo", "valor_unidade": 0.01, "valor_minimo": 1.00, "valor_maximo": 50.00 }
app.put('/api/config/pricing', async (req, res) => {
  const { tipo_cobranca, valor_unidade, valor_minimo, valor_maximo } = req.body;

  if (!tipo_cobranca || valor_unidade === undefined || valor_minimo === undefined) {
    return res.status(400).json({ 
      error: 'tipo_cobranca, valor_unidade e valor_minimo são obrigatórios' 
    });
  }

  try {
    // Atualizar configuração
    const result = await executeQuery('update_config', [tipo_cobranca, valor_unidade, valor_minimo, valor_maximo || null]);

    return res.json({
      message: 'Configuração atualizada com sucesso',
      config: result.rows[0]
    });

  } catch (error) {
    console.error('Erro ao atualizar configuração:', error);
    return res.status(500).json({ 
      error: 'Erro interno do servidor',
      details: error.message 
    });
  }
});

// Dashboard com estatísticas
// GET /api/dashboard/stats
app.get('/api/dashboard/stats', async (req, res) => {
  try {
    const result = await executeQuery('get_stats', []);
    
    const stats = result.rows[0];
    
    return res.json({
      veiculos_ativos: parseInt(stats.veiculos_ativos),
      aguardando_pagamento: parseInt(stats.aguardando_pagamento),
      entradas_hoje: parseInt(stats.entradas_hoje),
      saidas_hoje: parseInt(stats.saidas_hoje),
      faturamento_hoje: parseFloat(stats.faturamento_hoje),
      tempo_medio_hoje: formatarTempo(Math.floor(stats.tempo_medio_hoje_segundos))
    });

  } catch (error) {
    console.error('Erro ao obter estatísticas:', error);
    return res.status(500).json({ 
      error: 'Erro interno do servidor',
      details: error.message 
    });
  }
});

// =====================================================
// FUNÇÕES AUXILIARES
// =====================================================

function formatarTempo(segundos) {
  const horas = Math.floor(segundos / 3600);
  const minutos = Math.floor((segundos % 3600) / 60);
  const segs = segundos % 60;

  if (horas > 0) {
    return `${horas}h ${minutos}min ${segs}s`;
  } else if (minutos > 0) {
    return `${minutos}min ${segs}s`;
  } else {
    return `${segs}s`;
  }
}

// =====================================================
// INICIALIZAÇÃO DO SERVIDOR
// =====================================================

// Tratamento de erros não capturados
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
  console.log(`🔗 URL: http://localhost:${PORT}`);
  console.log(`🏥 Health check: http://localhost:${PORT}/health`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM recebido, fechando servidor...');
  pool.end(() => {
    console.log('Pool de conexões fechado');
    process.exit(0);
  });
});
