"""
Sistema de Detecção de QR Code via Webcam
==========================================
Este script monitora continuamente uma webcam para detectar QR Codes
e envia os dados para a API backend do sistema de estacionamento.

Dependências:
- opencv-python: Captura de vídeo
- pyzbar: Decodificação de QR codes
- requests: Comunicação com API
- python-dotenv: Gerenciamento de variáveis de ambiente

Uso:
    python detect_qr.py

Autor: Sistema de Estacionamento
"""

import cv2
import requests
import time
import os
from datetime import datetime
from pyzbar import pyzbar
from dotenv import load_dotenv
import numpy as np
import paho.mqtt.client as mqtt
import ssl

# Carregar variáveis de ambiente
load_dotenv()

# Configurações API
API_URL = os.getenv('API_URL', 'http://127.0.0.1:3000')
CAMERA_INDEX = int(os.getenv('CAMERA_INDEX', 0))
DETECTION_COOLDOWN = int(os.getenv('DETECTION_COOLDOWN', 5))  # segundos entre detecções do mesmo QR
CHECK_INTERVAL = 0.1  # segundos entre frames

# Configurações MQTT (HiveMQ Cloud)
MQTT_BROKER = os.getenv('MQTT_BROKER', '3c16c837ea4f4ac0966899396b41ab08.s1.eu.hivemq.cloud')
MQTT_PORT = int(os.getenv('MQTT_PORT', 8883))
MQTT_USER = os.getenv('MQTT_USER', 'guilherme')
MQTT_PASSWORD = os.getenv('MQTT_PASSWORD', 'Guilherme123')
MQTT_TOPIC_CANCELA = 'estacionamento/qr/cancela'

# Armazenar últimas detecções para evitar duplicatas
last_detections = {}

# Cliente MQTT
mqtt_client = None
mqtt_connected = False

def on_mqtt_connect(client, userdata, flags, reason_code, properties):
    """Callback quando conecta ao MQTT (API v2)"""
    global mqtt_connected
    if reason_code == 0:
        mqtt_connected = True
        print("✅ Conectado ao MQTT (HiveMQ Cloud)")
    else:
        mqtt_connected = False
        print(f"❌ Erro ao conectar MQTT: {reason_code}")

def on_mqtt_disconnect(client, userdata, flags, reason_code, properties):
    """Callback quando desconecta do MQTT (API v2)"""
    global mqtt_connected
    mqtt_connected = False
    print("⚠️ Desconectado do MQTT")

def setup_mqtt():
    """Configura e conecta ao broker MQTT"""
    global mqtt_client
    
    try:
        mqtt_client = mqtt.Client(client_id="PythonQRDetector", callback_api_version=mqtt.CallbackAPIVersion.VERSION2, protocol=mqtt.MQTTv311)
        mqtt_client.username_pw_set(MQTT_USER, MQTT_PASSWORD)
        
        # Configurar TLS para HiveMQ Cloud
        mqtt_client.tls_set(cert_reqs=ssl.CERT_NONE)
        mqtt_client.tls_insecure_set(True)
        
        mqtt_client.on_connect = on_mqtt_connect
        mqtt_client.on_disconnect = on_mqtt_disconnect
        
        print(f"🔌 Conectando ao MQTT: {MQTT_BROKER}:{MQTT_PORT}")
        mqtt_client.connect(MQTT_BROKER, MQTT_PORT, 60)
        mqtt_client.loop_start()
        
        # Aguardar conexão
        timeout = 10
        start = time.time()
        while not mqtt_connected and (time.time() - start) < timeout:
            time.sleep(0.1)
        
        if mqtt_connected:
            return True
        else:
            print("⚠️ Timeout ao conectar MQTT (continuando sem MQTT)")
            return False
            
    except Exception as e:
        print(f"❌ Erro ao configurar MQTT: {e}")
        print("⚠️ Continuando sem MQTT (servo não será acionado)")
        return False

def abrir_cancela_mqtt():
    """Envia comando via MQTT para abrir cancela (servo do ESP32)"""
    global mqtt_client, mqtt_connected
    
    if not mqtt_connected or mqtt_client is None:
        print("⚠️ MQTT não conectado - servo não será acionado")
        return False
    
    try:
        result = mqtt_client.publish(MQTT_TOPIC_CANCELA, "abrir", qos=1)
        if result.rc == mqtt.MQTT_ERR_SUCCESS:
            print("🚦 ✅ Comando MQTT enviado: ABRIR CANCELA")
            return True
        else:
            print(f"❌ Erro ao publicar MQTT: {result.rc}")
            return False
    except Exception as e:
        print(f"❌ Erro ao enviar comando MQTT: {e}")
        return False


def detect_qr_codes(frame):
    """
    Detecta e decodifica QR codes em um frame de vídeo.
    
    Args:
        frame: Frame capturado pela webcam (numpy array)
    
    Returns:
        list: Lista de dicionários com informações dos QR codes detectados
    """
    # Converter para escala de cinza para melhor detecção
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    
    # Detectar QR codes
    decoded_objects = pyzbar.decode(gray)
    
    results = []
    for obj in decoded_objects:
        # Extrair dados do QR code
        qr_data = obj.data.decode('utf-8')
        qr_type = obj.type
        
        # Obter coordenadas do QR code para desenhar retângulo
        points = obj.polygon
        if len(points) > 4:
            hull = cv2.convexHull(np.array([point for point in points], dtype=np.float32))
            points = hull
        
        results.append({
            'data': qr_data,
            'type': qr_type,
            'points': points,
            'rect': obj.rect
        })
    
    return results


def draw_qr_codes(frame, qr_codes):
    """
    Desenha retângulos e labels nos QR codes detectados.
    
    Args:
        frame: Frame original
        qr_codes: Lista de QR codes detectados
    
    Returns:
        frame: Frame modificado com anotações
    """
    for qr in qr_codes:
        # Desenhar retângulo ao redor do QR code
        points = qr['points']
        n = len(points)
        for i in range(n):
            pt1 = tuple(points[i])
            pt2 = tuple(points[(i + 1) % n])
            cv2.line(frame, pt1, pt2, (0, 255, 0), 3)
        
        # Adicionar texto com o conteúdo do QR code
        x, y, w, h = qr['rect']
        text = f"QR: {qr['data']}"
        cv2.putText(frame, text, (x, y - 10), cv2.FONT_HERSHEY_SIMPLEX, 
                    0.5, (0, 255, 0), 2)
    
    return frame


def send_to_api(qr_code, action):
    """
    Envia detecção de QR code para a API backend.
    
    Args:
        qr_code: Código do QR detectado
        action: "entry" ou "exit" (determinado pela lógica de negócio)
    
    Returns:
        dict: Resposta da API ou None em caso de erro
    """
    try:
        endpoint = f"{API_URL}/api/detect"
        payload = {
            "qr_code": qr_code,
            "action": action
        }
        
        print(f"[{datetime.now().strftime('%H:%M:%S')}] Enviando para API: {qr_code} - {action}")
        
        response = requests.post(endpoint, json=payload, timeout=5)
        
        if response.status_code in [200, 201]:
            data = response.json()
            print(f"✅ Sucesso: {data.get('message', 'OK')}")
            
            # Se a API retornar ação para catraca
            if 'action' in data:
                if data['action'] == 'catraca_abrir':
                    print("🚪 ABRIR CATRACA (simular GPIO/servo aqui)")
                    # Aqui você adicionaria código para controlar o servo motor
                    # import RPi.GPIO as GPIO
                    # controlar_servo(abrir=True)
                
                elif data['action'] == 'mostrar_pagamento':
                    print("💳 Mostrar tela de pagamento ao usuário")
                    veiculo = data.get('veiculo', {})
                    print(f"   Valor: R$ {veiculo.get('valor_calculado', 0):.2f}")
                    print(f"   Tempo: {veiculo.get('tempo_permanencia_formatado', 'N/A')}")
            
            return data
        elif response.status_code == 409:
            # Veículo já está no estacionamento (duplicata)
            print(f"⚠️ Veículo já registrado no estacionamento")
            return None
        elif response.status_code == 500:
            # Erro interno - pode ser constraint de duplicata
            error_text = response.text
            if 'duplicate key' in error_text or 'unique constraint' in error_text:
                print(f"⚠️ Veículo já existe no banco (usar saída em vez de entrada)")
            else:
                print(f"❌ Erro interno na API: {error_text}")
            return None
        else:
            print(f"❌ Erro na API: {response.status_code} - {response.text}")
            return None
            
    except requests.exceptions.Timeout:
        print("⏱️ Timeout ao conectar com API")
        return None
    except requests.exceptions.ConnectionError:
        print("🔌 Erro de conexão com API")
        return None
    except Exception as e:
        print(f"❌ Erro ao enviar para API: {str(e)}")
        return None


def determine_action(qr_code):
    """
    Determina se é uma entrada ou saída baseado no histórico.
    
    Lógica simplificada: consulta API para verificar status do veículo.
    Se veículo está ativo no estacionamento = saída
    Se não está = entrada
    
    Args:
        qr_code: Código do QR detectado
    
    Returns:
        str: "entry" ou "exit"
    """
    try:
        # Consultar status do veículo na API
        response = requests.get(f"{API_URL}/api/vehicle/{qr_code}", timeout=3)
        
        if response.status_code == 200:
            data = response.json()
            veiculo = data.get('veiculo', {})
            status = veiculo.get('status', '')
            
            # Se veículo está ativo = é saída
            if status == 'ativo':
                return 'exit'
            # Caso contrário = entrada
            else:
                return 'entry'
        else:
            # Se não encontrou veículo = entrada
            return 'entry'
            
    except Exception as e:
        print(f"⚠️ Erro ao determinar ação: {e}. Assumindo entrada.")
        return 'entry'


def main():
    """
    Loop principal de detecção.
    """
    print("=" * 60)
    print("🎥 Sistema de Detecção de QR Code - Estacionamento")
    print("=" * 60)
    print(f"API URL: {API_URL}")
    print(f"Câmera: {CAMERA_INDEX}")
    print(f"Cooldown: {DETECTION_COOLDOWN}s")
    print("Pressione Ctrl+C para sair")
    print("=" * 60)
    
    # Tentar inicializar captura de vídeo com diferentes backends
    cap = None
    backends_to_try = [
        (cv2.CAP_DSHOW, "DirectShow (Windows)"),
        (cv2.CAP_MSMF, "Media Foundation (Windows)"),
        (cv2.CAP_ANY, "Auto-detect")
    ]
    
    print("🔍 Tentando abrir câmera...\n")
    
    for backend, backend_name in backends_to_try:
        print(f"   Tentando backend: {backend_name}")
        cap = cv2.VideoCapture(CAMERA_INDEX, backend)
        
        if cap.isOpened():
            # Testar se consegue ler frame
            ret, test_frame = cap.read()
            if ret:
                print(f"   ✅ Sucesso com {backend_name}")
                break
            else:
                print(f"   ⚠️ Câmera aberta mas não consegue ler frames")
                cap.release()
                cap = None
        else:
            print(f"   ❌ Falhou com {backend_name}")
            if cap:
                cap.release()
                cap = None
    
    if not cap or not cap.isOpened():
        print("\n❌ Erro: Não foi possível abrir a câmera")
        print("   Possíveis causas:")
        print("   - Webcam não conectada ou não detectada")
        print("   - Câmera sendo usada por outro aplicativo (Teams, Zoom, etc)")
        print("   - Permissões da câmera bloqueadas no Windows")
        print("   - Driver incompatível")
        print(f"\n💡 Tente:")
        print(f"   1. Fechar outros programas que usam a câmera")
        print(f"   2. Verificar Configurações > Privacidade > Câmera no Windows")
        print(f"   3. Executar: python -c \"import cv2; print(cv2.getBuildInformation())\"")
        return
    
    # Configurar resolução (opcional)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
    
    # Obter propriedades da câmera
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = int(cap.get(cv2.CAP_PROP_FPS))
    
    print(f"\n✅ Câmera inicializada!")
    print(f"   Resolução: {width}x{height}")
    print(f"   FPS: {fps}")
    print("   Aguardando QR codes...\n")
    print("💡 Modo headless ativado (sem janela de vídeo)")
    print("💾 Imagens com QR detectado serão salvas em 'detections/'\n")
    
    # Configurar MQTT para controlar servo do ESP32
    setup_mqtt()
    
    # Criar pasta para salvar detecções
    import os
    os.makedirs('detections', exist_ok=True)
    
    frame_count = 0
    try:
        while True:
            # Capturar frame
            ret, frame = cap.read()
            
            if not ret or frame is None:
                print(f"❌ Erro ao capturar frame {frame_count}")
                print("   A câmera pode ter sido desconectada ou perdeu o sinal")
                print("   Tentando reconectar...")
                
                # Tentar reconectar
                cap.release()
                time.sleep(2)
                cap = cv2.VideoCapture(CAMERA_INDEX, cv2.CAP_DSHOW)
                
                if not cap.isOpened():
                    print("   ❌ Não foi possível reconectar. Encerrando.")
                    break
                else:
                    print("   ✅ Reconectado! Continuando...")
                    continue
            
            frame_count += 1
            
            # Detectar QR codes
            qr_codes = detect_qr_codes(frame)
            
            # Processar cada QR code detectado
            if len(qr_codes) > 0:
                print(f"\n📸 Frame {frame_count}: {len(qr_codes)} QR code(s) detectado(s)")
                
                for qr in qr_codes:
                    qr_data = qr['data']
                    current_time = time.time()
                    
                    # Verificar cooldown (evitar processar o mesmo QR múltiplas vezes)
                    if qr_data in last_detections:
                        time_since_last = current_time - last_detections[qr_data]
                        if time_since_last < DETECTION_COOLDOWN:
                            # Ainda em cooldown, ignorar
                            print(f"⏱️  QR '{qr_data}' em cooldown ({int(DETECTION_COOLDOWN - time_since_last)}s restantes)")
                            continue
                    
                    # Atualizar timestamp da última detecção
                    last_detections[qr_data] = current_time
                    
                    # Determinar se é entrada ou saída
                    action = determine_action(qr_data)
                    
                    # Enviar para API
                    api_response = send_to_api(qr_data, action)
                    
                    # Se detecção foi bem-sucedida, abrir cancela via MQTT
                    if api_response:
                        abrir_cancela_mqtt()
                    
                    # Salvar imagem com detecção
                    frame_with_qr = draw_qr_codes(frame.copy(), qr_codes)
                    timestamp_str = datetime.now().strftime('%Y%m%d_%H%M%S')
                    filename = f"detections/{qr_data}_{action}_{timestamp_str}.jpg"
                    cv2.imwrite(filename, frame_with_qr)
                    print(f"💾 Imagem salva: {filename}")
            
            # Status a cada 100 frames
            if frame_count % 100 == 0:
                print(f"🔄 Frame {frame_count} processado (sistema ativo)")
            
            # Aguardar um pouco antes do próximo frame
            time.sleep(CHECK_INTERVAL)
    
    except KeyboardInterrupt:
        print("\n🛑 Interrompido pelo usuário")
    
    finally:
        # Liberar recursos
        cap.release()
        
        # Desconectar MQTT
        if mqtt_client:
            mqtt_client.loop_stop()
            mqtt_client.disconnect()
            print("🔌 MQTT desconectado")
        
        print(f"✅ Sistema encerrado ({frame_count} frames processados)")


if __name__ == "__main__":
    main()
