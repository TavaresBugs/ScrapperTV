#!/usr/bin/env node
/**
 * Google Drive Integration
 * 
 * Funções para upload/download de dados para o Google Drive
 */
import { google, drive_v3 } from 'googleapis';
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { Readable } from 'stream';

// Tipos
interface DriveConfig {
  credentialsPath?: string;
  credentialsJson?: string;
  folderId: string;
}

interface UploadResult {
  fileId: string;
  name: string;
  webViewLink?: string;
}

/**
 * Cria cliente autenticado do Google Drive
 */
async function createDriveClient(config: DriveConfig): Promise<drive_v3.Drive> {
  let credentials: object;
  
  if (config.credentialsJson) {
    // Credenciais passadas como JSON string (GitHub Actions)
    credentials = JSON.parse(config.credentialsJson);
  } else if (config.credentialsPath && existsSync(config.credentialsPath)) {
    // Credenciais de arquivo local
    const content = await readFile(config.credentialsPath, 'utf-8');
    credentials = JSON.parse(content);
  } else {
    throw new Error('Credenciais do Google não encontradas');
  }
  
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  
  return google.drive({ version: 'v3', auth });
}

/**
 * Lista arquivos em uma pasta do Drive
 */
export async function listFiles(config: DriveConfig): Promise<drive_v3.Schema$File[]> {
  const drive = await createDriveClient(config);
  
  const response = await drive.files.list({
    q: `'${config.folderId}' in parents and trashed = false`,
    fields: 'files(id, name, mimeType, modifiedTime, size)',
    orderBy: 'name',
  });
  
  return response.data.files || [];
}

/**
 * Busca um arquivo pelo nome
 */
export async function findFile(config: DriveConfig, fileName: string): Promise<drive_v3.Schema$File | null> {
  const drive = await createDriveClient(config);
  
  const response = await drive.files.list({
    q: `'${config.folderId}' in parents and name = '${fileName}' and trashed = false`,
    fields: 'files(id, name, mimeType, modifiedTime)',
  });
  
  return response.data.files?.[0] || null;
}

/**
 * Busca uma pasta existente (não cria - Service Account não pode criar)
 */
export async function findFolder(config: DriveConfig, folderName: string, parentId?: string): Promise<string | null> {
  const drive = await createDriveClient(config);
  const parent = parentId || config.folderId;
  
  const response = await drive.files.list({
    q: `'${parent}' in parents and name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)',
    supportsAllDrives: true,
  });
  
  if (response.data.files && response.data.files.length > 0) {
    return response.data.files[0].id!;
  }
  
  return null;
}

/**
 * Copia um arquivo existente e renomeia (workaround para criar novos arquivos)
 * A Service Account pode copiar arquivos mesmo sem quota de storage
 */
export async function copyAndRenameFile(
  config: DriveConfig,
  sourceFileId: string,
  newName: string,
  parentFolderId?: string
): Promise<string> {
  const drive = await createDriveClient(config);
  const parent = parentFolderId || config.folderId;
  
  // Copiar o arquivo
  const copy = await drive.files.copy({
    fileId: sourceFileId,
    requestBody: {
      name: newName,
      parents: [parent],
    },
    supportsAllDrives: true,
    fields: 'id, name',
  });
  
  console.log(`  📋 Copiado: ${newName}`);
  return copy.data.id!;
}

/**
 * Busca ou "cria" uma pasta usando workaround de cópia
 * Se não existir, copia uma pasta template e renomeia
 */
export async function findOrCreateFolder(config: DriveConfig, folderName: string): Promise<string> {
  // Primeiro, tentar encontrar pasta existente
  const existing = await findFolder(config, folderName);
  if (existing) {
    return existing;
  }
  
  // Tentar criar diretamente (pode falhar se Service Account não tiver quota)
  const drive = await createDriveClient(config);
  
  try {
    const folder = await drive.files.create({
      requestBody: {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [config.folderId],
      },
      supportsAllDrives: true,
      fields: 'id',
    });
    
    console.log(`📁 Pasta criada: ${folderName}`);
    return folder.data.id!;
  } catch (error: any) {
    // Se falhar por quota, a pasta precisa ser criada manualmente
    if (error.code === 403 && error.message?.includes('storage quota')) {
      throw new Error(`Pasta "${folderName}" não existe. Crie manualmente no Google Drive e compartilhe com a Service Account.`);
    }
    throw error;
  }
}


/**
 * Faz upload de um arquivo JSON
 * Se criação falhar por quota, usa workaround de cópia
 */
export async function uploadJson(
  config: DriveConfig,
  fileName: string,
  data: object,
  parentFolderId?: string
): Promise<UploadResult> {
  const drive = await createDriveClient(config);
  const folderId = parentFolderId || config.folderId;
  
  const jsonContent = JSON.stringify(data, null, 2);
  
  // Verificar se arquivo já existe
  const existing = await drive.files.list({
    q: `'${folderId}' in parents and name = '${fileName}' and trashed = false`,
    fields: 'files(id)',
    supportsAllDrives: true,
  });
  
  let result: drive_v3.Schema$File;
  
  if (existing.data.files && existing.data.files.length > 0) {
    // Atualizar arquivo existente - isso FUNCIONA!
    const fileId = existing.data.files[0].id!;
    result = (await drive.files.update({
      fileId,
      media: {
        mimeType: 'application/json',
        body: Readable.from([jsonContent]),
      },
      supportsAllDrives: true,
      fields: 'id, name, webViewLink',
    })).data;
    console.log(`  ♻️ Atualizado: ${fileName}`);
  } else {
    // Arquivo não existe - tentar criar ou usar workaround de mover
    try {
      result = (await drive.files.create({
        requestBody: {
          name: fileName,
          mimeType: 'application/json',
          parents: [folderId],
        },
        media: {
          mimeType: 'application/json',
          body: Readable.from([jsonContent]),
        },
        supportsAllDrives: true,
        fields: 'id, name, webViewLink',
      })).data;
      console.log(`  ✅ Criado: ${fileName}`);
    } catch (error: any) {
      // Se falhar por quota, usar workaround de MOVER
      if (error.code === 403 && error.message?.includes('storage quota')) {
        console.log(`  🔄 Usando workaround de mover para ${fileName}...`);
        
        // Buscar pasta de rascunhos
        const draftsFolder = await findFolder(config, 'Rascunhos');
        if (!draftsFolder) {
          throw new Error(
            `Pasta "Rascunhos" não encontrada. Crie a pasta e faça upload de arquivos JSON de rascunho.`
          );
        }
        
        // Pegar um arquivo de rascunho disponível
        const drafts = await drive.files.list({
          q: `'${draftsFolder}' in parents and name contains 'draft_' and trashed = false`,
          fields: 'files(id, name)',
          pageSize: 1,
          supportsAllDrives: true,
        });
        
        if (!drafts.data.files || drafts.data.files.length === 0) {
          throw new Error(
            `Sem arquivos de rascunho disponíveis na pasta "Rascunhos". Faça upload de mais arquivos.`
          );
        }
        
        const draftFile = drafts.data.files[0];
        console.log(`    Usando rascunho: ${draftFile.name}`);
        
        // Mover + Atualizar + Renomear
        const moveRes = await moveUpdateRename(
          config,
          draftFile.id!,
          folderId,
          fileName,
          data
        );
        
        result = {
          id: moveRes.fileId,
          name: moveRes.name,
          webViewLink: moveRes.webViewLink,
        };
      } else {
        throw error;
      }
    }
  }
  
  return {
    fileId: result.id!,
    name: result.name!,
    webViewLink: result.webViewLink || undefined,
  };
}

/**
 * Faz download de um arquivo JSON
 */
export async function downloadJson<T = unknown>(
  config: DriveConfig,
  fileName: string,
  parentFolderId?: string
): Promise<T | null> {
  const drive = await createDriveClient(config);
  const folderId = parentFolderId || config.folderId;
  
  // Buscar arquivo
  const response = await drive.files.list({
    q: `'${folderId}' in parents and name = '${fileName}' and trashed = false`,
    fields: 'files(id)',
  });
  
  if (!response.data.files || response.data.files.length === 0) {
    return null;
  }
  
  const fileId = response.data.files[0].id!;
  
  // Download
  const file = await drive.files.get({
    fileId,
    alt: 'media',
  });
  
  return file.data as T;
}

/**
 * Move um arquivo para outra pasta
 */
export async function moveFile(
  config: DriveConfig,
  fileId: string,
  newParentId: string,
  removeFromCurrentParent: boolean = true
): Promise<void> {
  const drive = await createDriveClient(config);
  
  // Buscar pai atual
  const file = await drive.files.get({
    fileId,
    fields: 'parents',
    supportsAllDrives: true,
  });
  
  const previousParents = file.data.parents?.join(',') || '';
  
  await drive.files.update({
    fileId,
    addParents: newParentId,
    removeParents: removeFromCurrentParent ? previousParents : undefined,
    supportsAllDrives: true,
    fields: 'id, parents',
  });
}

/**
 * Renomeia um arquivo
 */
export async function renameFile(
  config: DriveConfig,
  fileId: string,
  newName: string
): Promise<void> {
  const drive = await createDriveClient(config);
  
  await drive.files.update({
    fileId,
    requestBody: {
      name: newName,
    },
    supportsAllDrives: true,
    fields: 'id, name',
  });
}

/**
 * Move, atualiza conteúdo e renomeia um arquivo (workaround completo)
 */
export async function moveUpdateRename(
  config: DriveConfig,
  sourceFileId: string,
  targetFolderId: string,
  newName: string,
  data: object
): Promise<UploadResult> {
  const drive = await createDriveClient(config);
  const jsonContent = JSON.stringify(data, null, 2);
  
  // 1. Mover para a pasta destino
  const file = await drive.files.get({
    fileId: sourceFileId,
    fields: 'parents',
    supportsAllDrives: true,
  });
  
  const previousParents = file.data.parents?.join(',') || '';
  
  // 2. Mover + Renomear + Atualizar conteúdo em uma única operação
  const result = await drive.files.update({
    fileId: sourceFileId,
    addParents: targetFolderId,
    removeParents: previousParents,
    requestBody: {
      name: newName,
    },
    media: {
      mimeType: 'application/json',
      body: Readable.from([jsonContent]),
    },
    supportsAllDrives: true,
    fields: 'id, name, webViewLink',
  });
  
  console.log(`  🚀 Movido+Atualizado: ${newName}`);
  
  return {
    fileId: result.data.id!,
    name: result.data.name!,
    webViewLink: result.data.webViewLink || undefined,
  };
}

/**
 * Deleta um arquivo
 */
export async function deleteFile(config: DriveConfig, fileId: string): Promise<void> {
  const drive = await createDriveClient(config);
  await drive.files.delete({ fileId });
}

// CLI para testes
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  
  // Configuração
  const config: DriveConfig = {
    credentialsPath: process.env.GOOGLE_CREDENTIALS_PATH || './scrappertv-6f272e09d271.json',
    credentialsJson: process.env.GOOGLE_CREDENTIALS,
    folderId: process.env.GOOGLE_FOLDER_ID || '179sM5CqlpObj7Ad_dagazBjgoapFW-7M',
  };
  
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║           Google Drive Integration - ScrapperTV               ║
╚═══════════════════════════════════════════════════════════════╝
`);
  
  switch (command) {
    case 'list':
      console.log('📂 Listando arquivos na pasta...\n');
      const files = await listFiles(config);
      if (files.length === 0) {
        console.log('  (pasta vazia)');
      } else {
        for (const file of files) {
          const size = file.size ? `(${(parseInt(file.size) / 1024).toFixed(1)}KB)` : '';
          const icon = file.mimeType?.includes('folder') ? '📁' : '📄';
          console.log(`  ${icon} ${file.name} ${size}`);
          console.log(`     ID: ${file.id}`);
        }
      }
      console.log(`\n✅ Total: ${files.length} itens`);
      break;
      
    case 'test':
      console.log('🧪 Testando conexão com Google Drive...\n');
      try {
        const testFiles = await listFiles(config);
        console.log(`✅ Conexão OK! Pasta contém ${testFiles.length} itens.`);
      } catch (error) {
        console.error('❌ Erro:', error);
        process.exit(1);
      }
      break;
      
    case 'upload-test':
      console.log('📤 Testando upload...\n');
      const testData = {
        test: true,
        timestamp: new Date().toISOString(),
        message: 'Teste de upload do ScrapperTV',
      };
      const result = await uploadJson(config, 'test-upload.json', testData);
      console.log(`\n✅ Upload OK! ID: ${result.fileId}`);
      break;
      
    case 'move-test':
      console.log('🚀 Testando mover arquivo...\n');
      // Pegar IDs das pastas
      const allFiles = await listFiles(config);
      const templateFile = allFiles.find(f => f.name === 'test-upload.json');
      const nqFolder = allFiles.find(f => f.name === 'NQ');
      
      if (!templateFile || !nqFolder) {
        console.error('❌ Precisa ter test-upload.json e pasta NQ');
        process.exit(1);
      }
      
      console.log(`Template: ${templateFile.id}`);
      console.log(`Pasta NQ: ${nqFolder.id}`);
      
      // Testar mover + atualizar + renomear
      const moveResult = await moveUpdateRename(
        config,
        templateFile.id!,
        nqFolder.id!,
        'teste-movido.json',
        { moved: true, timestamp: new Date().toISOString() }
      );
      
      console.log(`\n✅ Movido com sucesso! ID: ${moveResult.fileId}`);
      break;
      
    default:
      console.log(`
USAGE:
  npx tsx src/drive.ts <command>

COMMANDS:
  list          Lista arquivos na pasta do Drive
  test          Testa conexão com o Drive
  upload-test   Testa upload de arquivo
  move-test     Testa mover arquivo entre pastas

EXEMPLOS:
  npx tsx src/drive.ts list
  npx tsx src/drive.ts test
`);
  }
}

main().catch(console.error);
