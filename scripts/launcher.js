'use strict';

// Launcher do Zap Human Sender para Windows.
// Este arquivo é compilado para "Zap Human Sender.exe" (pasta dist/ZapHumanSender).
// Ele apenas sobe o servidor Node embutido e abre o painel no navegador.
//
// Estrutura esperada ao lado do .exe:
//   Zap Human Sender.exe
//   runtime/node.exe
//   app/server.js  (+ automator.js, fleet.js, public/, node_modules/ ...)
//   ffmpeg.exe      (opcional — melhora preview e variação de mídia)

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const baseDir = path.dirname(process.execPath);
const appDir = path.join(baseDir, 'app');
const nodeExe = path.join(baseDir, 'runtime', 'node.exe');
const serverEntry = path.join(appDir, 'server.js');
const PORT = process.env.PORT || '3050';

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (e) {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* espera */ }
  }
}

function fatal(msg) {
  console.error('\n[Zap Human Sender] ' + msg + '\n');
  console.error('A janela fecha em 20 segundos.');
  sleepSync(20000); // mantém a janela aberta para o usuário ler
  process.exit(1);
}

if (!fs.existsSync(nodeExe)) fatal('Não encontrei runtime\\node.exe ao lado do executável.');
if (!fs.existsSync(serverEntry)) fatal('Não encontrei app\\server.js ao lado do executável.');

// ffmpeg opcional: usa um ffmpeg.exe colocado na pasta, se existir.
const ffmpegCandidates = [
  path.join(baseDir, 'ffmpeg.exe'),
  path.join(appDir, 'ffmpeg.exe'),
  path.join(baseDir, 'runtime', 'ffmpeg.exe')
];
const ffmpeg = ffmpegCandidates.find(p => fs.existsSync(p));

const env = { ...process.env, PORT: String(PORT) };
if (ffmpeg) env.FFMPEG_PATH = ffmpeg;

console.log('======================================================');
console.log('  Zap Human Sender');
console.log('  Painel: http://localhost:' + PORT);
console.log('  (feche esta janela para encerrar o sistema)');
console.log('======================================================\n');
if (ffmpeg) console.log('ffmpeg: ' + ffmpeg + '\n');
else console.log('ffmpeg: nao encontrado (opcional) - preview/variação de mídia ficam limitados.\n');

const child = spawn(nodeExe, ['server.js'], { cwd: appDir, stdio: 'inherit', env });

// Abre o navegador no painel depois que o servidor teve tempo de subir.
setTimeout(() => {
  spawn('cmd', ['/c', 'start', '', 'http://localhost:' + PORT], { detached: true, stdio: 'ignore' }).unref();
}, 2500);

child.on('error', (err) => fatal('Falha ao iniciar o servidor: ' + err.message));
child.on('exit', (code) => {
  if (code && code !== 0) fatal('O servidor encerrou com código ' + code + '.');
  process.exit(0);
});

process.on('SIGINT', () => child.kill());
process.on('SIGTERM', () => child.kill());
