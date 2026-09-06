import puppeteer from 'puppeteer';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';

// Binário do ffmpeg: usa FFMPEG_PATH se definido (ex.: ffmpeg.exe ao lado do
// executável no Windows), senão tenta o 'ffmpeg' do PATH do sistema.
const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg';

// Localiza um Chrome/Edge instalado no sistema, multiplataforma.
// Prioridade: variável CHROME_PATH -> caminhos padrão do SO -> null
// (null deixa o Puppeteer tentar o Chromium embutido, se existir).
export function resolveBrowserExecutable() {
  const override = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (override && fs.existsSync(override)) return override;

  const pf = process.env['PROGRAMFILES'] || 'C:\\Program Files';
  const pfx86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  const localApp = process.env['LOCALAPPDATA'] || '';

  let candidates;
  if (process.platform === 'win32') {
    candidates = [
      path.join(pf, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(pfx86, 'Google\\Chrome\\Application\\chrome.exe'),
      localApp && path.join(localApp, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(pfx86, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(pf, 'Microsoft\\Edge\\Application\\msedge.exe')
    ];
  } else if (process.platform === 'darwin') {
    candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    ];
  } else {
    candidates = [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium'
    ];
  }

  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

// Função para formatar a saudação dinâmica baseada no horário
export function getGreeting() {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return 'Bom dia';
  if (hour >= 12 && hour < 18) return 'Boa tarde';
  return 'Boa noite';
}

// Parser de Spintax: {Olá|Oi|E aí} -> Escolhe um aleatoriamente
export function parseSpintax(text) {
  const spintaxPattern = /\{([^{}]+)\}/g;
  let newText = text;
  while (spintaxPattern.test(newText)) {
    newText = newText.replace(spintaxPattern, (match, choices) => {
      const options = choices.split('|');
      return options[Math.floor(Math.random() * options.length)];
    });
  }
  return newText;
}

// Classe Principal do Automador
export class WhatsappAutomator {
  constructor(options = {}) {
    this.browser = null;
    this.page = null;
    this.status = 'idle'; // idle, connecting, ready, sending, paused, stopped
    this.onLogCallback = options.onLog || (() => {});
    this.onStatusChangeCallback = options.onStatusChange || (() => {});
    this.onProgressCallback = options.onProgress || (() => {});

    // Identificação da sessão/número (usada no rodízio de vários números)
    this.id = options.id || 'principal';
    this.label = options.label || this.id;
    this.windowIndex = options.windowIndex || 0;

    // Quando true, gera uma variação única do vídeo a cada envio (hash diferente)
    this.varyMedia = options.varyMedia || false;

    this.contacts = [];
    this.currentIndex = 0;
    this.videoPath = null;
    this.messageTemplate = '';
    this.minDelay = 10;
    this.maxDelay = 45;

    this.isPaused = false;
    this.isStopped = false;

    // Pasta persistente para salvar login do WhatsApp (uma por número)
    this.sessionDir = options.sessionDir
      ? path.resolve(options.sessionDir)
      : path.resolve('./whatsapp-session');
  }

  log(type, message, extra = {}) {
    this.onLogCallback({
      timestamp: new Date().toLocaleTimeString(),
      type, // info, success, warning, error, countdown
      message,
      ...extra
    });
  }

  setStatus(status) {
    this.status = status;
    this.onStatusChangeCallback(status);
  }

  // Inicializa o Puppeteer
  async initializeBrowser() {
    if (this.browser) return true;

    this.log('info', '🚀 Iniciando navegador Chrome nativo...');
    this.setStatus('connecting');

    const chromePath = resolveBrowserExecutable();
    if (chromePath) {
      this.log('info', `🧭 Usando navegador do sistema: ${chromePath}`);
    } else {
      this.log('warning', '⚠️ Chrome/Edge não localizado nos caminhos padrão. Instale o Google Chrome ou defina a variável CHROME_PATH.');
    }

    try {
      // Cria pasta de sessão se não existir
      if (!fs.existsSync(this.sessionDir)) {
        fs.mkdirSync(this.sessionDir, { recursive: true });
      }

      // Remove locks remanescentes de execuções anteriores travadas.
      // Evita pkill amplo aqui: ele pode encerrar o Chrome recém-aberto ou a própria sessão gráfica.
      for (const lockFile of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
        const lockPath = path.join(this.sessionDir, lockFile);
        if (fs.existsSync(lockPath)) {
          try {
            fs.rmSync(lockPath, { force: true, recursive: true });
          } catch (e) {
            console.warn(`Falha ao limpar ${lockFile}:`, e.message);
          }
        }
      }

      this.browser = await puppeteer.launch({
        headless: false, // Abre visível para permitir ler o QR Code
        executablePath: chromePath || undefined, // Chrome/Edge do sistema (multiplataforma)
        userDataDir: this.sessionDir, // Salva os cookies e a sessão
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--window-size=1200,900',
          `--window-position=${60 + this.windowIndex * 80},${40 + this.windowIndex * 60}`,
          '--disable-gpu',
          '--disable-extensions'
        ],
        defaultViewport: null
      });

      const pages = await this.browser.pages();
      this.page = pages.length > 0 ? pages[0] : await this.browser.newPage();
      
      // Define User-Agent comum para evitar bloqueios (coerente com o SO atual)
      const uaPlatform = process.platform === 'win32'
        ? 'Windows NT 10.0; Win64; x64'
        : process.platform === 'darwin'
        ? 'Macintosh; Intel Mac OS X 10_15_7'
        : 'X11; Linux x86_64';
      await this.page.setUserAgent(
        `Mozilla/5.0 (${uaPlatform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36`
      );

      this.log('info', '🌐 Carregando o WhatsApp Web...');
      await this.page.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded', timeout: 60000 });

      // Loop para verificar se está conectado ou precisa de QR Code
      this.log('info', '⏳ Aguardando autenticação ou carregamento do WhatsApp...');
      
      let isReady = false;
      const startTime = Date.now();
      
      while (!isReady) {
        if (this.isStopped) {
          throw new Error('Inicialização cancelada pelo usuário.');
        }

        // Verifica se a lista de conversas apareceu (Conectado)
        const isConnected = await this.page.evaluate(() => {
          return !!(
            document.querySelector('[data-testid="chat-list"]') || 
            document.querySelector('[data-testid="conversation-text-input"]') ||
            document.querySelector('#pane-side')
          );
        });

        if (isConnected) {
          isReady = true;
          this.log('success', '✅ WhatsApp conectado e pronto para uso!');
          this.setStatus('ready');
          break;
        }

        // Verifica se o QR Code está visível na tela
        const hasQRCode = await this.page.evaluate(() => {
          return !!(
            document.querySelector('canvas') ||
            document.querySelector('[data-testid="qrcode"]') ||
            document.querySelector('[data-ref]')
          );
        });

        if (hasQRCode) {
          this.log('warning', '🔒 WhatsApp desconectado. Por favor, ESCANEIE O QR CODE na janela do Chrome aberta.');
          // Espera um tempo antes de checar de novo para não sobrecarregar
          await new Promise(resolve => setTimeout(resolve, 5000));
        } else {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }

        // Timeout geral de 3 minutos para conectar
        if (Date.now() - startTime > 180000) {
          throw new Error('Tempo limite excedido para carregamento ou leitura do QR Code.');
        }
      }

      return true;
    } catch (error) {
      this.log('error', `❌ Falha ao iniciar ou conectar: ${error.message}`);
      this.setStatus('idle');
      await this.closeBrowser();
      return false;
    }
  }

  // Fecha o navegador com segurança
  async closeBrowser() {
    if (this.browser) {
      this.log('info', '🔌 Fechando navegador...');
      try {
        await this.browser.close();
      } catch (e) {}
      this.browser = null;
      this.page = null;
    }
    this.setStatus('idle');
  }

  // Define os dados para o envio
  setupQueue(contacts, videoPath, messageTemplate, minDelay, maxDelay) {
    this.contacts = contacts.map(c => ({
      ...c,
      status: 'Pendente',
      error: null
    }));
    this.videoPath = videoPath;
    this.messageTemplate = messageTemplate;
    this.minDelay = parseInt(minDelay) || 10;
    this.maxDelay = parseInt(maxDelay) || 45;
    this.currentIndex = 0;
    this.isPaused = false;
    this.isStopped = false;
    
    this.onProgressCallback({
      contacts: this.contacts,
      currentIndex: this.currentIndex
    });
  }

  // Função para simular digitação humana real
  async simulateTyping(element, text) {
    await element.focus();
    
    // Garante que o campo esteja completamente limpo antes de iniciar a simulação de digitação
    await this.page.evaluate((el) => {
      el.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      el.innerHTML = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, element);
    
    // Pressiona um Backspace físico para atualizar o editor Lexical interno
    await this.page.keyboard.press('Backspace');
    
    // Pequena pausa humana antes de começar a digitar (400ms - 1s)
    const initialPause = Math.floor(Math.random() * 600) + 400;
    await new Promise(resolve => setTimeout(resolve, initialPause));

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      
      // Simula erros de digitação ocasionais e correção rápida (1.5% de chance se for letra comum)
      if (i > 1 && i < text.length - 1 && Math.random() < 0.015 && /[a-zA-Z]/.test(char)) {
        const wrongChar = String.fromCharCode(char.charCodeAt(0) + (Math.random() > 0.5 ? 1 : -1));
        await element.type(wrongChar);
        await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 200) + 150));
        await this.page.keyboard.press('Backspace');
        await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 150) + 100));
      }

      await element.type(char);

      // Intervalo variável entre toques (25ms a 95ms)
      const typingSpeed = Math.floor(Math.random() * 70) + 25;
      await new Promise(resolve => setTimeout(resolve, typingSpeed));
    }
  }

  // Executa o envio para toda a fila
  async processQueue() {
    if (this.status === 'sending') return;
    
    // Auto-cicatrização: Verifica se o navegador está realmente vivo e respondendo
    let browserHealthy = false;
    try {
      if (this.browser && this.page) {
        await this.page.evaluate(() => 1);
        browserHealthy = true;
      }
    } catch (e) {
      this.log('warning', '⚠️ Aba do navegador inativa ou desconectada. Reiniciando sessão preventivamente...');
    }

    if (!browserHealthy) {
      try {
        if (this.browser) {
          await this.browser.close().catch(() => {});
        }
      } catch (e) {}
      this.browser = null;
      this.page = null;
      
      const initialized = await this.initializeBrowser();
      if (!initialized) {
        this.log('error', '❌ Falha ao reiniciar a sessão do navegador.');
        this.setStatus('ready');
        return;
      }
    }

    this.setStatus('sending');
    this.log('info', `🎯 Iniciando fila de envio para ${this.contacts.length} contatos...`);

    while (this.currentIndex < this.contacts.length) {
      if (this.isStopped) {
        this.log('warning', '🛑 Fila interrompida pelo usuário.');
        this.setStatus('stopped');
        return;
      }

      if (this.isPaused) {
        this.log('warning', '⏸️ Envio pausado. Aguardando comando para continuar.');
        this.setStatus('paused');
        return;
      }

      const contact = this.contacts[this.currentIndex];
      contact.status = 'Processando';
      this.onProgressCallback({ contacts: this.contacts, currentIndex: this.currentIndex });

      const success = await this.sendWithAutoRetry(contact);

      if (success) {
        contact.status = 'Sucesso';
        this.log('success', `✅ Envio concluído com sucesso para ${contact.nome}!`);
      } else {
        contact.status = 'Falhou';
        // O erro já foi definido dentro da função sendSingleMessage
      }

      this.currentIndex++;
      this.onProgressCallback({ contacts: this.contacts, currentIndex: this.currentIndex });

      // Se não for o último, aplica o delay randômico
      if (this.currentIndex < this.contacts.length && !this.isStopped && !this.isPaused) {
        const delay = Math.floor(Math.random() * (this.maxDelay - this.minDelay + 1)) + this.minDelay;
        this.log('info', `⏱️ Aguardando delay de segurança de ${delay} segundos antes do próximo contato...`);
        
        // Contagem regressiva ativa enviando logs a cada segundo
        for (let sec = delay; sec > 0; sec--) {
          if (this.isStopped || this.isPaused) break;
          this.log('countdown', `Próximo envio em ${sec}s...`, { secondsLeft: sec, totalDelay: delay });
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }

    this.log('success', '🏆 Todos os contatos da lista foram processados!');
    this.setStatus('ready');
  }

  prepareVideoForPreview(sourcePath) {
    const parsed = path.parse(sourcePath);
    const targetPath = path.join(parsed.dir, parsed.name + '-whatsapp-preview.mp4');

    try {
      const sourceStat = fs.statSync(sourcePath);
      if (fs.existsSync(targetPath)) {
        const targetStat = fs.statSync(targetPath);
        if (targetStat.mtimeMs >= sourceStat.mtimeMs && targetStat.size > 0) {
          this.log('info', '🎞️ Usando vídeo convertido para preview: ' + path.basename(targetPath));
          return targetPath;
        }
      }

      this.log('info', '🎞️ Convertendo vídeo para formato compatível com preview do WhatsApp...');
      execFileSync(FFMPEG_BIN, [
        '-y',
        '-i', sourcePath,
        '-vf', "scale=1280:1280:force_original_aspect_ratio=decrease,format=yuv420p",
        '-c:v', 'libx264',
        '-profile:v', 'baseline',
        '-level', '3.1',
        '-preset', 'veryfast',
        '-crf', '23',
        '-movflags', '+faststart',
        '-c:a', 'aac',
        '-b:a', '128k',
        targetPath
      ], { stdio: 'pipe' });

      if (!fs.existsSync(targetPath) || fs.statSync(targetPath).size === 0) {
        throw new Error('ffmpeg não gerou um arquivo válido.');
      }

      this.log('success', '🎞️ Vídeo preparado para preview: ' + path.basename(targetPath));
      return targetPath;
    } catch (error) {
      this.log('warning', '⚠️ Não foi possível preparar vídeo para preview (' + error.message + '). Usando arquivo original.');
      return sourcePath;
    }
  }

  // Gera uma cópia única do vídeo a cada envio: remux rápido (sem recodificar) que
  // apenas troca os metadados, resultando em um arquivo com hash/assinatura diferente.
  // Reduz o sinal de "mídia idêntica em massa" que o WhatsApp usa para detectar spam.
  makeUniqueMediaVariant(basePath) {
    const parsed = path.parse(basePath);
    const tag = randomUUID();
    const targetPath = path.join(parsed.dir, `envio-${tag}.mp4`);

    try {
      execFileSync(FFMPEG_BIN, [
        '-y',
        '-i', basePath,
        '-map_metadata', '-1',
        '-c', 'copy',
        '-metadata', `comment=${tag}`,
        '-metadata', `title=${tag.slice(0, 8)}`,
        '-metadata', `creation_time=${new Date().toISOString()}`,
        '-movflags', '+faststart',
        targetPath
      ], { stdio: 'pipe' });

      if (!fs.existsSync(targetPath) || fs.statSync(targetPath).size === 0) {
        throw new Error('ffmpeg não gerou a variação.');
      }
      return { path: targetPath, temp: true };
    } catch (error) {
      this.log('warning', '⚠️ Não foi possível gerar variação de mídia (' + error.message + '). Usando arquivo padrão.');
      return { path: basePath, temp: false };
    }
  }

  // Envia um contato com 1 reenvio automático imediato caso a primeira tentativa falhe.
  // Se a falha persistir, retorna false e o chamador segue adiante com a lista.
  async sendWithAutoRetry(contact) {
    let success = await this.sendSingleMessage(contact);

    if (!success && !this.isStopped && !this.isPaused) {
      const retryPause = Math.floor(Math.random() * 5000) + 3000;
      this.log('warning', `⚠️ Falha no envio para ${contact.nome}. Fazendo 1 reenvio automático em ${Math.round(retryPause / 1000)}s...`);
      await new Promise(resolve => setTimeout(resolve, retryPause));

      if (!this.isStopped && !this.isPaused) {
        success = await this.sendSingleMessage(contact);
        if (success) {
          this.log('success', `✅ Reenvio automático bem-sucedido para ${contact.nome}!`);
        } else {
          this.log('error', `❌ Reenvio automático também falhou para ${contact.nome}. Seguindo adiante com a lista.`);
        }
      }
    }

    return success;
  }

  // Processa um único contato da fila
  async sendSingleMessage(contact) {
    this.log('info', `➡️ Processando contato: ${contact.nome} (${contact.telefone})`);

    // Arquivo temporário de variação de mídia (limpo no finally)
    let mediaVariant = null;

    // Auto-cicatrização individual do contato antes do envio
    let browserHealthy = false;
    try {
      if (this.browser && this.page) {
        await this.page.evaluate(() => 1);
        browserHealthy = true;
      }
    } catch (e) {
      this.log('warning', '⚠️ Aba do navegador inativa ao processar contato. Auto-cicatrizando...');
    }

    if (!browserHealthy) {
      try {
        if (this.browser) {
          await this.browser.close().catch(() => {});
        }
      } catch (e) {}
      this.browser = null;
      this.page = null;
      
      const initialized = await this.initializeBrowser();
      if (!initialized) {
        throw new Error('Falha ao auto-cicatrizar e reiniciar sessão do navegador.');
      }
    }

    try {
      if (!this.page) {
        throw new Error('Navegador não está pronto.');
      }

      // 1. Limpa o telefone (apenas números)
      let activePhone = contact.telefone.replace(/\D/g, '');
      if (!activePhone || activePhone.length < 10) {
        throw new Error('Formato de telefone inválido (DDI + DDD + Número requerido).');
      }

      // 2. Monta a mensagem personalizada
      const saudacao = getGreeting();
      let personalizedMessage = this.messageTemplate
        .replace(/{Nome}/g, contact.nome)
        .replace(/{saudacao}/g, saudacao);
      
      // Aplica spintax
      personalizedMessage = parseSpintax(personalizedMessage);

      // Função auxiliar para aguardar o estado do chat
      const waitForChatState = async () => {
        const startTime = Date.now();
        const timeout = 35000;
        
        while (Date.now() - startTime < timeout) {
          try {
            // 1. Se encontrar o input de texto ou o painel principal do chat, a conversa carregou
            const isReady = await this.page.evaluate(() => {
              return !!document.querySelector('[data-testid="conversation-text-input"]') || 
                     !!document.querySelector('#main') ||
                     !!document.querySelector('footer div[contenteditable="true"]');
            });
            if (isReady) return 'chat_ready';
            
            // 2. Se encontrar o popup de alerta bloqueante real de número inválido
            const isInvalid = await this.page.evaluate(() => {
              // Procura por qualquer elemento div, diálogo ou popup curto (alerta)
              const containers = Array.from(document.querySelectorAll('div, [role="dialog"], [data-testid="popup-contents"]'));
              
              for (const el of containers) {
                const text = el.innerText || '';
                // Popups de aviso do WhatsApp são pequenos (menos de 500 caracteres)
                if (text.length > 0 && text.length < 500) {
                  const hasWarningText = text.includes('compartilhado por url') || 
                                         text.includes('inválido') || 
                                         text.includes('não existe') || 
                                         text.includes('invalid') || 
                                         text.includes('doesn\'t exist');
                                         
                  // O popup de alerta de erro do WhatsApp sempre tem um botão exclusivo com o texto "OK"
                  const hasOKButton = Array.from(el.querySelectorAll('div[role="button"], button'))
                    .some(btn => btn.innerText.trim() === 'OK');
                    
                  if (hasWarningText && hasOKButton) {
                    return true;
                  }
                }
              }
              return false;
            });
            if (isInvalid) return 'invalid_number';
          } catch (e) {
            // Silencia erros transientes de contexto destruído ou detached frame durante o carregamento de página
          }
          
          // Pausa de 500ms para evitar alto consumo de CPU
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        return 'timeout';
      };

      // 3. Abre o chat do contato
      this.log('info', `🔗 Abrindo chat com ${activePhone}...`);
      await this.page.goto(`https://web.whatsapp.com/send?phone=${activePhone}`, {
        waitUntil: 'domcontentloaded',
        timeout: 45000
      });

      // 4. Detecção de número inválido ou carregamento do chat
      this.log('info', '⏳ Aguardando confirmação do chat ou erro de número...');
      let chatState = await waitForChatState();

      if (chatState === 'invalid_number') {
        // Clica no botão de fechar/OK do popup para liberar a tela
        try {
          await this.page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('div[role="button"]'));
            const okBtn = buttons.find(b => b.innerText.includes('OK') || b.innerText.includes('Fechar'));
            if (okBtn) okBtn.click();
          });
          await new Promise(resolve => setTimeout(resolve, 1500));
        } catch (e) {}

        // TENTATIVA DE AUTO-CORREÇÃO DO 9º DÍGITO PARA NÚMEROS BRASILEIROS LEGADOS
        if (activePhone.startsWith('55') && activePhone.length === 13 && activePhone[4] === '9') {
          const legacyPhone = activePhone.slice(0, 4) + activePhone.slice(5);
          this.log('warning', `⚠️ O formato com o 9º dígito (${activePhone}) falhou. Tentando formato legado sem o 9 (${legacyPhone})...`);
          
          await this.page.goto(`https://web.whatsapp.com/send?phone=${legacyPhone}`, {
            waitUntil: 'domcontentloaded',
            timeout: 45000
          });
          
          this.log('info', '⏳ Aguardando confirmação no formato legado...');
          chatState = await waitForChatState();
          
          if (chatState === 'chat_ready') {
            activePhone = legacyPhone;
            this.log('success', '✅ Conexão bem-sucedida usando o formato legado!');
          }
        }
      }

      if (chatState === 'invalid_number') {
        this.log('error', `❌ O número ${contact.telefone} é inválido ou não possui WhatsApp.`);
        contact.error = 'Número inválido / Não possui WhatsApp';

        // Clica no botão de fechar/OK do popup para liberar a tela
        try {
          await this.page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('div[role="button"]'));
            const okBtn = buttons.find(b => b.innerText.includes('OK') || b.innerText.includes('Fechar'));
            if (okBtn) okBtn.click();
          });
          await new Promise(resolve => setTimeout(resolve, 1500));
        } catch (e) {}

        return false;
      }

      if (chatState === 'timeout') {
        throw new Error('Tempo esgotado ao tentar abrir o chat (conexão lenta ou instabilidade).');
      }

      this.log('success', '💬 Chat aberto com sucesso!');

      // DEBUG: Loga a estrutura detalhada de todos os campos contenteditable na página
      try {
        const debugEditables = await this.page.evaluate(() => {
          return Array.from(document.querySelectorAll('div[contenteditable="true"]')).map(el => {
            const getParents = (element) => {
              let p = element.parentElement;
              const tags = [];
              for (let i = 0; i < 5; i++) {
                if (!p) break;
                tags.push(`${p.tagName}.${Array.from(p.classList).join('.')}(id=${p.id || ''}, testid=${p.getAttribute('data-testid') || ''})`);
                p = p.parentElement;
              }
              return tags;
            };
            return {
              className: el.className,
              id: el.id || '',
              testid: el.getAttribute('data-testid') || '',
              role: el.getAttribute('role') || '',
              title: el.getAttribute('title') || '',
              ariaLabel: el.getAttribute('aria-label') || '',
              parentHierarchy: getParents(el)
            };
          });
        });
        this.log('info', `🔎 [DOM INSPECTOR] Campos de texto detectados: ${JSON.stringify(debugEditables)}`);
      } catch (err) {
        this.log('warning', `⚠️ Falha ao depurar DOM: ${err.message}`);
      }

      // 5. Verifica se o arquivo de vídeo existe
      if (!fs.existsSync(this.videoPath)) {
        throw new Error('Arquivo de vídeo não encontrado no servidor. Por favor, carregue o vídeo novamente.');
      }

      // Limpa qualquer texto pendente no campo normal do chat antes de abrir o editor de mídia.
      // Isso evita que uma falha anterior deixe a legenda no rodapé e contamine o próximo envio.
      await this.page.evaluate(() => {
        const footerEditable = Array.from(document.querySelectorAll('footer div[contenteditable="true"], #main footer div[contenteditable="true"]'))[0];
        if (!footerEditable) return;
        footerEditable.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        footerEditable.innerHTML = '';
        footerEditable.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      }).catch(() => {});

      // Função auxiliar para localizar o campo de legenda dentro do editor de mídia/documento.
      const findCaptionInput = async (fileName) => {
        try {
          const handle = await this.page.evaluateHandle((name) => {
            const normalize = (value) => (value || '')
              .normalize('NFD')
              .replace(/[\u0300-\u036f]/g, '')
              .trim()
              .toLowerCase();

            const isVisible = (el) => {
              if (!el) return false;
              const rect = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              return rect.width > 10 && rect.height > 10 &&
                rect.bottom > 0 && rect.right > 0 &&
                rect.top < window.innerHeight && rect.left < window.innerWidth &&
                style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
            };

            const selectedSendButton = Array.from(document.querySelectorAll('div[role="button"], button')).find((button) => {
              const label = normalize(button.getAttribute('aria-label') || button.getAttribute('title') || '');
              return isVisible(button) &&
                (label.includes('enviar') || label.includes('send')) &&
                (label.includes('item selecionado') || label.includes('itens selecionados') || label.includes('selected item') || label.includes('selected'));
            });

            let mediaRoot = selectedSendButton?.closest('[data-testid="drawer-middle"], [data-testid="media-editor"], [data-testid="media-viewer"], [role="dialog"]') || null;

            if (!mediaRoot && name) {
              const fileAnchor = Array.from(document.querySelectorAll('*')).find((el) => {
                if (!isVisible(el) || el.children.length > 0) return false;
                return normalize(el.textContent) === normalize(name);
              });

              let parent = fileAnchor?.parentElement || null;
              for (let i = 0; i < 12 && parent; i++) {
                const hasSelectedSend = Array.from(parent.querySelectorAll('div[role="button"], button')).some((button) => {
                  const label = normalize(button.getAttribute('aria-label') || button.getAttribute('title') || '');
                  return (label.includes('enviar') || label.includes('send')) &&
                    (label.includes('item selecionado') || label.includes('selected'));
                });
                const hasEditable = !!parent.querySelector('div[contenteditable="true"]');
                if (hasSelectedSend && hasEditable) {
                  mediaRoot = parent;
                  break;
                }
                if (parent.tagName === 'BODY' || parent.id === 'app') break;
                parent = parent.parentElement;
              }
            }

            if (!mediaRoot) return null;

            const editables = Array.from(mediaRoot.querySelectorAll('div[contenteditable="true"]'))
              .filter((el) => isVisible(el))
              .filter((el) => !el.closest('#side, [data-testid="side"], footer'));

            if (editables.length === 0) return null;

            const sendRect = selectedSendButton?.getBoundingClientRect?.() || null;
            const scored = editables.map((el) => {
              const rect = el.getBoundingClientRect();
              const label = normalize(el.getAttribute('aria-label') || el.getAttribute('title') || '');
              const placeholder = normalize(el.getAttribute('data-placeholder') || '');
              const captionSignal = label.includes('legenda') || label.includes('caption') || placeholder.includes('legenda') || placeholder.includes('caption');
              const distanceToSend = sendRect ? Math.abs((rect.top + rect.height / 2) - (sendRect.top + sendRect.height / 2)) : 0;
              return {
                el,
                score: (captionSignal ? 10000 : 0) + rect.width + rect.top - distanceToSend,
                debug: {
                  label: el.getAttribute('aria-label') || '',
                  placeholder: el.getAttribute('data-placeholder') || '',
                  text: el.innerText || '',
                  x: rect.left,
                  y: rect.top,
                  width: rect.width,
                  height: rect.height,
                  inFooter: !!el.closest('footer'),
                  rootTestId: mediaRoot.getAttribute('data-testid') || '',
                }
              };
            }).sort((a, b) => b.score - a.score);

            window.__zapCaptionCandidates = scored.map(({ debug, score }) => ({ ...debug, score }));
            return scored[0]?.el || null;
          }, fileName);

          if (handle && handle.asElement()) {
            return handle.asElement();
          }
          await handle.dispose().catch(() => {});
        } catch (e) {}
        return null;
      };

      // 6. Faz o upload do vídeo pelo menu de anexos usando o FileChooser do Puppeteer.
      // Isso evita deixar a janela nativa de diretórios aberta e permite priorizar preview.
      const clickAttachmentOption = async (optionLabels) => {
        await this.page.evaluate(() => {
          const normalize = (value) => (value || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .trim()
            .toLowerCase();

          const isVisible = (el) => {
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
          };

          const attachButton = Array.from(document.querySelectorAll('button, div[role="button"]')).find((button) => {
            const label = normalize(button.getAttribute('aria-label') || button.getAttribute('title') || '');
            const icon = normalize(button.querySelector('[data-icon]')?.getAttribute('data-icon') || button.getAttribute('data-icon') || '');
            return isVisible(button) && (label.includes('anexar') || label.includes('attach') || icon.includes('plus'));
          });
          attachButton?.click();
        });

        await new Promise(resolve => setTimeout(resolve, 700));

        const clicked = await this.page.evaluate((labels) => {
          const normalize = (value) => (value || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .trim()
            .toLowerCase();
          const normalizedLabels = labels.map(normalize);
          const candidates = Array.from(document.querySelectorAll('button, div[role="button"], li, span, div'));
          const option = candidates.find((el) => {
            const label = normalize(el.getAttribute('aria-label') || el.getAttribute('title') || '');
            const text = normalize(el.innerText || el.textContent || '');
            return normalizedLabels.includes(label) || normalizedLabels.includes(text);
          });
          if (!option) return false;
          option.click();
          return true;
        }, optionLabels);

        if (!clicked) {
          throw new Error('Opção de anexo não encontrada: ' + optionLabels.join(' / '));
        }
      };

      const uploadFromAttachmentMenu = async (optionLabels, filePathToUpload) => {
        const chooserPromise = this.page.waitForFileChooser({ timeout: 8000 });
        await clickAttachmentOption(optionLabels);
        const fileChooser = await chooserPromise;
        await fileChooser.accept([filePathToUpload]);
      };

      const findCaptionInputUntil = async (fileName, timeoutMs) => {
        const startTime = Date.now();
        while (Date.now() - startTime < timeoutMs) {
          const input = await findCaptionInput(fileName);
          if (input) return input;
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        return null;
      };

      let previewVideoPath = this.prepareVideoForPreview(this.videoPath);

      // Gera uma variação única do arquivo para este envio (hash diferente a cada disparo).
      if (this.varyMedia) {
        mediaVariant = this.makeUniqueMediaVariant(previewVideoPath);
        previewVideoPath = mediaVariant.path;
      }

      let uploadedVideoPath = previewVideoPath;
      let captionInput = null;

      this.log('info', '📁 Tentando carregar o vídeo como Fotos e vídeos para manter preview...');
      try {
        await uploadFromAttachmentMenu(['Fotos e vídeos', 'Photos & videos', 'Photos and videos'], previewVideoPath);
        this.log('info', '⏳ Processando upload com preview...');
        captionInput = await findCaptionInputUntil(path.basename(previewVideoPath), 20000);
        if (captionInput) {
          this.log('success', '📁 Vídeo carregado com preview em modo Fotos e vídeos!');
        }
      } catch (error) {
        this.log('warning', '⚠️ Falha ao abrir upload com preview: ' + error.message);
      }

      if (!captionInput) {
        this.log('warning', '⚠️ Preview não ficou disponível. Tentando envio alternativo como Documento...');
        await this.page.keyboard.press('Escape').catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 700));

        uploadedVideoPath = this.videoPath;
        await uploadFromAttachmentMenu(['Documento', 'Document'], uploadedVideoPath);
        this.log('info', '⏳ Processando upload do documento...');
        captionInput = await findCaptionInputUntil(path.basename(uploadedVideoPath), 20000);

        if (!captionInput) {
          throw new Error('Tempo limite esgotado ao aguardar o editor de mídia/documento do WhatsApp Web.');
        }

        this.log('success', '📁 Vídeo carregado com sucesso em modo Documento!');
      }

      const captionDebug = await this.page.evaluate((captionEl) => {
        const rect = captionEl?.getBoundingClientRect?.();
        return {
          chosen: rect ? {
            label: captionEl.getAttribute('aria-label') || '',
            placeholder: captionEl.getAttribute('data-placeholder') || '',
            text: captionEl.innerText || '',
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height,
            inFooter: !!captionEl.closest('footer'),
            inDrawer: !!captionEl.closest('[data-testid="drawer-middle"], [data-testid="media-editor"], [data-testid="media-viewer"], [role="dialog"]'),
          } : null,
          candidates: window.__zapCaptionCandidates || []
        };
      }, captionInput).catch(() => null);
      this.log('info', '🧪 Campo de legenda selecionado: ' + JSON.stringify(captionDebug));

      // Simula a digitação humanizada
      await this.simulateTyping(captionInput, personalizedMessage);
      this.log('success', '✍️ Legenda personalizada digitada!');

      const getOutgoingMessageCount = async () => {
        return await this.page.evaluate(() => {
          const main = document.querySelector('#main') || document;
          const dataIds = new Set(
            Array.from(main.querySelectorAll('[data-id]'))
              .map(el => el.getAttribute('data-id') || '')
              .filter(id => id.startsWith('true_'))
          );

          if (dataIds.size > 0) return dataIds.size;

          const fallbackOutgoing = Array.from(main.querySelectorAll('.message-out, [class*=message-out]'));
          return fallbackOutgoing.length;
        }).catch(() => 0);
      };

      const outgoingBeforeSend = await getOutgoingMessageCount();
      this.log('info', `📊 Mensagens enviadas antes do clique: ${outgoingBeforeSend}.`);

      // Pequeno delay humano de reação antes de clicar em enviar (1s - 2.5s)
      const reactionDelay = Math.floor(Math.random() * 1500) + 1000;
      await new Promise(resolve => setTimeout(resolve, reactionDelay));

      // 8. Clica no botão de enviar
      this.log('info', '🚀 Enviando mensagem + vídeo...');
      try {
        const debugPath = path.resolve('./logs/whatsapp-preview-before-send.png');
        await this.page.screenshot({ path: debugPath, fullPage: false });
        this.log('info', `🧪 Screenshot do preview antes do clique: ${debugPath}`);
      } catch (error) {
        this.log('warning', `⚠️ Não foi possível salvar screenshot do preview: ${error.message}`);
      }
      
      const clickSendButton = async (captionHandle) => {
        const refreshActivePage = async () => {
          const pages = await this.browser.pages();
          const whatsappPage = pages.find(p => p.url().includes('web.whatsapp.com')) || pages[pages.length - 1];
          if (whatsappPage && whatsappPage !== this.page) {
            this.page = whatsappPage;
          }
          await this.page.bringToFront().catch(() => {});
        };

        const getPreviewSendHandle = async () => {
          const handle = await this.page.evaluateHandle(() => {
            const normalize = (value) => (value || '')
              .normalize('NFD')
              .replace(/[\u0300-\u036f]/g, '')
              .trim()
              .toLowerCase();

            const isVisible = (el) => {
              if (!el) return false;
              const rect = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              return rect.width >= 24 && rect.height >= 24 &&
                rect.bottom > 0 && rect.right > 0 &&
                rect.top < window.innerHeight && rect.left < window.innerWidth &&
                style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
            };

            const isDisabled = (el) => {
              return el.getAttribute('aria-disabled') === 'true' ||
                el.getAttribute('disabled') !== null ||
                !!el.closest('[aria-disabled="true"]');
            };

            const describe = (button, priority) => {
              const rect = button.getBoundingClientRect();
              const iconEl = button.matches('[data-icon]') ? button : button.querySelector('[data-icon]');
              return {
                button,
                priority,
                label: button.getAttribute('aria-label') || button.getAttribute('title') || '',
                text: button.innerText || '',
                icon: iconEl?.getAttribute('data-icon') || '',
                testId: button.getAttribute('data-testid') || '',
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
                width: rect.width,
                height: rect.height,
              };
            };

            const uniqueButtons = (root) => {
              const raw = Array.from(root.querySelectorAll('div[role="button"], button, [data-icon*="send"], [data-testid*="send"]'));
              const buttons = raw.map(el => el.closest('div[role="button"], button') || el);
              return buttons.filter((el, index, arr) => arr.indexOf(el) === index);
            };

            const buttonInfo = (button) => {
              const iconEl = button.matches('[data-icon]') ? button : button.querySelector('[data-icon]');
              const label = normalize(button.getAttribute('aria-label') || button.getAttribute('title') || '');
              const text = normalize(button.innerText || '');
              const icon = normalize(iconEl?.getAttribute('data-icon') || '');
              const testId = normalize(button.getAttribute('data-testid') || '');
              const forbidden = /emoji|emojis|gif|figurinhas|sticker|anexar|attach|remover|remove|fechar|close|cancelar|cancel|painel/.test(label) ||
                /emoji|mood|attach|clip|plus|x-|close|remove|cancel/.test(icon);
              const selectedItemLabel = (label.includes('enviar') || label.includes('send')) &&
                (label.includes('item selecionado') || label.includes('itens selecionados') || label.includes('selected item') || label.includes('selected'));
              const sendSignal = label === 'enviar' || label === 'send' || text === 'enviar' || text === 'send' ||
                testId.includes('send') || icon.includes('send');
              return { label, text, icon, testId, forbidden, selectedItemLabel, sendSignal };
            };

            const roots = Array.from(document.querySelectorAll('[data-testid="drawer-middle"], [data-testid="media-editor"], [data-testid="media-viewer"], [role="dialog"]'));
            roots.push(document);

            const inspected = [];
            const exactMatches = [];
            const drawerSendMatches = [];

            for (const root of roots) {
              for (const button of uniqueButtons(root)) {
                const info = buttonInfo(button);
                const visible = isVisible(button);
                const disabled = isDisabled(button);
                const rootName = root === document ? 'document' : root.tagName + (root.getAttribute('data-testid') ? '[' + root.getAttribute('data-testid') + ']' : '');

                if ((info.selectedItemLabel || info.sendSignal || info.forbidden) && visible) {
                  const desc = describe(button, info.selectedItemLabel ? 'selected-item-label' : 'send-signal');
                  inspected.push({ root: rootName, ...desc, button: undefined, forbidden: info.forbidden, disabled });
                }

                if (!visible || disabled || info.forbidden) continue;
                if (info.selectedItemLabel) exactMatches.push(describe(button, 'selected-item-label'));

                const inDrawer = button.closest('[data-testid="drawer-middle"], [data-testid="media-editor"], [data-testid="media-viewer"], [role="dialog"]');
                if (inDrawer && info.sendSignal) drawerSendMatches.push(describe(button, 'drawer-send-icon'));
              }
            }

            const candidates = exactMatches.length > 0 ? exactMatches : drawerSendMatches;
            candidates.sort((a, b) => {
              const priorityDelta = (a.priority === 'selected-item-label' ? 1 : 0) - (b.priority === 'selected-item-label' ? 1 : 0);
              if (priorityDelta !== 0) return -priorityDelta;
              return (b.x + b.y) - (a.x + a.y);
            });

            window.__zapLastSendCandidates = inspected;
            window.__zapChosenSendCandidate = candidates[0] ? { ...candidates[0], button: undefined } : null;
            return candidates[0]?.button || null;
          });

          const element = handle.asElement();
          if (!element) {
            await handle.dispose().catch(() => {});
            return null;
          }
          return element;
        };

        for (let attempt = 1; attempt <= 5; attempt++) {
          try {
            await refreshActivePage();
            const sendHandle = await getPreviewSendHandle();
            const candidatesDebug = await this.page.evaluate(() => ({
              inspected: window.__zapLastSendCandidates || [],
              chosen: window.__zapChosenSendCandidate || null,
            })).catch(() => ({ inspected: [], chosen: null }));

            this.log('info', '🧪 Candidatos de envio: ' + JSON.stringify(candidatesDebug));

            if (!sendHandle) {
              this.log('warning', '⚠️ Botão de envio do preview não encontrado (tentativa ' + attempt + '/5).');
              await new Promise(resolve => setTimeout(resolve, 1500));
              continue;
            }

            const chosen = candidatesDebug.chosen || {};
            this.log('info', '🖱️ Clicando no botão enviar do preview' + (chosen.label ? ' (' + chosen.label + ')' : '') + '.');
            await sendHandle.click({ delay: 120 });
            await sendHandle.dispose().catch(() => {});
            return true;
          } catch (error) {
            const detached = /detached|Execution context was destroyed|Cannot find context|Target closed/i.test(error.message);
            this.log(detached ? 'warning' : 'error', '⚠️ Falha ao clicar em enviar (tentativa ' + attempt + '/5): ' + error.message);
            await new Promise(resolve => setTimeout(resolve, 1500));
          }
        }

        return false;
      };

      const successSend = await clickSendButton(captionInput);
      if (!successSend) {
        throw new Error('Botão de envio de mídia não localizado ou bloqueado. Confira se o preview do vídeo terminou de carregar.');
      }

      // 9. Aguarda a janela de mídia fechar. O chat normal já existe por baixo do modal,
      // então confirmar apenas #main/footer pode gerar falso positivo.
      this.log('info', '⏳ Confirmando fechamento do editor de mídia após o envio...');
      try {
        await this.page.waitForFunction((captionEl) => !captionEl || !document.contains(captionEl), { timeout: 30000 }, captionInput);
      } catch (error) {
        const stillOpen = await this.page.evaluate((captionEl) => !!captionEl && document.contains(captionEl), captionInput).catch(() => false);
        if (stillOpen) {
          throw new Error('O botão foi acionado, mas o editor de mídia continuou aberto. O envio provavelmente não foi confirmado.');
        }
      }

      this.log('info', '⏳ Confirmando criação da mensagem enviada no chat...');
      try {
        await this.page.waitForFunction((previousCount) => {
          const main = document.querySelector('#main') || document;
          const dataIds = new Set(
            Array.from(main.querySelectorAll('[data-id]'))
              .map(el => el.getAttribute('data-id') || '')
              .filter(id => id.startsWith('true_'))
          );
          const count = dataIds.size || Array.from(main.querySelectorAll('.message-out, [class*=message-out]')).length;
          return count > previousCount;
        }, { timeout: 45000 }, outgoingBeforeSend);
      } catch (error) {
        const outgoingAfterSend = await getOutgoingMessageCount();
        throw new Error(`O editor fechou, mas nenhuma nova mensagem enviada apareceu no chat (antes: ${outgoingBeforeSend}, depois: ${outgoingAfterSend}).`);
      }
      
      // Aguarda mais 3 segundos de folga para processamento de envio de vídeo pesado
      await new Promise(resolve => setTimeout(resolve, 3000));

      return true;
    } catch (error) {
      this.log('error', `❌ Falha ao enviar para ${contact.nome}: ${error.message}`);
      contact.error = error.message;
      return false;
    } finally {
      // Remove o arquivo temporário da variação de mídia deste envio
      if (mediaVariant && mediaVariant.temp) {
        try {
          fs.rmSync(mediaVariant.path, { force: true });
        } catch (e) {}
      }
    }
  }

  // Pausa a fila
  pause() {
    if (this.status === 'sending') {
      this.isPaused = true;
      this.setStatus('paused');
      this.log('warning', '⏸️ Solicitação de pausa recebida. O envio será pausado após finalizar a tarefa atual.');
    }
  }

  // Resume a fila
  resume() {
    if (this.status === 'paused') {
      this.isPaused = false;
      this.isStopped = false;
      this.processQueue(); // Reinicia o processamento
    }
  }

  // Para a fila completamente
  stop() {
    this.isStopped = true;
    this.isPaused = false;
    if (this.status === 'paused') {
      this.setStatus('stopped');
      this.log('warning', '🛑 Fila de envio encerrada pelo usuário.');
    } else if (this.status === 'idle' || this.status === 'ready') {
      this.setStatus('stopped');
    } else {
      this.log('warning', '🛑 Solicitação de interrupção recebida. A automação será interrompida após finalizar o contato atual.');
    }
  }
}
