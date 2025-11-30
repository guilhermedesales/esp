-- ===== SCHEMA PARA SUPABASE =====
-- Execute este SQL no SQL Editor do seu projeto Supabase

-- Tabela de Acessos (entradas no estacionamento)
CREATE TABLE IF NOT EXISTS acessos (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  total INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Índice para consultas por data
CREATE INDEX idx_acessos_timestamp ON acessos(timestamp DESC);

-- Tabela de Histórico de Vagas (mudanças de estado)
CREATE TABLE IF NOT EXISTS historico_vagas (
  id BIGSERIAL PRIMARY KEY,
  numero_vaga INTEGER NOT NULL,
  estado_anterior VARCHAR(20),
  estado_novo VARCHAR(20) NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Índice para consultas por vaga e data
CREATE INDEX idx_historico_vagas_numero ON historico_vagas(numero_vaga);
CREATE INDEX idx_historico_vagas_timestamp ON historico_vagas(timestamp DESC);

-- Tabela de Estatísticas Diárias (opcional - para dashboards)
CREATE TABLE IF NOT EXISTS estatisticas_diarias (
  id BIGSERIAL PRIMARY KEY,
  data DATE NOT NULL UNIQUE,
  total_acessos INTEGER DEFAULT 0,
  tempo_medio_ocupacao_ms BIGINT,
  taxa_ocupacao_percentual DECIMAL(5,2),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Índice para consultas por data
CREATE INDEX idx_estatisticas_data ON estatisticas_diarias(data DESC);

-- Habilitar Row Level Security (RLS)
ALTER TABLE acessos ENABLE ROW LEVEL SECURITY;
ALTER TABLE historico_vagas ENABLE ROW LEVEL SECURITY;
ALTER TABLE estatisticas_diarias ENABLE ROW LEVEL SECURITY;

-- Políticas de acesso público (AJUSTE conforme necessário)
-- Permitir SELECT para qualquer usuário (leitura pública)
CREATE POLICY "Permitir leitura pública de acessos"
  ON acessos FOR SELECT
  USING (true);

CREATE POLICY "Permitir leitura pública de histórico"
  ON historico_vagas FOR SELECT
  USING (true);

CREATE POLICY "Permitir leitura pública de estatísticas"
  ON estatisticas_diarias FOR SELECT
  USING (true);

-- Permitir INSERT para qualquer usuário (escrita pública)
-- ATENÇÃO: Em produção, considere usar autenticação ou chaves de API
CREATE POLICY "Permitir inserção de acessos"
  ON acessos FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Permitir inserção de histórico"
  ON historico_vagas FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Permitir inserção de estatísticas"
  ON estatisticas_diarias FOR INSERT
  WITH CHECK (true);

-- Permitir UPDATE apenas para estatísticas (agregar dados diários)
CREATE POLICY "Permitir atualização de estatísticas"
  ON estatisticas_diarias FOR UPDATE
  USING (true)
  WITH CHECK (true);

-- ===== VIEWS ÚTEIS =====

-- View: Acessos por hora do dia atual
CREATE OR REPLACE VIEW acessos_hoje_por_hora AS
SELECT 
  EXTRACT(HOUR FROM timestamp) as hora,
  COUNT(*) as total
FROM acessos
WHERE DATE(timestamp) = CURRENT_DATE
GROUP BY hora
ORDER BY hora;

-- View: Resumo de ocupação por vaga
CREATE OR REPLACE VIEW resumo_ocupacao_vagas AS
SELECT 
  numero_vaga,
  COUNT(*) as total_mudancas,
  SUM(CASE WHEN estado_novo = 'ocupada' THEN 1 ELSE 0 END) as vezes_ocupada,
  SUM(CASE WHEN estado_novo = 'bloqueada' THEN 1 ELSE 0 END) as vezes_bloqueada,
  MAX(timestamp) as ultima_mudanca
FROM historico_vagas
GROUP BY numero_vaga
ORDER BY numero_vaga;

-- View: Últimas 50 mudanças
CREATE OR REPLACE VIEW ultimas_mudancas AS
SELECT 
  numero_vaga,
  estado_anterior,
  estado_novo,
  timestamp
FROM historico_vagas
ORDER BY timestamp DESC
LIMIT 50;

-- ===== FUNÇÃO PARA CALCULAR ESTATÍSTICAS DIÁRIAS =====
CREATE OR REPLACE FUNCTION calcular_estatisticas_diarias(data_alvo DATE)
RETURNS void AS $$
DECLARE
  total_acessos_dia INTEGER;
BEGIN
  -- Contar acessos do dia
  SELECT COUNT(*) INTO total_acessos_dia
  FROM acessos
  WHERE DATE(timestamp) = data_alvo;
  
  -- Inserir ou atualizar estatísticas
  INSERT INTO estatisticas_diarias (data, total_acessos, updated_at)
  VALUES (data_alvo, total_acessos_dia, NOW())
  ON CONFLICT (data) 
  DO UPDATE SET 
    total_acessos = EXCLUDED.total_acessos,
    updated_at = NOW();
END;
$$ LANGUAGE plpgsql;

-- ===== COMENTÁRIOS NAS TABELAS =====
COMMENT ON TABLE acessos IS 'Registro de todos os acessos (entradas) no estacionamento';
COMMENT ON TABLE historico_vagas IS 'Histórico de mudanças de estado das vagas (livre, ocupada, bloqueada)';
COMMENT ON TABLE estatisticas_diarias IS 'Agregação diária de estatísticas do estacionamento';

COMMENT ON COLUMN acessos.total IS 'Contador total acumulado de acessos';
COMMENT ON COLUMN historico_vagas.numero_vaga IS 'Número identificador da vaga (1, 2, 3, etc)';
COMMENT ON COLUMN historico_vagas.estado_anterior IS 'Estado antes da mudança (livre, ocupada, bloqueada)';
COMMENT ON COLUMN historico_vagas.estado_novo IS 'Novo estado após a mudança';
