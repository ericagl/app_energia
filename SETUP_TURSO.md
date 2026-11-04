# Histórico durável e gratuito com Turso (libSQL)

O que muda: **só a camada de dados do servidor**. Firmware, API e interface
ficam **intactos**. As leituras reais passam a ser gravadas no Turso (SQLite na
nuvem), então o histórico **sobrevive aos deploys** do Render free.

Validado localmente: `init_db`, inserção, duplicata, `bill`, `history`,
`months`, `insights` rodam com o adaptador libSQL. O código remoto é idêntico —
só a conexão muda.

---

## 1. Aplicar as mudanças no projeto

1. Substitua `app/db.py` pelo `db.py` entregue (drop-in; mesmo SQL, agora via libSQL).
2. Adicione ao `requirements.txt`:
   ```
   libsql-experimental>=0.0.40
   ```
3. No `app/config.py`, logo **depois** da linha do `DB_DEMO` e **antes** da linha
   `DB_LEITURA = ...`, cole este bloco:
   ```python
   # --- Turso (libSQL): historico duravel na nuvem ------------------------------
   # Se TURSO_DATABASE_URL estiver definido, as leituras REAIS passam a ser
   # gravadas/lidas no Turso. Sem ele, usa o arquivo local DB_REAL, como antes.
   TURSO_DATABASE_URL = os.getenv("TURSO_DATABASE_URL", "").strip()
   TURSO_AUTH_TOKEN = os.getenv("TURSO_AUTH_TOKEN", "").strip()
   if TURSO_DATABASE_URL:
       DB_REAL = TURSO_DATABASE_URL
   ```

## 2. Criar o banco no Turso e pegar URL + token

Pelo site (turso.tech) ou pela CLI. Pela CLI:

```bash
# instalar a CLI (Linux/macOS)
curl -sSfL https://get.tur.so/install.sh | bash

turso auth signup          # ou: turso auth login
turso db create monitor-energia

turso db show monitor-energia --url     # => libsql://monitor-energia-XXXX.turso.io
turso db tokens create monitor-energia  # => o token (string longa)
```

Guarde os dois valores: a **URL** (`libsql://...`) e o **token**.

## 3. (Opcional) Levar o histórico que já existe para o Turso

Se você já tem leituras reais em `dados/energia_real.db` e quer preservá-las:

```bash
sqlite3 dados/energia_real.db .dump > dump.sql
turso db shell monitor-energia < dump.sql
```
(A ordem não importa: o `init_db` usa `CREATE TABLE IF NOT EXISTS`.)

## 4. Configurar as variáveis

**Local (`.env`):**
```
TURSO_DATABASE_URL=libsql://monitor-energia-XXXX.turso.io
TURSO_AUTH_TOKEN=cole_o_token_aqui
```

**No Render:** painel do serviço → **Environment** → adicione as mesmas duas
chaves (`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`). O `render.yaml` já declara as
duas como `sync:false` (secretas, não vão para o git).

## 5. Testar

Localmente:
```bash
./run.sh            # sobe lendo o .env (agora com Turso)
curl -s http://localhost:8000/api/energy/status
```
Mande uma leitura de teste (com a sua API_KEY) e confirme que ela aparece no app
e **continua lá depois de reiniciar o servidor** — essa é a prova de que o
histórico ficou no Turso, não no disco efêmero.

Depois, no Render: faça o deploy, confira a URL `onrender.com`, mande uma leitura
e **redeploye** — os dados devem permanecer.

---

## Limites honestos do Turso free
- Sem backups automáticos no plano grátis — para um protótipo, tudo bem; se o
  dado virar crítico, exporte de vez em quando (`turso db shell ... .dump`).
- A Turso foi adquirida pela Supabase (out/2026); o free pode mudar com o tempo.
  Seus dados são SQLite, então migrar depois (ex.: para Postgres) é viável.
- Sem escritores concorrentes — no seu caso só o ESP32 escreve, então não afeta.
