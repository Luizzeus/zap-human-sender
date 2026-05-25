// ==========================================================================
// FRONT-END CONTROLLER - ZAP HUMAN SENDER
// ==========================================================================

document.addEventListener('DOMContentLoaded', () => {
  // --- Elementos do DOM ---
  const botStatusBadge = document.getElementById('bot-status-badge');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  
  // Estatísticas
  const valTotal = document.getElementById('val-total');
  const valEnviados = document.getElementById('val-enviados');
  const valFalhas = document.getElementById('val-falhas');
  const valPendentes = document.getElementById('val-pendentes');
  const valPercent = document.getElementById('val-percent');
  const progressFill = document.getElementById('progress-fill');

  // Card 1: Upload
  const dropzone = document.getElementById('dropzone');
  const videoInput = document.getElementById('video-input');
  const previewContainer = document.getElementById('preview-container');
  const videoPreview = document.getElementById('video-preview');
  const previewFilename = document.getElementById('preview-filename');
  const btnRemoveVideo = document.getElementById('btn-remove-video');
  const uploadProgressBar = document.getElementById('upload-progress-bar');
  const uploadFill = document.getElementById('upload-fill');
  const uploadStatus = document.getElementById('upload-status');

  // Card 2: Contatos
  const contactsInput = document.getElementById('contacts-input');
  const btnLoadExample = document.getElementById('btn-load-example');
  const btnClearContacts = document.getElementById('btn-clear-contacts');

  // Card 3: Mensagem
  const messageTemplate = document.getElementById('message-template');
  const variableBadges = document.querySelectorAll('.variable-badges .badge');

  // Card 4: Configurações
  const delayMinInput = document.getElementById('delay-min');
  const delayMaxInput = document.getElementById('delay-max');

  // Controles
  const btnConnect = document.getElementById('btn-connect');
  const btnStart = document.getElementById('btn-start');
  const btnPause = document.getElementById('btn-pause');
  const btnStop = document.getElementById('btn-stop');

  // Monitoramento
  const consoleLogs = document.getElementById('console-logs');
  const queueTableBody = document.getElementById('queue-table-body');

  // --- Estado da Aplicação no Front-end ---
  let isVideoUploaded = false;
  let parsedContacts = [];
  let botState = 'idle'; // idle, connecting, ready, sending, paused, stopped
  let eventSource = null;

  // --- Inicialização ---
  connectSSE();
  validateFormState();

  // ==========================================================================
  // 1. DRAG AND DROP & UPLOAD DE VÍDEO
  // ==========================================================================

  // Clique na zona abre o seletor de arquivos
  dropzone.addEventListener('click', (e) => {
    // Evita abrir se clicou no botão remover ou se o vídeo já está carregado
    if (e.target !== btnRemoveVideo && !isVideoUploaded) {
      videoInput.click();
    }
  });

  // Eventos de arrastar arquivo
  ['dragenter', 'dragover'].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add('dragover');
    }, false);
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove('dragover');
    }, false);
  });

  // Drop do arquivo
  dropzone.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    const files = dt.files;
    if (files.length > 0) {
      handleVideoFile(files[0]);
    }
  });

  // Seleção via janela de arquivo
  videoInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleVideoFile(e.target.files[0]);
    }
  });

  // Processamento e Upload do arquivo
  function handleVideoFile(file) {
    if (file.type !== 'video/mp4') {
      appendLog('error', 'Apenas arquivos de vídeo .mp4 são suportados.');
      return;
    }

    // 1. Mostra o preview local instantaneamente
    const fileURL = URL.createObjectURL(file);
    videoPreview.src = fileURL;
    previewFilename.textContent = file.name;
    
    // Oculta área padrão, mostra preview local
    dropzone.querySelector('.dropzone-content').style.display = 'none';
    previewContainer.style.display = 'flex';
    
    // 2. Faz o upload via AJAX com progresso
    uploadVideoToServer(file);
  }

  function uploadVideoToServer(file) {
    const formData = new FormData();
    formData.append('video', file);

    const xhr = new XMLHttpRequest();
    
    // Configura UI de progresso
    uploadProgressBar.style.display = 'block';
    uploadFill.style.width = '0%';
    uploadStatus.textContent = 'Preparando envio...';
    
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const percent = Math.round((e.loaded / e.total) * 100);
        uploadFill.style.width = `${percent}%`;
        uploadStatus.textContent = `Enviando vídeo ao servidor: ${percent}%`;
      }
    });

    xhr.onload = function() {
      if (xhr.status === 200) {
        const response = JSON.parse(xhr.responseText);
        if (response.success) {
          isVideoUploaded = true;
          uploadStatus.textContent = '✅ Vídeo enviado e processado com sucesso!';
          appendLog('success', 'Menu de vídeo salvo com sucesso no servidor.');
          validateFormState();
        } else {
          handleUploadFailure(response.error || 'Erro desconhecido');
        }
      } else {
        handleUploadFailure(`Código HTTP ${xhr.status}`);
      }
    };

    xhr.onerror = function() {
      handleUploadFailure('Falha na conexão de rede.');
    };

    xhr.open('POST', '/api/upload', true);
    xhr.send(formData);
  }

  function handleUploadFailure(errorMsg) {
    isVideoUploaded = false;
    uploadStatus.textContent = `❌ Falha no upload: ${errorMsg}`;
    appendLog('error', `Falha no upload do vídeo do cardápio: ${errorMsg}`);
    validateFormState();
  }

  // Remoção de vídeo
  btnRemoveVideo.addEventListener('click', (e) => {
    e.stopPropagation();
    
    // Reseta inputs
    videoInput.value = '';
    videoPreview.src = '';
    
    // Alterna visibilidade
    previewContainer.style.display = 'none';
    dropzone.querySelector('.dropzone-content').style.display = 'block';
    uploadProgressBar.style.display = 'none';
    
    isVideoUploaded = false;
    validateFormState();
    appendLog('info', 'Vídeo do cardápio removido.');
  });


  // ==========================================================================
  // 2. PARSER DE LISTA DE CONTATOS
  // ==========================================================================

  contactsInput.addEventListener('input', () => {
    parseContactsList();
  });

  function parseContactsList() {
    const rawText = contactsInput.value.trim();
    if (!rawText) {
      parsedContacts = [];
      renderQueueTable();
      validateFormState();
      return;
    }

    const lines = rawText.split('\n');
    parsedContacts = [];

    lines.forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      // Suporta ";" ou "," como separador
      const separator = trimmed.includes(';') ? ';' : ',';
      const parts = trimmed.split(separator);
      
      const nome = parts[0] ? parts[0].trim() : 'Cliente';
      let telefone = parts[1] ? parts[1].trim() : '';

      // Limpa caracteres especiais do telefone
      const cleanPhone = telefone.replace(/\D/g, '');

      parsedContacts.push({
        nome: nome,
        telefone: cleanPhone || 'Inválido',
        status: 'Pendente',
        error: null
      });
    });

    renderQueueTable();
    validateFormState();
  }

  // Calcula a saudação esperada local baseada no horário do cliente
  function getEstimatedGreeting() {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 12) return 'Bom dia ☀️';
    if (hour >= 12 && hour < 18) return 'Boa tarde 🌤️';
    return 'Boa noite 🌙';
  }

  function renderQueueTable() {
    if (parsedContacts.length === 0) {
      queueTableBody.innerHTML = `
        <tr>
          <td colspan="5" class="text-center empty-row-message">Nenhum contato importado ainda. Cole sua lista na coluna ao lado.</td>
        </tr>
      `;
      updateStatsPanel(0, 0, 0, 0);
      return;
    }

    const estimatedGreeting = getEstimatedGreeting();
    let rowsHTML = '';

    parsedContacts.forEach((c, index) => {
      const statusClass = c.status.toLowerCase();
      let statusBadge = `<span class="badge-status ${statusClass}">${c.status}</span>`;
      
      if (c.status === 'Falhou' && c.error) {
        statusBadge = `<span class="badge-status falhou" title="${c.error}">Falhou ℹ️</span>`;
      }

      // Habilita reenvio se falhou e o bot não está enviando ativamente
      const canRetry = c.status === 'Falhou' && (botState === 'ready' || botState === 'idle' || botState === 'stopped');
      const actionButton = canRetry 
        ? `<button type="button" class="btn-action-table" onclick="retrySingleContact(${index})">Reenviar</button>` 
        : `<span class="text-muted" style="font-size:0.75rem;">—</span>`;

      rowsHTML += `
        <tr class="queue-row-${index}">
          <td><strong>${escapeHTML(c.nome)}</strong></td>
          <td><code>${escapeHTML(c.telefone)}</code></td>
          <td><span class="text-muted">${estimatedGreeting}</span></td>
          <td>${statusBadge}</td>
          <td>${actionButton}</td>
        </tr>
      `;
    });

    queueTableBody.innerHTML = rowsHTML;

    // Atualiza estatísticas do front
    const total = parsedContacts.length;
    const enviados = parsedContacts.filter(c => c.status === 'Sucesso').length;
    const falhas = parsedContacts.filter(c => c.status === 'Falhou').length;
    const pendentes = parsedContacts.filter(c => c.status === 'Pendente').length;
    updateStatsPanel(total, enviados, falhas, pendentes);
  }

  function updateStatsPanel(total, enviados, falhas, pendentes) {
    valTotal.textContent = total;
    valEnviados.textContent = enviados;
    valFalhas.textContent = falhas;
    valPendentes.textContent = pendentes;

    // Calcula percentual de progresso
    if (total > 0) {
      const processed = enviados + falhas;
      const percent = Math.round((processed / total) * 100);
      valPercent.textContent = `${percent}%`;
      progressFill.style.width = `${percent}%`;
    } else {
      valPercent.textContent = '0%';
      progressFill.style.width = '0%';
    }
  }


  // ==========================================================================
  // 3. INJEÇÃO DE VARIÁVEIS NO TEMPLATE
  // ==========================================================================

  variableBadges.forEach(badge => {
    badge.addEventListener('click', () => {
      const varName = badge.getAttribute('data-var');
      insertTextAtCursor(messageTemplate, varName);
      validateFormState();
    });
  });

  function insertTextAtCursor(textarea, text) {
    const startPos = textarea.selectionStart;
    const endPos = textarea.selectionEnd;
    const beforeText = textarea.value.substring(0, startPos);
    const afterText = textarea.value.substring(endPos, textarea.value.length);
    
    textarea.value = beforeText + text + afterText;
    textarea.selectionStart = textarea.selectionEnd = startPos + text.length;
    textarea.focus();
  }

  messageTemplate.addEventListener('input', () => {
    validateFormState();
  });


  // ==========================================================================
  // 4. VALIDAÇÃO DE FORMULÁRIO E ESTADOS DOS BOTÕES
  // ==========================================================================

  function validateFormState() {
    const hasContacts = parsedContacts.length > 0;
    const hasTemplate = messageTemplate.value.trim().length > 0;
    
    // Se o bot está ativamente enviando/conectando, bloqueamos controles e edição
    const isBotActive = botState === 'sending' || botState === 'connecting';

    if (isBotActive) {
      btnConnect.disabled = true;
      btnStart.disabled = true;
      contactsInput.disabled = true;
      messageTemplate.disabled = true;
      delayMinInput.disabled = true;
      delayMaxInput.disabled = true;
      btnLoadExample.disabled = true;
      btnClearContacts.disabled = true;
    } else {
      // Habilita edição
      btnConnect.disabled = false;
      contactsInput.disabled = false;
      messageTemplate.disabled = false;
      delayMinInput.disabled = false;
      delayMaxInput.disabled = false;
      btnLoadExample.disabled = false;
      btnClearContacts.disabled = false;

      // Iniciar só habilita se tiver contatos, template e vídeo carregado
      btnStart.disabled = !(hasContacts && hasTemplate && isVideoUploaded);
    }
  }


  // ==========================================================================
  // 5. EVENT SOURCE (SSE) - RECEBER LOGS E STATUS EM TEMPO REAL
  // ==========================================================================

  function connectSSE() {
    if (eventSource) {
      eventSource.close();
    }

    eventSource = new EventSource('/api/logs');

    eventSource.onmessage = (event) => {
      const log = JSON.parse(event.data);
      
      // Processa atualizações de estado do bot
      if (log.type === 'status_change') {
        updateBotStatusBadge(log.status);
        return;
      }

      // Processa atualizações de progresso
      if (log.type === 'progress_update') {
        const progress = log.progress;
        if (progress && progress.contacts) {
          parsedContacts = progress.contacts;
          renderQueueTable();
        }
        return;
      }

      // Renderiza logs comuns no console
      appendLog(log.type, log.message, log.timestamp);
    };

    eventSource.onerror = (err) => {
      console.error('SSE Connection Error:', err);
      updateBotStatusBadge('stopped');
      appendLog('error', 'Conexão com servidor de monitoramento perdida. Tentando reconectar...');
      setTimeout(connectSSE, 5000);
    };
  }

  function updateBotStatusBadge(status) {
    botState = status;
    validateFormState();
    
    // Limpa classes anteriores
    statusDot.className = 'status-indicator-dot';
    statusDot.classList.add(status);

    // Ajusta o texto do badge
    let text = 'Desconectado';
    if (status === 'connecting') text = 'Iniciando Navegador...';
    if (status === 'ready') text = 'WhatsApp Pronto';
    if (status === 'sending') text = 'Enviando...';
    if (status === 'paused') text = 'Pausado';
    if (status === 'stopped') text = 'Interrompido';

    statusText.textContent = text;

    // Configura estados dos botões de ação
    if (status === 'sending') {
      btnStart.disabled = true;
      btnPause.disabled = false;
      btnStop.disabled = false;
      btnPause.innerHTML = '<span class="icon">⏸</span> Pausar';
    } else if (status === 'paused') {
      btnStart.disabled = true;
      btnPause.disabled = false;
      btnStop.disabled = false;
      btnPause.innerHTML = '<span class="icon">▶</span> Retomar';
    } else {
      btnPause.disabled = true;
      btnStop.disabled = true;
      btnPause.innerHTML = '<span class="icon">⏸</span> Pausar';
    }
  }

  function appendLog(type, message, timestamp = null) {
    const time = timestamp || new Date().toLocaleTimeString();
    const line = document.createElement('div');
    line.className = `log-line ${type}`;
    line.innerHTML = `<span class="log-time">[${time}]</span> ${escapeHTML(message)}`;
    
    consoleLogs.appendChild(line);
    
    // Autoscroll
    consoleLogs.scrollTop = consoleLogs.scrollHeight;
  }


  // ==========================================================================
  // 6. SOLICITAÇÕES À API (REST CONTROLS)
  // ==========================================================================

  // Abre o WhatsApp Web para login/QR Code sem iniciar envios
  btnConnect.addEventListener('click', async () => {
    try {
      appendLog('info', 'Abrindo WhatsApp Web para autenticação...');
      const connectRes = await fetch('/api/connect', { method: 'POST' });
      const connectData = await connectRes.json();
      if (!connectData.success) {
        throw new Error(connectData.error || 'Falha ao abrir WhatsApp Web.');
      }
      appendLog('success', 'WhatsApp Web aberto. Confira a janela do Chrome.');
    } catch (err) {
      appendLog('error', `Erro ao abrir WhatsApp: ${err.message}`);
    }
  });

  // Carrega configurações de Fila e inicia
  btnStart.addEventListener('click', async () => {
    const contactsData = parsedContacts.map(c => ({ nome: c.nome, telefone: c.telefone }));
    const minDelay = parseInt(delayMinInput.value) || 10;
    const maxDelay = parseInt(delayMaxInput.value) || 45;
    
    if (minDelay > maxDelay) {
      appendLog('error', 'O delay mínimo não pode ser maior que o delay máximo.');
      return;
    }

    try {
      // 1. Envia contatos e template ao servidor
      appendLog('info', 'Enviando lista de contatos para configuração...');
      
      const configRes = await fetch('/api/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contacts: contactsData,
          messageTemplate: messageTemplate.value,
          minDelay: minDelay,
          maxDelay: maxDelay
        })
      });

      const configData = await configRes.json();
      if (!configData.success) {
        throw new Error(configData.error || 'Falha ao configurar a fila no servidor.');
      }

      // 2. Dispara a inicialização da automação
      appendLog('info', 'Iniciando automação do navegador...');
      const startRes = await fetch('/api/start', { method: 'POST' });
      const startData = await startRes.json();
      
      if (!startData.success) {
        throw new Error(startData.error || 'Falha ao disparar o início do envio.');
      }

    } catch (err) {
      appendLog('error', `Erro ao iniciar automação: ${err.message}`);
    }
  });

  // Pausa ou retoma o envio
  btnPause.addEventListener('click', async () => {
    try {
      if (botState === 'sending') {
        appendLog('info', 'Solicitando pausa de envios...');
        await fetch('/api/pause', { method: 'POST' });
      } else if (botState === 'paused') {
        appendLog('info', 'Retomando envios da fila...');
        await fetch('/api/resume', { method: 'POST' });
      }
    } catch (err) {
      appendLog('error', `Falha ao gerenciar pausa: ${err.message}`);
    }
  });

  // Interrompe o envio completamente
  btnStop.addEventListener('click', async () => {
    if (confirm('Deseja realmente interromper todo o envio da fila? Os contatos pendentes não serão enviados.')) {
      try {
        appendLog('info', 'Solicitando parada total...');
        await fetch('/api/stop', { method: 'POST' });
      } catch (err) {
        appendLog('error', `Falha ao solicitar interrupção: ${err.message}`);
      }
    }
  });

  // Carrega exemplo para agilizar testes
  btnLoadExample.addEventListener('click', () => {
    contactsInput.value = 
`Roberto Silva;5511999998888
Clara Mendes;5511988887777
Arthur Santos;5511977776666
Número Inválido Teste;55000000000`;

    messageTemplate.value = 
`{saudacao}, {Nome}! 😊

Segue o cardápio de hoje preparado especialmente para você. 🍽️

Qualquer dúvida estou à disposição!`;

    parseContactsList();
    appendLog('success', 'Exemplo carregado. Cole seus números de teste reais para validar!');
  });

  // Limpa lista de contatos
  btnClearContacts.addEventListener('click', () => {
    contactsInput.value = '';
    parseContactsList();
    appendLog('info', 'Lista de contatos limpa.');
  });


  // --- Função Global para o Botão Reenviar da Tabela ---
  window.retrySingleContact = async function(index) {
    try {
      appendLog('info', `Iniciando reenvio para contato #${index + 1}...`);
      const res = await fetch('/api/retry-single', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index: index })
      });
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || 'Erro desconhecido ao reenviar.');
      }
    } catch (err) {
      appendLog('error', `Falha ao reenviar contato: ${err.message}`);
    }
  };


  // --- Utilitários ---
  function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/[&<>'"]/g, 
      tag => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;'
      }[tag] || tag)
    );
  }
});
