// Captura as telas do painel usadas no manual e no vídeo do operador (docs/assets).
// Uso: 1) inicie o servidor  ->  PORT=3070 npm start
//      2) rode              ->  node scripts/gerar-telas-doc.mjs
import puppeteer from 'puppeteer';
import { resolveBrowserExecutable } from '../automator.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '..', 'docs', 'assets');
const BASE = 'http://localhost:3070';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: resolveBrowserExecutable() || undefined,
  args: ['--no-sandbox', '--disable-gpu', '--force-color-profile=srgb'],
  defaultViewport: { width: 1500, height: 1000, deviceScaleFactor: 2 }
});
const page = await browser.newPage();

async function shotEl(sel, name) {
  await page.waitForSelector(sel, { timeout: 8000 });
  const el = await page.$(sel);
  await el.scrollIntoView();
  await sleep(250);
  await el.screenshot({ path: path.join(OUT, name) });
  console.log('  ->', name);
}
async function shotFull(name) {
  await page.screenshot({ path: path.join(OUT, name), fullPage: true });
  console.log('  ->', name);
}

console.log('carregando painel...');
await page.goto(BASE, { waitUntil: 'networkidle2' });
await sleep(800);

// 01 - painel vazio (hero)
await shotFull('01-painel-vazio.png');

// preenche as sessões (Card 4)
await page.click('#sessions-input', { clickCount: 3 });
await page.keyboard.press('Backspace');
await page.type('#sessions-input', 'Principal\nNúmero B\nNúmero C', { delay: 8 });
await page.evaluate(() => document.getElementById('sessions-input').dispatchEvent(new Event('input', { bubbles: true })));
await sleep(200);

// carrega exemplo (contatos + mensagem + tabela)
await page.click('#btn-load-example');
await sleep(600);

// 02..07 recortes dos cards
await shotEl('.media-card', '02-card-midia.png');
await shotEl('.contacts-card', '03-card-contatos.png');
await shotEl('.template-card', '04-card-mensagem.png');
await shotEl('.settings-card', '05-card-envio-seguro.png');
await shotEl('.control-card', '06-controles.png');
await shotEl('.stats-grid', '07-estatisticas.png');

// configura a fila no servidor -> dispara fleet_stats + progress via SSE
await page.evaluate(async () => {
  await fetch('/api/contacts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contacts: [
        { nome: 'Roberto Silva', telefone: '5511999998888' },
        { nome: 'Clara Mendes', telefone: '5511988887777' },
        { nome: 'Arthur Santos', telefone: '5511977776666' },
        { nome: 'Marina Lopes', telefone: '5511966665555' },
        { nome: 'Paulo Nunes', telefone: '5511955554444' }
      ],
      messageTemplate: '{saudacao}, {Nome}! Segue o cardápio de hoje. 🍽️',
      minDelay: 60, maxDelay: 150,
      sessions: ['Principal', 'Número B', 'Número C'],
      safety: { dailyLimit: 150, batchSize: 20, batchPauseMin: 18, activeStartHour: 8, activeEndHour: 20, warmupEnabled: true, warmupStart: 30, warmupStep: 20 }
    })
  });
});
await sleep(1500);

// 08 - painel de números
await shotEl('.fleet-card', '08-painel-numeros.png');

// 09 - tabela com status simulados (apenas ilustrativo)
await page.evaluate(() => {
  const rows = document.querySelectorAll('#queue-table-body tr');
  const set = (tr, badge, cls, sess) => {
    if (!tr) return;
    const tds = tr.querySelectorAll('td');
    tds[2].innerHTML = sess ? `<span class="badge-sessao">${sess}</span>` : tds[2].innerHTML;
    tds[3].innerHTML = `<span class="badge-status ${cls}">${badge}</span>`;
  };
  set(rows[0], 'Sucesso', 'sucesso', 'Principal');
  set(rows[1], 'Sucesso', 'sucesso', 'Número B');
  set(rows[2], 'Falhou ℹ️', 'falhou', 'Número C');
  set(rows[3], 'Processando', 'processando', 'Principal');
  if (rows[2]) rows[2].querySelectorAll('td')[4].innerHTML = '<button type="button" class="btn-action-table">Reenviar</button>';
});
await sleep(200);
await shotEl('.queue-list-card', '09-tabela-status.png');

// 10 - console de logs
await shotEl('.log-card', '10-console-logs.png');

// 11 - painel completo "operando"
await page.evaluate(() => window.scrollTo(0, 0));
await sleep(300);
await shotFull('11-painel-operando.png');

await browser.close();
console.log('OK - telas em', OUT);
