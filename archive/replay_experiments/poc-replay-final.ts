import fs from 'fs';
import path from 'path';
import 'dotenv/config';
import { connect } from './connection.js';
import { RawCandle } from './types.js';

async function testFinalReplay() {
  const sessionId = process.env.TV_SESSION_ID;
  console.log('\n🎬 Testando Protocolo CORRIGIDO de Replay (2011)...');
  
  const connection = await connect({ sessionId });
  console.log('✅ Conectado.');

  // Target: 30 Nov 2011 23:00 UTC (1322694000)
  const targetTime = 1322694000;
  
  const chartSession = 'cs_' + Math.random().toString(36).substring(2, 14);
  const replaySession = 'rs_' + Math.random().toString(36).substring(2, 14);
  const symbol = 'CME_MINI:NQ1!';

  return new Promise<void>((resolve, reject) => {
    let dataReceived = false;
    let requestSent = false;

    connection.subscribe((event) => {
      // Log de tudo do replay
      if (event.name.includes('replay') || event.name === 'timescale_update') {
         if (event.name !== 'timescale_update') {
            console.log(`📥 REPLAY EVENT: ${event.name}`, event.params);
         }
      }

      if (event.name === 'critical_error') {
         console.error('❌ CRITICAL:', event.params);
         connection.close();
         process.exit(1);
      }

      // 4. Se o replay estiver pronto, pedir dados
      if ((event.name === 'replay_ok' || event.name === 'replay_point') && !requestSent) {
         console.log('✅ Replay Inicializado! Pedindo dados...');
         requestSent = true;
         
         console.log('5️⃣ Pedindo dados (No Chart)...');
         connection.send('create_series', [
            chartSession,
            'sds_1',
            's0',
            'sds_sym_0',
            '15',
            50, 
            ''
         ]);
      }

      // SUCESSO?
      if(event.name === 'timescale_update' && !dataReceived) {
        dataReceived = true;
        const params = event.params as [string, Record<string, { s: RawCandle[] }>];
        const seriesData = params[1]?.['sds_1']?.s;
        if (seriesData && seriesData.length > 0) {
          console.log(`📊 DADOS RECEBIDOS: ${seriesData.length} candles`);
          const first = seriesData[0];
          console.log(`   Data: ${new Date(first.v[0]*1000).toISOString()} (${first.v[0]})`);
          
          if (Math.abs(first.v[0] - targetTime) < 86400 * 30) {
             console.log('🎉🎉🎉 SUCESSO TOTAL! CHEGAMOS EM 2011! 🎉🎉🎉');
             
             // SALVAR ARQUIVO
             const dir = 'data/samples';
             if (!fs.existsSync(dir)){
                 fs.mkdirSync(dir, { recursive: true });
             }
             const filePath = path.join(dir, '2011_sample.json');
             
             // Formatar para leitura humana
             const formatted = seriesData.map(c => ({
                 time: new Date(c.v[0] * 1000).toISOString(),
                 open: c.v[1],
                 high: c.v[2],
                 low: c.v[3],
                 close: c.v[4],
                 volume: c.v[5]
             }));
             
             fs.writeFileSync(filePath, JSON.stringify(formatted, null, 2));
             console.log(`💾 Dados salvos em: ${filePath}`);

             setTimeout(() => {
                 connection.close();
                 process.exit(0);
             }, 500);
          }
        }
      }
    });

    // SEQÜÊNCIA INICIAL
    console.log('1️⃣ Criando sessões...');
    connection.send('chart_create_session', [chartSession, '']);
    connection.send('replay_create_session', [replaySession, '']); 
    
    // console.log('2️⃣ Resolvendo símbolos...');
    // Apenas no replay, implicitamente
    // connection.send('resolve_symbol', [
    //   replaySession, 
    //   'sds_sym_0',
    //   JSON.stringify({ symbol, adjustment: 'splits' })
    // ]);

    console.log(`3️⃣ Resetando para 2011 (${targetTime})...`);
    connection.send('replay_reset', [
      replaySession,
      'sds_sym_0',
      targetTime
    ]);
    
    console.log('4️⃣ Linkando Chart -> Replay (Via Resolve Symbol)...');
    // Link Mágico
    connection.send('resolve_symbol', [
      chartSession,
      'sds_sym_0',
      JSON.stringify({ 
        symbol, 
        adjustment: 'splits', 
        session: replaySession 
      }) 
    ]);
    
    // NOTA: create_series agora é enviado APÓS o evento de sucesso do replay
  });
}

testFinalReplay();