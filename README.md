# Casa Solar — Conta de Energia Inteligente

Aplicativo web acessível que recebe as medições de **geração solar** e
**consumo** da casa enviadas por um **ESP32** e as apresenta como uma **conta de
luz moderna**: quanto o sol gerou, quanto a casa consumiu, o saldo, para onde
foi a energia e quanto isso vale em R$ — com leitura por voz e um assistente de
perguntas clicáveis.

```
ESP32 (PZEM-004T + INA219) ──Wi-Fi──► POST /api/energy/readings ──► FastAPI ──► SQLite ──► App web (PWA)
```

- **Backend:** FastAPI + SQLite (Python) · **Frontend:** HTML/CSS/JS sem frameworks
- **Dois modos:** `real` (padrão — só leituras do ESP32) e `demonstracao`
  (valores fictícios, com aviso em todas as telas). Os dados de cada modo ficam
  em bancos separados e nunca se misturam.

> **Situação da integração:** o servidor, o contrato de comunicação e a
> interface foram testados com **payloads de exemplo** (testes automatizados e
> teste no navegador). **Nenhuma transmissão de um ESP32 real foi recebida
> ainda.** O firmware em `firmware/` é um exemplo **não testado em hardware**.
> Veja [Pendências](#pendências-para-operar-com-dados-reais).

---

## Sumário
1. [Rodar com dados reais (ESP32)](#1-rodar-com-dados-reais-esp32)
2. [Rodar com valores fictícios (demonstração)](#2-rodar-com-valores-fictícios-demonstração)
3. [Contrato de comunicação (JSON)](#3-contrato-de-comunicação-json)
4. [Programar o ESP32](#4-programar-o-esp32)
5. [Comunicação e falhas](#5-comunicação-e-falhas)
6. [O que o app mostra e de onde vem cada número](#6-o-que-o-app-mostra-e-de-onde-vem-cada-número)
7. [Configuração (variáveis de ambiente)](#7-configuração-variáveis-de-ambiente)
8. [API](#8-api)
9. [Testes](#9-testes)
10. [Voz, assistente e acessibilidade](#10-voz-assistente-e-acessibilidade)
11. [Estrutura do projeto](#11-estrutura-do-projeto)
12. [Pendências para operar com dados reais](#pendências-para-operar-com-dados-reais)

---

## 1. Rodar com dados reais (ESP32)

### 1.1 Preparar o servidor

```bash
cd monitor_energia
cp .env.exemplo .env
python3 -c "import secrets; print(secrets.token_urlsafe(32))"   # gera uma chave
```

Abra o `.env` e preencha pelo menos:

```ini
MODO=real
API_KEY=cole-aqui-a-chave-gerada
TARIFA_RS_POR_KWH=0.95        # tarifa real da sua concessionária
UNIDADE_NOME="Minha residência"
```

> Sem `API_KEY` o servidor **recusa** todas as leituras (seguro por padrão).
> O `.env` contém a chave: não o publique (já está no `.gitignore`).

### 1.2 Subir o servidor

```bash
./run.sh            # cria o .venv, instala dependências, lê o .env e sobe em 0.0.0.0:8000
```

Abra **http://localhost:8000**. Antes da primeira transmissão o app mostra
**"Aguardando a primeira transmissão do medidor"** e os cards ficam com "—"
(nunca zeros inventados). No terminal aparece o modo de operação e, se faltar
a chave, um aviso.

Descubra o IP do computador na rede (o ESP32 vai usá-lo):

```bash
hostname -I          # ex.: 192.168.0.10
```

### 1.3 Testar o recebimento sem o ESP32 (opcional)

Use um **banco de teste**, para não misturar com as medições reais:

```bash
DB_REAL=dados/teste.db ./run.sh
```

Em outro terminal, envie uma leitura de exemplo (troque a chave):

```bash
curl -X POST http://localhost:8000/api/energy/readings \
  -H "Content-Type: application/json" -H "X-API-Key: SUA_CHAVE" \
  -d '{"device_id":"ESP32_TESTE","generation":{"power_w":850,"energy_kwh":12.5},
       "consumption":{"power_w":620,"energy_kwh":8.3}}'
```

Resposta esperada: `{"ok":true,"duplicada":false,...}`. Em até 10 s o app
mostra "Medidor ESP32_TESTE conectado". Depois apague `dados/teste.db` e volte a
rodar só com `./run.sh`.

### 1.4 Conectar o ESP32

Siga a [seção 4](#4-programar-o-esp32): copie `config.exemplo.h` para
`config.h`, preencha Wi-Fi, `SERVIDOR_URL` (`http://IP-DO-COMPUTADOR:8000/api/energy/readings`),
a **mesma** `API_KEY` do `.env` e o `DEVICE_ID`, e grave no ESP32.

Para conferir se chegou:

```bash
curl http://localhost:8000/api/energy/status     # estado, dispositivos, recusas e último erro
tail -f dados/ingestao.log                       # leituras recusadas e motivos
```

### 1.5 Celular e tablet

Na **mesma rede Wi-Fi**, abra `http://IP-DO-COMPUTADOR:8000`. Leitura em voz
alta e botões funcionam por HTTP; o **microfone** exige HTTPS (ou localhost).

---

## 2. Rodar com valores fictícios (demonstração)

```bash
./run.sh demonstracao        # ou: MODO=demonstracao ./run.sh
```

- Liga o **simulador** (casa com ~1,2 kWp; ~35 dias de histórico + uma leitura a
  cada 5 s), gravando em `dados/energia_demonstracao.db`.
- Todas as telas mostram **"Modo demonstração: os números são simulados"**, o
  indicador de comunicação mostra "Simulador" e a leitura por voz avisa.
- Leituras que um ESP32 enviar nesse período vão para o banco **real**, não
  para a demonstração.
- O modo **nunca** é ativado sozinho (nem quando o ESP32 cai): só por
  `MODO=demonstracao` ou `./run.sh demonstracao`.

Também há uma prévia sem servidor: definir `window.__USE_MOCK__ = true` antes
dos scripts faz o navegador simular os dados (`static/mock.js`).

Para voltar aos dados reais: `./run.sh` (com `MODO=real` no `.env`).

---

## 3. Contrato de comunicação (JSON)

`POST /api/energy/readings` · cabeçalhos `Content-Type: application/json` e
`X-API-Key: <API_KEY>`. Corpo: **uma leitura** ou uma **lista** de até 200
(ex.: leituras guardadas enquanto o Wi-Fi caiu).

```json
{
  "device_id": "ESP32_ENERGIA_001",
  "timestamp": "2026-10-03T13:00:00Z",
  "generation":  { "power_w": 850, "energy_kwh": 12.5 },
  "consumption": { "power_w": 620, "energy_kwh": 8.3 },
  "grid": {
    "import_power_w": 0, "export_power_w": 230,
    "import_energy_kwh": 1.2, "export_energy_kwh": 4.5
  }
}
```

| Campo | Obrigatório | Significado |
|---|---|---|
| `device_id` | sim | identificador do ESP32 (`A–Z a–z 0–9 _ . -`, até 64) |
| `timestamp` | não | hora da medição, ISO 8601 **com fuso** (UTC com `Z`). Sem ele, usa a hora do servidor |
| `generation.power_w` | não* | potência gerada **agora** (W) |
| `generation.energy_kwh` | não* | contador **acumulado** de energia gerada (kWh) |
| `consumption.power_w` | não* | potência consumida **agora** (W) |
| `consumption.energy_kwh` | não* | contador **acumulado** de energia consumida (kWh) |
| `grid.*` | não | **só** se o ESP32 tiver um medidor no ponto de conexão com a rede |

\* Pelo menos uma medição de geração ou consumo. **Sensor sem resposta: omita o
campo** — o servidor registra "não medido", nunca zero.

**Regras do servidor**

- **Energia vem de contadores acumulados.** O servidor calcula a energia de
  cada intervalo pela diferença entre contadores do mesmo dispositivo. Uma
  transmissão perdida não perde energia (a próxima diferença a inclui).
- A **primeira** leitura de cada contador é a linha de base (energia do
  intervalo desconhecida). Se o contador **voltar** (ESP32 reiniciou, medidor
  zerado), o intervalo fica sem energia e o app avisa "dados incompletos" —
  nunca energia negativa.
- **Potência (W) nunca é somada como energia (kWh).**
- Sem `grid`, as energias injetada/importada/usada direto são **calculadas**
  (ver seção 6). Com `grid`, são **medidas**.

**Respostas**

| Código | Quando |
|---|---|
| `200` | aceita (`"duplicada": false`) ou repetida (`"duplicada": true`, mesmo `device_id` + `timestamp` — não grava de novo). Lote: `{aceitas, duplicadas, rejeitadas:[{indice, motivo}]}` |
| `401` | `X-API-Key` ausente ou errada |
| `403` | `device_id` fora de `DISPOSITIVOS_PERMITIDOS` |
| `409` | leitura **anterior** à última recebida do mesmo dispositivo (fora de ordem) |
| `413` | lote com mais de 200 leituras |
| `422` | formato inválido, campo desconhecido, valor negativo, potência acima de `MAX_POTENCIA_W`, timestamp sem fuso / anterior a 2020 (relógio sem NTP) / no futuro, salto de energia impossível para o intervalo |
| `503` | servidor sem `API_KEY` configurada (recebimento desligado) |

Toda recusa é registrada em `dados/ingestao.log` e aparece em
`/api/energy/status` (`estatisticas.ultimo_erro`).

---

## 4. Programar o ESP32

Exemplo em `firmware/esp32_energia/` (**não testado em hardware**), para o
hardware previsto no projeto:

| Sensor | Mede | Ligação |
|---|---|---|
| PZEM-004T v3 | consumo AC da casa: potência e contador de energia (guardado no próprio PZEM) | UART2 — RX 16, TX 17 |
| INA219 | geração DC: potência; a energia é integrada no ESP32 e salva na flash | I2C — SDA 21, SCL 22 |

1. IDE Arduino com suporte a ESP32; instale as bibliotecas **PZEM-004T-v30**
   (mandulaj) e **Adafruit INA219**.
2. Copie `config.exemplo.h` para `config.h` e preencha `WIFI_SSID`,
   `WIFI_SENHA`, `SERVIDOR_URL`, `API_KEY` (igual ao `.env`) e `DEVICE_ID`.
3. Grave e abra o Monitor Serial (115200): cada envio mostra o JSON e, em caso
   de erro, o código HTTP e o motivo.

O exemplo sincroniza o relógio por NTP (UTC), omite sensores que não
respondem, guarda até 30 leituras se o Wi-Fi cair e as reenvia em ordem. Ele
**não** envia `grid`, porque esse hardware não mede a rede.

> **Atenção:** o INA219 mede até 26 V e ~3,2 A (shunt padrão) — serve para um
> painel pequeno/protótipo, **não** para o lado DC de uma instalação
> residencial (centenas de volts). Para um sistema real, use um medidor
> adequado ou os dados do inversor.

Intervalo de envio: `INTERVALO_MS` (10 s). Configure no servidor
`LIMITE_ATRASO_S` ≥ 3× esse intervalo.

---

## 5. Comunicação e falhas

O app consulta `/api/energy/status` a cada 5 s e mostra um indicador (ponto +
texto) no topo:

| Estado | Quando | O que o app faz |
|---|---|---|
| **Conectado** | última transmissão há ≤ `LIMITE_ATRASO_S` (60 s) | valores ao vivo como **atuais**; cards e gráficos se atualizam sozinhos |
| **Sem comunicação recente** | até `LIMITE_DESCONEXAO_S` (600 s) | ao vivo vira "—"; a última leitura aparece como **histórica**, com data e hora |
| **Desconectado** | acima disso | idem, mostrando só o histórico registrado |
| **Aguardando a primeira transmissão** | nenhuma leitura ainda | cards com "—"; se faltar `API_KEY`, o app diz que o recebimento está desligado |

Mudanças de estado são anunciadas ao leitor de tela. Em nenhuma situação o app
substitui medições por valores simulados ou por zero:

- **Sem leituras no período:** "Sem leituras no período" / "—".
- **Sensor que não respondeu:** "—" e, nos totais, aviso de **dados
  incompletos**.
- **Servidor fora do ar:** aviso de conexão e últimos dados recebidos.
- **Assistente e leitura por voz:** dizem que não há medição atual e informam a
  última leitura válida.

---

## 6. O que o app mostra e de onde vem cada número

Telas: **Minha conta** (identificação, status, 🔊 Ouvir minha conta, gerada /
consumida / saldo, de onde veio a energia, valor estimado, ao vivo) ·
**Histórico** (hora a hora, dia a dia, saldo acumulado, mensal — com tabelas) ·
**Detalhes** (fluxo de energia e demonstrativo com a origem de cada dado) ·
**Assistente** (perguntas clicáveis).

| Valor | Origem | Como é obtido |
|---|---|---|
| Potência gerada / consumida | **Medido** | `power_w` da última leitura |
| Energia gerada / consumida | **Medido** | soma das diferenças dos contadores `energy_kwh` |
| Injetada (exportada) | **Medido** com `grid`; senão **calculado** | Σ diferença de `export_energy_kwh` · ou Σ `max(geração − consumo, 0)` por leitura |
| Importada | **Medido** com `grid`; senão **calculado** | Σ diferença de `import_energy_kwh` · ou Σ `max(consumo − geração, 0)` por leitura |
| Consumida direto do sol | **Medido/calculado** | geração − exportada · ou Σ `min(geração, consumo)` por leitura |
| Saldo | **Calculado** | geração − consumo |
| % do consumo atendido pelo sol | **Calculado** | consumida direto do sol ÷ consumo |
| Créditos acumulados | **Não disponível** | só a concessionária registra |
| Valor a pagar / economia | **Estimativa** | (importada − injetada) × tarifa / geração × tarifa; sem impostos, taxa mínima, bandeiras e Fio B |

O app informa na tela, no assistente e na leitura por voz quando os fluxos são
medidos, calculados ou mistos. Os calculados não incluem perdas do inversor e
ficam mais precisos quanto menor o intervalo entre leituras. Consistência
garantida e testada: `usada direto + injetada = gerada` e
`usada direto + importada = consumida`.

---

## 7. Configuração (variáveis de ambiente)

Coloque no `.env` (lido pelo `run.sh`) ou exporte antes de rodar.

| Variável | Padrão | Função |
|---|---|---|
| `MODO` | `real` | `real` ou `demonstracao` (`SIMULAR=1` antigo equivale a `demonstracao`) |
| `API_KEY` | vazio | chave exigida em `X-API-Key`; **vazio = recebimento desligado** |
| `DISPOSITIVOS_PERMITIDOS` | vazio | `device_id` aceitos, separados por vírgula (vazio = qualquer) |
| `MAX_POTENCIA_W` | `20000` | potência máxima plausível; acima disso a leitura é recusada |
| `TOLERANCIA_FUTURO_S` | `300` | quanto um timestamp pode estar no futuro (relógio adiantado) |
| `LIMITE_ATRASO_S` | `60` | sem transmissão há mais que isso → "sem comunicação recente" |
| `LIMITE_DESCONEXAO_S` | `600` | sem transmissão há mais que isso → "desconectado" |
| `TARIFA_RS_POR_KWH` | `0.95` | **TODO:** tarifa real (R$/kWh com impostos) |
| `UNIDADE_NOME` | `Minha residência` | nome da unidade consumidora (use aspas no `.env`) |
| `DIA_LEITURA` | vazio | dia da leitura da concessionária (1–31); vazio = "não informada" |
| `DB_REAL` | `dados/energia_real.db` | banco das leituras do ESP32 |
| `DB_DEMO` | `dados/energia_demonstracao.db` | banco do simulador |
| `LOG_ARQUIVO` | `dados/ingestao.log` | registro de recusas e erros de recebimento |
| `TTS_VOZ` | `pt-BR-FranciscaNeural` | voz do servidor (`pt-BR-AntonioNeural`, `pt-BR-ThalitaMultilingualNeural`) |

> O antigo `energia.db` (raiz do projeto) foi preenchido pelo simulador das
> versões anteriores e **não é mais lido**. Pode ser apagado.

**Segurança:** a chave fica só no servidor (`.env`) e no ESP32 (`config.h`),
nunca no frontend nem no repositório (`.gitignore`). A comparação é feita em
tempo constante. Todos os campos são validados (tipos, faixas, timestamps,
saltos impossíveis), e duplicatas são barradas por índice único
(`device_id` + horário). Em rede aberta, use HTTPS (proxy reverso ou túnel)
para a chave não trafegar em texto puro.

---

## 8. API

| Rota | Função |
|---|---|
| `POST /api/energy/readings` | recebe leituras do ESP32 (seção 3) |
| `GET /api/energy/current` | leitura mais recente + `atual` (true/false) + estado |
| `GET /api/energy/history?period=day\|month` | série por hora/dia, com fluxos |
| `GET /api/energy/status` | modo, estado da comunicação, dispositivos, estatísticas e último erro |
| `GET /api/bill?period=day\|month` | conta do período (totais, fluxos e origem, estimativas, dados incompletos) |
| `GET /api/months?n=12` | totais por mês e dias com leitura |
| `GET /api/insights` | comparações com os 7 dias anteriores e o mês anterior |
| `GET /api/info` | unidade, modo, tarifa, próxima leitura, limites |
| `GET /api/tts?texto=…` · `GET /api/tts/vozes` | voz neural do servidor |
| `GET /api/latest`, `GET /api/history`, `POST /api/ingest` | compatibilidade com a versão anterior |

`POST /api/ingest` (formato antigo, com incrementos já calculados no ESP32)
continua aceito, também exige `X-API-Key`, e o cabeçalho opcional
`X-Dispositivo` identifica o aparelho.

---

## 9. Testes

```bash
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest -q
```

25 testes automatizados (`tests/test_integracao_esp32.py`), com **payloads de
exemplo** num banco temporário (os bancos reais não são tocados). Cobrem:

- **Recebimento e gravação:** leitura única e lote, e conversão de contadores
  em energia.
- **Segurança:** sem chave, chave errada, recebimento desligado, dispositivo
  não autorizado, chave fora das respostas públicas.
- **Validação:** formato, campos desconhecidos, negativos, limites, timestamps,
  saltos impossíveis.
- **Duplicatas, ordem e contadores:** duplicata, fora de ordem, reinício de
  contador, sensor indisponível (não vira zero).
- **Fluxos de energia:** fluxos calculados consistentes e rede medida
  prevalecendo.
- **Comunicação:** aguardando, conectado, sem comunicação, desconectado e
  recuperação.
- **Histórico e modos:** histórico diário e mensal, separação real ×
  demonstração, formato antigo.

Também foi feito um teste no navegador (Chrome headless, em tempo real) com
leituras de exemplo:

- **Modo real sem dados:** sem aviso de demonstração e com "—" nos cards.
- **Primeiras transmissões:** cards atualizados sozinhos em cerca de 12 s, com
  valores iguais aos incrementos enviados.
- **Perda de comunicação:** ao vivo vira "—" e a última leitura passa a
  histórica, com aviso ao leitor de tela.
- **Recuperação:** volta para "conectado".
- **Assistente e leitura da conta:** usam as medições e respeitam o estado da
  comunicação.
- **Modo demonstração:** aviso visível e banco real intocado.

---

## 10. Voz, assistente e acessibilidade

- **🔊 Ouvir minha conta:** lê por seções:
  1. identificação (avisa se é demonstração ou se o medidor está sem
     comunicação);
  2. energia gerada, energia consumida e saldo;
  3. de onde veio a energia (dizendo se os valores foram medidos ou
     calculados);
  4. valor estimado.

  O cartão narrado fica destacado. Controles: voltar, pausar/continuar,
  avançar e parar (`Esc`).
- **Dois motores de voz:** voz do aparelho (Web Speech) quando há voz pt-BR
  instalada; senão, voz neural do servidor (`edge-tts`, precisa de internet).
  Se um falhar, o app usa o outro.
- **Assistente:** perguntas em 5 assuntos.
  - *Agora*: "Quanto estou gerando agora?", "Quanto minha residência está
    consumindo?", "Estou importando ou exportando energia agora?" e "Qual foi
    minha geração hoje?".
  - *Geração*, *Consumo*, *Economia* e *Conta*: incluem "Quanto estou
    exportando?", "Qual foi meu maior consumo hoje?" e "Como interpretar meu
    saldo?".
  - As respostas usam as medições, dizem quando algo é estimado ou calculado e,
    sem comunicação, informam que não há medição atual em vez de repetir a
    última como se fosse agora.
  - Também é possível digitar ou falar a pergunta.
- **Acessibilidade (WCAG 2.2 AA):**
  - navegação completa por teclado;
  - nomes acessíveis em botões e campos;
  - gráficos com descrição e tabela equivalente;
  - informação nunca só pela cor (ícones, ▲/▼ e texto);
  - temas claro, escuro e alto contraste, e botão "Texto maior";
  - alvos de toque ≥ 48 px;
  - respeito a "reduzir movimento".

  A auditoria com leitores de tela reais fica para o Incremento 3.

---

## 11. Estrutura do projeto

```
monitor_energia/
├── app/
│   ├── main.py        rotas da API e servidor do app
│   ├── ingestao.py    contrato JSON, validação, contadores → energia, estado da comunicação, log
│   ├── db.py          SQLite: leituras, conta, histórico, fluxos
│   ├── config.py      variáveis de ambiente (modo, chave, limites, tarifa)
│   ├── simulator.py   simulador (só no modo demonstração, banco próprio)
│   └── tts.py         voz neural do servidor
├── static/            app web: index.html, styles.css, app.js, voz.js, graficos.js, util.js, mock.js, sw.js
├── firmware/esp32_energia/   firmware de exemplo + config.exemplo.h
├── tests/             testes automatizados (pytest)
├── dados/             bancos e log (criado ao rodar; fora do git)
├── .env.exemplo       modelo de configuração
├── run.sh             ./run.sh [real|demonstracao]
├── requirements.txt / requirements-dev.txt
```

Para uma fonte futura (MQTT, Modbus, API de inversor), monte um `LeituraESP32`
e chame `ingestao.registrar()`: as mesmas validações e o mesmo banco são
reaproveitados, sem um segundo caminho até os dados.

---

## Pendências para operar com dados reais

1. **Montar o hardware e gravar o firmware** (ou adaptar o seu ao contrato da
   seção 3) e confirmar a primeira transmissão real em `/api/energy/status` e
   no app.
2. **Validar as medições:**
   - comparar a potência do PZEM-004T com um alicate amperímetro ou com o
     medidor da concessionária;
   - conferir a energia mensal com a conta de luz;
   - ajustar o INA219 ou trocar o sensor de geração, conforme a escala da
     instalação.
3. **Configurar a tarifa real** (`TARIFA_RS_POR_KWH`) e o `DIA_LEITURA`.
4. **Decidir sobre a medição da rede:** se houver um medidor bidirecional ou um
   inversor com dados de exportação, enviar o bloco `grid` torna injetada e
   importada **medidas**.
5. **Usar HTTPS** se o servidor ficar acessível fora da rede local.
6. **Créditos energéticos** continuam dependendo da conta da concessionária.

Até concluir os itens 1 e 2, a integração está **pronta para receber**, mas não
**validada com o equipamento real**.
