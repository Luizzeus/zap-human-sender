import express from 'express';
import multer from 'multer';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { FleetCoordinator, DEFAULT_SAFETY } from './fleet.js';

// Utilitários para trabalhar com ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Garante a existência dos diretórios necessários
const uploadsDir = path.join(__dirname, 'uploads');
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3050;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Configura o armazenamento do Multer para o vídeo do cardápio
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    // Salva sempre como cardapio.mp4 substituindo o anterior
    cb(null, 'cardapio.mp4');
  }
});

const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'video/mp4') {
      cb(null, true);
    } else {
      cb(new Error('Apenas arquivos de vídeo .mp4 são suportados!'), false);
    }
  }
});

// Clientes SSE conectados
const sseClients = new Set();

// Histórico de logs da execução atual na memória
let logHistory = [];

// Último snapshot do painel de números (para novos clientes SSE)
let lastFleetStats = [];

// Envia uma mensagem de log para todos os clientes SSE conectados
const broadcastLog = (logEntry) => {
  if (logEntry && logEntry.type === 'fleet_stats') {
    lastFleetStats = logEntry.fleet || [];
  }

  logHistory.push(logEntry);
  // Limita a memória a 200 logs
  if (logHistory.length > 200) logHistory.shift();

  // Escreve em arquivo físico diário
  const today = new Date().toISOString().split('T')[0];
  const logFilePath = path.join(logsDir, `envio_log_${today}.json`);

  let logsFileContent = [];
  try {
    if (fs.existsSync(logFilePath)) {
      logsFileContent = JSON.parse(fs.readFileSync(logFilePath, 'utf-8'));
    }
  } catch (e) {
    logsFileContent = [];
  }

  logsFileContent.push(logEntry);
  fs.writeFileSync(logFilePath, JSON.stringify(logsFileContent, null, 2), 'utf-8');

  // Transmite para os navegadores
  const dataString = `data: ${JSON.stringify(logEntry)}\n\n`;
  sseClients.forEach(client => client.write(dataString));
};

// Converte um rótulo de sessão em um id seguro para pasta/arquivo
function slugify(label) {
  return String(label || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'sessao';
}

// Constrói o coordenador de números a partir de uma lista de rótulos
function buildFleet(sessionLabels) {
  const seen = new Set();
  const sessions = (Array.isArray(sessionLabels) && sessionLabels.length ? sessionLabels : ['Principal'])
    .map(raw => String(raw || '').trim())
    .filter(Boolean)
    .map(label => {
      let id = slugify(label);
      while (seen.has(id)) id += '-x';
      seen.add(id);
      return { id, label };
    });
  if (sessions.length === 0) sessions.push({ id: 'principal', label: 'Principal' });

  const fleet = new FleetCoordinator({
    sessions,
    onLog: (logEntry) => broadcastLog(logEntry),
    onStatusChange: (status) => {
      broadcastLog({
        timestamp: new Date().toLocaleTimeString(),
        type: 'status_change',
        message: `Status alterado para: ${status}`,
        status: status
      });
    },
    onProgress: (progress) => {
      broadcastLog({
        timestamp: new Date().toLocaleTimeString(),
        type: 'progress_update',
        message: `Progresso: ${progress.currentIndex}/${progress.contacts.length}`,
        progress: progress
      });
    }
  });
  fleet._sessionKey = sessions.map(s => s.id).join('|');
  return fleet;
}

// Instância global da automação (rodízio de números)
let automator = buildFleet(['Principal']);

// SSE Endpoint para logs em tempo real
app.get('/api/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Envia logs históricos da execução atual
  logHistory.forEach(log => {
    res.write(`data: ${JSON.stringify(log)}\n\n`);
  });

  // Registra o cliente ativo
  sseClients.add(res);

  // Envia o status atual no momento da conexão
  res.write(`data: ${JSON.stringify({
    timestamp: new Date().toLocaleTimeString(),
    type: 'status_change',
    message: `Status atual: ${automator.status}`,
    status: automator.status
  })}\n\n`);

  // Envia o último snapshot do painel de números
  res.write(`data: ${JSON.stringify({
    timestamp: new Date().toLocaleTimeString(),
    type: 'fleet_stats',
    message: 'Painel de números',
    fleet: lastFleetStats.length ? lastFleetStats : automator.fleetSnapshot()
  })}\n\n`);

  if (automator.contacts.length > 0) {
    res.write(`data: ${JSON.stringify({
      timestamp: new Date().toLocaleTimeString(),
      type: 'progress_update',
      message: `Fila carregada`,
      progress: {
        contacts: automator.contacts,
        currentIndex: automator.currentIndex
      }
    })}\n\n`);
  }

  req.on('close', () => {
    sseClients.delete(res);
  });
});

// Rota de Upload do Vídeo
app.post('/api/upload', (req, res) => {
  upload.single('video')(req, res, (err) => {
    if (err) {
      broadcastLog({
        timestamp: new Date().toLocaleTimeString(),
        type: 'error',
        message: `Falha no upload do vídeo: ${err.message}`
      });
      return res.status(400).json({ success: false, error: err.message });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, error: 'Nenhum arquivo enviado.' });
    }

    const filePath = path.join(uploadsDir, 'cardapio.mp4');
    broadcastLog({
      timestamp: new Date().toLocaleTimeString(),
      type: 'success',
      message: `Menu carregado com sucesso! Arquivo salvo em: ${filePath}`
    });

    res.json({ success: true, path: filePath });
  });
});

// Rota para definir os dados da fila de contatos e configurações
app.post('/api/contacts', async (req, res) => {
  const { contacts, messageTemplate, minDelay, maxDelay, sessions, safety } = req.body;

  if (!contacts || !Array.isArray(contacts) || contacts.length === 0) {
    return res.status(400).json({ success: false, error: 'Lista de contatos inválida ou vazia.' });
  }

  if (!messageTemplate) {
    return res.status(400).json({ success: false, error: 'Modelo de mensagem vazio.' });
  }

  // Reconstrói o rodízio somente se o conjunto de números mudou
  const desiredLabels = (Array.isArray(sessions) && sessions.length) ? sessions : ['Principal'];
  const desiredKey = desiredLabels
    .map(l => slugify(l))
    .filter(Boolean)
    .join('|');

  if (desiredKey && desiredKey !== automator._sessionKey) {
    if (automator.status === 'sending') {
      return res.status(400).json({ success: false, error: 'Não é possível alterar os números durante um envio ativo.' });
    }
    broadcastLog({
      timestamp: new Date().toLocaleTimeString(),
      type: 'info',
      message: `Reconfigurando números de WhatsApp: ${desiredLabels.join(', ')}`
    });
    try {
      await automator.closeBrowser();
    } catch (e) {}
    automator = buildFleet(desiredLabels);
  }

  const filePath = path.join(uploadsDir, 'cardapio.mp4');

  // Carrega a fila no automator
  automator.setupQueue(contacts, filePath, messageTemplate, minDelay, maxDelay, safety || {});

  broadcastLog({
    timestamp: new Date().toLocaleTimeString(),
    type: 'info',
    message: `Fila configurada com ${contacts.length} contatos em ${automator.members.length} número(s). Pronto para iniciar.`
  });

  res.json({ success: true, count: contacts.length, sessions: automator.members.map(m => m.label) });
});

// Rota para abrir/conectar o WhatsApp Web sem iniciar envios
app.post('/api/connect', async (req, res) => {
  if (automator.status === 'sending') {
    return res.status(400).json({ success: false, error: 'Automação já está em andamento.' });
  }

  // Reconstrói o rodízio se os números informados mudaram
  const desiredLabels = (Array.isArray(req.body?.sessions) && req.body.sessions.length) ? req.body.sessions : null;
  if (desiredLabels) {
    const desiredKey = desiredLabels.map(l => slugify(l)).filter(Boolean).join('|');
    if (desiredKey && desiredKey !== automator._sessionKey) {
      try { await automator.closeBrowser(); } catch (e) {}
      automator = buildFleet(desiredLabels);
      broadcastLog({
        timestamp: new Date().toLocaleTimeString(),
        type: 'info',
        message: `Números configurados: ${desiredLabels.join(', ')}`
      });
    }
  }

  res.json({ success: true, message: 'Abrindo WhatsApp Web...' });

  try {
    await automator.initializeBrowser();
  } catch (error) {
    broadcastLog({
      timestamp: new Date().toLocaleTimeString(),
      type: 'error',
      message: `Erro ao abrir WhatsApp Web: ${error.message}`
    });
  }
});

// Rota de Início do Envio
app.post('/api/start', async (req, res) => {
  if (automator.status === 'sending') {
    return res.status(400).json({ success: false, error: 'Automação já está em andamento.' });
  }

  if (automator.contacts.length === 0) {
    return res.status(400).json({ success: false, error: 'Nenhum contato na fila de envio.' });
  }

  const filePath = path.join(uploadsDir, 'cardapio.mp4');
  if (!fs.existsSync(filePath)) {
    return res.status(400).json({ success: false, error: 'Vídeo do cardápio não encontrado. Por favor, faça o upload antes de iniciar.' });
  }

  // Responde imediatamente para não deixar a requisição HTTP bloqueada (o processo rodará em background)
  res.json({ success: true, message: 'Automação iniciada!' });

  // Inicia o processo em background
  try {
    await automator.processQueue();
  } catch (error) {
    broadcastLog({
      timestamp: new Date().toLocaleTimeString(),
      type: 'error',
      message: `Erro fatal no fluxo da fila: ${error.message}`
    });
  }
});

// Rota de Pausa
app.post('/api/pause', (req, res) => {
  if (automator.status !== 'sending') {
    return res.status(400).json({ success: false, error: 'O envio não está ativo.' });
  }
  automator.pause();
  res.json({ success: true });
});

// Rota de Retomada (Resume)
app.post('/api/resume', (req, res) => {
  if (automator.status !== 'paused') {
    return res.status(400).json({ success: false, error: 'O envio não está pausado.' });
  }
  automator.resume();
  res.json({ success: true });

  // Roda em background
  automator.processQueue().catch(error => {
    broadcastLog({
      timestamp: new Date().toLocaleTimeString(),
      type: 'error',
      message: `Erro ao retomar fluxo da fila: ${error.message}`
    });
  });
});

// Rota de Parada Completa
app.post('/api/stop', (req, res) => {
  automator.stop();
  res.json({ success: true });
});

// Rota para Reenviar um Contato Específico que Falhou
app.post('/api/retry-single', async (req, res) => {
  const { index } = req.body;

  if (index === undefined || index < 0 || index >= automator.contacts.length) {
    return res.status(400).json({ success: false, error: 'Índice de contato inválido.' });
  }

  if (automator.status === 'sending') {
    return res.status(400).json({ success: false, error: 'A automação global já está rodando. Aguarde terminar ou pause.' });
  }

  const contact = automator.contacts[index];
  contact.status = 'Processando';
  broadcastLog({
    timestamp: new Date().toLocaleTimeString(),
    type: 'progress_update',
    message: `Reenviando para ${contact.nome}`,
    progress: {
      contacts: automator.contacts,
      currentIndex: automator.currentIndex
    }
  });

  res.json({ success: true, message: `Reenvio iniciado para ${contact.nome}!` });

  // Executa o envio individual em background
  try {
    if (!automator.browser) {
      const initialized = await automator.initializeBrowser();
      if (!initialized) return;
    }

    automator.setStatus('sending'); // temporariamente 'sending' para desabilitar botões
    const success = await automator.sendSingleMessage(contact);

    if (success) {
      contact.status = 'Sucesso';
      broadcastLog({
        timestamp: new Date().toLocaleTimeString(),
        type: 'success',
        message: `✅ Reenvio concluído com sucesso para ${contact.nome}!`
      });
    } else {
      contact.status = 'Falhou';
    }

    automator.setStatus('ready');
    broadcastLog({
      timestamp: new Date().toLocaleTimeString(),
      type: 'progress_update',
      message: `Status atualizado após reenvio`,
      progress: {
        contacts: automator.contacts,
        currentIndex: automator.currentIndex
      }
    });
  } catch (error) {
    contact.status = 'Falhou';
    contact.error = error.message;
    automator.setStatus('ready');
    broadcastLog({
      timestamp: new Date().toLocaleTimeString(),
      type: 'error',
      message: `Erro no reenvio para ${contact.nome}: ${error.message}`
    });
  }
});

// Rota utilitária: valores padrão das configurações de segurança
app.get('/api/safety-defaults', (req, res) => {
  res.json({ success: true, defaults: DEFAULT_SAFETY });
});

// Inicia o servidor Express
app.listen(PORT, () => {
  console.log(`🚀 Servidor Zap Human Sender rodando na porta ${PORT}`);
  console.log(`🌐 Acesse o painel em: http://localhost:${PORT}`);
});
