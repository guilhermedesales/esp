"""
Script de Teste do Sistema QR - SEM WEBCAM
==========================================
Este script testa o sistema completo sem precisar de webcam.
Gera QR codes de teste e simula detecções.

Uso:
    python test_system.py
"""

import requests
import qrcode
import cv2
import os
import sys
from datetime import datetime
from pyzbar import pyzbar

# Adicionar path do detector
sys.path.append(os.path.dirname(__file__))
from detect_qr import detect_qr_codes

# Configurações
API_URL = 'http://localhost:3000'
TEST_QR_CODES = ['ABC-1234', 'XYZ-9876', 'TEST-001']


def gerar_qr_code(data, filename):
    """Gera um QR code de teste."""
    qr = qrcode.QRCode(
        version=1,
        error_correction=qrcode.constants.ERROR_CORRECT_H,
        box_size=10,
        border=4,
    )
    qr.add_data(data)
    qr.make(fit=True)
    
    img = qr.make_image(fill_color="black", back_color="white")
    img.save(filename)
    print(f"✅ QR code gerado: {filename} (dados: {data})")
    return filename


def testar_detecao(filename):
    """Testa se o detector consegue ler o QR code."""
    img = cv2.imread(filename)
    if img is None:
        print(f"❌ Erro ao ler imagem: {filename}")
        return None
    
    qr_codes = detect_qr_codes(img)
    
    if len(qr_codes) == 0:
        print(f"❌ Nenhum QR code detectado em {filename}")
        return None
    
    print(f"✅ QR code detectado: {qr_codes[0]['data']}")
    return qr_codes[0]['data']


def testar_api_entrada(qr_code):
    """Testa registro de entrada via API."""
    try:
        print(f"\n🚗 Testando ENTRADA do veículo {qr_code}...")
        response = requests.post(
            f"{API_URL}/api/detect",
            json={"qr_code": qr_code, "action": "entry"},
            timeout=5
        )
        
        if response.status_code in [200, 201]:
            data = response.json()
            print(f"✅ Entrada registrada: {data.get('message')}")
            return True
        else:
            print(f"❌ Erro na API: {response.status_code} - {response.text}")
            return False
    except requests.exceptions.ConnectionError:
        print("❌ Erro: Backend não está rodando!")
        print("💡 Execute: cd backend && npm start")
        return False
    except Exception as e:
        print(f"❌ Erro: {e}")
        return False


def testar_api_consulta(qr_code):
    """Testa consulta de veículo via API."""
    try:
        print(f"\n🔍 Consultando status do veículo {qr_code}...")
        response = requests.get(f"{API_URL}/api/vehicle/{qr_code}", timeout=5)
        
        if response.status_code == 200:
            data = response.json()
            veiculo = data.get('veiculo', {})
            print(f"✅ Veículo encontrado:")
            print(f"   Status: {veiculo.get('status')}")
            print(f"   Entrada: {veiculo.get('entrada')}")
            print(f"   Tempo atual: {veiculo.get('tempo_formatado')}")
            print(f"   Valor atual: R$ {veiculo.get('valor_atual', 0):.2f}")
            return True
        else:
            print(f"❌ Veículo não encontrado")
            return False
    except Exception as e:
        print(f"❌ Erro: {e}")
        return False


def testar_api_saida(qr_code):
    """Testa registro de saída via API."""
    try:
        print(f"\n🚗 Testando SAÍDA do veículo {qr_code}...")
        response = requests.post(
            f"{API_URL}/api/detect",
            json={"qr_code": qr_code, "action": "exit"},
            timeout=5
        )
        
        if response.status_code in [200, 201]:
            data = response.json()
            veiculo = data.get('veiculo', {})
            print(f"✅ Saída registrada: {data.get('message')}")
            print(f"   Tempo permanência: {veiculo.get('tempo_permanencia_formatado')}")
            print(f"   Valor a pagar: R$ {veiculo.get('valor_calculado', 0):.2f}")
            return veiculo
        else:
            print(f"❌ Erro na API: {response.status_code} - {response.text}")
            return None
    except Exception as e:
        print(f"❌ Erro: {e}")
        return None


def testar_api_pagamento(veiculo_id, valor):
    """Testa confirmação de pagamento via API."""
    try:
        print(f"\n💳 Testando PAGAMENTO do veículo ID {veiculo_id}...")
        response = requests.post(
            f"{API_URL}/api/payment/confirm",
            json={
                "veiculo_id": veiculo_id,
                "valor_pago": valor,
                "metodo": "pix"
            },
            timeout=5
        )
        
        if response.status_code in [200, 201]:
            data = response.json()
            print(f"✅ Pagamento confirmado: {data.get('message')}")
            return True
        else:
            print(f"❌ Erro na API: {response.status_code} - {response.text}")
            return False
    except Exception as e:
        print(f"❌ Erro: {e}")
        return False


def main():
    """Executa todos os testes."""
    print("=" * 70)
    print("🧪 TESTE DO SISTEMA DE ESTACIONAMENTO COM QR CODE")
    print("=" * 70)
    print(f"API URL: {API_URL}")
    print()
    
    # Criar pasta para QR codes de teste
    os.makedirs('test_qr_codes', exist_ok=True)
    
    # Teste 1: Verificar se backend está rodando
    print("=" * 70)
    print("TESTE 1: Verificar Backend")
    print("=" * 70)
    try:
        response = requests.get(f"{API_URL}/health", timeout=3)
        if response.status_code == 200:
            print("✅ Backend está rodando")
        else:
            print("❌ Backend retornou erro")
            return
    except:
        print("❌ Backend NÃO está rodando!")
        print("💡 Abra outro terminal e execute: cd backend && npm start")
        return
    
    # Teste 2: Gerar e detectar QR codes
    print("\n" + "=" * 70)
    print("TESTE 2: Geração e Detecção de QR Codes")
    print("=" * 70)
    
    qr_test = TEST_QR_CODES[0]
    filename = f'test_qr_codes/{qr_test}.png'
    gerar_qr_code(qr_test, filename)
    detected = testar_detecao(filename)
    
    if detected != qr_test:
        print(f"❌ Detecção falhou! Esperado: {qr_test}, Detectado: {detected}")
        return
    
    # Teste 3: Fluxo completo (Entrada → Consulta → Saída → Pagamento)
    print("\n" + "=" * 70)
    print("TESTE 3: Fluxo Completo do Sistema")
    print("=" * 70)
    
    # 3.1: Entrada
    if not testar_api_entrada(qr_test):
        return
    
    # Aguardar 3 segundos para simular permanência
    print("\n⏱️  Aguardando 3 segundos (simulando permanência)...")
    import time
    time.sleep(3)
    
    # 3.2: Consulta
    if not testar_api_consulta(qr_test):
        return
    
    # 3.3: Saída
    veiculo = testar_api_saida(qr_test)
    if not veiculo:
        return
    
    # 3.4: Pagamento
    veiculo_id = veiculo.get('id')
    valor = veiculo.get('valor_calculado', 1.0)
    
    if not testar_api_pagamento(veiculo_id, valor):
        return
    
    # Teste 4: Verificar estatísticas
    print("\n" + "=" * 70)
    print("TESTE 4: Dashboard de Estatísticas")
    print("=" * 70)
    try:
        response = requests.get(f"{API_URL}/api/dashboard/stats", timeout=5)
        if response.status_code == 200:
            stats = response.json()
            print("✅ Estatísticas do dia:")
            print(f"   Entradas: {stats.get('entradas_hoje')}")
            print(f"   Saídas: {stats.get('saidas_hoje')}")
            print(f"   Faturamento: R$ {stats.get('faturamento_hoje', 0):.2f}")
            print(f"   Tempo médio: {stats.get('tempo_medio_hoje')}")
        else:
            print(f"❌ Erro ao buscar estatísticas")
    except Exception as e:
        print(f"❌ Erro: {e}")
    
    # Resumo final
    print("\n" + "=" * 70)
    print("✅ TODOS OS TESTES PASSARAM!")
    print("=" * 70)
    print("\n💡 Próximos passos:")
    print("   1. Gere seus próprios QR codes (placas de veículos)")
    print("   2. Imprima e cole nos carros")
    print("   3. Execute: python detect_qr.py")
    print("   4. Aproxime os QR codes da webcam")
    print("   5. Acesse o dashboard admin em front/pages/admin.html")
    print()


if __name__ == "__main__":
    main()
