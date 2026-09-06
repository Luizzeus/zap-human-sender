import path from 'path';
import fs from 'fs';
import { WhatsappAutomator } from './automator.js';

// Configurações de segurança anti-bloqueio (valores padrão)
export const DEFAULT_SAFETY = {
  dailyLimit: 150,      // teto de envios por número, por dia
  batchSize: 25,        // envios seguidos antes de uma pausa longa
  batchPauseMin: 20,    // duração da pausa entre lotes (minutos, com jitter)
  activeStartHour: 9,   // início da janela de envio (hora local)
  activeEndHour: 19,    // fim da janela de envio (hora local)
  warmupEnabled: true,  // aquecimento gradual de números novos
  warmupStart: 30,      // limite no 1º dia de uso do número
  warmupStep: 20        // incremento no limite a cada dia
};

function localDateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Coordena o rodízio de vários números de WhatsApp, aplicando teto diário,
// aquecimento gradual, pausa entre lotes e janela de horário de envio.
export class FleetCoordinator {
  constructor(options = {}) {
    const sessions = (options.sessions && options.sessions.length)
      ? options.sessions
      : [{ id: 'principal', label: 'Principal' }];

    this.onLog = options.onLog || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});
    this.onProgress = options.onProgress || (() => {});

    this.status = 'idle'; // idle, connecting, ready, sending, paused, stopped
    this.contacts = [];
    this.currentIndex = 0;
    this.videoPath = null;
    this.messageTemplate = '';
    this.minDelay = 60;
    this.maxDelay = 150;
    this.isPaused = false;
    this.isStopped = false;
    this.lastIdx = -1;

    this.safety = { ...DEFAULT_SAFETY };
    this.stateFile = path.resolve('./fleet-state.json');
    this.state = {};

    this.members = sessions.map((s, i) => new WhatsappAutomator({
      id: s.id,
      label: s.label,
      windowIndex: i,
      varyMedia: true,
      // Mantém o diretório legado para o número principal (evita re-scan do QR).
      sessionDir: s.id === 'principal' ? './whatsapp-session' : `./whatsapp-session-${s.id}`,
      onLog: (entry) => this.onLog({ ...entry, message: `[${s.label}] ${entry.message}` }),
      onStatusChange: () => {},
      onProgress: () => {}
    }));

    this.loadState();
  }

  log(type, message, extra = {}) {
    this.onLog({ timestamp: new Date().toLocaleTimeString(), type, message, ...extra });
  }

  setStatus(status) {
    this.status = status;
    this.onStatusChange(status);
  }

  emitProgress() {
    this.onProgress({ contacts: this.contacts, currentIndex: this.currentIndex });
  }

  emitFleetStats() {
    this.onLog({
      timestamp: new Date().toLocaleTimeString(),
      type: 'fleet_stats',
      message: 'Atualização do painel de números',
      fleet: this.fleetSnapshot()
    });
  }

  // Compat com server.js: verdadeiro se qualquer número está com navegador aberto.
  get browser() {
    return this.members.some(m => m.browser) ? true : null;
  }

  // -------------------------------------------------------------------------
  // Estado persistente de envios por número (fleet-state.json)
  // -------------------------------------------------------------------------
  loadState() {
    try {
      if (fs.existsSync(this.stateFile)) {
        this.state = JSON.parse(fs.readFileSync(this.stateFile, 'utf-8')) || {};
      }
    } catch (e) {
      this.state = {};
    }
    return this.state;
  }

  saveState() {
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch (e) {}
  }

  pruneDaily(entry) {
    if (!entry || !entry.daily) return;
    const keys = Object.keys(entry.daily).sort();
    while (keys.length > 21) {
      delete entry.daily[keys.shift()];
    }
  }

  daysSinceFirst(id) {
    const s = this.state[id];
    if (!s || !s.firstDate) return 0;
    const first = new Date(s.firstDate + 'T00:00:00');
    const now = new Date(localDateKey() + 'T00:00:00');
    return Math.max(0, Math.round((now - first) / 86400000));
  }

  sentToday(id) {
    const s = this.state[id];
    return (s && s.daily && s.daily[localDateKey()]) || 0;
  }

  warmupLimitToday(id) {
    const daily = this.safety.dailyLimit;
    if (!this.safety.warmupEnabled) return daily;
    const lim = this.safety.warmupStart + this.safety.warmupStep * this.daysSinceFirst(id);
    return Math.min(daily, Math.max(1, lim));
  }

  recordSent(id) {
    const k = localDateKey();
    if (!this.state[id]) this.state[id] = { firstDate: k, daily: {} };
    if (!this.state[id].firstDate) this.state[id].firstDate = k;
    if (!this.state[id].daily) this.state[id].daily = {};
    this.state[id].daily[k] = (this.state[id].daily[k] || 0) + 1;
    this.pruneDaily(this.state[id]);
    this.saveState();
  }

  fleetSnapshot() {
    const now = Date.now();
    return this.members.map(m => ({
      id: m.id,
      label: m.label,
      connected: !!m.browser,
      sentToday: this.sentToday(m.id),
      limitToday: this.warmupLimitToday(m.id),
      dailyLimit: this.safety.dailyLimit,
      daysActive: this.daysSinceFirst(m.id),
      pausedUntil: (m._pauseUntil && m._pauseUntil > now) ? m._pauseUntil : null
    }));
  }

  // -------------------------------------------------------------------------
  // Configuração da fila
  // -------------------------------------------------------------------------
  setupQueue(contacts, videoPath, messageTemplate, minDelay, maxDelay, safety) {
    this.contacts = contacts.map(c => ({ ...c, status: 'Pendente', error: null, sessao: null }));
    this.videoPath = videoPath;
    this.messageTemplate = messageTemplate;
    this.minDelay = parseInt(minDelay) || 60;
    this.maxDelay = parseInt(maxDelay) || 150;
    if (this.maxDelay < this.minDelay) this.maxDelay = this.minDelay;

    const s = { ...DEFAULT_SAFETY, ...(safety || {}) };
    const int = (value, fallback) => {
      const n = parseInt(value, 10);
      return Number.isFinite(n) ? n : fallback;
    };
    this.safety = {
      dailyLimit: Math.max(1, int(s.dailyLimit, DEFAULT_SAFETY.dailyLimit)),
      batchSize: Math.max(1, int(s.batchSize, DEFAULT_SAFETY.batchSize)),
      batchPauseMin: Math.max(0, int(s.batchPauseMin, DEFAULT_SAFETY.batchPauseMin)),
      activeStartHour: Math.min(23, Math.max(0, int(s.activeStartHour, DEFAULT_SAFETY.activeStartHour))),
      activeEndHour: Math.min(24, Math.max(0, int(s.activeEndHour, DEFAULT_SAFETY.activeEndHour))),
      warmupEnabled: s.warmupEnabled !== false && s.warmupEnabled !== 'false',
      warmupStart: Math.max(1, int(s.warmupStart, DEFAULT_SAFETY.warmupStart)),
      warmupStep: Math.max(0, int(s.warmupStep, DEFAULT_SAFETY.warmupStep))
    };

    this.currentIndex = 0;
    this.isPaused = false;
    this.isStopped = false;
    this.lastIdx = -1;

    this.members.forEach(m => {
      m.videoPath = videoPath;
      m.messageTemplate = messageTemplate;
      m.minDelay = this.minDelay;
      m.maxDelay = this.maxDelay;
      m.varyMedia = true;
      m._sinceBatch = 0;
      m._pauseUntil = 0;
      m._nextFreeAt = 0;
      m.isPaused = false;
      m.isStopped = false;
    });

    this.loadState();
    this.emitProgress();
    this.emitFleetStats();
  }

  // -------------------------------------------------------------------------
  // Conexão dos navegadores
  // -------------------------------------------------------------------------
  async initializeBrowser() {
    this.setStatus('connecting');
    this.log('info', `🌐 Abrindo ${this.members.length} sessão(ões) de WhatsApp Web...`);
    for (const m of this.members) {
      this.log('info', `— Abrindo a sessão "${m.label}". Escaneie o QR Code da janela correspondente, se pedido.`);
      try {
        await m.initializeBrowser();
      } catch (e) {
        this.log('error', `Falha ao abrir a sessão "${m.label}": ${e.message}`);
      }
    }
    const ok = this.members.filter(m => m.browser).length;
    this.log(ok === this.members.length ? 'success' : 'warning', `Sessões conectadas: ${ok}/${this.members.length}.`);
    this.setStatus(ok > 0 ? 'ready' : 'idle');
    this.emitFleetStats();
    return ok > 0;
  }

  async ensureMemberReady(member) {
    if (member.browser && member.page) {
      try {
        await member.page.evaluate(() => 1);
        return;
      } catch (e) {
        try { await member.browser.close().catch(() => {}); } catch (e2) {}
        member.browser = null;
        member.page = null;
      }
    }
    await member.initializeBrowser();
  }

  // -------------------------------------------------------------------------
  // Rodízio / seleção do próximo número
  // -------------------------------------------------------------------------
  pickNextMember() {
    const now = Date.now();
    const n = this.members.length;
    const order = [];
    for (let k = 1; k <= n; k++) order.push(this.members[(this.lastIdx + k) % n]);

    let allCapped = true;
    let earliestReady = Infinity;

    for (const m of order) {
      const capped = this.sentToday(m.id) >= this.warmupLimitToday(m.id);
      if (capped) continue;
      allCapped = false;

      const blockedUntil = Math.max(m._pauseUntil || 0, m._nextFreeAt || 0);
      if (blockedUntil > now) {
        earliestReady = Math.min(earliestReady, blockedUntil);
        continue;
      }
      return { member: m };
    }

    if (allCapped) return { reason: 'capped' };
    return { reason: 'wait', readyAt: earliestReady === Infinity ? now + 30000 : earliestReady };
  }

  isWithinActiveHours() {
    const { activeStartHour, activeEndHour } = this.safety;
    if (activeStartHour === activeEndHour) return true; // janela de 24h
    const h = new Date().getHours();
    return activeStartHour < activeEndHour
      ? (h >= activeStartHour && h < activeEndHour)
      : (h >= activeStartHour || h < activeEndHour); // janela cruzando a meia-noite
  }

  async waitForActiveHours() {
    let warned = false;
    while (!this.isStopped && !this.isPaused) {
      if (this.isWithinActiveHours()) return;
      if (!warned) {
        this.log('warning', `⏰ Fora da janela de envio (${this.safety.activeStartHour}h–${this.safety.activeEndHour}h). Aguardando o horário permitido...`);
        warned = true;
      }
      await this.interruptibleSleep(5 * 60000);
    }
  }

  async interruptibleSleep(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (this.isStopped || this.isPaused) return;
      await new Promise(r => setTimeout(r, Math.min(1000, Math.max(0, end - Date.now()))));
    }
  }

  // -------------------------------------------------------------------------
  // Loop principal de envio
  // -------------------------------------------------------------------------
  async processQueue() {
    if (this.status === 'sending') return;

    this.loadState();
    this.setStatus('sending');
    const restantes = this.contacts.length - this.currentIndex;
    this.log('info', `🎯 Rodízio iniciado: ${this.members.length} número(s), ${restantes} contato(s) a enviar. Delay por número: ${this.minDelay}-${this.maxDelay}s.`);
    this.emitFleetStats();

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

      await this.waitForActiveHours();
      if (this.isStopped || this.isPaused) continue;

      const pick = this.pickNextMember();
      if (!pick.member) {
        if (pick.reason === 'capped') {
          const pendentes = this.contacts.length - this.currentIndex;
          this.log('warning', `🚧 Teto diário atingido em todos os números. ${pendentes} contato(s) permanecem pendentes para o próximo dia.`);
          break;
        }
        const waitMs = Math.max(5000, Math.min(pick.readyAt - Date.now(), 5 * 60000));
        this.log('info', `⏳ Todos os números em pausa de segurança. Retomando em ~${Math.round(waitMs / 1000)}s...`);
        await this.interruptibleSleep(waitMs);
        continue;
      }

      const member = pick.member;
      this.lastIdx = this.members.indexOf(member);

      const contact = this.contacts[this.currentIndex];
      contact.status = 'Processando';
      contact.sessao = member.label;
      this.emitProgress();

      await this.ensureMemberReady(member);
      if (!member.browser) {
        this.log('error', `❌ Número "${member.label}" não conectou. Pulando a vez dele por 60s.`);
        member._nextFreeAt = Date.now() + 60000;
        contact.status = 'Pendente';
        this.emitProgress();
        continue;
      }

      member.isPaused = this.isPaused;
      member.isStopped = this.isStopped;

      const success = await member.sendWithAutoRetry(contact);

      if (success) {
        contact.status = 'Sucesso';
        contact.error = null;
        this.recordSent(member.id);
        member._sinceBatch = (member._sinceBatch || 0) + 1;
        this.log('success', `✅ [${member.label}] Enviado para ${contact.nome} — ${this.sentToday(member.id)}/${this.warmupLimitToday(member.id)} hoje.`);

        if (member._sinceBatch >= this.safety.batchSize && this.safety.batchPauseMin > 0) {
          const base = this.safety.batchPauseMin * 60000;
          const jitter = Math.floor(Math.random() * base * 0.4);
          member._pauseUntil = Date.now() + base + jitter;
          member._sinceBatch = 0;
          this.log('info', `😴 [${member.label}] Lote de ${this.safety.batchSize} concluído. Pausa de ~${Math.round((member._pauseUntil - Date.now()) / 60000)} min.`);
        }
      } else {
        contact.status = 'Falhou';
      }

      this.currentIndex++;
      this.emitProgress();
      this.emitFleetStats();

      // Delay individual: apenas este número espera antes da próxima vez dele.
      const perNumberDelay = Math.floor(Math.random() * (this.maxDelay - this.minDelay + 1)) + this.minDelay;
      member._nextFreeAt = Date.now() + perNumberDelay * 1000;

      // Pequeno intervalo global entre números diferentes.
      if (this.currentIndex < this.contacts.length && !this.isStopped && !this.isPaused) {
        const gap = Math.floor(Math.random() * 12) + 8; // 8–20s
        for (let sec = gap; sec > 0; sec--) {
          if (this.isStopped || this.isPaused) break;
          this.log('countdown', `Próximo envio em ${sec}s...`, { secondsLeft: sec, totalDelay: gap });
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    }

    if (this.currentIndex >= this.contacts.length) {
      this.log('success', '🏆 Todos os contatos da lista foram processados!');
    }
    this.setStatus('ready');
    this.emitFleetStats();
  }

  // Reenvio manual de um contato específico (usa qualquer número disponível).
  async sendSingleMessage(contact) {
    let member = this.members.find(m => m.browser && m.page) || this.members[0];
    await this.ensureMemberReady(member);
    member.isPaused = false;
    member.isStopped = false;
    member.videoPath = this.videoPath;
    member.messageTemplate = this.messageTemplate;
    const ok = await member.sendWithAutoRetry(contact);
    if (ok) {
      contact.sessao = member.label;
      this.recordSent(member.id);
      this.emitFleetStats();
    }
    return ok;
  }

  pause() {
    if (this.status === 'sending') {
      this.isPaused = true;
      this.members.forEach(m => { m.isPaused = true; });
      this.setStatus('paused');
      this.log('warning', '⏸️ Solicitação de pausa recebida. O envio será pausado após finalizar o contato atual.');
    }
  }

  resume() {
    if (this.status === 'paused') {
      this.isPaused = false;
      this.isStopped = false;
      this.members.forEach(m => { m.isPaused = false; m.isStopped = false; });
      this.processQueue();
    }
  }

  stop() {
    this.isStopped = true;
    this.isPaused = false;
    this.members.forEach(m => { m.isStopped = true; m.isPaused = false; });
    if (this.status === 'paused') {
      this.setStatus('stopped');
      this.log('warning', '🛑 Fila de envio encerrada pelo usuário.');
    } else if (this.status === 'idle' || this.status === 'ready') {
      this.setStatus('stopped');
    } else {
      this.log('warning', '🛑 Solicitação de interrupção recebida. A automação será interrompida após finalizar o contato atual.');
    }
  }

  async closeBrowser() {
    for (const m of this.members) {
      try { await m.closeBrowser(); } catch (e) {}
    }
    this.setStatus('idle');
  }
}
