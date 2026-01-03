import 'dotenv/config';
import { connect } from './connection.js';
import { RawCandle } from './types.js';
import fs from 'fs';
import path from 'path';

async function testReplayStrict() {
  const sessionId = process.env.TV_SESSION_ID;
  console.log('\n🎬 Testando Replay Protocol (Sequencial Estrito)...');
  
  const connection = await connect({ sessionId });
  console.log('✅ Conectado.');

  const targetTime = 1322694000; // 30 Nov 2011
  const chartSession = 'cs_' + Math.random().toString(36).substring(2, 14);
  const replaySession = 'rs_' + Math.random().toString(36).substring(2, 14);
  const symbol = 'CME_MINI:NQ1!';

  // State Machine
  let replayReady = false;
  let chartReady = false;

  connection.subscribe((event) => {
    // Log GENÉRICO para descobrir eventos novos
    if (!['qsd', 'quote_completed', 'timescale_update'].includes(event.name)) {
        console.log(`🔎 EVENTO: ${event.name}`, JSON.stringify(event.params).substring(0, 100));
    }

    if (event.name === 'critical_error') {
       console.error('❌ CRITICAL:', event.params);
       process.exit(1);
    }
    // ... rest of logic


    if (event.name === 'replay_point') {
        const point = event.params[1];
        if (point === targetTime) {
            console.log('✅ Replay Point Confirmado em 2011!');
            replayReady = true;
            initChartSide();
        }
    }

    if (event.name === 'symbol_resolved') {
        if (event.params[0] === chartSession) {
            console.log('✅ Símbolo do Gráfico Resolvido (Linkado).');
            chartReady = true;
            requestData();
        }
    }

    if(event.name === 'timescale_update') {
        const params = event.params as [string, Record<string, { s: RawCandle[] }>];
        const seriesData = params[1]?.['sds_1']?.s;
        if (seriesData && seriesData.length > 0) {
          console.log(`📊 DADOS RECEBIDOS: ${seriesData.length} candles`);
          const first = seriesData[0];
          console.log(`   Data: ${new Date(first.v[0]*1000).toISOString()} (${first.v[0]})`);
          
          if (Math.abs(first.v[0] - targetTime) < 86400 * 30) {
             console.log('🎉🎉🎉 SUCESSO TOTAL! DADOS DE 2011 CAPTURADOS! 🎉🎉🎉');
             saveData(seriesData);
             process.exit(0);
          }
        }
    }
  });

  // 1. Iniciar Lado do Replay
  console.log('1️⃣ Iniciando Sessão de Replay...');
  connection.send('replay_create_session', [replaySession, '']);
  connection.send('replay_reset', [replaySession, 'sds_sym_0', targetTime]);
  // Aguarda 'replay_point'...

  function initChartSide() {
      console.log('2️⃣ Iniciando Sessão de Gráfico Linkada...');
      connection.send('chart_create_session', [chartSession, '']);
      connection.send('resolve_symbol', [
          chartSession,
          'sds_sym_1',
          JSON.stringify({ 
            symbol: symbol, 
            adjustment: 'splits', 
            session: replaySession // O Link Mágico
          })
      ]);
      
      // Não esperar evento, tentar pedir dados logo
      console.log('   (Aguardando 1s para propagação...)');
      setTimeout(() => {
          requestData();
      }, 1000);
  }

  function requestData() {
      console.log('3️⃣ Pedindo Dados (create_series)...');
      connection.send('create_series', [
          chartSession,
          'sds_1',
          's1',
          'sds_sym_1',
          '15',
          50,
          ''
      ]);
      
      /* Removed request_more_tickmarks to avoid crash */
  }

  function saveData(data: RawCandle[]) {
     const dir = 'data/samples';
     if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
     const filePath = path.join(dir, '2011_final_check.json');
     const formatted = data.map(c => ({
         time: new Date(c.v[0] * 1000).toISOString(),
         open: c.v[1], high: c.v[2], low: c.v[3], close: c.v[4], volume: c.v[5]
     }));
     fs.writeFileSync(filePath, JSON.stringify(formatted, null, 2));
     console.log(`💾 Salvo em: ${filePath}`);
  }
}

testReplayStrict();
