-- =====================================================
-- SISTEMA DE ESTACIONAMENTO COM DETECÇÃO DE QR CODE
-- =====================================================
-- Este schema adiciona funcionalidade de detecção de QR
-- como "placas" de veículos para controle de entrada/saída
-- e cálculo automático de valores a pagar
-- =====================================================

-- Tabela de configuração de preços
CREATE TABLE IF NOT EXISTS configuracao_precos (
  id SERIAL PRIMARY KEY,
  tipo_cobranca VARCHAR(20) NOT NULL DEFAULT 'por_segundo', -- 'por_segundo', 'por_minuto', 'por_hora'
  valor_unidade DECIMAL(10,2) NOT NULL DEFAULT 0.01, -- 1 centavo por segundo (exemplo)
  valor_minimo DECIMAL(10,2) NOT NULL DEFAULT 1.00, -- Valor mínimo a cobrar
  valor_maximo DECIMAL(10,2) DEFAULT NULL, -- Valor máximo (diária), NULL = sem limite
  ativo BOOLEAN DEFAULT TRUE,
  atualizado_em TIMESTAMP DEFAULT NOW(),
  CONSTRAINT check_tipo_cobranca CHECK (tipo_cobranca IN ('por_segundo', 'por_minuto', 'por_hora'))
);

-- Inserir configuração padrão (1 real por 10 minutos = R$ 0,00166... por segundo)
INSERT INTO configuracao_precos (tipo_cobranca, valor_unidade, valor_minimo, valor_maximo, ativo)
VALUES ('por_segundo', 0.00166, 1.00, 50.00, TRUE);

-- Tabela de veículos (registros ativos no estacionamento)
CREATE TABLE IF NOT EXISTS veiculos (
  id SERIAL PRIMARY KEY,
  qr_code VARCHAR(100) NOT NULL UNIQUE, -- Código QR único do veículo (funciona como placa)
  entrada TIMESTAMP NOT NULL DEFAULT NOW(), -- Momento de entrada
  saida TIMESTAMP DEFAULT NULL, -- Momento de saída (NULL = ainda está no estacionamento)
  tempo_permanencia INTEGER DEFAULT NULL, -- Tempo em segundos (calculado na saída)
  valor_calculado DECIMAL(10,2) DEFAULT NULL, -- Valor calculado baseado no tempo
  valor_pago DECIMAL(10,2) DEFAULT NULL, -- Valor efetivamente pago
  status VARCHAR(20) NOT NULL DEFAULT 'ativo', -- 'ativo', 'aguardando_pagamento', 'pago', 'cancelado'
  qr_pagamento TEXT DEFAULT NULL, -- QR code PIX ou link de pagamento
  pago_em TIMESTAMP DEFAULT NULL, -- Momento do pagamento
  observacoes TEXT DEFAULT NULL,
  criado_em TIMESTAMP DEFAULT NOW(),
  atualizado_em TIMESTAMP DEFAULT NOW(),
  CONSTRAINT check_status CHECK (status IN ('ativo', 'aguardando_pagamento', 'pago', 'cancelado'))
);

-- Índices para otimizar consultas
CREATE INDEX idx_veiculos_qr_code ON veiculos(qr_code);
CREATE INDEX idx_veiculos_status ON veiculos(status);
CREATE INDEX idx_veiculos_entrada ON veiculos(entrada);

-- Tabela de histórico completo (registro permanente de todos os eventos)
CREATE TABLE IF NOT EXISTS registros_estacionamento (
  id SERIAL PRIMARY KEY,
  veiculo_id INTEGER REFERENCES veiculos(id) ON DELETE CASCADE,
  qr_code VARCHAR(100) NOT NULL,
  tipo_evento VARCHAR(20) NOT NULL, -- 'entrada', 'saida', 'pagamento', 'cancelamento'
  timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
  valor DECIMAL(10,2) DEFAULT NULL,
  detalhes JSONB DEFAULT NULL, -- Dados adicionais (ex: método de pagamento, motivo de cancelamento)
  CONSTRAINT check_tipo_evento CHECK (tipo_evento IN ('entrada', 'saida', 'pagamento', 'cancelamento'))
);

-- Índices para consultas de histórico
CREATE INDEX idx_registros_qr_code ON registros_estacionamento(qr_code);
CREATE INDEX idx_registros_timestamp ON registros_estacionamento(timestamp);
CREATE INDEX idx_registros_tipo_evento ON registros_estacionamento(tipo_evento);

-- Função auxiliar para calcular valor baseado em tempo e configuração
CREATE OR REPLACE FUNCTION calcular_valor_estacionamento(segundos INTEGER)
RETURNS DECIMAL(10,2) AS $$
DECLARE
  config RECORD;
  valor_calculado DECIMAL(10,2);
  unidades DECIMAL(10,2);
BEGIN
  -- Buscar configuração ativa
  SELECT * INTO config FROM configuracao_precos WHERE ativo = TRUE ORDER BY id DESC LIMIT 1;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Nenhuma configuração de preço ativa encontrada';
  END IF;
  
  -- Calcular baseado no tipo de cobrança
  CASE config.tipo_cobranca
    WHEN 'por_segundo' THEN
      unidades := segundos;
    WHEN 'por_minuto' THEN
      unidades := CEIL(segundos / 60.0);
    WHEN 'por_hora' THEN
      unidades := CEIL(segundos / 3600.0);
  END CASE;
  
  -- Calcular valor
  valor_calculado := unidades * config.valor_unidade;
  
  -- Aplicar valor mínimo
  IF valor_calculado < config.valor_minimo THEN
    valor_calculado := config.valor_minimo;
  END IF;
  
  -- Aplicar valor máximo (se configurado)
  IF config.valor_maximo IS NOT NULL AND valor_calculado > config.valor_maximo THEN
    valor_calculado := config.valor_maximo;
  END IF;
  
  RETURN ROUND(valor_calculado, 2);
END;
$$ LANGUAGE plpgsql;

-- Trigger para atualizar timestamp de atualização
CREATE OR REPLACE FUNCTION update_atualizado_em()
RETURNS TRIGGER AS $$
BEGIN
  NEW.atualizado_em = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_veiculos_atualizado_em
  BEFORE UPDATE ON veiculos
  FOR EACH ROW
  EXECUTE FUNCTION update_atualizado_em();

CREATE TRIGGER trigger_config_precos_atualizado_em
  BEFORE UPDATE ON configuracao_precos
  FOR EACH ROW
  EXECUTE FUNCTION update_atualizado_em();

-- View para consulta rápida de veículos ativos com tempo atual
CREATE OR REPLACE VIEW veiculos_ativos AS
SELECT 
  v.id,
  v.qr_code,
  v.entrada,
  EXTRACT(EPOCH FROM (NOW() - v.entrada))::INTEGER AS tempo_decorrido_segundos,
  calcular_valor_estacionamento(EXTRACT(EPOCH FROM (NOW() - v.entrada))::INTEGER) AS valor_atual,
  v.status,
  c.tipo_cobranca,
  c.valor_unidade
FROM veiculos v
CROSS JOIN configuracao_precos c
WHERE v.status = 'ativo' AND c.ativo = TRUE;

-- View para dashboard administrativo
CREATE OR REPLACE VIEW dashboard_veiculos AS
SELECT
  COUNT(*) FILTER (WHERE status = 'ativo') AS veiculos_ativos,
  COUNT(*) FILTER (WHERE status = 'aguardando_pagamento') AS aguardando_pagamento,
  COUNT(*) FILTER (WHERE DATE(entrada) = CURRENT_DATE) AS entradas_hoje,
  COUNT(*) FILTER (WHERE DATE(saida) = CURRENT_DATE) AS saidas_hoje,
  COALESCE(SUM(valor_pago) FILTER (WHERE DATE(pago_em) = CURRENT_DATE), 0) AS faturamento_hoje,
  COALESCE(AVG(tempo_permanencia) FILTER (WHERE saida IS NOT NULL AND DATE(saida) = CURRENT_DATE), 0) AS tempo_medio_hoje_segundos
FROM veiculos;

-- =====================================================
-- EXEMPLOS DE QUERIES ÚTEIS
-- =====================================================

-- Consultar veículo específico por QR code com valor atual
-- SELECT * FROM veiculos_ativos WHERE qr_code = 'ABC123';

-- Consultar histórico completo de um veículo
-- SELECT * FROM registros_estacionamento WHERE qr_code = 'ABC123' ORDER BY timestamp DESC;

-- Consultar resumo do dia
-- SELECT * FROM dashboard_veiculos;

-- Atualizar configuração de preço (exemplo: R$ 1,00 por 10 minutos)
-- UPDATE configuracao_precos SET valor_unidade = 0.00166, tipo_cobranca = 'por_segundo' WHERE id = 1;

-- Consultar veículos que precisam pagar (já saíram mas não pagaram)
-- SELECT * FROM veiculos WHERE status = 'aguardando_pagamento' ORDER BY saida DESC;
