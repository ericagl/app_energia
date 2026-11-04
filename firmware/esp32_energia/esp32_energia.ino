/*
 * Casa Solar — firmware de EXEMPLO para o ESP32 (não testado em hardware).
 *
 * Mede e envia ao servidor (POST /api/energy/readings), a cada INTERVALO_MS:
 *   - consumo da casa:  PZEM-004T v3 (AC)  -> potência (W) e contador de energia (kWh)
 *   - geração solar:    INA219 (DC)        -> potência (W); a energia (kWh) é
 *                                              integrada aqui e guardada na flash
 * Não envia o bloco "grid": este hardware NÃO mede a troca com a rede.
 * O servidor calcula injetada/importada a partir de geração e consumo.
 *
 * Regras do contrato (ver README do servidor):
 *   - sensor sem resposta -> o campo é OMITIDO (nunca enviar 0 no lugar);
 *   - energy_kwh é ACUMULADO (o servidor calcula a diferença);
 *   - timestamp em UTC via NTP; sem relógio sincronizado, o campo é omitido.
 *
 * Bibliotecas (Gerenciador de Bibliotecas da IDE Arduino):
 *   - "PZEM-004T-v30" (mandulaj)
 *   - "Adafruit INA219"
 *
 * ATENÇÃO: o INA219 mede até 26 V e, com o shunt padrão, ~3,2 A — serve para um
 * painel/protótipo pequeno, não para o lado DC de uma instalação residencial
 * (centenas de volts). Para isso, use um medidor adequado ou leia o inversor.
 */
#include <WiFi.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <Wire.h>
#include <time.h>
#include <PZEM004Tv30.h>
#include <Adafruit_INA219.h>

#include "config.h"   // copie de config.exemplo.h

PZEM004Tv30 pzem(Serial2, PZEM_RX_PIN, PZEM_TX_PIN);
Adafruit_INA219 ina219;
Preferences prefs;

bool inaOk = false;
double geracaoKwh = 0;          // contador acumulado de geração (persistido)
unsigned long ultimoMs = 0, ultimoSalvarMs = 0;

// Fila simples para leituras que não puderam ser enviadas (Wi-Fi caiu).
const int MAX_FILA = 30;
String fila[MAX_FILA];
int filaTam = 0;

void conectarWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_SENHA);
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) delay(250);
}

bool relogioOk() { return time(nullptr) > 1600000000; }  // depois de 2020

String agoraUtc() {
  time_t t = time(nullptr);
  struct tm tmUtc;
  gmtime_r(&t, &tmUtc);
  char buf[25];
  strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &tmUtc);
  return String(buf);
}

String montarJson() {
  String j = "{\"device_id\":\"" DEVICE_ID "\"";
  if (relogioOk()) j += ",\"timestamp\":\"" + agoraUtc() + "\"";

  // Geração (INA219): potência agora + energia integrada
  if (inaOk) {
    float pW = ina219.getPower_mW() / 1000.0;
    if (pW < 0) pW = 0;
    j += ",\"generation\":{\"power_w\":" + String(pW, 1) + ",\"energy_kwh\":" + String(geracaoKwh, 4) + "}";
  }

  // Consumo (PZEM-004T): NaN = sem resposta -> omite o bloco
  float pC = pzem.power();
  float eC = pzem.energy();
  if (!isnan(pC) || !isnan(eC)) {
    j += ",\"consumption\":{";
    bool primeiro = true;
    if (!isnan(pC)) { j += "\"power_w\":" + String(pC, 1); primeiro = false; }
    if (!isnan(eC)) { j += String(primeiro ? "" : ",") + "\"energy_kwh\":" + String(eC, 4); }
    j += "}";
  }
  return j + "}";
}

// 200 = aceita ou duplicada; 4xx = recusada (não adianta reenviar).
int enviar(const String& corpo) {
  if (WiFi.status() != WL_CONNECTED) return -1;
  HTTPClient http;
  http.begin(SERVIDOR_URL);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-API-Key", API_KEY);
  int codigo = http.POST(corpo);
  if (codigo != 200) Serial.printf("Envio: HTTP %d %s\n", codigo, http.getString().c_str());
  http.end();
  return codigo;
}

void enfileirar(const String& j) {
  if (filaTam == MAX_FILA) {            // descarta a mais antiga
    for (int i = 1; i < MAX_FILA; i++) fila[i - 1] = fila[i];
    filaTam--;
  }
  fila[filaTam++] = j;
}

void esvaziarFila() {
  while (filaTam > 0) {
    int c = enviar(fila[0]);
    if (c < 0 || c >= 500) return;      // servidor/rede fora: tenta depois
    for (int i = 1; i < filaTam; i++) fila[i - 1] = fila[i];
    filaTam--;
  }
}

void setup() {
  Serial.begin(115200);
  prefs.begin("energia", false);
  geracaoKwh = prefs.getDouble("ger_kwh", 0);  // sobrevive a reinícios
  inaOk = ina219.begin();
  if (!inaOk) Serial.println("INA219 não encontrado: geração não será enviada.");
  conectarWifi();
  configTime(0, 0, "pool.ntp.org", "a.st1.ntp.org.br");  // UTC
  ultimoMs = millis();
}

void loop() {
  unsigned long agora = millis();
  if (agora - ultimoMs < INTERVALO_MS) { delay(50); return; }

  // Integra a energia gerada no intervalo (W x h -> kWh)
  if (inaOk) {
    float pW = ina219.getPower_mW() / 1000.0;
    if (pW > 0) geracaoKwh += pW * ((agora - ultimoMs) / 3600000.0) / 1000.0;
  }
  ultimoMs = agora;
  if (agora - ultimoSalvarMs > 300000) {     // grava na flash a cada 5 min
    prefs.putDouble("ger_kwh", geracaoKwh);
    ultimoSalvarMs = agora;
  }

  conectarWifi();
  String j = montarJson();
  esvaziarFila();
  int c = enviar(j);
  if (c < 0 || c >= 500) enfileirar(j);      // guarda para reenviar
  Serial.println(j);
}
