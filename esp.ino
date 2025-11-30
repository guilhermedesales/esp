#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <ESP32Servo.h>
#include <WiFiClientSecure.h>

// --- CONFIG WIFI / MQTT ---
const char* ssid = "PC_BatchProcessing";
const char* password = "05042002";

const char* mqttServer = "3c16c837ea4f4ac0966899396b41ab08.s1.eu.hivemq.cloud";
const int mqttPort = 8883;  // TLS
const char* mqttUser = "guilherme";
const char* mqttPassword = "Guilherme123";

// --- PINOS ---
int sensor1 = 5;
int ledVermelho1 = 15;
int ledVerde1 = 4;

int sensor2 = 26;
int ledVermelho2 = 18;
int ledVerde2 = 19;

int sensorCancela = 2;
int servoPin = 25;

// --- OBJETOS ---
WiFiClientSecure espClientSecure;
PubSubClient client(espClientSecure);
LiquidCrystal_I2C lcd(0x27, 16, 2);
Servo servo;

// --- VARIÁVEIS ---
int estadoAnterior1 = -1;
int estadoAnterior2 = -1;
String estadoAnteriorPub1 = "";
String estadoAnteriorPub2 = "";

int estadoCancela = 0;
unsigned long tempoAbertura = 0;  
int ultimoValorCancela = HIGH;
int contadorAcessos = 0;
bool bloqueado1 = false;
bool bloqueado2 = false;

String lcdLinha1 = "BEM VINDO";
unsigned long tempoUltimoPiscar1 = 0;
unsigned long tempoUltimoPiscar2 = 0;
bool estadoLedPiscar1 = false;
bool estadoLedPiscar2 = false;
const unsigned long intervaloPiscar = 500;

unsigned long tempoUltimoScroll1 = 0;
int scrollIndexLinha1 = 0;

bool wifiConectado = false;
bool mqttConectado = false;

// --- FUNÇÕES ---
void reconnect() {
  while (!client.connected()) {
    Serial.print("Conectando MQTT...");
    if (client.connect("ESP32Vagas", mqttUser, mqttPassword)) {
      Serial.println("Conectado!");
      client.subscribe("estacionamento/vaga1/bloqueio");
      client.subscribe("estacionamento/vaga2/bloqueio");
      client.subscribe("estacionamento/lcd");
      mqttConectado = true;
    } else {
      Serial.print(".");
      delay(1000);
    }
  }
}

void callback(char* topic, byte* payload, unsigned int length){
  String msg = "";
  for(int i=0;i<length;i++) msg += (char)payload[i];

  if(String(topic)=="estacionamento/vaga1/bloqueio") bloqueado1 = (msg=="true");
  if(String(topic)=="estacionamento/vaga2/bloqueio") bloqueado2 = (msg=="true");
  if(String(topic)=="estacionamento/lcd") lcdLinha1 = msg;
}

String getLCDDisplayString(String texto, int &scrollIndex, unsigned long &ultimoScroll) {
  int len = texto.length();
  if(len <= 16){
    int espacos = (16 - len) / 2;
    int resto = (16 - len) % 2;
    String res = "";
    for(int i=0;i<espacos;i++) res += " ";
    res += texto;
    for(int i=0;i<espacos+resto;i++) res += " ";
    return res;
  } else {
    if(millis() - ultimoScroll >= 500){
      scrollIndex++;
      if(scrollIndex >= len) scrollIndex = 0;
      ultimoScroll = millis();
    }
    String res = texto.substring(scrollIndex);
    if(res.length() < 16){
      res += texto.substring(0, 16 - res.length());
    }
    return res.substring(0,16);
  }
}

void setup() {
  Serial.begin(115200);

  pinMode(sensor1, INPUT); pinMode(ledVermelho1, OUTPUT); pinMode(ledVerde1, OUTPUT);
  pinMode(sensor2, INPUT); pinMode(ledVermelho2, OUTPUT); pinMode(ledVerde2, OUTPUT);
  pinMode(sensorCancela, INPUT); servo.attach(servoPin); servo.write(0);

  lcd.init(); lcd.backlight(); lcd.clear();
  lcd.setCursor(0,0); lcd.print(lcdLinha1);
  lcd.setCursor(0,1); lcd.print("Vagas Livres: 00");

  WiFi.begin(ssid, password);
  Serial.print("Conectando WiFi");

  espClientSecure.setInsecure(); // ignora certificado, necessário para HiveMQ TLS
}

void loop() {
  if(WiFi.status() == WL_CONNECTED && !wifiConectado){
    wifiConectado = true;
    Serial.println(" - WiFi conectado!");
    client.setServer(mqttServer, mqttPort);
    client.setCallback(callback);
  }

  if(wifiConectado && !mqttConectado) reconnect();
  if(mqttConectado) client.loop();

  int valor1 = digitalRead(sensor1);
  int valor2 = digitalRead(sensor2);
  int valorCancela = digitalRead(sensorCancela);

  bool novaDeteccao = (ultimoValorCancela == HIGH && valorCancela == LOW);
  if (estadoCancela == 0 && novaDeteccao) {
    servo.write(90);
    estadoCancela = 1;
    tempoAbertura = millis();
    contadorAcessos++;
    if(mqttConectado){
      client.publish("estacionamento/cancela","aberta");
      client.publish("estacionamento/acessos", String(contadorAcessos).c_str());
    }
  }
  if (estadoCancela == 1 && (millis() - tempoAbertura >= 2000)) {
    servo.write(0);
    estadoCancela = 0;
    if(mqttConectado) client.publish("estacionamento/cancela","fechada");
  }
  ultimoValorCancela = valorCancela;

  unsigned long now = millis();

  if(bloqueado1){
    if(valor1==LOW){
      if(now - tempoUltimoPiscar1 >= intervaloPiscar){
        estadoLedPiscar1 = !estadoLedPiscar1;
        tempoUltimoPiscar1 = now;
      }
      digitalWrite(ledVermelho1, estadoLedPiscar1 ? HIGH : LOW);
      digitalWrite(ledVerde1, LOW);
    } else { digitalWrite(ledVermelho1,HIGH); digitalWrite(ledVerde1,LOW);}
  } else { digitalWrite(ledVermelho1, valor1==LOW?HIGH:LOW); digitalWrite(ledVerde1, valor1==LOW?LOW:HIGH); }

  if(bloqueado2){
    if(valor2==LOW){
      if(now - tempoUltimoPiscar2 >= intervaloPiscar){
        estadoLedPiscar2 = !estadoLedPiscar2;
        tempoUltimoPiscar2 = now;
      }
      digitalWrite(ledVermelho2, estadoLedPiscar2?HIGH:LOW);
      digitalWrite(ledVerde2, LOW);
    } else { digitalWrite(ledVermelho2,HIGH); digitalWrite(ledVerde2,LOW);}
  } else { digitalWrite(ledVermelho2, valor2==LOW?HIGH:LOW); digitalWrite(ledVerde2, valor2==LOW?LOW:HIGH); }

  String estado1 = bloqueado1 ? "vaga1:bloqueada" : (valor1==LOW ? "vaga1:ocupada" : "vaga1:livre");
  String estado2 = bloqueado2 ? "vaga2:bloqueada" : (valor2==LOW ? "vaga2:ocupada" : "vaga2:livre");

  if(estado1 != estadoAnteriorPub1){
    if(mqttConectado) client.publish("vaga/topico", estado1.c_str());
    estadoAnteriorPub1 = estado1;
  }
  if(estado2 != estadoAnteriorPub2){
    if(mqttConectado) client.publish("vaga/topico", estado2.c_str());
    estadoAnteriorPub2 = estado2;
  }

  lcd.setCursor(0,0);
  lcd.print(getLCDDisplayString(lcdLinha1, scrollIndexLinha1, tempoUltimoScroll1));

  int vagasLivres = (valor1==HIGH && !bloqueado1 ? 1 : 0) + (valor2==HIGH && !bloqueado2 ? 1 : 0);
  String linha2 = "Vagas Livres: ";
  if(vagasLivres < 10) linha2 += "0";
  linha2 += String(vagasLivres);
  lcd.setCursor(0,1);
  lcd.print(linha2);

  delay(30);
}
