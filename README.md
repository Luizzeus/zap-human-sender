# Zap Human Sender

Sistema profissional de automação e disparo em lote para WhatsApp Web com comportamento humanizado, painel de controle web integrado, agendamento de campanhas e suporte a múltiplos formatos de mídia (texto, imagem e vídeo).

O projeto é construído em Node.js com automação de navegador via Puppeteer, simulando ações humanas (como "digitando..." ou "gravando...") e aplicando intervalos dinâmicos (delays) entre disparos para reduzir drasticamente o risco de banimentos.

---

## 🚀 Principais Funcionalidades

*   **Comportamento Humanizado:** Simula digitação para mensagens de texto e status de gravação de mídia antes do envio.
*   **Envio de Mídias:** Suporte para o envio de imagens (PNG, JPG, WEBP) e vídeos (.mp4) além de mensagens de texto tradicionais.
*   **Fila com Delays Variáveis:** Definição de tempo mínimo e máximo de espera entre cada envio, garantindo aleatoriedade no comportamento.
*   **Painel Administrativo Web:** Interface amigável integrada (servida em `http://localhost:3050`) para carregar contatos, configurar mensagens e acompanhar o progresso.
*   **Logs em Tempo Real (SSE):** Monitoramento da execução e status de cada envio direto na tela através de conexões Server-Sent Events.
*   **Agendamento de Envios:** Permite agendar campanhas completas para serem executadas automaticamente em uma data e hora futura configurada.
*   **Gestão de Licenciamento:** Sistema embutido de ativação por chaves criptográficas de licença (com suporte para planos Demo, Mensais, Trimestrais, Anuais e Perpétuos).
*   **Reenvio Individual:** Opção de tentar novamente o envio de forma individual para contatos específicos que falharam durante a execução em lote.
*   **Compilador de Executável (Windows):** Facilidade de compilar a aplicação inteira em um arquivo `.exe` executável autônomo de Windows (utilizando `pkg`).

---

## 📁 Estrutura do Projeto

*   `server.js`: Backend Node.js em Express responsável pelas APIs REST, controle de upload, agendamentos, geração de logs e transmissão via Server-Sent Events (SSE).
*   `automator.js`: O motor de automação construído com Puppeteer para controle e interação com a interface do WhatsApp Web.
*   `gerar-licenca.js`: Script utilitário em linha de comando para gerar licenças criptográficas válidas a partir de parâmetros (cliente, validade, plano).
*   `public/`: Pasta contendo a interface web do painel administrativo (HTML, CSS, JS).
*   `licencas/`: Diretório contendo modelos e registros das licenças comerciais emitidas.
*   `iniciar-windows.bat`: Script em lotes para inicialização facilitada no Windows.
*   `dist/`: Pasta destino de compilação dos binários finais.

---

## 🛠️ Instalação e Execução (Desenvolvimento)

### 1. Instalar dependências
Certifique-se de ter o Node.js v18 ou superior instalado. No diretório do projeto, execute:
```bash
npm install
```

### 2. Executar o Servidor local
Inicie o servidor de desenvolvimento:
```bash
npm start
```
Acesse o painel administrativo pelo navegador em: **[http://localhost:3050](http://localhost:3050)**

---

## 📦 Compilando para Executável (.exe) no Windows

Para distribuir o software sem expor o código-fonte e sem exigir que o cliente final instale o Node.js, compile um binário executável:

```bash
npm run build:win
```

O arquivo executável autônomo será gerado em:
```text
dist/zap-human-sender-win-x64.exe
```

*Nota: O executável utilizará o Google Chrome ou Microsoft Edge instalado no próprio sistema Windows do cliente, mantendo o tamanho do binário leve.*

---

## 🔒 Segurança e Dados Locais

O diretório é configurado com `.gitignore` para omitir as pastas locais geradas dinamicamente:
*   `node_modules/`: Dependências locais.
*   `whatsapp-session/`: Sessão salva do WhatsApp Web (mantém o usuário conectado).
*   `uploads/`: Mídias enviadas para o painel.
*   `logs/`: Registro de histórico de envios em JSON.
