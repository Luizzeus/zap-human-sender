// Monta um pacote portátil do Zap Human Sender para Windows em dist/ZapHumanSender.
//
//   dist/ZapHumanSender/
//     Zap Human Sender.exe   <- launcher compilado (abre o painel no navegador)
//     runtime/node.exe       <- runtime Node embutido (roda o servidor real)
//     app/                   <- código + node_modules de produção
//     LEIA-ME.txt
//
// Basta copiar a pasta ZapHumanSender inteira para qualquer Windows e dar
// duplo clique no .exe. Requer apenas o Google Chrome (ou Edge) instalado.
//
// Uso: npm run build:win

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outRoot = path.join(root, 'dist', 'ZapHumanSender');
const appDir = path.join(outRoot, 'app');
const runtimeDir = path.join(outRoot, 'runtime');
const exeName = 'Zap Human Sender.exe';

const APP_FILES = ['server.js', 'automator.js', 'fleet.js', 'package.json', 'package-lock.json'];
const APP_DIRS = ['public'];

function log(msg) {
  console.log('[build:win] ' + msg);
}

function run(cmd, args, opts = {}) {
  // Executa via shell (necessário no Windows para npm.cmd/npx.cmd) e cita
  // argumentos que contenham espaços.
  const quoted = args.map(a => (/[\s"]/.test(a) ? '"' + a.replace(/"/g, '\\"') + '"' : a));
  const line = [cmd, ...quoted].join(' ');
  log(line);
  execSync(line, { stdio: 'inherit', ...opts });
}

function dirSizeMB(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSizeMB.raw(full);
    else total += fs.statSync(full).size;
  }
  return (total / 1024 / 1024).toFixed(0);
}
dirSizeMB.raw = function raw(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += raw(full);
    else total += fs.statSync(full).size;
  }
  return total;
};

// 1. Limpa a saída anterior
if (fs.existsSync(outRoot)) {
  log('limpando ' + outRoot);
  fs.rmSync(outRoot, { recursive: true, force: true });
}
fs.mkdirSync(appDir, { recursive: true });
fs.mkdirSync(runtimeDir, { recursive: true });

// 2. Runtime Node embutido
const nodeSrc = process.execPath;
log('copiando runtime Node: ' + nodeSrc);
fs.copyFileSync(nodeSrc, path.join(runtimeDir, 'node.exe'));

// 3. Código da aplicação
for (const f of APP_FILES) {
  const src = path.join(root, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(appDir, f));
  else log('aviso: ' + f + ' nao encontrado, ignorando');
}
for (const d of APP_DIRS) {
  const src = path.join(root, d);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(appDir, d), { recursive: true });
}

// 4. Dependências de produção (sem baixar o Chromium do Puppeteer)
log('instalando dependencias de producao em app/ (pode levar ~1 min)...');
run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], {
  cwd: appDir,
  env: {
    ...process.env,
    PUPPETEER_SKIP_DOWNLOAD: '1',
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: '1',
    npm_config_ignore_scripts: 'false'
  }
});

// 5. Compila o launcher para .exe
log('compilando o launcher para ' + exeName + ' ...');
run('npx', [
  '--yes', '@yao-pkg/pkg@6',
  path.join(root, 'scripts', 'launcher.js'),
  '--targets', 'node22-win-x64',
  '--output', path.join(outRoot, exeName)
]);

// 6. LEIA-ME
const leiaMe = `ZAP HUMAN SENDER - versao portatil para Windows
================================================

COMO USAR
  1. Copie a pasta "ZapHumanSender" inteira para o computador Windows.
  2. Instale o Google Chrome (ou o Microsoft Edge ja serve).
  3. De um duplo clique em "${exeName}".
  4. O painel abre sozinho no navegador em http://localhost:3050
  5. Para encerrar tudo, feche a janela preta do console.

ESTRUTURA (nao separe estes itens)
  ${exeName}      -> atalho que inicia o sistema
  runtime\\node.exe    -> motor Node embutido
  app\\               -> codigo, painel e dependencias
  ffmpeg.exe          -> OPCIONAL: coloque aqui um ffmpeg.exe para
                        melhorar o preview do video e a variacao de
                        midia por envio (baixe em https://www.gyan.dev/ffmpeg/builds/)

SESSOES DO WHATSAPP
  Os logins ficam salvos em app\\whatsapp-session* e sao reaproveitados
  nas proximas execucoes. Para comecar do zero, apague essas pastas.

PORTA
  Padrao 3050. Para trocar, crie a variavel de ambiente PORT antes de abrir.

OBSERVACOES
  - Precisa de Chrome/Edge instalado no Windows (o sistema usa o navegador
    do proprio computador; nao vem embutido).
  - O Windows/antivirus pode pedir confirmacao na primeira execucao.
`;
fs.writeFileSync(path.join(outRoot, 'LEIA-ME.txt'), leiaMe, 'utf-8');

// 7. Resumo
const totalMB = dirSizeMB(outRoot);
log('');
log('PRONTO: ' + outRoot);
log('Tamanho total: ~' + totalMB + ' MB');
log('Distribua a pasta "ZapHumanSender" inteira.');
