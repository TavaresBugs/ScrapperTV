#!/usr/bin/env node
/**
 * Gera arquivos JSON de rascunho para upload manual no Google Drive
 * 
 * Uso:
 *   npx tsx src/generate-drafts.ts
 * 
 * Depois de gerar, faça upload da pasta 'drafts' para o Google Drive
 * como uma subpasta de ScrapperTV-Data chamada "Rascunhos"
 */
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';

const DRAFTS_DIR = './drafts';
const NUM_FILES = 1000; // 1000 arquivos é suficiente para muito tempo

async function generateDrafts() {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║       Gerador de Arquivos de Rascunho - ScrapperTV            ║
╚═══════════════════════════════════════════════════════════════╝
`);

  // Criar diretório
  await mkdir(DRAFTS_DIR, { recursive: true });
  
  console.log(`📁 Gerando ${NUM_FILES} arquivos em ${DRAFTS_DIR}/...\n`);
  
  // Gerar arquivos
  for (let i = 1; i <= NUM_FILES; i++) {
    const filename = `draft_${String(i).padStart(4, '0')}.json`;
    const content = JSON.stringify({
      _draft: true,
      _created: new Date().toISOString(),
      _index: i,
    }, null, 2);
    
    await writeFile(join(DRAFTS_DIR, filename), content);
    
    // Mostrar progresso a cada 100 arquivos
    if (i % 100 === 0) {
      console.log(`  ✅ ${i}/${NUM_FILES} arquivos criados`);
    }
  }
  
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                      CONCLUÍDO!                               ║
╚═══════════════════════════════════════════════════════════════╝

📁 ${NUM_FILES} arquivos gerados em: ${DRAFTS_DIR}/

PRÓXIMOS PASSOS:
1. Abra o Google Drive
2. Vá para a pasta ScrapperTV-Data
3. Crie uma pasta chamada "Rascunhos"
4. Faça upload de todos os arquivos da pasta ${DRAFTS_DIR}/ para "Rascunhos"
5. Compartilhe a pasta "Rascunhos" com:
   scrapper-drive@scrappertv.iam.gserviceaccount.com (Editor)

Pronto! O sistema de atualização automática poderá usar esses arquivos.
`);
}

generateDrafts().catch(console.error);
