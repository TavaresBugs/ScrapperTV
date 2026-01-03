#!/usr/bin/env node
/**
 * Script de teste - Abre o browser Playwright para testes manuais
 * O browser fica aberto até você pressionar Ctrl+C
 */

import { chromium } from 'playwright';

async function main() {
  const args = process.argv.slice(2);
  const symbol = args.find((_, i) => args[i-1] === '-s') || 'CME_MINI_DL:NQ1!';
  const sessionId = args.find((_, i) => args[i-1] === '--session');

  console.log('\n🚀 Abrindo browser Playwright para teste manual...');
  console.log('   Pressione Ctrl+C para fechar quando terminar.\n');

  const browser = await chromium.launch({
    headless: false,
    args: ['--start-maximized']
  });

  const context = await browser.newContext({
    viewport: null,
    acceptDownloads: true
  });

  if (sessionId) {
    console.log('🔐 Configurando sessão...');
    await context.addCookies([{
      name: 'sessionid',
      value: sessionId,
      domain: '.tradingview.com',
      path: '/'
    }]);
  }

  const page = await context.newPage();
  
  const url = `https://www.tradingview.com/chart/?symbol=${symbol}`;
  console.log(`📊 Navegando para: ${url}\n`);
  await page.goto(url);

  console.log('✅ Browser aberto! Faça seus testes manualmente.');
  console.log('   - Ative o Replay mode');
  console.log('   - Selecione uma data');
  console.log('   - Exporte o CSV e veja onde salva');
  console.log('\n   Pressione Ctrl+C para fechar.\n');

  // Mantém o script rodando
  await new Promise(() => {});
}

main().catch(console.error);
