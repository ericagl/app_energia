// Copie este arquivo para "config.h" (mesma pasta) e preencha.
// NÃO publique o config.h: ele contém a senha do Wi-Fi e a chave do servidor.
#pragma once

#define WIFI_SSID       "nome-da-rede"
#define WIFI_SENHA      "senha-da-rede"

// IP do computador que roda o servidor (veja com "hostname -I") e porta.
#define SERVIDOR_URL    "http://192.168.0.10:8000/api/energy/readings"
// Mesmo valor de API_KEY do arquivo .env do servidor.
#define API_KEY         "cole-aqui-a-mesma-chave-do-servidor"
// Identificador deste ESP32 (letras, números, _ . -). Aparece no aplicativo.
#define DEVICE_ID       "ESP32_ENERGIA_001"

// Intervalo entre envios (ms). Use LIMITE_ATRASO_S no servidor >= 3x este valor.
#define INTERVALO_MS    10000

// Pinos do PZEM-004T v3 (UART2) e do INA219 (I2C padrão: SDA 21, SCL 22).
#define PZEM_RX_PIN     16
#define PZEM_TX_PIN     17
